import request from "supertest";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/config.js";
import type {
  AnalyzeMeetingInput,
  MeetingAnalyzer,
  NormalizedMeetingEvent,
  RecallAdapter,
  RecallBotConfig
} from "../src/server/contracts.js";
import { createScoutRuntime } from "../src/server/index.js";

const baseConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  port: 3000,
  host: "127.0.0.1",
  analysisDelayMs: 1,
  allowDevIngest: false,
  codex: {
    binary: "codex",
    model: "gpt-5.6",
    reasoningEffort: "low"
  },
  ...overrides
});

class FakeAnalyzer implements MeetingAnalyzer {
  async analyze(input: AnalyzeMeetingInput) {
    return {
      threadId: input.threadId ?? "thread-test",
      graph: {
        ...input.currentGraph,
        topic: { id: "billing", label: "Billing workflow" },
        nodes: [
          {
            id: "finance",
            kind: "team" as const,
            label: "Finance",
            state: "current" as const,
            confidence: 1,
            evidenceUtteranceIds: input.newUtterances.map((item) => item.id)
          }
        ]
      }
    };
  }

  async close(): Promise<void> {}
}

class FakeRecall implements RecallAdapter {
  createConfig?: RecallBotConfig;

  async createBot(config: RecallBotConfig) {
    this.createConfig = config;
    return { botId: "bot-test" };
  }

  verifyWebhook(): void {}

  normalizeEvent(payload: unknown): NormalizedMeetingEvent[] {
    const kind = (payload as { kind?: string }).kind;
    if (kind === "transcript") {
      return [
        {
          type: "transcript.final",
          utterance: {
            id: "utt-live-1",
            sequence: 1,
            participantId: "person-1",
            participantName: "Alex",
            text: "Finance manually copies invoices into a spreadsheet.",
            startedAt: 1,
            endedAt: 2,
            finalized: true
          }
        }
      ];
    }
    if (kind === "status") {
      return [
        {
          type: "bot.status",
          botId: "bot-test",
          status: "listening"
        }
      ];
    }
    return [];
  }
}

const eventually = async (check: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Expected runtime state was not reached.");
};

describe("Scout runtime", () => {
  it("creates a usable local session while clearly reporting missing Recall configuration", async () => {
    const runtime = createScoutRuntime(baseConfig(), {
      analyzer: new FakeAnalyzer()
    });

    const response = await request(runtime.app)
      .post("/api/sessions")
      .send({ meetingUrl: "https://zoom.example.invalid/j/123" })
      .expect(201);

    const snapshot = runtime.store.getRequired(response.body.sessionId);
    expect(snapshot.recall.status).toBe("error");
    expect(snapshot.recall.detail).toContain("PUBLIC_API_BASE_URL");
    await runtime.close();
  });

  it("routes verified real-time and dashboard events to the correct session", async () => {
    const recall = new FakeRecall();
    const config = baseConfig({
      publicBaseUrl: "https://scout.example.invalid",
      recall: {
        region: "us-west-2",
        apiKey: "test-key",
        apiBaseUrl: "https://us-west-2.recall.ai/api/v1",
        workspaceVerificationSecret: "whsec_workspace",
        statusWebhookSecret: "whsec_status",
        outputMode: "screenshare"
      }
    });
    const runtime = createScoutRuntime(config, {
      analyzer: new FakeAnalyzer(),
      recall,
      statusRecall: recall
    });

    const created = await request(runtime.app)
      .post("/api/sessions")
      .send({ meetingUrl: "https://zoom.example.invalid/j/123" })
      .expect(201);
    await eventually(() => Boolean(recall.createConfig));
    const sessionId = created.body.sessionId as string;
    const token = recall.createConfig?.sessionToken;
    expect(token).toBeTruthy();

    await request(runtime.app)
      .post(`/webhooks/recall/${token}`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ kind: "transcript" }))
      .expect(204);

    await request(runtime.app)
      .post("/webhooks/recall/status")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ kind: "status" }))
      .expect(204);

    await eventually(() => runtime.store.getRequired(sessionId).revision === 1);
    const snapshot = runtime.store.getRequired(sessionId);
    expect(snapshot.utterances).toHaveLength(1);
    expect(snapshot.participants[0]?.name).toBe("Alex");
    expect(snapshot.recall.status).toBe("active");
    expect(snapshot.graph.topic.label).toBe("Billing workflow");
    await runtime.close();
  });

  it("keeps development ingest absent unless explicitly enabled", async () => {
    const disabled = createScoutRuntime(baseConfig(), {
      analyzer: new FakeAnalyzer()
    });
    await request(disabled.app)
      .post("/api/dev/sessions/not-real/utterances")
      .send({})
      .expect(404);
    await disabled.close();
  });
});
