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
    nodes: [{
      id: "allocation",
      kind: "process",
      label: "Allocate orders",
      state: "current",
      scope: "current",
      certainty: "asserted",
      confidence: 1,
      evidenceUtteranceIds: ["utt-1"]
    }],
    edges: [],
    pains: [],
    contradictions: [],
    suggestedQuestion: {
      text: "Which allocation constraint causes the most delay?",
      evidenceUtteranceIds: ["utt-1"]
    }
  });
  store.setStatus(session.id, "ended");
  store.editPostCall(
    session.id,
    1,
    store.getRequired(session.id).graph,
    "Prioritize allocation latency.",
    {
      allocation: {
        targetType: "node",
        disposition: "unsupported",
        note: "The reviewer could not validate this step."
      }
    }
  );
  return store.getRequired(session.id);
};

describe("Codex handoff package", () => {
  it("keeps evidence, curated semantics, outcomes and orchestration explicit", () => {
    const handoff = buildCodexHandoffPackage(endedSession());
    expect(handoff.evidence.transcript).toHaveLength(1);
    expect(handoff).not.toHaveProperty("sessionId");
    expect(handoff.evidence.transcript[0]).not.toHaveProperty("participantId");
    expect(handoff.diagrams.views).toHaveLength(3);
    expect(handoff.review.annotations).toEqual({
      allocation: {
        targetType: "node",
        disposition: "unsupported",
        note: "The reviewer could not validate this step."
      }
    });
    expect(handoff.review).not.toHaveProperty("intervention");
    expect(handoff.outcomes.map((outcome) => outcome.title)).toEqual([
      "Process improvement design",
      "Integrated delivery plan"
    ]);
    expect(handoff.orchestration.tasks).toHaveLength(2);
    expect(handoff.orchestration.lead.objective).toContain("2 evidence-led Codex work tasks");
    expect(handoff.orchestration.operatingRules.join(" ")).toContain(
      "do not create runtime subagents"
    );
    expect(handoff.orchestration.tasks.every((task) => task.model === "gpt-5.6-sol")).toBe(true);
  });

  it("adds the selected intervention without changing legacy handoff fields", () => {
    const snapshot = endedSession();
    snapshot.graph.pains = [{
      id: "manual-allocation",
      description: "Orders are re-keyed before allocation",
      targetNodeIds: ["allocation"],
      severity: "high",
      state: "current",
      evidenceUtteranceIds: ["utt-1"]
    }];
    snapshot.postCall.intervention = {
      painId: "manual-allocation",
      desiredOutcome: "Remove duplicate entry",
      proposal: "Add a bounded allocation adapter",
      constraints: ["Keep the current process available"],
      acceptanceCriteria: ["One order requires one entry"],
      nonGoals: ["Replace allocation"],
      decision: "approved_for_build"
    };

    const handoff = buildCodexHandoffPackage(snapshot);
    expect(handoff.review.intervention).toEqual(
      snapshot.postCall.intervention
    );
    expect(handoff.orchestration.tasks).toHaveLength(3);
    expect(handoff.orchestration.tasks.at(-1)).toMatchObject({
      id: "implementation-slice",
      dependsOn: ["delivery-plan"],
      objective: "Add a bounded allocation adapter",
      plugins: []
    });
    expect(handoff.orchestration.tasks.at(-1)?.doneWhen).toEqual(
      expect.arrayContaining([
        "Constraint: Keep the current process available",
        "Acceptance criterion: One order requires one entry",
        "Must not: Replace allocation"
      ])
    );
    expect(handoff.outcomes.at(-1)).toMatchObject({
      id: "implementation-slice",
      title: "Authorized implementation slice"
    });
  });

  it("does not add an implementation task for a candidate intervention", () => {
    const snapshot = endedSession();
    snapshot.postCall.intervention = {
      painId: "manual-allocation",
      desiredOutcome: "Remove duplicate entry",
      proposal: "Add a bounded allocation adapter",
      constraints: ["Keep the current process available"],
      acceptanceCriteria: ["One order requires one entry"],
      nonGoals: ["Replace allocation"],
      decision: "candidate"
    };

    const handoff = buildCodexHandoffPackage(snapshot);
    expect(handoff.orchestration.tasks.map((task) => task.id)).toEqual([
      "process-design",
      "delivery-plan"
    ]);
  });

  it("writes a private local project and opens the supported Codex deep-link contract", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scout-handoff-test-"));
    const prepared = await writeCodexHandoffProject(root, endedSession());
    expect(prepared.files).toEqual([
      "README.md",
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
      .toContain("codex-launch.json");
    expect(await readFile(path.join(prepared.directory, "SCOUT_CONTEXT.md"), "utf8"))
      .toContain("untrusted customer data");
    expect(await readFile(path.join(prepared.directory, "SCOUT_CONTEXT.md"), "utf8"))
      .toContain("unsupported items remain historical evidence");
    expect(JSON.parse(await readFile(path.join(prepared.directory, "manifest.json"), "utf8")))
      .toMatchObject({ algorithm: "sha256", graphRevision: 2, reviewRevision: 1 });
    expect((await stat(prepared.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(prepared.directory, "transcript.md"))).mode & 0o777).toBe(0o600);
    const deepLink = new URL(prepared.launchUrl);
    expect(deepLink.protocol).toBe("codex:");
    expect(deepLink.searchParams.get("path")).toBe(prepared.directory);
    expect(deepLink.searchParams.get("prompt")).toContain("2 named outcomes");
  });

  it("writes the approved build brief and includes it in the manifest", async () => {
    const snapshot = endedSession();
    snapshot.postCall.intervention = {
      painId: "manual-allocation",
      desiredOutcome: "Remove duplicate entry",
      proposal: "Add a bounded allocation adapter",
      constraints: ["Keep the current process available"],
      acceptanceCriteria: ["One order requires one entry"],
      nonGoals: ["Replace allocation"],
      decision: "approved_for_build"
    };
    const root = await mkdtemp(path.join(os.tmpdir(), "scout-handoff-test-"));
    const prepared = await writeCodexHandoffProject(root, snapshot);

    expect(prepared.files).toContain("BUILD_BRIEF.md");
    expect(await readFile(path.join(prepared.directory, "BUILD_BRIEF.md"), "utf8"))
      .toContain("Add a bounded allocation adapter");
    const manifest = JSON.parse(
      await readFile(path.join(prepared.directory, "manifest.json"), "utf8")
    );
    expect(manifest.files).toHaveProperty("BUILD_BRIEF.md");
  });

  it("keeps the legacy project file set when no intervention is present", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scout-handoff-test-"));
    const prepared = await writeCodexHandoffProject(root, endedSession());

    expect(prepared.files).not.toContain("BUILD_BRIEF.md");
    const manifest = JSON.parse(
      await readFile(path.join(prepared.directory, "manifest.json"), "utf8")
    );
    expect(manifest.files).not.toHaveProperty("BUILD_BRIEF.md");
  });

  it("keeps candidate project files and manifest on the legacy contract", async () => {
    const snapshot = endedSession();
    snapshot.postCall.intervention = {
      painId: "manual-allocation",
      desiredOutcome: "Remove duplicate entry",
      proposal: "Add a bounded allocation adapter",
      constraints: ["Keep the current process available"],
      acceptanceCriteria: ["One order requires one entry"],
      nonGoals: ["Replace allocation"],
      decision: "candidate"
    };
    const root = await mkdtemp(path.join(os.tmpdir(), "scout-handoff-test-"));
    const prepared = await writeCodexHandoffProject(root, snapshot);
    const manifest = JSON.parse(
      await readFile(path.join(prepared.directory, "manifest.json"), "utf8")
    );

    expect(prepared.files).not.toContain("BUILD_BRIEF.md");
    expect(manifest.files).not.toHaveProperty("BUILD_BRIEF.md");
  });

  it("encodes paths and prompts without concatenating unsafe query text", () => {
    const link = new URL(codexDeepLink("/tmp/customer & vision", "Read #1 & proceed"));
    expect(link.searchParams.get("path")).toBe("/tmp/customer & vision");
    expect(link.searchParams.get("prompt")).toBe("Read #1 & proceed");
  });
});
