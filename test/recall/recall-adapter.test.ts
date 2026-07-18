import { readFileSync } from "node:fs";
import { Webhook } from "svix";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  RecallBotCreationAmbiguousError,
  RecallClient,
  buildRecallCreateBotRequest,
  validateRecallApiBaseUrl,
  validateRecallMeetingUrl,
  validateRecallPublicBaseUrl
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
  meetingUrl: "https://zoom.us/j/123456",
  botName: "Live Architect",
  publicBaseUrl: "https://scout.example.dev/",
  sessionId: "session-demo",
  correlationId: "correlation-token-demo",
  sessionToken: "session-token-demo",
  whiteboardId: "whiteboard-token-demo"
};

const client = (options?: {
  fetch?: typeof globalThis.fetch;
  outputMode?: "screenshare" | "camera";
  retry?: ConstructorParameters<typeof RecallClient>[0]["retry"];
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
            url: "https://scout.example.dev/webhooks/recall/session-token-demo",
            events: [
              "transcript.partial_data",
              "transcript.data",
              "participant_events.join",
              "participant_events.update",
              "participant_events.leave"
            ]
          }
        ]
      },
      metadata: {
        scout_correlation_id: "correlation-token-demo"
      },
      output_media: {
        screenshare: {
          kind: "webpage",
          config: {
            url: "https://scout.example.dev/whiteboard/whiteboard-token-demo"
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

  it("deduplicates bot creation for the same Scout session", async () => {
    const fetchMock = vi.fn(
      async (..._arguments: Parameters<typeof globalThis.fetch>) =>
        Response.json({ id: "bot-created" }, { status: 201 })
    );
    const adapter = client({ fetch: fetchMock as typeof globalThis.fetch });

    await expect(
      Promise.all([adapter.createBot(botConfig), adapter.createBot(botConfig)])
    ).resolves.toEqual([{ botId: "bot-created" }, { botId: "bot-created" }]);
    expect(fetchMock).toHaveBeenCalledOnce();
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
          url: "https://scout.example.dev/whiteboard/whiteboard-token-demo"
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
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00.000Z"));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("locks bot classification to the first matching participant identity", async () => {
    const adapter = client({
      fetch: vi.fn(async () =>
        Response.json({ id: "bot-demo" }, { status: 201 })
      ) as typeof globalThis.fetch
    });
    await adapter.createBot(botConfig);

    const botJoin = fixture("participant.join.json") as Record<string, any>;
    botJoin.data.data.participant.name = "Live Architect";
    expect(adapter.normalizeEvent(botJoin)).toMatchObject([
      {
        type: "participant.changed",
        participant: { id: "73", name: "Live Architect", isBot: true }
      }
    ]);

    const humanJoin = fixture("participant.join.json") as Record<string, any>;
    humanJoin.data.data.participant.id = 74;
    humanJoin.data.data.participant.name = "Jordan";
    expect(adapter.normalizeEvent(humanJoin)).toMatchObject([
      { participant: { id: "74", isBot: false } }
    ]);

    const humanRename = fixture("participant.update.json") as Record<
      string,
      any
    >;
    humanRename.data.data.participant.id = 74;
    humanRename.data.data.participant.name = "Live Architect";
    expect(adapter.normalizeEvent(humanRename)).toMatchObject([
      {
        type: "participant.changed",
        participant: { id: "74", name: "Live Architect", isBot: false }
      }
    ]);

    const botRename = fixture("participant.update.json") as Record<string, any>;
    botRename.data.data.participant.id = 73;
    botRename.data.data.participant.name = "Renamed by platform";
    expect(adapter.normalizeEvent(botRename)).toMatchObject([
      {
        type: "participant.changed",
        participant: { id: "73", name: "Renamed by platform", isBot: true }
      }
    ]);
  });

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
        type: "participant.changed",
        action: "joined",
        occurredAt: Date.parse("2026-07-18T10:05:06.000Z"),
        participant: {
          id: "73",
          name: "Jamie Chen",
          platform: "zoom",
          joinedAt: Date.parse("2026-07-18T10:05:06.000Z"),
          present: true
        }
      }
    ]);
  });

  it("normalizes participant updates and leaves with stable identity and presence", () => {
    expect(client().normalizeEvent(fixture("participant.update.json"))).toEqual([
      {
        type: "participant.changed",
        action: "updated",
        occurredAt: Date.parse("2026-07-18T10:05:07.000Z"),
        participant: {
          id: "73",
          name: "Jamie Chen",
          platform: "zoom",
          platformIdentity: "zoom:stable-jamie-73",
          present: true
        }
      }
    ]);
    expect(client().normalizeEvent(fixture("participant.leave.json"))).toEqual([
      {
        type: "participant.changed",
        action: "left",
        occurredAt: Date.parse("2026-07-18T10:30:00.000Z"),
        participant: {
          id: "73",
          name: "Jamie Chen",
          platform: "zoom",
          platformIdentity: "zoom:stable-jamie-73",
          present: false,
          leftAt: Date.parse("2026-07-18T10:30:00.000Z")
        }
      }
    ]);
  });

  it("preserves a known participant name when a later leave payload omits it", () => {
    const adapter = client();
    adapter.normalizeEvent(fixture("participant.join.json"));
    const leave = fixture("participant.leave.json") as Record<string, any>;
    leave.data.data.participant.name = null;

    expect(adapter.normalizeEvent(leave)).toMatchObject([
      {
        type: "participant.changed",
        action: "left",
        participant: { id: "73", name: "Jamie Chen", present: false }
      }
    ]);
  });

  it("does not treat an unverified email as a stable operator identity", () => {
    const rejoin = fixture("participant.join.json") as Record<string, any>;
    rejoin.data.data.participant.id = 99;
    rejoin.data.data.participant.email = "jamie@example.org";
    rejoin.data.data.timestamp.absolute = "2026-07-18T10:31:00.000Z";

    expect(client().normalizeEvent(rejoin)).toMatchObject([
      {
        type: "participant.changed",
        action: "joined",
        participant: {
          id: "99",
          present: true
        }
      }
    ]);
    expect(client().normalizeEvent(rejoin)[0]).not.toHaveProperty(
      "participant.platformIdentity"
    );
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
            },
            timestamp: { absolute: "2026-07-18T10:05:06.000Z" }
          }
        }
      })
    ).toMatchObject([
      {
        type: "participant.changed",
        action: "joined",
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
        detail: "Waiting for the host to admit the bot",
        occurredAt: Date.parse("2026-07-18T10:04:30.000Z")
      }
    ]);

    expect(
      client().normalizeEvent({
        event: "bot.in_call_not_recording",
        data: {
          data: {
            code: "in_call_not_recording",
            updated_at: "2026-07-18T10:05:07.000Z"
          },
          bot: { id: "bot-paused", metadata: {} }
        }
      })
    ).toEqual([
      {
        type: "bot.status",
        botId: "bot-paused",
        status: "creating",
        detail: "Bot is in the call but is not recording",
        occurredAt: Date.parse("2026-07-18T10:05:07.000Z")
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
      {
        type: "bot.status",
        botId: "bot-demo",
        status: "listening",
        occurredAt: Date.parse("2026-07-18T10:05:08.000Z")
      }
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
        type: "integration.error",
        source: "recall",
        botId: "bot-demo",
        code: "meeting_not_found",
        detail: "meeting_not_found",
        occurredAt: Date.parse("2026-07-18T10:05:09.000Z"),
        fatal: true
      }
    ]);
  });

  it("surfaces permission, transcription, and output failures", () => {
    expect(
      client().normalizeEvent(fixture("bot.recording-permission-denied.json"))
    ).toEqual([
      {
        type: "integration.error",
        source: "recall",
        botId: "bot-demo",
        code: "zoom_local_recording_disabled",
        detail: "The host account has local recording disabled.",
        occurredAt: Date.parse("2026-07-18T10:05:08.000Z"),
        fatal: false
      }
    ]);
    expect(client().normalizeEvent(fixture("bot.output-log.json"))).toEqual([
      {
        type: "integration.error",
        source: "recall",
        botId: "bot-demo",
        code: "bot_output_error",
        detail: "Failed to connect to the real-time transcription provider.",
        occurredAt: Date.parse("2026-07-18T10:05:09.000Z"),
        fatal: true
      }
    ]);
    expect(client().normalizeEvent(fixture("transcript.failed.json"))).toEqual([
      {
        type: "integration.error",
        source: "recall",
        botId: "bot-demo",
        code: "transcription_provider_unavailable",
        detail: "The transcript provider was unavailable.",
        occurredAt: Date.parse("2026-07-18T10:05:10.000Z"),
        fatal: true
      }
    ]);
  });

  it("ignores unknown bot events and leaves ordering to transactional application", () => {
    const adapter = client();
    expect(
      adapter.normalizeEvent({
        event: "bot.future_status",
        data: { data: { code: "future_status" }, bot: { id: "bot-demo" } }
      })
    ).toEqual([]);

    expect(
      adapter.normalizeEvent({
        event: "bot.fatal",
        data: {
          data: {
            code: "fatal",
            sub_code: "meeting_not_found",
            updated_at: "2026-07-18T10:05:09.000Z"
          },
          bot: { id: "bot-terminal" }
        }
      })
    ).toHaveLength(1);
    expect(
      adapter.normalizeEvent({
        event: "bot.done",
        data: {
          data: {
            code: "done",
            updated_at: "2026-07-18T10:05:10.000Z"
          },
          bot: { id: "bot-terminal" }
        }
      })
    ).toHaveLength(1);

    expect(
      adapter.normalizeEvent({
        event: "bot.in_call_recording",
        data: {
          data: {
            code: "in_call_recording",
            updated_at: "2026-07-18T10:06:00.000Z"
          },
          bot: { id: "bot-ordered" }
        }
      })
    ).toHaveLength(1);
    expect(
      adapter.normalizeEvent({
        event: "bot.joining_call",
        data: {
          data: {
            code: "joining_call",
            updated_at: "2026-07-18T10:05:00.000Z"
          },
          bot: { id: "bot-ordered" }
        }
      })
    ).toHaveLength(1);
  });

  it("rejects unattributed transcripts and keeps nullable word endings monotonic", () => {
    const payload = fixture("transcript.final.json") as Record<string, any>;
    payload.data.data.participant.name = null;
    expect(client().normalizeEvent(payload)).toEqual([]);

    const withNullableEnding = fixture("transcript.final.json") as Record<
      string,
      any
    >;
    withNullableEnding.data.data.words.at(-1).end_timestamp = null;
    const events = client().normalizeEvent(withNullableEnding);
    expect(events[0]).toMatchObject({
      type: "transcript.final",
      utterance: { endedAt: 13.5 }
    });
  });

  it("rejects implausible or missing participant ordering timestamps", () => {
    const future = fixture("participant.join.json") as Record<string, any>;
    future.data.data.timestamp.absolute = "2099-01-01T00:00:00.000Z";
    expect(client().normalizeEvent(future)).toEqual([]);

    const missing = fixture("participant.join.json") as Record<string, any>;
    delete missing.data.data.timestamp;
    expect(client().normalizeEvent(missing)).toEqual([]);
  });

  it("rejects transcript timestamps outside the supported meeting window", () => {
    const payload = fixture("transcript.final.json") as Record<string, any>;
    for (const word of payload.data.data.words) {
      word.start_timestamp.relative = 1e308;
    }
    expect(client().normalizeEvent(payload)).toEqual([]);
  });
});

