import { readFileSync } from "node:fs";
import { Webhook } from "svix";
import { describe, expect, it, vi } from "vitest";
import {
  RecallClient,
  buildRecallCreateBotRequest
} from "../../src/server/recall/index.js";
import type { RecallBotConfig } from "../../src/server/contracts.js";

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/recall/${name}`, import.meta.url), "utf8")
  ) as unknown;

const webhookSecret = `whsec_${Buffer.from(
  "scout-recall-test-signing-key-32-bytes"
).toString("base64")}`;

const botConfig: RecallBotConfig = {
  meetingUrl: "https://zoom.example.invalid/j/123456",
  botName: "Live Architect",
  publicBaseUrl: "https://scout.example.invalid/",
  sessionId: "session-demo",
  sessionToken: "session-token-demo"
};

const client = (options?: {
  fetch?: typeof globalThis.fetch;
  outputMode?: "screenshare" | "camera";
}): RecallClient =>
  new RecallClient({
    apiBaseUrl: "https://eu-central-1.recall.ai/api/v1/",
    apiKey: "test-api-key",
    webhookSecret,
    ...options
  });

describe("Recall create bot request", () => {
  it("creates a Live Architect bot with transcript, participant, and screenshare configuration", async () => {
    const fetchMock = vi.fn(
      async (..._arguments: Parameters<typeof globalThis.fetch>) =>
        Response.json({ id: "bot-created" }, { status: 201 })
    );
    const adapter = client({
      fetch: fetchMock as unknown as typeof globalThis.fetch
    });

    await expect(adapter.createBot(botConfig)).resolves.toEqual({
      botId: "bot-created"
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit
    ];
    expect(url).toBe("https://eu-central-1.recall.ai/api/v1/bot/");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "test-api-key",
      "content-type": "application/json"
    });

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      meeting_url: botConfig.meetingUrl,
      bot_name: "Live Architect",
      recording_config: {
        transcript: {
          provider: {
            recallai_streaming: {
              mode: "prioritize_low_latency",
              language_code: "en"
            }
          },
          diarization: {
            use_separate_streams_when_available: true
          }
        },
        realtime_endpoints: [
          {
            type: "webhook",
            url: "https://scout.example.invalid/webhooks/recall/session-token-demo",
            events: [
              "transcript.partial_data",
              "transcript.data",
              "participant_events.join"
            ]
          }
        ]
      },
      output_media: {
        screenshare: {
          kind: "webpage",
          config: {
            url: "https://scout.example.invalid/whiteboard/session-demo"
          }
        }
      }
    });
  });

  it("uses Recall's pause and resume recording endpoints", async () => {
    const fetchMock = vi.fn(
      async (..._arguments: Parameters<typeof globalThis.fetch>) =>
        new Response(null, { status: 200 })
    );
    const adapter = client({
      fetch: fetchMock as unknown as typeof globalThis.fetch
    });

    await adapter.pauseRecording("bot/with spaces");
    await adapter.resumeRecording("bot/with spaces");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://eu-central-1.recall.ai/api/v1/bot/bot%2Fwith%20spaces/pause_recording/",
      "https://eu-central-1.recall.ai/api/v1/bot/bot%2Fwith%20spaces/resume_recording/"
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      "POST",
      "POST"
    ]);
  });

  it("can build the documented camera webpage fallback without changing session URLs", () => {
    const request = buildRecallCreateBotRequest(botConfig, {
      outputMode: "camera",
      languageCode: "en-GB"
    });

    expect(request.output_media).toEqual({
      camera: {
        kind: "webpage",
        config: {
          url: "https://scout.example.invalid/whiteboard/session-demo"
        }
      }
    });
    expect(
      request.recording_config.transcript.provider.recallai_streaming
        .language_code
    ).toBe("en-GB");
  });
});

describe("Recall event normalization", () => {
  it("normalizes a finalized attributed transcript with relative timing", () => {
    const events = client().normalizeEvent(fixture("transcript.final.json"));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "transcript.final",
      utterance: {
        sequence: 12_250,
        participantId: "42",
        participantName: "Alex Morgan",
        text: "Sales exports leads weekly.",
        startedAt: 12.25,
        endedAt: 13.95,
        finalized: true
      }
    });
    if (events[0]?.type === "transcript.final") {
      expect(events[0].utterance.id).toMatch(
        /^transcript-demo:42:12250:13950:[a-f0-9]{10}$/
      );
    }
  });

  it("normalizes partial transcripts without marking them finalized", () => {
    const events = client().normalizeEvent(fixture("transcript.partial.json"));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "transcript.partial",
      utterance: {
        id: "transcript-demo:42:12250:partial",
        participantId: "42",
        participantName: "Alex Morgan",
        text: "Sales exp",
        startedAt: 12.25,
        finalized: false
      }
    });
  });

  it("normalizes participant identity and absolute join time", () => {
    expect(
      client().normalizeEvent(fixture("participant.join.json"))
    ).toEqual([
      {
        type: "participant.joined",
        participant: {
          id: "73",
          name: "Jamie Chen",
          platform: "zoom",
          joinedAt: Date.parse("2026-07-18T10:05:06.000Z")
        }
      }
    ]);
  });

  it("retains a stable platform identity when Recall exposes one", () => {
    expect(
      client().normalizeEvent({
        event: "participant_events.join",
        data: {
          data: {
            participant: {
              id: 74,
              name: "Stephen",
              platform: "zoom",
              extra_data: {
                zoom: { conf_user_id: "stable-user-1" }
              }
            }
          }
        }
      })
    ).toMatchObject([
      {
        type: "participant.joined",
        participant: {
          id: "74",
          platformIdentity: "zoom:stable-user-1"
        }
      }
    ]);
  });

  it("maps legacy and current bot lifecycle payloads to session-facing states", () => {
    expect(
      client().normalizeEvent(fixture("bot.status-change.json"))
    ).toEqual([
      {
        type: "bot.status",
        botId: "bot-demo",
        status: "waiting_for_admission",
        detail: "Waiting for the host to admit the bot"
      }
    ]);

    expect(
      client().normalizeEvent({
        event: "bot.in_call_recording",
        data: {
          data: {
            code: "in_call_recording",
            sub_code: null,
            updated_at: "2026-07-18T10:05:08.000Z"
          },
          bot: { id: "bot-demo", metadata: {} }
        }
      })
    ).toEqual([
      { type: "bot.status", botId: "bot-demo", status: "listening" }
    ]);

    expect(
      client().normalizeEvent({
        event: "bot.fatal",
        data: {
          data: {
            code: "fatal",
            sub_code: "meeting_not_found",
            updated_at: "2026-07-18T10:05:09.000Z"
          },
          bot: { id: "bot-demo", metadata: {} }
        }
      })
    ).toEqual([
      {
        type: "bot.status",
        botId: "bot-demo",
        status: "error",
        detail: "meeting_not_found"
      }
    ]);
  });
});

describe("Recall webhook verification", () => {
  it("verifies the raw body and rejects a changed body", () => {
    const rawBody = JSON.stringify(fixture("transcript.final.json"));
    const messageId = "msg_recall_demo";
    const timestamp = new Date();
    const signature = new Webhook(webhookSecret).sign(
      messageId,
      timestamp,
      rawBody
    );
    const headers = {
      "webhook-id": messageId,
      "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1_000)),
      "webhook-signature": signature
    };
    const adapter = client();

    expect(() => adapter.verifyWebhook(rawBody, headers)).not.toThrow();
    expect(() =>
      adapter.verifyWebhook(`${rawBody} `, headers)
    ).toThrow();
  });
});
