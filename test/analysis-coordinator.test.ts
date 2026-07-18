import { describe, expect, it } from "vitest";
import { AnalysisCoordinator } from "../src/server/analysis-coordinator.js";
import type {
  AnalyzeMeetingInput,
  AnalyzeMeetingResult,
  MeetingAnalyzer
} from "../src/server/contracts.js";
import { SessionStore } from "../src/server/session-store.js";

class FakeAnalyzer implements MeetingAnalyzer {
  readonly calls: AnalyzeMeetingInput[] = [];

  async analyze(input: AnalyzeMeetingInput): Promise<AnalyzeMeetingResult> {
    this.calls.push(input);
    return {
      threadId: input.threadId ?? "thread-1",
      graph: {
        ...input.currentGraph,
        topic: { id: "billing", label: "Billing workflow" },
        nodes: [
          {
            id: "finance",
            kind: "team",
            label: "Finance",
            state: "current",
            confidence: 0.95,
            evidenceUtteranceIds: input.newUtterances.map((item) => item.id)
          }
        ]
      }
    };
  }

  async close(): Promise<void> {}
}

const addUtterance = (store: SessionStore, sessionId: string, id: string) => {
  store.appendUtterance(sessionId, {
    id,
    sequence: Number(id.replace(/\D/g, "")) || 1,
    participantId: "person-1",
    participantName: "Alex",
    text: "Finance manually copies invoices into a spreadsheet.",
    startedAt: 1,
    endedAt: 2,
    finalized: true
  });
};

describe("AnalysisCoordinator", () => {
  it("sends only new finalized utterances and accepts a full snapshot", async () => {
    const store = new SessionStore();
    const analyzer = new FakeAnalyzer();
    const coordinator = new AnalysisCoordinator(store, analyzer, 1);
    const session = store.create("https://zoom.example/test", "session-1");

    addUtterance(store, session.id, "utt-1");
    await coordinator.analyzeNow(session.id);
    addUtterance(store, session.id, "utt-2");
    await coordinator.analyzeNow(session.id);

    expect(analyzer.calls).toHaveLength(2);
    expect(analyzer.calls[0]?.newUtterances.map((item) => item.id)).toEqual([
      "utt-1"
    ]);
    expect(analyzer.calls[1]?.newUtterances.map((item) => item.id)).toEqual([
      "utt-2"
    ]);
    expect(store.getRequired(session.id).revision).toBe(2);
  });

  it("does not analyze when no finalized utterance is pending", async () => {
    const store = new SessionStore();
    const analyzer = new FakeAnalyzer();
    const coordinator = new AnalysisCoordinator(store, analyzer, 1);
    const session = store.create("https://zoom.example/test", "session-2");

    await coordinator.analyzeNow(session.id);

    expect(analyzer.calls).toHaveLength(0);
  });
});
