import express from "express";
import request from "supertest";
import { Webhook } from "svix";
import { describe, expect, it, vi } from "vitest";
import type {
  NormalizedMeetingEvent,
  RecallAdapter
} from "../../src/server/contracts.js";
import {
  createRecallWebhookHandler,
  RecallClient,
  RecallWebhookDeliveryCache,
  recallRawJsonBody
} from "../../src/server/recall/index.js";

const adapter = (overrides: Partial<RecallAdapter> = {}): RecallAdapter => ({
  async createBot() {
    return { botId: "bot-test" };
  },
  async pauseRecording() {},
  async resumeRecording() {},
  verifyWebhook() {},
  normalizeEvent() {
    return [];
  },
  ...overrides
});

const appWithHandler = (options: {
  adapter: RecallAdapter;
  onEvents: (events: NormalizedMeetingEvent[]) => void | Promise<void>;
  onAsyncError?: (error: unknown) => void;
  deliveryCache?: RecallWebhookDeliveryCache;
}) => {
  const app = express();
  app.post(
    "/recall",
    recallRawJsonBody,
    createRecallWebhookHandler(options)
  );
  return app;
};

const deliveryHeaders = (id: string): Record<string, string> => ({
  "webhook-id": id,
  "webhook-timestamp": "1784369106",
  "webhook-signature": "v1,test"
});

