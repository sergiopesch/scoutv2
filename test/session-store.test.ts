import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/server/session-store.js";

describe("SessionStore", () => {
  it("atomically replaces the accepted graph and increments the revision", () => {
    const store = new SessionStore();
    const session = store.create("https://zoom.example/test", "session-1");
    const graph = {
      ...session.graph,
      topic: { id: "sales", label: "Sales workflow" }
    };

    const updated = store.acceptGraph(session.id, graph);

    expect(updated.revision).toBe(1);
    expect(updated.graph.topic.label).toBe("Sales workflow");
    expect(updated.analysis.status).toBe("idle");
  });

  it("keeps utterance revisions in the append-only log and rebuilds the projection", () => {
    const store = new SessionStore();
    const session = store.create("https://zoom.example/test", "session-2");
    const utterance = {
      id: "utt-1",
      sequence: 1,
      participantId: "person-1",
      participantName: "Alex",
      text: "Invoices are copied into a spreadsheet.",
      startedAt: 1,
      endedAt: 2,
      finalized: true
    };

    store.appendUtterance(session.id, utterance);
    store.appendUtterance(session.id, {
      ...utterance,
      text: "Invoices are manually copied into a spreadsheet."
    });

    const updated = store.getRequired(session.id);
    expect(updated.utterances).toHaveLength(1);
    expect(updated.utterances[0]?.text).toContain("manually");
    expect(updated.analysis.pendingUtteranceCount).toBe(1);
    expect(
      store
        .getEvents(session.id)
        .filter((event) => event.type === "utterance.recorded")
    ).toHaveLength(2);
    expect(store.rebuild(session.id)).toEqual(updated);

    store.acceptGraph(session.id, updated.graph);
    const redelivered = store.appendUtterance(session.id, utterance);
    expect(redelivered.analysis.pendingUtteranceCount).toBe(0);
  });

  it("returns event copies that cannot rewrite canonical history", () => {
    const store = new SessionStore();
    const session = store.create("https://zoom.example/test", "session-3");
    const events = store.getEvents(session.id);
    if (events[0]?.type === "session.created") {
      events[0].meetingUrl = "https://attacker.example/changed";
    }

    expect(store.getRequired(session.id).meetingUrl).toBe(
      "https://zoom.example/test"
    );
  });

  it("shows a partial immediately and replaces it with the matching final", () => {
    const store = new SessionStore();
    const session = store.create("https://zoom.example/test", "session-partial");
    const partial = {
      id: "transcript-1:person-1:1000:partial",
      sequence: 1_000,
      participantId: "person-1",
      participantName: "Alex",
      text: "We manually",
      startedAt: 1,
      endedAt: 1.4,
      finalized: false
    };

    const interim = store.appendUtterance(session.id, partial);
    expect(interim.utterances).toEqual([partial]);
    expect(interim.analysis.pendingUtteranceCount).toBe(0);

    const final = {
      ...partial,
      id: "transcript-1:person-1:1000:2500:hash",
      text: "We manually copy the invoices.",
      endedAt: 2.5,
      finalized: true
    };
    const completed = store.appendUtterance(session.id, final);
    expect(completed.utterances).toEqual([final]);
    expect(completed.analysis.pendingUtteranceCount).toBe(1);

    const latePartial = store.appendUtterance(session.id, {
      ...partial,
      text: "We manually copy"
    });
    expect(latePartial.utterances).toEqual([final]);
    expect(latePartial.analysis.pendingUtteranceCount).toBe(1);
    expect(store.rebuild(session.id)).toEqual(latePartial);
  });

  it("owns pause state in the event log and makes repeated transitions idempotent", () => {
    const store = new SessionStore();
    const session = store.create("https://zoom.example/test", "session-pause");

    const paused = store.setProcessingPaused(session.id, true);
    const repeated = store.setProcessingPaused(session.id, true);

    expect(paused.processing).toMatchObject({
      paused: true,
      incomingTranscriptPolicy: "discard"
    });
    expect(repeated).toEqual(paused);
    expect(
      store
        .getEvents(session.id)
        .filter((event) => event.type === "processing.paused-set")
    ).toHaveLength(1);
    expect(store.rebuild(session.id)).toEqual(paused);
  });

  it("clears test context atomically while preserving the live meeting", () => {
    const store = new SessionStore();
    const session = store.create("https://zoom.example/test", "session-reset");
    store.setStatus(session.id, "analyzing");
    store.upsertParticipant(session.id, { id: "person-1", name: "Alex" });
    store.setRecall(session.id, {
      status: "active",
      botId: "bot-1",
      detail: "Connected"
    });
    store.appendUtterance(session.id, {
      id: "utt-1",
      sequence: 1,
      participantId: "person-1",
      participantName: "Alex",
      text: "Finance manually copies invoices.",
      startedAt: 1,
      endedAt: 2,
      finalized: true
    });
    store.setCodex(session.id, {
      status: "connected",
      threadId: "thread-old"
    });
    store.setProcessingPaused(session.id, true);
    store.acceptGraph(session.id, {
      ...session.graph,
      topic: { id: "billing", label: "Billing workflow" },
      suggestedQuestion: {
        text: "Who owns this?",
        evidenceUtteranceIds: ["utt-1"]
      }
    });

    const emitted: string[] = [];
    const unsubscribe = store.subscribe(session.id, (snapshot) => {
      emitted.push(`${snapshot.revision}:${snapshot.utterances.length}`);
    });
    const reset = store.resetContext(session.id);
    unsubscribe();

    expect(reset).toMatchObject({
      id: session.id,
      meetingUrl: session.meetingUrl,
      status: "listening",
      revision: 0,
      participants: [{ id: "person-1", name: "Alex" }],
      recall: { status: "active", botId: "bot-1", detail: "Connected" },
      codex: { status: "idle" },
      processing: {
        paused: true,
        incomingTranscriptPolicy: "discard"
      },
      analysis: { status: "idle", pendingUtteranceCount: 0 }
    });
    expect(reset.utterances).toEqual([]);
    expect(reset.graph.nodes).toEqual([]);
    expect(reset.graph.suggestedQuestion).toBeUndefined();
    expect(emitted.at(-1)).toBe("0:0");
    expect(
      store
        .getEvents(session.id)
        .some(
          (event) =>
            event.type === "utterance.recorded" ||
            event.type === "graph.accepted" ||
            event.type === "codex.state-set"
        )
    ).toBe(false);
    expect(store.getEvents(session.id).at(-1)?.type).toBe(
      "session.context-reset"
    );
  });
});