describe("Recall request resilience and validation", () => {
  it("keeps the timeout active while consuming a stalled response body", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "GET"
          ? Response.json({ next: null, results: [] })
          : new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode('{"id":"partial')
                  );
                }
              }),
              { status: 201 }
            )
    );
    const adapter = client({
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      retry: { requestTimeoutMs: 10, maxAttempts: 1 }
    });

    await expect(adapter.createBot(botConfig)).rejects.toThrow(
      /timed out after 10ms/
    );
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      "POST",
      "GET"
    ]);
  });

  it("rejects oversized provider response bodies", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "GET"
          ? Response.json({ next: null, results: [] })
          : new Response(new Uint8Array(1_048_577), { status: 201 })
    );
    const adapter = client({
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      retry: { requestTimeoutMs: 1_000, maxAttempts: 1 }
    });

    await expect(adapter.createBot(botConfig)).rejects.toThrow(
      /response exceeded 1048576 bytes/
    );
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      "POST",
      "GET"
    ]);
  });

  it("recovers one bot after an ambiguous create response", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "GET"
          ? Response.json({
              next: null,
              results: [
                {
                  id: "bot-recovered",
                  metadata: {
                    scout_correlation_id: botConfig.correlationId
                  }
                }
              ]
            })
          : Response.json(null, { status: 201 })
    );
    const adapter = client({ fetch: fetchMock as typeof globalThis.fetch });

    await expect(adapter.createBot(botConfig)).resolves.toEqual({
      botId: "bot-recovered"
    });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      "POST",
      "GET"
    ]);
  });

  it("filters reconciliation by exact metadata and valid bot IDs", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        next: null,
        results: [
          {
            id: "bot-matched",
            metadata: { scout_correlation_id: botConfig.correlationId }
          },
          {
            id: "bot-matched",
            metadata: { scout_correlation_id: botConfig.correlationId }
          },
          {
            id: "bot-wrong-correlation",
            metadata: { scout_correlation_id: "different-correlation-token" }
          },
          {
            id: "bot with spaces",
            metadata: { scout_correlation_id: botConfig.correlationId }
          },
          { id: "bot-no-metadata" },
          null
        ]
      })
    );
    const adapter = client({ fetch: fetchMock as typeof globalThis.fetch });

    await expect(
      adapter.findBotsByCorrelationId(botConfig.correlationId)
    ).resolves.toEqual(["bot-matched"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://eu-central-1.recall.ai/api/v1/bot/?metadata__scout_correlation_id=correlation-token-demo&page_size=100",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "test-api-key" })
      })
    );
  });

  it("honors Retry-After with bounded retries for explicit provider failures", async () => {
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response("busy", {
          status: 429,
          headers: { "Retry-After": "2" }
        })
      )
      .mockResolvedValueOnce(Response.json({ id: "bot-retried" }, { status: 201 }));
    const adapter = client({
      fetch: fetchMock,
      retry: { maxAttempts: 2, sleep, jitterMs: 0 }
    });

    await expect(adapter.createBot(botConfig)).resolves.toEqual({
      botId: "bot-retried"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("reconciles an ambiguous 503 create response without another POST", async () => {
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (_input, init) =>
      init?.method === "GET"
        ? Response.json({
            next: null,
            results: [
              {
                id: "bot-recovered-after-503",
                metadata: {
                  scout_correlation_id: botConfig.correlationId
                }
              }
            ]
          })
        : new Response("upstream unavailable", { status: 503 })
    );
    const adapter = client({
      fetch: fetchMock,
      retry: { maxAttempts: 4, sleep }
    });

    await expect(adapter.createBot(botConfig)).resolves.toEqual({
      botId: "bot-recovered-after-503"
    });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      "POST",
      "GET"
    ]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    [409, 1_000],
    [507, 30_000]
  ])("retries provider-safe HTTP %i responses", async (status, expectedDelay) => {
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("retry", { status }))
      .mockResolvedValueOnce(Response.json({ id: `bot-${status}` }, { status: 201 }));
    const adapter = client({
      fetch: fetchMock,
      retry: { maxAttempts: 2, sleep, jitterMs: 0 }
    });

    await expect(adapter.createBot(botConfig)).resolves.toEqual({
      botId: `bot-${status}`
    });
    expect(sleep).toHaveBeenCalledWith(expectedDelay);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      "POST",
      "POST"
    ]);
  });

  it("does not retry ambiguous network failures that could duplicate a bot", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (_input, init) =>
      init?.method === "GET"
        ? Response.json({ next: null, results: [] })
        : Promise.reject(new Error("connection reset"))
    );
    const adapter = client({
      fetch: fetchMock,
      retry: { maxAttempts: 4, sleep: vi.fn() }
    });

    const error = await adapter.createBot(botConfig).catch((cause) => cause);
    expect(error).toBeInstanceOf(RecallBotCreationAmbiguousError);
    expect(error).toMatchObject({ correlationId: botConfig.correlationId });
    expect(error.message).toContain("Recall create bot request failed");
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      "POST",
      "GET"
    ]);
  });

  it("aborts requests that exceed the configured timeout", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(
      async (_input, init) =>
        init?.method === "GET"
          ? Response.json({ next: null, results: [] })
          : new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(new DOMException("Aborted", "AbortError"));
              });
            })
    );
    const adapter = client({
      fetch: fetchMock,
      retry: { requestTimeoutMs: 5 }
    });

    await expect(adapter.createBot(botConfig)).rejects.toThrow(
      "Recall create bot timed out after 5ms"
    );
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      "POST",
      "GET"
    ]);
  });

  it("checks credentials and can explicitly remove a bot from a call", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(null, { status: 200 })
    );
    const adapter = client({ fetch: fetchMock });

    await expect(adapter.checkReadiness()).resolves.toEqual({ ready: true });
    await expect(adapter.leaveBot("bot/one")).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://eu-central-1.recall.ai/api/v1/bot/?page_size=1",
      "https://eu-central-1.recall.ai/api/v1/bot/bot%2Fone/leave_call/"
    ]);
  });

  it("fails readiness quickly instead of sleeping through provider backoff", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("unavailable", { status: 503 })
    );
    const adapter = client({
      fetch: fetchMock,
      retry: { maxAttempts: 4, sleep }
    });

    await expect(adapter.checkReadiness()).resolves.toMatchObject({
      ready: false,
      detail: expect.stringContaining("HTTP 503")
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rejects local callback/meeting URLs and malformed API endpoints", () => {
    expect(() => validateRecallPublicBaseUrl("http://scout.example.dev")).toThrow(
      "must use HTTPS"
    );
    expect(() => validateRecallPublicBaseUrl("https://localhost:3000")).toThrow(
      "publicly reachable"
    );
    expect(() => validateRecallPublicBaseUrl("https://[::1]:3000")).toThrow(
      "publicly reachable"
    );
    expect(() => validateRecallPublicBaseUrl("https://scout.example.dev/path")).toThrow(
      "without a path"
    );
    expect(() => validateRecallMeetingUrl("https://127.0.0.1/meeting")).toThrow(
      "publicly reachable"
    );
    expect(validateRecallApiBaseUrl("https://us-west-2.recall.ai/api/v1/")).toBe(
      "https://us-west-2.recall.ai/api/v1"
    );
  });
});

