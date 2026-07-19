import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/config.js";
import type { AnalyzeMeetingInput, MeetingAnalyzer } from "../src/server/contracts.js";
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
  codex: { binary: "codex", model: "gpt-5.6-sol", reasoningEffort: "low" }
};

class IdleAnalyzer implements MeetingAnalyzer {
  async analyze(input: AnalyzeMeetingInput) {
    return { threadId: input.threadId ?? "thread", graph: input.currentGraph };
  }
  async close(): Promise<void> {}
  async resetSession(): Promise<void> {}
  async checkReadiness() { return { ready: true }; }
}

const prepareEndedSession = (runtime: ReturnType<typeof createScoutRuntime>) => {
  const session = runtime.store.create(
    "https://meet.example.invalid/post-call",
    "session-post-call-runtime"
  );
  runtime.store.upsertParticipant(session.id, { id: "operator", name: "Scout" });
  runtime.store.upsertParticipant(session.id, { id: "customer", name: "Morgan" });
  runtime.store.selectOperator(session.id, "operator");
  runtime.store.appendUtterance(session.id, {
    id: "utt-1",
    sequence: 1,
    participantId: "customer",
    participantName: "Morgan",
    text: "The orders API sends allocations to the warehouse.",
    startedAt: 1,
    endedAt: 2,
    finalized: true
  });
  runtime.store.acceptGraph(session.id, {
    topic: { id: "orders", label: "Order fulfilment", evidenceUtteranceIds: ["utt-1"] },
    nodes: [{
      id: "orders-api",
      kind: "system",
      label: "Orders API",
      state: "current",
      scope: "current",
      certainty: "asserted",
      confidence: 1,
      facets: { architecture: { kind: "api" } },
      evidenceUtteranceIds: ["utt-1"]
    }],
    edges: [],
    pains: [],
    contradictions: []
  });
  runtime.store.setStatus(session.id, "ended");
  return runtime.store.getRequired(session.id);
};

describe("post-call review and Codex handoff routes", () => {
  it("serves and atomically saves a complete evidence-valid review snapshot", async () => {
    const runtime = createScoutRuntime(config, { analyzer: new IdleAnalyzer() });
    const snapshot = prepareEndedSession(runtime);

    const review = await request(runtime.app).get(`/api/reviews/${snapshot.id}`);
    expect(review.status).toBe(200);
    expect(review.body).toMatchObject({ postCallReady: true, revision: 1 });

    const graph = structuredClone(snapshot.graph);
    graph.nodes[0]!.label = "Reviewed Orders API";
    const saved = await request(runtime.app)
      .put(`/api/reviews/${snapshot.id}`)
      .send({ expectedRevision: 1, graph, notes: "Confirmed after the call." });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      revision: 2,
      graph: { nodes: [{ label: "Reviewed Orders API" }] },
      postCall: { revision: 1, notes: "Confirmed after the call." }
    });

    const stale = await request(runtime.app)
      .put(`/api/reviews/${snapshot.id}`)
      .send({ expectedRevision: 1, graph, notes: "Stale" });
    expect(stale.status).toBe(409);
    expect(stale.body.current.revision).toBe(2);
    await runtime.close();
  });

  it("rejects unknown or non-customer evidence in human edits", async () => {
    const runtime = createScoutRuntime(config, { analyzer: new IdleAnalyzer() });
    const snapshot = prepareEndedSession(runtime);
    const graph = structuredClone(snapshot.graph);
    graph.nodes[0]!.evidenceUtteranceIds = ["unknown-utterance"];
    const response = await request(runtime.app)
      .put(`/api/reviews/${snapshot.id}`)
      .send({ expectedRevision: 1, graph, notes: "" });
    expect(response.status).toBe(422);
    expect(response.body.issues.join(" ")).toContain("unknown utterance");
    await runtime.close();
  });

  it("previews and downloads the reviewed machine-readable Codex package", async () => {
    const runtime = createScoutRuntime(config, { analyzer: new IdleAnalyzer() });
    const snapshot = prepareEndedSession(runtime);
    const blocked = await request(runtime.app).get(`/api/handoffs/${snapshot.id}`);
    expect(blocked.body).toMatchObject({ ready: false });
    expect(blocked.body).not.toHaveProperty("package");
    const approved = await request(runtime.app)
      .put(`/api/reviews/${snapshot.id}`)
      .send({ expectedRevision: snapshot.revision, graph: snapshot.graph, notes: "Approved." });
    expect(approved.status).toBe(200);
    const preview = await request(runtime.app).get(`/api/handoffs/${snapshot.id}`);
    expect(preview.status).toBe(200);
    expect(preview.body.ready).toBe(true);
    expect(preview.body.package.orchestration.tasks).toHaveLength(4);

    const download = await request(runtime.app).get(
      `/api/handoffs/${snapshot.id}/download`
    );
    expect(download.status).toBe(200);
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(download.body.schemaVersion).toBe("1.0");
    await runtime.close();
  });

  it("prepares only the exact reviewed revision in an isolated local workspace", async () => {
    const handoffRootDir = await mkdtemp(path.join(os.tmpdir(), "scout-runtime-handoff-"));
    const runtime = createScoutRuntime(config, {
      analyzer: new IdleAnalyzer(),
      handoffRootDir
    });
    const snapshot = prepareEndedSession(runtime);
    const approved = await request(runtime.app)
      .put(`/api/reviews/${snapshot.id}`)
      .send({ expectedRevision: snapshot.revision, graph: snapshot.graph, notes: "Approved." });
    const stale = await request(runtime.app)
      .post(`/api/handoffs/${snapshot.id}/prepare`)
      .send({ expectedGraphRevision: snapshot.revision, expectedReviewRevision: 0 });
    expect(stale.status).toBe(409);
    const prepared = await request(runtime.app)
      .post(`/api/handoffs/${snapshot.id}/prepare`)
      .send({
        expectedGraphRevision: approved.body.revision,
        expectedReviewRevision: approved.body.postCall.revision
      });
    expect(prepared.status).toBe(201);
    expect(prepared.body.directory.startsWith(handoffRootDir)).toBe(true);
    expect(prepared.body.files).toContain("manifest.json");
    expect(prepared.body).not.toHaveProperty("package");
    await runtime.close();
    await rm(handoffRootDir, { recursive: true, force: true });
  });

  it("keeps review and handoff gated until the meeting is terminal", async () => {
    const runtime = createScoutRuntime(config, { analyzer: new IdleAnalyzer() });
    const session = runtime.store.create(
      "https://meet.example.invalid/live",
      "session-live-review-gate"
    );
    const preview = await request(runtime.app).get(`/api/handoffs/${session.id}`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ ready: false });
    const save = await request(runtime.app)
      .put(`/api/reviews/${session.id}`)
      .send({ expectedRevision: 0, graph: session.graph, notes: "" });
    expect(save.status).toBe(409);
    await runtime.close();
  });

  it("locks participant attribution after the meeting becomes reviewable", async () => {
    const runtime = createScoutRuntime(config, { analyzer: new IdleAnalyzer() });
    const snapshot = prepareEndedSession(runtime);
    const response = await request(runtime.app)
      .put(`/api/sessions/${snapshot.id}/operator`)
      .send({ participantId: "customer" });
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("locked after the meeting ends");
    await runtime.close();
  });
});
