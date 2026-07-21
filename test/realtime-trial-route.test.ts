import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/config.js";
import type { MeetingAnalyzer } from "../src/server/contracts.js";
import { createScoutRuntime } from "../src/server/index.js";
import type { RealtimeTrialAdapter } from "../src/server/realtime/index.js";

const config: AppConfig = {
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
  codex: { binary: "codex", model: "gpt-5.6-sol", reasoningEffort: "low" }
};

const analyzer: MeetingAnalyzer = {
  async analyze(input) {
    return { threadId: input.threadId ?? "thread-test", graph: input.currentGraph };
  },
  async close() {}
};

describe("public Realtime trial route", () => {
  it("validates and brokers a browser SDP offer", async () => {
    const createCall = vi.fn(async ({ sdp }) => ({
      sdp: sdp.replace("offer", "answer"),
      callId: "call-test"
    }));
    const realtimeTrial: RealtimeTrialAdapter = { createCall };
    const runtime = createScoutRuntime(config, { analyzer, realtimeTrial });
    const offer = `v=0\r\n${"a=offer-line\r\n".repeat(4)}`;

    try {
      const response = await request(runtime.app)
        .post("/api/trial/realtime")
        .set("Content-Type", "application/sdp")
        .send(offer)
        .expect(201)
        .expect("Content-Type", /application\/sdp/);

      expect(response.text).toContain("answer-line");
      expect(response.headers["x-scout-trial-id"]).toBeTruthy();
      expect(response.headers["x-scout-call-id"]).toBe("call-test");
      expect(createCall).toHaveBeenCalledWith(
        expect.objectContaining({
          sdp: offer,
          safetyIdentifier: expect.stringMatching(/^scout-trial-/)
        })
      );

      await request(runtime.app)
        .post(`/api/trial/realtime/${response.headers["x-scout-trial-id"]}/end`)
        .expect(204);
    } finally {
      await runtime.close();
    }
  });

  it("rejects malformed SDP without calling OpenAI", async () => {
    const realtimeTrial: RealtimeTrialAdapter = { createCall: vi.fn() };
    const runtime = createScoutRuntime(config, { analyzer, realtimeTrial });
    try {
      await request(runtime.app)
        .post("/api/trial/realtime")
        .set("Content-Type", "application/sdp")
        .send("not-an-offer")
        .expect(400);
      expect(realtimeTrial.createCall).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });
});
