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
import { RecallBotCreationAmbiguousError } from "../src/server/recall/index.js";

const baseConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  port: 3000,
  host: "127.0.0.1",
  analysisDelayMs: 1,
  analysisRerunDelayMs: 1,
  analysisMaxBatchUtterances: 40,
  analysisMaxBatchBytes: 48_000,
  maxAutomaticAnalysisTurnsPerSession: 20,
  maxActiveSessions: 3,
  maxSseConnections: 128,
  maxSseConnectionsPerSession: 32,
  sessionRetentionMs: 60_000,
  shutdownGraceMs: 1_000,
  allowDevIngest: true,
  codex: {
    binary: "codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "low"
  },
  ...overrides
});

const liveConfig = (overrides: Partial<AppConfig> = {}): AppConfig =>
  baseConfig({
    publicBaseUrl: "https://scout.example.dev",
    recall: {
      region: "us-west-2",
      apiKey: "test-key",
      apiBaseUrl: "https://us-west-2.recall.ai/api/v1",
      workspaceVerificationSecret: "whsec_workspace",
      statusWebhookSecret: "whsec_status",
      statusWebhookVerificationMode: "svix",
      outputMode: "screenshare",
      requestTimeoutMs: 1_000,
      maxRetries: 0
    },
    ...overrides
  });

class FakeAnalyzer implements MeetingAnalyzer {
  readonly resetCalls: string[] = [];
  readinessReady = true;
  readinessError?: Error;
  resetError?: Error;
  holdClose = false;

  async analyze(input: AnalyzeMeetingInput) {
    const customerParticipantIds = new Set(
      input.participants
        .filter((participant) => participant.role === "customer")
        .map((participant) => participant.id)
    );
    const customerEvidence = input.newUtterances.filter((utterance) =>
      customerParticipantIds.has(utterance.participantId)
    );
    return {
      threadId: input.threadId ?? "thread-test",
      graph: {
        ...input.currentGraph,
        topic: {
          id: "billing",
          label: "Billing workflow",
          evidenceUtteranceIds: customerEvidence.map((item) => item.id)
        },
        nodes: [
          {
            id: "finance",
            kind: "team" as const,
            label: "Finance",
            state: "current" as const,
            confidence: 1,
            evidenceUtteranceIds: customerEvidence.map((item) => item.id)
          }
        ]
      }
    };
  }

  async resetSession(sessionId: string): Promise<void> {
    if (this.resetError) throw this.resetError;
    this.resetCalls.push(sessionId);
  }

  async checkReadiness() {
    if (this.readinessError) throw this.readinessError;
    return { ready: this.readinessReady };
  }

  async close(): Promise<void> {
    if (this.holdClose) await new Promise<void>(() => {});
  }
}

class FakeRecall implements RecallAdapter {
  createConfig?: RecallBotConfig;
  readonly recordingActions: string[] = [];
  failPause = false;
  holdPause = false;
  createCount = 0;
  failCreate = false;
  ambiguousCreate = false;
  holdCreate = false;
  readinessReady = true;
  readinessError?: Error;
  onResume?: () => Promise<void>;
  readonly leaveCalls: string[] = [];
  readonly correlationLookupCalls: string[] = [];
  correlationMatches: string[] = [];
  private releaseHeldPause?: () => void;
  private releaseHeldCreate?: () => void;

  async createBot(config: RecallBotConfig) {
    this.createCount += 1;
    this.createConfig = config;
    if (this.failCreate) throw new Error("Recall create unavailable");
    if (this.ambiguousCreate) {
      throw new RecallBotCreationAmbiguousError(
        config.correlationId,
        "Recall bot creation outcome is ambiguous"
      );
    }
    if (this.holdCreate) {
      await new Promise<void>((resolve) => {
        this.releaseHeldCreate = resolve;
      });
    }
    return { botId: "bot-test" };
  }

  async findBotsByCorrelationId(correlationId: string): Promise<string[]> {
    this.correlationLookupCalls.push(correlationId);
    return [...this.correlationMatches];
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
    await this.onResume?.();
  }

  async leaveBot(botId: string): Promise<void> {
    this.leaveCalls.push(botId);
  }