describe("Recall webhook verification", () => {
  it("rejects malformed workspace verification secrets at startup", () => {
    expect(
      () =>
        new RecallClient({
          apiBaseUrl: "https://eu-central-1.recall.ai/api/v1",
          apiKey: "test-api-key",
          workspaceVerificationSecret: "workspace-secret"
        })
    ).toThrow("must be a Recall whsec_ verification secret");
  });

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

  it("requires an explicit per-endpoint secret for legacy Svix dashboard mode", () => {
    expect(
      () =>
        new RecallClient({
          apiBaseUrl: "https://eu-central-1.recall.ai/api/v1",
          apiKey: "test-api-key",
          workspaceVerificationSecret: webhookSecret,
          webhookVerificationMode: "legacy-svix-dashboard"
        })
    ).toThrow("legacy Svix dashboard webhook secret is required");

    const legacyClient = new RecallClient({
      apiBaseUrl: "https://eu-central-1.recall.ai/api/v1",
      apiKey: "test-api-key",
      workspaceVerificationSecret: "not-a-whsec",
      legacySvixWebhookSecret: webhookSecret,
      webhookVerificationMode: "legacy-svix-dashboard"
    });
    const rawBody = "{}";
    const messageId = "legacy-svix-message";
    const timestamp = new Date();
    const signature = new Webhook(webhookSecret).sign(
      messageId,
      timestamp,
      rawBody
    );
    expect(() =>
      legacyClient.verifyWebhook(rawBody, {
        "svix-id": messageId,
        "svix-timestamp": String(Math.floor(timestamp.getTime() / 1_000)),
        "svix-signature": signature
      })
    ).not.toThrow();
  });
});
