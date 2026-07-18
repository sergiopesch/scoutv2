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

  it("deduplicates finalized utterances by stable ID", () => {
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
  });
});
