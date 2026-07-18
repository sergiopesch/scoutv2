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
  analysisRerunDelayMs: 1,
  maxAutomaticAnalysisTurnsPerSession: 20,
  maxActiveSessions: 3,
  allowDevIngest: false,
  codex: {
    binary: "codex",
    model: "gpt-5.6-sol",
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
  readonly recordingActions: string[] = [];
  failPause = false;
  holdPause = false;
  createCount = 0;
  private releaseHeldPause?: () => void;

  async createBot(config: RecallBotConfig) {
    this.createCount += 1;
    this.createConfig = config;
    return { botId: "bot-test" };
  }

  async pauseRecording(botId: string): Promise<void> {
    this.recordingActions.push(`pause:${botId}`);
    if (this.holdPause) {
      await new Promise<void>((resolve) => {
        this.releaseHeldPause = resolve;
      });
    }
    if (this.failPause) throw new Error("Recall pause unavailable");
  }

  async resumeRecording(botId: string): Promise<void> {
    this.recordingActions.push(`resume:${botId}`);
  }

  releasePause(): void {
    this.releaseHeldPause?.();
  }

  verifyWebhook(): void {}

  normalizeEvent(payload: unknown): NormalizedMeetingEvent[] {
    const kind = (payload as { kind?: string }).kind;
    if (kind === "partial") {
      return [
        {
          type: "transcript.partial",
          utterance: {
            id: "utt-live-partial",
            sequence: 1,
            participantId: "person-1",
            participantName: "Alex",
            text: "Finance manually copies",
            startedAt: 1,
            endedAt: 1.5,
            finalized: false
          }
        }
      ];
    }
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
    if (kind === "second-transcript" || kind === "paused-transcript") {
      return [
        {
          type: "transcript.final",
          utterance: {
            id:
              kind === "second-transcript"
                ? "utt-live-2"
                : "utt-while-paused",
            sequence: 2,
            participantId: "person-1",
            participantName: "Alex",
            text: "This utterance arrived after the first analysis.",
            startedAt: 3,
            endedAt: 4,
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
      .send(JSON.stringify({ kind: "partial" }))
      .expect(204);

    await eventually(
      () => runtime.store.getRequired(sessionId).utterances.length === 1
    );
    const interim = runtime.store.getRequired(sessionId);
    expect(interim.utterances[0]).toMatchObject({
      text: "Finance manually copies",
      finalized: false
    });
    expect(interim.analysis.pendingUtteranceCount).toBe(0);
    expect(interim.revision).toBe(0);

    await request(runtime.app)
      .put(`/api/sessions/${sessionId}/participants/person-1/role`)
      .send({ role: "customer" })
      .expect(200);

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
    expect(snapshot.participants[0]?.role).toBe("customer");
    expect(snapshot.recall.status).toBe("active");
    expect(snapshot.graph.topic.label).toBe("Billing workflow");

    const whiteboard = await request(runtime.app)
      .get(`/api/whiteboards/${sessionId}`)
      .expect(200);
    expect(whiteboard.body.graph.topic.label).toBe("Billing workflow");
    expect(whiteboard.body).not.toHaveProperty("meetingUrl");
    expect(whiteboard.body).not.toHaveProperty("participants");
    expect(whiteboard.body).not.toHaveProperty("utterances");
    expect(whiteboard.body).not.toHaveProperty("recall");
    expect(whiteboard.body).not.toHaveProperty("codex");
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

  it("limits concurrently active sessions before creating another bot", async () => {
    const runtime = createScoutRuntime(
      baseConfig({ maxActiveSessions: 1 }),
      { analyzer: new FakeAnalyzer() }
    );

    await request(runtime.app)
      .post("/api/sessions")
      .send({ meetingUrl: "https://zoom.example.invalid/j/first" })
      .expect(201);
    const rejected = await request(runtime.app)
      .post("/api/sessions")
      .send({ meetingUrl: "https://zoom.example.invalid/j/second" })
      .expect(429);

    expect(rejected.body.error).toContain("active session limit");
    await runtime.close();
  });

  it("pauses upstream capture, discards paused transcript events, and resumes the same session", async () => {
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
      .put(`/api/sessions/${sessionId}/participants/person-1/role`)
      .send({ role: "customer" })
      .expect(200);
    await eventually(() => runtime.store.getRequired(sessionId).revision === 1);
    const beforePause = runtime.store.getRequired(sessionId);

    const paused = await request(runtime.app)
      .put(`/api/sessions/${sessionId}/processing`)
      .send({ paused: true })
      .expect(200);
    expect(paused.body.processing).toMatchObject({
      paused: true,
      incomingTranscriptPolicy: "discard"
    });
    expect(recall.recordingActions).toEqual(["pause:bot-test"]);

    await request(runtime.app)
      .post(`/webhooks/recall/${token}`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ kind: "paused-transcript" }))
      .expect(204);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const whilePaused = runtime.store.getRequired(sessionId);
    expect(whilePaused.utterances).toEqual(beforePause.utterances);
    expect(whilePaused.graph).toEqual(beforePause.graph);
    expect(whilePaused.codex.threadId).toBe(beforePause.codex.threadId);
    await request(runtime.app)
      .post(`/api/sessions/${sessionId}/analyze`)
      .expect(409);

    const refreshed = await request(runtime.app)
      .get(`/api/sessions/${sessionId}`)
      .expect(200);
    expect(refreshed.body.processing.paused).toBe(true);

    await request(runtime.app)
      .put(`/api/sessions/${sessionId}/processing`)
      .send({ paused: false })
      .expect(200);
    expect(recall.recordingActions).toEqual([
      "pause:bot-test",
      "resume:bot-test"
    ]);

    await request(runtime.app)
      .post(`/webhooks/recall/${token}`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ kind: "second-transcript" }))
      .expect(204);
    await eventually(() => runtime.store.getRequired(sessionId).revision === 2);
    const resumed = runtime.store.getRequired(sessionId);
    expect(resumed.id).toBe(beforePause.id);
    expect(resumed.recall.botId).toBe(beforePause.recall.botId);
    expect(resumed.codex.threadId).toBe(beforePause.codex.threadId);
    expect(resumed.utterances.map((utterance) => utterance.id)).toEqual([
      "utt-live-1",
      "utt-live-2"
    ]);
    await runtime.close();
  });

  it("serializes repeated pause requests and preserves active state on upstream failure", async () => {
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

    await Promise.all([
      request(runtime.app)
        .put(`/api/sessions/${sessionId}/processing`)
        .send({ paused: true })
        .expect(200),
      request(runtime.app)
        .put(`/api/sessions/${sessionId}/processing`)
        .send({ paused: true })
        .expect(200)
    ]);
    expect(recall.recordingActions).toEqual(["pause:bot-test"]);

    await request(runtime.app)
      .put(`/api/sessions/${sessionId}/processing`)
      .send({ paused: false })
      .expect(200);
    recall.failPause = true;
    await request(runtime.app)
      .put(`/api/sessions/${sessionId}/processing`)
      .send({ paused: true })
      .expect(502);
    expect(runtime.store.getRequired(sessionId).processing.paused).toBe(false);
    await runtime.close();
  });

  it("resets context through the API without replacing the Recall bot or pause state", async () => {
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
    await eventually(
      () =>
        runtime.store.getRequired(created.body.sessionId).recall.botId ===
        "bot-test"
    );
    const sessionId = created.body.sessionId as string;
    runtime.store.upsertParticipant(sessionId, { id: "person-1", name: "Alex" });
    runtime.store.appendUtterance(sessionId, {
      id: "utt-1",
      sequence: 1,
      participantId: "person-1",
      participantName: "Alex",
      text: "Finance manually copies invoices.",
      startedAt: 1,
      endedAt: 2,
      finalized: true
    });
    runtime.store.setCodex(sessionId, {
      status: "connected",
      threadId: "thread-old"
    });
    runtime.store.acceptGraph(sessionId, {
      ...runtime.store.getRequired(sessionId).graph,
      topic: { id: "billing", label: "Billing workflow" }
    });
    recall.holdPause = true;
    const pauseRequest = request(runtime.app)
      .put(`/api/sessions/${sessionId}/processing`)
      .send({ paused: true })
      .expect(200)
      .then((response) => response);
    await eventually(() => recall.recordingActions.length === 1);

    const received: number[] = [];
    const unsubscribe = runtime.store.subscribe(sessionId, (snapshot) => {
      received.push(snapshot.revision);
    });
    const resetRequest = request(runtime.app)
      .post(`/api/sessions/${sessionId}/reset`)
      .expect(200)
      .then((response) => response);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runtime.store.getRequired(sessionId).revision).toBe(1);

    recall.releasePause();
    const [, reset] = await Promise.all([pauseRequest, resetRequest]);
    unsubscribe();

    expect(reset.body).toMatchObject({
      id: sessionId,
      revision: 0,
      utterances: [],
      participants: [{ id: "person-1", name: "Alex" }],
      recall: { status: "waiting", botId: "bot-test" },
      codex: { status: "idle" },
      processing: {
        paused: true,
        incomingTranscriptPolicy: "discard"
      },
      analysis: { status: "idle", pendingUtteranceCount: 0 }
    });
    expect(reset.body.graph.topic.label).toBe("Business discovery");
    expect(received.at(-1)).toBe(0);
    expect(recall.createCount).toBe(1);

    const repeated = await request(runtime.app)
      .post(`/api/sessions/${sessionId}/reset`)
      .expect(200);
    expect(repeated.body).toMatchObject({ revision: 0, utterances: [] });
    expect(repeated.body.processing.paused).toBe(true);
    expect(recall.createCount).toBe(1);
    await runtime.close();
  });
});