describe("Recall webhook handler", () => {
  it("accepts a genuinely signed raw request through Express", async () => {
    const webhookSecret = `whsec_${Buffer.from(
      "scout-recall-express-signing-key"
    ).toString("base64")}`;
    const rawBody = '{"event":"bot.ready","data":{}}';
    const messageId = "delivery-signed-express";
    const timestamp = new Date();
    const signature = new Webhook(webhookSecret).sign(
      messageId,
      timestamp,
      rawBody
    );
    const onEvents = vi.fn();
    const app = appWithHandler({
      adapter: new RecallClient({
        apiBaseUrl: "https://eu-central-1.recall.ai/api/v1",
        apiKey: "test-api-key",
        workspaceVerificationSecret: webhookSecret
      }),
      onEvents,
      deliveryCache: new RecallWebhookDeliveryCache()
    });

    await request(app)
      .post("/recall")
      .set("content-type", "application/json")
      .set({
        "webhook-id": messageId,
        "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1_000)),
        "webhook-signature": signature
      })
      .send(rawBody)
      .expect(204);

    expect(onEvents).toHaveBeenCalledWith([]);
  });

  it("verifies the exact raw body before parsing and applying events", async () => {
    const rawBody = '{"event":"participant_events.join"}';
    const verifyWebhook = vi.fn();
    const normalized: NormalizedMeetingEvent[] = [
      {
        type: "participant.changed",
        action: "joined",
        participant: { id: "participant-1", name: "Taylor", present: true }
      }
    ];
    const normalizeEvent = vi.fn(() => normalized);
    const onEvents = vi.fn();
    const app = appWithHandler({
      adapter: adapter({ verifyWebhook, normalizeEvent }),
      onEvents,
      deliveryCache: new RecallWebhookDeliveryCache()
    });

    await request(app)
      .post("/recall")
      .set("content-type", "application/json")
      .set(deliveryHeaders("delivery-raw"))
      .send(rawBody)
      .expect(204);

    expect(verifyWebhook).toHaveBeenCalledWith(
      rawBody,
      expect.objectContaining(deliveryHeaders("delivery-raw"))
    );
    expect(normalizeEvent).toHaveBeenCalledWith({
      event: "participant_events.join"
    });
    expect(onEvents).toHaveBeenCalledWith(normalized);
  });

  it("rejects unverified or malformed deliveries without applying them", async () => {
    const onEvents = vi.fn();
    const verificationApp = appWithHandler({
      adapter: adapter({
        verifyWebhook() {
          throw new Error("bad signature");
        }
      }),
      onEvents
    });
    await request(verificationApp)
      .post("/recall")
      .set("content-type", "application/json")
      .send("{}")
      .expect(400, { error: "webhook verification failed" });

    const malformedApp = appWithHandler({ adapter: adapter(), onEvents });
    await request(malformedApp)
      .post("/recall")
      .set("content-type", "application/json")
      .send("not-json")
      .expect(400, { error: "invalid webhook JSON" });
    expect(onEvents).not.toHaveBeenCalled();
  });

  it("deduplicates successful deliveries by verified webhook ID", async () => {
    const onEvents = vi.fn();
    const deliveryCache = new RecallWebhookDeliveryCache();
    const app = appWithHandler({
      adapter: adapter(),
      onEvents,
      deliveryCache
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await request(app)
        .post("/recall")
        .set("content-type", "application/json")
        .set(deliveryHeaders("delivery-duplicate"))
        .send("{}")
        .expect(204);
    }
    expect(onEvents).toHaveBeenCalledOnce();
  });

  it("rejects conflicting unsigned webhook IDs beside a signed Svix ID", async () => {
    const webhookSecret = `whsec_${Buffer.from(
      "scout-recall-svix-id-precedence"
    ).toString("base64")}`;
    const rawBody = "{}";
    const svixId = "signed-svix-id";
    const timestamp = new Date();
    const signature = new Webhook(webhookSecret).sign(
      svixId,
      timestamp,
      rawBody
    );
    const onEvents = vi.fn();
    const app = appWithHandler({
      adapter: new RecallClient({
        apiBaseUrl: "https://eu-central-1.recall.ai/api/v1",
        apiKey: "test-api-key",
        legacySvixWebhookSecret: webhookSecret,
        webhookVerificationMode: "legacy-svix-dashboard"
      }),
      onEvents,
      deliveryCache: new RecallWebhookDeliveryCache()
    });

    await request(app)
      .post("/recall")
      .set("content-type", "application/json")
      .set({
        "svix-id": svixId,
        "svix-timestamp": String(Math.floor(timestamp.getTime() / 1_000)),
        "svix-signature": signature,
        "webhook-id": "unsigned-conflicting-id"
      })
      .send(rawBody)
      .expect(400, { error: "conflicting webhook delivery IDs" });

    expect(onEvents).not.toHaveBeenCalled();
  });

  it("returns a retryable failure and releases the ID after application errors", async () => {
    const failure = new Error("store unavailable");
    const onEvents = vi
      .fn<(events: NormalizedMeetingEvent[]) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const onAsyncError = vi.fn();
    const app = appWithHandler({
      adapter: adapter(),
      onEvents,
      onAsyncError,
      deliveryCache: new RecallWebhookDeliveryCache()
    });

    await request(app)
      .post("/recall")
      .set("content-type", "application/json")
      .set(deliveryHeaders("delivery-retry"))
      .send("{}")
      .expect(503, { error: "webhook processing failed" });
    await request(app)
      .post("/recall")
      .set("content-type", "application/json")
      .set(deliveryHeaders("delivery-retry"))
      .send("{}")
      .expect(204);

    expect(onAsyncError).toHaveBeenCalledWith(failure);
    expect(onEvents).toHaveBeenCalledTimes(2);
  });

  it("returns a retryable failure when normalization throws", async () => {
    const failure = new Error("normalizer unavailable");
    const normalizeEvent = vi
      .fn<RecallAdapter["normalizeEvent"]>()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockReturnValueOnce([]);
    const onAsyncError = vi.fn();
    const app = appWithHandler({
      adapter: adapter({ normalizeEvent }),
      onEvents: vi.fn(),
      onAsyncError,
      deliveryCache: new RecallWebhookDeliveryCache()
    });

    await request(app)
      .post("/recall")
      .set("content-type", "application/json")
      .set(deliveryHeaders("delivery-normalize-retry"))
      .send("{}")
      .expect(503);
    await request(app)
      .post("/recall")
      .set("content-type", "application/json")
      .set(deliveryHeaders("delivery-normalize-retry"))
      .send("{}")
      .expect(204);

    expect(normalizeEvent).toHaveBeenCalledTimes(2);
    expect(onAsyncError).toHaveBeenCalledWith(failure);
  });
});

describe("Recall webhook delivery cache", () => {
  it("coalesces concurrent processing of the same delivery", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = vi.fn(async () => blocked);
    const cache = new RecallWebhookDeliveryCache();

    const first = cache.process("delivery-concurrent", operation);
    const second = cache.process("delivery-concurrent", operation);
    release?.();
    await Promise.all([first, second]);

    expect(operation).toHaveBeenCalledOnce();
  });

  it("bounds unique in-flight deliveries while evicting completed entries", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cache = new RecallWebhookDeliveryCache({ maxEntries: 1 });
    const first = cache.process("delivery-1", async () => blocked);

    await expect(
      cache.process("delivery-2", async () => undefined)
    ).rejects.toThrow(/at capacity/);
    release?.();
    await first;

    await expect(
      cache.process("delivery-3", async () => undefined)
    ).resolves.toBeUndefined();
  });
});
