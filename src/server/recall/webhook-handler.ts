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
}

const stringHeaders = (request: Request): Record<string, string> =>
  Object.fromEntries(
    Object.entries(request.headers).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value.join(",") : String(value ?? "")
    ])
  );

/**
 * Mount `recallRawJsonBody` on the Recall webhook route before any global
 * `express.json()` middleware. Signature verification must receive the exact
 * bytes sent by Recall.
 */
export const createRecallWebhookHandler = (
  options: RecallWebhookHandlerOptions
): RequestHandler => {
  return (request: Request, response: Response, _next: NextFunction): void => {
    if (!Buffer.isBuffer(request.body)) {
      response.status(400).json({ error: "raw webhook body required" });
      return;
    }

    const rawBody = request.body.toString("utf8");
    try {
      options.adapter.verifyWebhook(rawBody, stringHeaders(request));
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

    const events = options.adapter.normalizeEvent(payload);
    response.status(204).end();

    queueMicrotask(() => {
      Promise.resolve(options.onEvents(events)).catch((error: unknown) => {
        options.onAsyncError?.(error);
      });
    });
  };
};
