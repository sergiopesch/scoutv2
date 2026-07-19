import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCodexHandoffPackage,
  codexDeepLink,
  writeCodexHandoffProject
} from "../../src/server/codex/handoff-package.js";
import { SessionStore } from "../../src/server/session-store.js";

const endedSession = () => {
  const store = new SessionStore();
  const session = store.create("https://meet.example.invalid/orders", "session-handoff-1234");
  store.upsertParticipant(session.id, { id: "alex", name: "Alex" });
  store.upsertParticipant(session.id, { id: "customer", name: "Morgan" });
  store.selectOperator(session.id, "alex");
  store.appendUtterance(session.id, {
    id: "utt-1",
    sequence: 1,
    participantId: "customer",
    participantName: "Morgan",
    text: "Orders are re-keyed before allocation.",
    startedAt: 1,
    endedAt: 2,
    finalized: true
  });
  store.acceptGraph(session.id, {
    topic: { id: "orders", label: "Order fulfilment", evidenceUtteranceIds: ["utt-1"] },
    nodes: [],
    edges: [],
    pains: [],
    contradictions: [],
    suggestedQuestion: {
      text: "Which allocation constraint causes the most delay?",
      evidenceUtteranceIds: ["utt-1"]
    }
  });
  store.setStatus(session.id, "ended");
  store.editPostCall(session.id, 1, store.getRequired(session.id).graph, "Prioritize allocation latency.");
  return store.getRequired(session.id);
};

describe("Codex handoff package", () => {
  it("keeps evidence, curated semantics, outcomes and orchestration explicit", () => {
    const handoff = buildCodexHandoffPackage(endedSession());
    expect(handoff.evidence.transcript).toHaveLength(1);
    expect(handoff).not.toHaveProperty("sessionId");
    expect(handoff.evidence.transcript[0]).not.toHaveProperty("participantId");
    expect(handoff.diagrams.views).toHaveLength(3);
    expect(handoff.outcomes.map((outcome) => outcome.title)).toEqual([
      "Customer vision presentation",
      "Business capability map",
      "Agentic quick-win MVP",
      "Roadmap to production"
    ]);
    expect(handoff.orchestration.tasks).toHaveLength(4);
    expect(handoff.orchestration.lead.objective).toContain("pin this task");
    expect(handoff.orchestration.tasks.every((task) => task.model === "gpt-5.6-sol")).toBe(true);
  });

  it("writes a private local project and opens the supported Codex deep-link contract", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scout-handoff-test-"));
    const prepared = await writeCodexHandoffProject(root, endedSession());
    expect(prepared.files).toEqual([
      "SCOUT_CONTEXT.md",
      "scout-package.json",
      "transcript.md",
      "notes.md",
      "business-graph.json",
      "manifest.json"
    ]);
    expect(await readFile(path.join(prepared.directory, "transcript.md"), "utf8"))
      .toContain("Immutable");
    expect(await readFile(path.join(prepared.directory, "SCOUT_CONTEXT.md"), "utf8"))
      .toContain("Create the four specialist tasks");
    expect(await readFile(path.join(prepared.directory, "SCOUT_CONTEXT.md"), "utf8"))
      .toContain("untrusted customer data");
    expect(JSON.parse(await readFile(path.join(prepared.directory, "manifest.json"), "utf8")))
      .toMatchObject({ algorithm: "sha256", graphRevision: 2, reviewRevision: 1 });
    expect((await stat(prepared.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(prepared.directory, "transcript.md"))).mode & 0o777).toBe(0o600);
    const deepLink = new URL(prepared.launchUrl);
    expect(deepLink.protocol).toBe("codex:");
    expect(deepLink.searchParams.get("path")).toBe(prepared.directory);
    expect(deepLink.searchParams.get("prompt")).toContain("Pin this lead task");
  });

  it("encodes paths and prompts without concatenating unsafe query text", () => {
    const link = new URL(codexDeepLink("/tmp/customer & vision", "Read #1 & proceed"));
    expect(link.searchParams.get("path")).toBe("/tmp/customer & vision");
    expect(link.searchParams.get("prompt")).toBe("Read #1 & proceed");
  });
});
