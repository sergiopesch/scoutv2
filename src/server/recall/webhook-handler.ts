import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response
} from "express";
import type {
  NormalizedMeetingEvent,
  RecallAdapter
} from "../contracts.js";

export const recallRawJsonBody: RequestHandler = express.raw({
  type: "application/json",
  limit: "1mb"
});

export interface RecallWebhookHandlerOptions {
  adapter: RecallAdapter;
  onEvents: (events: NormalizedMeetingEvent[]) => void | Promise<void>;
  onAsyncError?: (error: unknown) => void;
  deliveryCache?: RecallWebhookDeliveryCache;
}

export interface RecallWebhookDeliveryCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

interface DeliveryEntry {
  expiresAt: number;
  processing: Promise<void>;
  completed: boolean;
}

/**
 * Recall retries non-2xx webhook deliveries. Keep a bounded process-local set
 * of completed/in-flight delivery IDs so a retry cannot append the same
 * utterance or lifecycle transition twice. Failed processing is deliberately
 * removed so the provider can retry it.
 */
export class RecallWebhookDeliveryCache {
  private readonly entries = new Map<string, DeliveryEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private nextPruneAt = 0;

  constructor(options: RecallWebhookDeliveryCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 20_000;
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1_000;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new Error("Recall webhook delivery cache maxEntries must be at least 1");
    }
    if (!Number.isFinite(this.ttlMs) || this.ttlMs < 1) {
      throw new Error("Recall webhook delivery cache ttlMs must be positive");
    }
  }

  async process(deliveryId: string, operation: () => Promise<void>): Promise<void> {
    this.prune();
    const existing = this.entries.get(deliveryId);
    if (existing) {
      await existing.processing;
      return;
    }
    if (!this.ensureRoomForOne()) {
      throw new Error("Recall webhook delivery cache is at capacity");
    }

    const processing = Promise.resolve().then(operation);
    this.entries.set(deliveryId, {
      expiresAt: this.now() + this.ttlMs,
      processing,
      completed: false
    });
    try {
      await processing;
      const current = this.entries.get(deliveryId);
      if (current?.processing === processing) {
        current.completed = true;
        current.expiresAt = this.now() + this.ttlMs;
      }
      this.enforceLimit();
    } catch (error) {
      const current = this.entries.get(deliveryId);
      if (current?.processing === processing) this.entries.delete(deliveryId);
      throw error;
    }
  }

  private prune(): void {
    const now = this.now();
    if (now < this.nextPruneAt) return;
    this.nextPruneAt = now + Math.min(this.ttlMs, 60_000);
    for (const [deliveryId, entry] of this.entries) {
      if (entry.completed && entry.expiresAt <= now) {
        this.entries.delete(deliveryId);
      }
    }
  }

  private enforceLimit(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = [...this.entries.entries()].find(
        ([, entry]) => entry.completed
      )?.[0];
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }

  private ensureRoomForOne(): boolean {
    while (this.entries.size >= this.maxEntries) {
      let removed = false;
      for (const [deliveryId, entry] of this.entries) {
        if (!entry.completed) continue;
        this.entries.delete(deliveryId);
        removed = true;
        break;
      }
      if (!removed) return false;
    }
    return true;
  }
}

const defaultDeliveryCache = new RecallWebhookDeliveryCache();

const stringHeaders = (request: Request): Record<string, string> =>
  Object.fromEntries(
    Object.entries(request.headers).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value.join(",") : String(value ?? "")
    ])
  );

const deliveryId = (headers: Record<string, string>): string | undefined => {
  const svixId = headers["svix-id"]?.trim();
  const webhookId = headers["webhook-id"]?.trim();
  if (svixId && webhookId && svixId !== webhookId) {
    throw new Error("conflicting webhook delivery IDs");
  }
  // Svix verifies this signed identifier when present, so deduplication must
  // use the same precedence as signature verification.
  return svixId || webhookId || undefined;
};

/**
 * Mount `recallRawJsonBody` on the Recall webhook route before any global
 * `express.json()` middleware. Signature verification must receive the exact
 * bytes sent by Recall.
 */
export const createRecallWebhookHandler = (
  options: RecallWebhookHandlerOptions
): RequestHandler => {
  return async (
    request: Request,
    response: Response,
    _next: NextFunction
  ): Promise<void> => {
    if (!Buffer.isBuffer(request.body)) {
      response.status(400).json({ error: "raw webhook body required" });
      return;
    }

    const rawBody = request.body.toString("utf8");
    const headers = stringHeaders(request);
    try {
      options.adapter.verifyWebhook(rawBody, headers);
    } catch {
      response.status(400).json({ error: "webhook verification failed" });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody) as unknown;
    } catch {
      response.status(400).json({ error: "invalid webhook JSON" });
      return;
    }

    let id: string | undefined;
    try {
      id = deliveryId(headers);
    } catch {
      response.status(400).json({ error: "conflicting webhook delivery IDs" });
      return;
    }
    try {
      const operation = async (): Promise<void> => {
        const events = options.adapter.normalizeEvent(payload);
        await options.onEvents(events);
      };
      if (id) {
        await (options.deliveryCache ?? defaultDeliveryCache).process(id, operation);
      } else {
        // Verification normally guarantees an ID. Preserve compatibility with
        // custom test adapters while declining to deduplicate an unidentified
        // request.
        await operation();
      }
      response.status(204).end();
    } catch (error) {
      try {
        options.onAsyncError?.(error);
      } catch {
        // Error reporting must not prevent the retryable response below.
      }
      // A non-2xx response asks Recall to retry. The delivery reservation was
      // removed above, so a later verified attempt can be applied normally.
      response.status(503).json({ error: "webhook processing failed" });
    }
  };
};
