import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/server/session-store.js";

describe("SessionStore", () => {
  it("removes failing subscribers without interrupting canonical updates or peers", () => {
    const store = new SessionStore();
    const session = store.create("https://zoom.example/test", "session-listeners");

    expect(() =>
      store.subscribe(session.id, () => {
        throw new Error("initial listener failed");
      })
    ).toThrow("initial listener failed");

    let failingCalls = 0;
    store.subscribe(session.id, () => {
      failingCalls += 1;
      if (failingCalls > 1) throw new Error("live listener failed");
    });
    const observed: string[] = [];
    store.subscribe(session.id, (snapshot) => observed.push(snapshot.status));

    expect(() => store.setStatus(session.id, "listening")).not.toThrow();
    store.setStatus(session.id, "ended");

    expect(store.getRequired(session.id).status).toBe("ended");
    expect(failingCalls).toBe(2);
    expect(observed).toEqual(["creating", "listening", "ended"]);
  });

  it("atomically replaces the accepted graph and increments the revision", () => {
    const store = new SessionStore();
    const session = store.create("https://zoom.example/test", "session-1");
    const graph = {
      ...session.graph,
      topic: {
        id: "sales",
        label: "Sales workflow",
        evidenceUtteranceIds: ["test-evidence"]
      }
    };

    const updated = store.acceptGraph(session.id, graph);

    expect(updated.revision).toBe(1);
    expect(updated.graph.topic.label).toBe("Sales workflow");
    expect(updated.analysis.status).toBe("idle");
  });

  it("accepts post-call edits as complete revision-checked graph snapshots", () => {
    const store = new SessionStore();
    const session = store.create("https://zoom.example/test", "session-post-call");
    store.setStatus(session.id, "ended");
    const graph = {
      ...session.graph,
      topic: {
        id: "orders",
        label: "Reviewed orders",
        evidenceUtteranceIds: ["utt-1"]
      }
    };

    const edited = store.editPostCall(session.id, 0, graph, "Approved by the delivery team.");
    expect(edited).toMatchObject({
      revision: 1,
      graph: { topic: { label: "Reviewed orders" } },
      postCall: { revision: 1, notes: "Approved by the delivery team." }
    });
    expect(() => store.editPostCall(session.id, 0, graph, "stale"))
      .toThrow("Expected graph revision 0, but revision 1 is current");
    expect(store.rebuild(session.id)).toEqual(edited);
  });

  it("blocks editing before the meeting ends or while final evidence is pending", () => {
    const store = new SessionStore();
    const session = store.create("https://zoom.example/test", "session-post-call-gates");
    expect(() => store.editPostCall(session.id, 0, session.graph, ""))
      .toThrow("only after the meeting ends");
    store.appendUtterance(session.id, {
      id: "utt-1",
      sequence: 1,
      participantId: "customer",
      participantName: "Customer",
      text: "We reconcile orders manually.",
      startedAt: 1,
      endedAt: 2,
      finalized: true
    });
    store.setStatus(session.id, "ended");
    expect(() => store.editPostCall(session.id, 0, session.graph, ""))
      .toThrow("Finish the final analysis");
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

  it("compacts superseded partial history and projects whiteboard updates without transcripts", () => {
    const store = new SessionStore();
    const session = store.create(
      "https://zoom.example/test",
      "session-partial-compaction"
    );
    for (let index = 0; index < 2_000; index += 1) {
      store.appendUtterance(session.id, {
        id: "transcript:person-1:1000:partial",
        sequence: 1_000,
        participantId: "person-1",
        participantName: "Alex",
        text: `Partial update ${index}`,
        startedAt: 1,
        endedAt: 1.5,
        finalized: false
      });
    }
    expect(
      store
        .getEvents(session.id)
        .filter((event) => event.type === "utterance.recorded")
    ).toHaveLength(1);

    let whiteboardPayload: unknown;
    const unsubscribe = store.subscribeWhiteboard(session.id, (snapshot) => {
      whiteboardPayload = snapshot;
    });
    store.appendUtterance(session.id, {
      id: "transcript:person-1:1000:2000:final",
      sequence: 1_000,
      participantId: "person-1",
      participantName: "Alex",
      text: "The finalized attributed utterance.",
      startedAt: 1,
      endedAt: 2,
      finalized: true
    });
    unsubscribe();

    expect(
      store
        .getEvents(session.id)
        .filter(
          (event) =>
            event.type === "utterance.recorded" && !event.utterance.finalized
        )
    ).toHaveLength(0);
    expect(whiteboardPayload).not.toHaveProperty("utterances");
    expect(store.rebuild(session.id)).toEqual(store.getRequired(session.id));
  });

  it("persists participant roles without letting later Recall updates erase them", () => {
    const store = new SessionStore();
    const session = store.create("https://zoom.example/test", "session-roles");

    store.upsertParticipant(session.id, { id: "person-1", name: "Alex" });
    store.setParticipantRole(session.id, "person-1", "customer");
    store.upsertParticipant(session.id, {
      id: "person-1",
      name: "Alex Morgan",
      platform: "zoom"
    });

    expect(store.getRequired(session.id).participants).toEqual([
      {
        id: "person-1",
        name: "Alex Morgan",
        platform: "zoom",
        role: "customer"
      }
    ]);
    expect(store.rebuild(session.id).participants[0]?.role).toBe("customer");
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
    store.upsertParticipant(session.id, {
      id: "person-1",
      name: "Alex"
    });
    store.selectOperator(session.id, "person-1");
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
      topic: {
        id: "billing",
        label: "Billing workflow",
        evidenceUtteranceIds: ["utt-1"]
      },
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
      operatorParticipantId: "person-1",
      participants: [{ id: "person-1", name: "Alex", role: "operator" }],
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

  it("preserves the monotonic role revision across context resets and rebuilds", () => {
    const store = new SessionStore();
    const session = store.create(
      "https://zoom.example/test",
      "session-role-reset"
    );
    for (const id of ["person-1", "person-2", "person-3"]) {
      store.upsertParticipant(session.id, { id, name: id });
    }

    expect(store.selectOperator(session.id, "person-1").roleRevision).toBe(1);
    const corrected = store.selectOperator(session.id, "person-2");
    expect(corrected.roleRevision).toBe(2);

    const reset = store.resetContext(session.id);
    expect(reset.roleRevision).toBe(2);
    expect(reset.updatedAt).toBeGreaterThan(corrected.updatedAt);
    expect(store.rebuild(session.id).roleRevision).toBe(2);
    expect(store.selectOperator(session.id, "person-3").roleRevision).toBe(3);
  });

  it("assigns operator and client roles explicitly and follows a stable rejoin identity", () => {
    const store = new SessionStore();
    const session = store.create(
      "https://zoom.example/test",
      "session-identity"
    );
    store.upsertParticipant(session.id, {
      id: "operator-old",
      name: "Stephen",
      platformIdentity: "zoom:stable-stephen"
    });
    store.upsertParticipant(session.id, {
      id: "client-1",
      name: "Maya"
    });
    store.upsertParticipant(session.id, {
      id: "bot-1",
      name: "Live Architect",
      isBot: true
    });

    const selected = store.selectOperator(session.id, "operator-old");
    expect(selected.operatorParticipantId).toBe("operator-old");
    expect(
      Object.fromEntries(
        selected.participants.map((participant) => [
          participant.id,
          participant.role
        ])
      )
    ).toEqual({
      "operator-old": "operator",
      "client-1": "customer",
      "bot-1": undefined
    });
    expect(() => store.selectOperator(session.id, "bot-1")).toThrow(
      "cannot be selected"
    );

    const rejoined = store.upsertParticipant(session.id, {
      id: "operator-new",
      name: "Stephen",
      platformIdentity: "zoom:stable-stephen"
    });
    expect(rejoined.operatorParticipantId).toBe("operator-new");
    expect(
      rejoined.participants
        .filter((participant) => participant.role === "operator")
        .map((participant) => participant.id)
    ).toEqual(["operator-old", "operator-new"]);
    expect(store.rebuild(session.id)).toEqual(rejoined);
  });

  it("learns a stable identity after selection and follows a later provider rejoin", () => {
    const store = new SessionStore();
    const session = store.create("https://zoom.example/test", "session-late-identity");
    store.upsertParticipant(session.id, { id: "operator-old", name: "Stephen" });
    store.selectOperator(session.id, "operator-old");
    store.upsertParticipant(session.id, {
      id: "operator-old",
      name: "Stephen",
      platformIdentity: "zoom:stable-stephen"
    });
    const rejoined = store.upsertParticipant(session.id, {
      id: "operator-new",
      name: "Stephen",
      platformIdentity: "zoom:stable-stephen",
      present: true
    });

    expect(rejoined.operatorParticipantId).toBe("operator-new");
    expect(store.rebuild(session.id)).toEqual(rejoined);
  });

  it("invalidates a graph but preserves finalized evidence when roles change", () => {
    const store = new SessionStore();
    const session = store.create("https://zoom.example/test", "session-role-change");
    store.upsertParticipant(session.id, { id: "person-1", name: "Morgan" });
    store.upsertParticipant(session.id, { id: "person-2", name: "Taylor" });
    store.selectOperator(session.id, "person-1");
    store.appendUtterance(session.id, {
      id: "utt-1",
      sequence: 1,
      participantId: "person-2",
      participantName: "Taylor",
      text: "We reconcile invoices each Friday.",
      startedAt: 1,
      endedAt: 2,
      finalized: true
    });
    store.setCodex(session.id, { status: "connected", threadId: "thread-1" });
    store.acceptGraph(session.id, {
      ...session.graph,
      topic: {
        id: "billing",
        label: "Billing",
        evidenceUtteranceIds: ["utt-1"]
      },
      nodes: [
        {
          id: "finance",
          kind: "team",
          label: "Finance",
          state: "current",
          confidence: 1,
          evidenceUtteranceIds: ["utt-1"]
        }
      ]
    });

    const corrected = store.selectOperator(session.id, "person-2");

    expect(corrected.roleRevision).toBeGreaterThan(session.roleRevision);
    expect(corrected.revision).toBe(0);
    expect(corrected.graph.nodes).toEqual([]);
    expect(corrected.utterances.map((utterance) => utterance.id)).toEqual(["utt-1"]);
    expect(corrected.analysis.pendingUtteranceCount).toBe(1);
    expect(corrected.codex.status).toBe("idle");
    expect(store.rebuild(session.id)).toEqual(corrected);
  });
});
