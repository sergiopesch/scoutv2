import { once } from "node:events";
import type { AddressInfo } from "node:net";
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

const config: AppConfig = {
  port: 0,
  host: "127.0.0.1",
  analysisDelayMs: 1_000,
  analysisRerunDelayMs: 500,
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
  }
};

class IdleAnalyzer implements MeetingAnalyzer {
  async analyze(input: AnalyzeMeetingInput) {
    return { threadId: input.threadId ?? "thread-test", graph: input.currentGraph };
  }

  async close(): Promise<void> {}

  async resetSession(): Promise<void> {}

  async checkReadiness() {
    return { ready: true };
  }
}

class LifecycleRecall implements RecallAdapter {
  readonly leaveCalls: string[] = [];
  holdLeave = false;
  failLeaveCount = 0;
  private releaseHeldLeave?: () => void;

  async createBot(_config: RecallBotConfig) {
    return { botId: "bot-lifecycle" };
  }

  async pauseRecording(): Promise<void> {}
  async resumeRecording(): Promise<void> {}

  async leaveBot(botId: string): Promise<void> {
    this.leaveCalls.push(botId);
    if (this.failLeaveCount > 0) {
      this.failLeaveCount -= 1;
      throw new Error("temporary leave failure");
    }
    if (this.holdLeave) {
      await new Promise<void>((resolve) => {
        this.releaseHeldLeave = resolve;
      });
    }
  }

  releaseLeave(): void {
    this.releaseHeldLeave?.();
  }

  async checkReadiness() {
    return { ready: true };
  }

  verifyWebhook(): void {}
  normalizeEvent(): NormalizedMeetingEvent[] {
    return [];
  }
}

const eventually = async (check: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected lifecycle state was not reached.");
};

describe("Scout server lifecycle", () => {
  it("retains bot ownership and retries retirement after a leave failure", async () => {
    const recall = new LifecycleRecall();
    recall.failLeaveCount = 1;
    const runtime = createScoutRuntime(
      { ...config, sessionRetentionMs: 20, shutdownGraceMs: 500 },
      { analyzer: new IdleAnalyzer(), recall }
    );
    const session = runtime.store.create(
      "https://zoom.example.invalid/j/retire-retry",
      "session-retire-retry"
    );
    runtime.store.setRecall(session.id, {
      status: "idle",
      botId: "bot-lifecycle"
    });
    runtime.store.setStatus(session.id, "ended");

    await eventually(() => recall.leaveCalls.length >= 1);
    expect(runtime.store.get(session.id)).toBeDefined();
    await eventually(() => recall.leaveCalls.length >= 2);
    await eventually(() => runtime.store.get(session.id) === undefined);

    await runtime.close();
    expect(recall.leaveCalls).toEqual(["bot-lifecycle", "bot-lifecycle"]);
  });

  it("retries a transient Recall leave failure during graceful shutdown", async () => {
    const recall = new LifecycleRecall();
    recall.failLeaveCount = 1;
    const runtime = createScoutRuntime(
      { ...config, shutdownGraceMs: 500 },
      { analyzer: new IdleAnalyzer(), recall }
    );
    const session = runtime.store.create(
      "https://zoom.example.invalid/j/shutdown-retry",
      "session-shutdown-retry"
    );
    runtime.store.setRecall(session.id, {
      status: "idle",
      botId: "bot-lifecycle"
    });

    await runtime.close();

    expect(recall.leaveCalls).toEqual(["bot-lifecycle", "bot-lifecycle"]);
    expect(runtime.store.get(session.id)).toBeUndefined();
  });

  it("rejects SSE connections beyond the configured per-session limit", async () => {
    const runtime = createScoutRuntime(
      { ...config, maxSseConnections: 1, maxSseConnectionsPerSession: 1 },
      { analyzer: new IdleAnalyzer() }
    );
    const session = runtime.store.create(
      "https://zoom.example.invalid/j/sse-limit",
      "session-sse-limit"
    );
    const server = runtime.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const first = await fetch(
      `http://127.0.0.1:${address.port}/events/${session.id}`
    );
    const reader = first.body!.getReader();
    await reader.read();

    const second = await fetch(
      `http://127.0.0.1:${address.port}/events/${session.id}`
    );
    expect(second.status).toBe(429);

    await reader.cancel();
    await runtime.close();
    const serverClosed = once(server, "close");
    server.close();
    await serverClosed;
  });

  it("ends live SSE responses when the runtime drains", async () => {
    const runtime = createScoutRuntime(config, { analyzer: new IdleAnalyzer() });
    const session = runtime.store.create(
      "https://zoom.example.invalid/j/123",
      "session-sse-shutdown"
    );
    const server = runtime.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;

    const response = await fetch(
      `http://127.0.0.1:${address.port}/events/${session.id}`
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("event: session");

    await runtime.close();
    const completed = await Promise.race([
      reader.read().then((chunk) => chunk.done),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000))
    ]);
    expect(completed).toBe(true);

    const serverClosed = once(server, "close");
    server.close();
    await serverClosed;
  });

  it("closes retained-session streams and retires a bot exactly once", async () => {
    const recall = new LifecycleRecall();
    recall.holdLeave = true;
    const runtime = createScoutRuntime(
      { ...config, sessionRetentionMs: 20, shutdownGraceMs: 500 },
      { analyzer: new IdleAnalyzer(), recall }
    );
    const session = runtime.store.create(
      "https://zoom.example.invalid/j/retention",
      "session-sse-retention"
    );
    runtime.store.setRecall(session.id, {
      status: "idle",
      botId: "bot-lifecycle"
    });
    runtime.store.setStatus(session.id, "ended");
    const server = runtime.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/events/${session.id}`
    );
    const reader = response.body!.getReader();
    await reader.read();

    await eventually(() => recall.leaveCalls.length === 1);
    expect(runtime.store.get(session.id)).toBeDefined();
    const ended = await Promise.race([
      reader.read().then((chunk) => chunk.done),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 500))
    ]);
    expect(ended).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 60));
    const closing = runtime.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(recall.leaveCalls).toEqual(["bot-lifecycle"]);
    recall.releaseLeave();
    await closing;
    expect(runtime.store.get(session.id)).toBeUndefined();
    expect(recall.leaveCalls).toEqual(["bot-lifecycle"]);

    const serverClosed = once(server, "close");
    server.close();
    await serverClosed;
  });
});