  async checkReadiness() {
    if (this.readinessError) throw this.readinessError;
    return { ready: this.readinessReady };
  }

  releasePause(): void {
    this.releaseHeldPause?.();
  }

  releaseCreate(): void {
    this.releaseHeldCreate?.();
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
    if (kind === "ended") {
      return [
        {
          type: "bot.status",
          botId: "bot-test",
          status: "ended",
          occurredAt: 20
        }
      ];
    }
    if (kind === "fatal") {
      return [
        {
          type: "integration.error",
          source: "recall",
          code: "recording_permission_denied",
          detail: "Recording permission was denied",
          botId: "bot-test",
          occurredAt: 10,
          fatal: true
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
  it("creates a truthful rehearsal session when dev ingest is explicitly enabled", async () => {
    const runtime = createScoutRuntime(baseConfig(), {
      analyzer: new FakeAnalyzer()
    });

    const response = await request(runtime.app)
      .post("/api/sessions")
      .send({ meetingUrl: "https://zoom.example.invalid/j/123" })
      .expect(201);

    await request(runtime.app).get("/livez").expect(200);
    const ready = await request(runtime.app).get("/readyz").expect(200);
    expect(ready.body).toMatchObject({ ok: true, mode: "rehearsal" });

    const snapshot = runtime.store.getRequired(response.body.sessionId);
    expect(response.body.mode).toBe("rehearsal");
    expect(snapshot.status).toBe("listening");
    expect(snapshot.recall).toMatchObject({
      status: "idle",
      detail: expect.stringContaining("rehearsal mode")
    });
    const metrics = await request(runtime.app).get("/metrics").expect(200);
    expect(metrics.body).toMatchObject({
      sessionsCreated: 1,
      activeSessions: 1,
      retainedSessions: 1
    });
    await runtime.close();
  });

  it("returns bounded JSON errors without exposing stack traces for oversized bodies", async () => {
    const runtime = createScoutRuntime(baseConfig(), {
      analyzer: new FakeAnalyzer()
    });
    const response = await request(runtime.app)
      .post("/webhooks/recall/status")
      .set("content-type", "application/json")
      .send(`{"oversized":"${"x".repeat(1_100_000)}"}`)
      .expect(413);

    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.body).toEqual({ error: "request body too large" });
    expect(response.text).not.toContain("raw-body");
    expect(response.text).not.toContain(process.cwd());
    await runtime.close();
  });

  it("rejects live session creation before allocating capacity when dependencies are absent", async () => {
    const runtime = createScoutRuntime(baseConfig({ allowDevIngest: false }), {
      analyzer: new FakeAnalyzer()
    });

    const readiness = await request(runtime.app).get("/readyz").expect(503);
    expect(readiness.body).toMatchObject({
      ok: false,
      mode: "unavailable",
      recall: { ready: false }
    });
    await request(runtime.app)
      .post("/api/sessions")
      .send({ meetingUrl: "https://zoom.example.invalid/j/123" })
      .expect(503);
    expect(runtime.store.list()).toEqual([]);
    await runtime.close();
  });

  it("rolls back a failed Recall bot creation without poisoning session capacity", async () => {
    const recall = new FakeRecall();
    recall.failCreate = true;
    const runtime = createScoutRuntime(
      baseConfig({
        maxActiveSessions: 1,
        publicBaseUrl: "https://scout.example.dev",
        recall: {
          region: "us-west-2",
          apiKey: "test-key",
          apiBaseUrl: "https://us-west-2.recall.ai/api/v1",
          workspaceVerificationSecret: "whsec_workspace",
          statusWebhookSecret: "whsec_status",
          statusWebhookVerificationMode: "svix",
          outputMode: "screenshare",
          requestTimeoutMs: 1_000,
          maxRetries: 0
        }
      }),
      { analyzer: new FakeAnalyzer(), recall, statusRecall: recall }
    );

    await request(runtime.app)
      .post("/api/sessions")
      .send({ meetingUrl: "https://zoom.example.invalid/j/123" })
      .expect(502);
    expect(runtime.store.list()).toEqual([]);

    recall.failCreate = false;
    await request(runtime.app)
      .post("/api/sessions")
      .send({ meetingUrl: "https://zoom.example.invalid/j/456" })
      .expect(201);
    expect(runtime.store.list()).toHaveLength(1);
    await runtime.close();
  });

  it("retains and retires an ambiguously created bot by a non-capability correlation ID", async () => {
    const recall = new FakeRecall();
    recall.ambiguousCreate = true;
    recall.correlationMatches = ["bot-reconciled"];
    const runtime = createScoutRuntime(liveConfig(), {
      analyzer: new FakeAnalyzer(),
      recall,
      statusRecall: recall
    });

    const response = await request(runtime.app)
      .post("/api/sessions")
      .send({ meetingUrl: "https://zoom.example.invalid/j/ambiguous-create" })
      .expect(502);

    expect(response.body).toMatchObject({ cleanupPending: true });
    const sessionId = response.body.sessionId as string;
    const correlationId = recall.createConfig?.correlationId;
    expect(correlationId).toBeTruthy();
    expect(correlationId).not.toBe(sessionId);
    expect(recall.createConfig?.sessionToken).not.toBe(correlationId);
    expect(runtime.store.getRequired(sessionId)).toMatchObject({
      status: "error",
      recall: { status: "error" }
    });

    await runtime.close();
    expect(recall.correlationLookupCalls).toEqual([correlationId]);
    expect(recall.leaveCalls).toEqual(["bot-reconciled"]);
    expect(runtime.store.get(sessionId)).toBeUndefined();
  });

  it("retries an early dashboard status after the create response maps its bot", async () => {
    const recall = new FakeRecall();
    recall.holdCreate = true;
    const runtime = createScoutRuntime(liveConfig(), {
      analyzer: new FakeAnalyzer(),
      recall,
      statusRecall: recall
    });

    const creation = request(runtime.app)
      .post("/api/sessions")
      .send({ meetingUrl: "https://zoom.example.invalid/j/early-status" })
      .then((response) => response);
    await eventually(() => Boolean(recall.createConfig));

    await request(runtime.app)
      .post("/webhooks/recall/status")
      .set("content-type", "application/json")
      .send({ kind: "ended" })
      .expect(503);

    recall.releaseCreate();
    const created = await creation;
    expect(created.status).toBe(201);
    await request(runtime.app)
      .post("/webhooks/recall/status")
      .set("content-type", "application/json")
      .send({ kind: "ended" })
      .expect(204);
    expect(runtime.store.getRequired(created.body.sessionId).status).toBe("ended");
    await runtime.close();
  });

  it("leaves a bot that resolves during shutdown instead of publishing a session", async () => {
    const recall = new FakeRecall();
    recall.holdCreate = true;
    const runtime = createScoutRuntime(liveConfig(), {
      analyzer: new FakeAnalyzer(),
      recall,
      statusRecall: recall
    });
    const creation = request(runtime.app)
      .post("/api/sessions")
      .send({ meetingUrl: "https://zoom.example.invalid/j/shutdown-race" })
      .then((response) => response);
    await eventually(() => Boolean(recall.createConfig));

    const closing = runtime.close();
    recall.releaseCreate();
    const [created] = await Promise.all([creation, closing.then(() => undefined)]);

    expect(created.status).toBe(503);
    expect(recall.leaveCalls).toEqual(["bot-test"]);
    expect(runtime.store.list()).toEqual([]);
  });

  it("fails readiness closed without healthy, resettable dependencies", async () => {
    for (const failure of ["codex", "recall", "throw", "missing-check"] as const) {
      const analyzer = new FakeAnalyzer();
      const recall = new FakeRecall();
      if (failure === "codex") analyzer.readinessReady = false;
      if (failure === "recall") recall.readinessReady = false;
      if (failure === "throw") analyzer.readinessError = new Error("preflight failed");
      const dependency = failure === "missing-check"
        ? ({
            analyze: analyzer.analyze.bind(analyzer),
            resetSession: analyzer.resetSession.bind(analyzer),
            close: analyzer.close.bind(analyzer)
          } as MeetingAnalyzer)
        : analyzer;
      const runtime = createScoutRuntime(liveConfig(), {
        analyzer: dependency,
        recall,
        statusRecall: recall
      });

      await request(runtime.app).get("/readyz").expect(503);
      await request(runtime.app)
        .post("/api/sessions")
        .send({ meetingUrl: "https://zoom.example.invalid/j/not-ready" })
        .expect(503);
      expect(runtime.store.list()).toEqual([]);
      await runtime.close();
    }
  });

  it("bounds runtime close when an integration never settles", async () => {
    const analyzer = new FakeAnalyzer();
    analyzer.holdClose = true;
    const runtime = createScoutRuntime(
      baseConfig({ shutdownGraceMs: 20 }),
      { analyzer }
    );
    const startedAt = performance.now();

    await expect(runtime.close()).rejects.toThrow(/cleanup deadline/);

    expect(performance.now() - startedAt).toBeLessThan(250);
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
        statusWebhookVerificationMode: "svix",
        outputMode: "screenshare",
        requestTimeoutMs: 1_000,
        maxRetries: 0
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
    expect(recall.createConfig?.correlationId).toBeTruthy();
    expect(recall.createConfig?.correlationId).not.toBe(sessionId);
    expect(recall.createConfig?.correlationId).not.toBe(token);
    expect(recall.createConfig?.botName).toMatch(
      /^Live Architect · [A-Za-z0-9_-]{11}$/
    );

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

    runtime.store.upsertParticipant(sessionId, {
      id: "operator-1",
      name: "Morgan"
    });
    await request(runtime.app)
      .put(`/api/sessions/${sessionId}/operator`)
      .send({ participantId: "operator-1" })
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

    const whiteboardId = String(created.body.whiteboardUrl).split("/").at(-1)!;
    expect(whiteboardId).not.toBe(sessionId);
    await request(runtime.app)
      .get(`/api/whiteboards/${sessionId}`)
      .expect(404);
    await request(runtime.app)
      .put(`/api/sessions/${whiteboardId}/operator`)
      .send({ participantId: "operator-1" })
      .expect(404);
    const whiteboard = await request(runtime.app)
      .get(`/api/whiteboards/${whiteboardId}`)
      .expect(200);
    expect(whiteboard.body.id).toBe(whiteboardId);
    expect(whiteboard.body.graph.topic.label).toBe("Billing workflow");
    expect(whiteboard.body.graph.topic).not.toHaveProperty(
      "evidenceUtteranceIds"
    );
    expect(whiteboard.body.graph.nodes[0]).not.toHaveProperty(
      "evidenceUtteranceIds"
    );
    expect(JSON.stringify(whiteboard.body)).not.toContain("utt-live-1");
    expect(whiteboard.body).not.toHaveProperty("meetingUrl");
    expect(whiteboard.body).not.toHaveProperty("participants");
    expect(whiteboard.body).not.toHaveProperty("utterances");
    expect(whiteboard.body).not.toHaveProperty("recall");
    expect(whiteboard.body).not.toHaveProperty("codex");
    await runtime.close();
  });

  it("preserves a fatal Recall terminal state across late finals and done events", async () => {
    const recall = new FakeRecall();
    const runtime = createScoutRuntime(
      baseConfig({
        publicBaseUrl: "https://scout.example.dev",
        recall: {
          region: "us-west-2",
          apiKey: "test-key",
          apiBaseUrl: "https://us-west-2.recall.ai/api/v1",
          workspaceVerificationSecret: "whsec_workspace",
          statusWebhookSecret: "whsec_status",
          statusWebhookVerificationMode: "svix",
          outputMode: "screenshare",
          requestTimeoutMs: 1_000,
          maxRetries: 0
        }
      }),
      { analyzer: new FakeAnalyzer(), recall, statusRecall: recall }
    );
    const created = await request(runtime.app)
      .post("/api/sessions")
      .send({ meetingUrl: "https://zoom.example.invalid/j/123" })
      .expect(201);
    const sessionId = created.body.sessionId as string;
    const token = recall.createConfig?.sessionToken;
    expect(token).toBeTruthy();

    await request(runtime.app)
      .post(`/webhooks/recall/${token}`)
      .set("content-type", "application/json")
      .send({ kind: "fatal" })
      .expect(204);
    await request(runtime.app)
      .post(`/webhooks/recall/${token}`)
      .set("content-type", "application/json")
      .send({ kind: "transcript" })
      .expect(204);
    await request(runtime.app)
      .post("/webhooks/recall/status")
      .set("content-type", "application/json")
      .send({ kind: "ended" })
      .expect(204);

    expect(runtime.store.getRequired(sessionId)).toMatchObject({
      status: "error",
      recall: {
        status: "error",
        detail: expect.stringContaining("recording_permission_denied")
      }
    });
    expect(runtime.store.getRequired(sessionId).utterances).toHaveLength(1);
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

  it("never exposes rehearsal ingest when live Recall mode is configured", async () => {
    const recall = new FakeRecall();
    const runtime = createScoutRuntime(
      liveConfig({ allowDevIngest: true }),
      { analyzer: new FakeAnalyzer(), recall, statusRecall: recall }
    );
    const created = await request(runtime.app)
      .post("/api/sessions")
      .send({ meetingUrl: "https://zoom.example.invalid/j/live" })
      .expect(201);

    await request(runtime.app)
      .post(`/api/dev/sessions/${created.body.sessionId}/utterances`)
      .send({})
      .expect(404);
    await runtime.close();
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
        statusWebhookVerificationMode: "svix",
        outputMode: "screenshare",
        requestTimeoutMs: 1_000,
        maxRetries: 0
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
    runtime.store.upsertParticipant(sessionId, {
      id: "operator-1",
      name: "Morgan"
    });
    await request(runtime.app)
      .put(`/api/sessions/${sessionId}/operator`)
      .send({ participantId: "operator-1" })
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

    recall.onResume = async () => {
      await request(runtime.app)
        .post(`/webhooks/recall/${token}`)
        .set("Content-Type", "application/json")
        .send(JSON.stringify({ kind: "second-transcript" }))
        .expect(204);
    };
    await request(runtime.app)
      .put(`/api/sessions/${sessionId}/processing`)
      .send({ paused: false })
      .expect(200);
    expect(recall.recordingActions).toEqual([
      "pause:bot-test",
      "resume:bot-test"
    ]);
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
        statusWebhookVerificationMode: "svix",
        outputMode: "screenshare",
        requestTimeoutMs: 1_000,
        maxRetries: 0
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

  it("lets one human self-select as operator and rejects bot selection", async () => {
    const runtime = createScoutRuntime(baseConfig(), {
      analyzer: new FakeAnalyzer()
    });
    const created = await request(runtime.app)
      .post("/api/sessions")
      .send({ meetingUrl: "https://zoom.example.invalid/j/123" })
      .expect(201);
    const sessionId = created.body.sessionId as string;
    runtime.store.upsertParticipant(sessionId, {
      id: "person-1",
      name: "Stephen"
    });
    runtime.store.upsertParticipant(sessionId, {
      id: "person-2",
      name: "Maya"
    });
    runtime.store.upsertParticipant(sessionId, {
      id: "bot-1",
      name: "Live Architect",
      isBot: true
    });

    const selected = await request(runtime.app)
      .put(`/api/sessions/${sessionId}/operator`)
      .send({ participantId: "person-1" })
      .expect(200);
    expect(selected.body.operatorParticipantId).toBe("person-1");
    expect(selected.body.participants).toMatchObject([
      { id: "person-1", role: "operator" },
      { id: "person-2", role: "customer" },
      { id: "bot-1", isBot: true }
    ]);

    await request(runtime.app)
      .put(`/api/sessions/${sessionId}/operator`)
      .send({ participantId: "bot-1" })
      .expect(400);
    await request(runtime.app)
      .put(`/api/sessions/${sessionId}/operator`)
      .send({ participantId: "missing" })
      .expect(400);

    const corrected = await request(runtime.app)
      .put(`/api/sessions/${sessionId}/operator`)
      .send({ participantId: "person-2" })
      .expect(200);
    expect(corrected.body.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "person-1", role: "customer" }),
        expect.objectContaining({ id: "person-2", role: "operator" })
      ])
    );
    await runtime.close();
  });

  it("reports and retries a failed Codex quarantine before roles become usable", async () => {
    const analyzer = new FakeAnalyzer();
    const runtime = createScoutRuntime(baseConfig(), { analyzer });
    const created = await request(runtime.app)
      .post("/api/sessions")
      .send({ meetingUrl: "https://zoom.example.invalid/j/reset-failure" })
      .expect(201);
    const sessionId = created.body.sessionId as string;
    runtime.store.upsertParticipant(sessionId, { id: "operator", name: "Morgan" });
    runtime.store.upsertParticipant(sessionId, { id: "customer", name: "Taylor" });
    analyzer.resetError = new Error("quarantine unavailable");

    await request(runtime.app)
      .put(`/api/sessions/${sessionId}/operator`)
      .send({ participantId: "operator" })
      .expect(409);
    expect(runtime.store.getRequired(sessionId).analysis).toMatchObject({
      status: "error",
      blockedReason: expect.stringContaining("Codex reset failed")
    });
    await request(runtime.app)
      .put(`/api/sessions/${sessionId}/operator`)
      .send({ participantId: "operator" })
      .expect(409);

    analyzer.resetError = undefined;
    const recovered = await request(runtime.app)
      .put(`/api/sessions/${sessionId}/operator`)
      .send({ participantId: "operator" })
      .expect(200);
    expect(recovered.body.operatorParticipantId).toBe("operator");
    expect(recovered.body.analysis.status).not.toBe("error");
    await runtime.close();
  });

  it("atomically rebuilds analysis from all finals after operator correction", async () => {
    const analyzer = new FakeAnalyzer();
    const runtime = createScoutRuntime(
      baseConfig({ analysisDelayMs: 10_000, analysisRerunDelayMs: 10_000 }),
      { analyzer }
    );
    const created = await request(runtime.app)
      .post("/api/sessions")
      .send({ meetingUrl: "https://zoom.example.invalid/j/123" })
      .expect(201);
    const sessionId = created.body.sessionId as string;
    runtime.store.upsertParticipant(sessionId, { id: "person-1", name: "Morgan" });
    runtime.store.upsertParticipant(sessionId, { id: "person-2", name: "Taylor" });
    await request(runtime.app)
      .put(`/api/sessions/${sessionId}/operator`)
      .send({ participantId: "person-1" })
      .expect(200);
    for (const [id, participantId, participantName] of [
      ["operator-1", "person-1", "Morgan"],
      ["customer-1", "person-2", "Taylor"]
    ] as const) {
      runtime.store.appendUtterance(sessionId, {
        id,
        sequence: runtime.store.getRequired(sessionId).utterances.length + 1,
        participantId,
        participantName,
        text: `${participantName} described the billing workflow.`,
        startedAt: 1,
        endedAt: 2,
        finalized: true
      });
    }
    await request(runtime.app)
      .post(`/api/sessions/${sessionId}/analyze`)
      .expect(202);
    await eventually(() => runtime.store.getRequired(sessionId).revision === 1);
    expect(
      runtime.store.getRequired(sessionId).graph.nodes[0]?.evidenceUtteranceIds
    ).toEqual(["customer-1"]);

    const corrected = await request(runtime.app)
      .put(`/api/sessions/${sessionId}/operator`)
      .send({ participantId: "person-2" })
      .expect(200);
    expect(corrected.body).toMatchObject({
      revision: 0,
      operatorParticipantId: "person-2",
      utterances: [{ id: "operator-1" }, { id: "customer-1" }],
      graph: { nodes: [] },
      codex: { status: "idle" }
    });

    await request(runtime.app)
      .post(`/api/sessions/${sessionId}/analyze`)
      .expect(202);
    await eventually(() => runtime.store.getRequired(sessionId).revision === 1);
    expect(
      runtime.store.getRequired(sessionId).graph.nodes[0]?.evidenceUtteranceIds
    ).toEqual(["operator-1"]);
    expect(analyzer.resetCalls).toEqual([sessionId, sessionId]);
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
        statusWebhookVerificationMode: "svix",
        outputMode: "screenshare",
        requestTimeoutMs: 1_000,
        maxRetries: 0
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
    runtime.store.upsertParticipant(sessionId, {
      id: "person-1",
      name: "Alex"
    });
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
      topic: {
        id: "billing",
        label: "Billing workflow",
        evidenceUtteranceIds: ["utt-1"]
      }
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
