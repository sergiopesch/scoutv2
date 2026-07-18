import { afterEach, describe, expect, it, vi } from "vitest";
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
    return resultFor(input);
  }

  async close(): Promise<void> {}
}

class BlockingAnalyzer implements MeetingAnalyzer {
  readonly calls: AnalyzeMeetingInput[] = [];
  private releaseFirstCall?: () => void;
  private readonly firstCallGate = new Promise<void>((resolve) => {
    this.releaseFirstCall = resolve;
  });

  async analyze(input: AnalyzeMeetingInput): Promise<AnalyzeMeetingResult> {
    this.calls.push(input);
    if (this.calls.length === 1) await this.firstCallGate;
    return resultFor(input);
  }

  releaseFirst(): void {
    this.releaseFirstCall?.();
  }

  async close(): Promise<void> {}
}

const resultFor = (input: AnalyzeMeetingInput): AnalyzeMeetingResult => ({
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
});

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

afterEach(() => {
  vi.useRealTimers();
});

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

  it("starts from one finalized utterance after the leading-edge delay", async () => {
    vi.useFakeTimers();
    const store = new SessionStore();
    const analyzer = new FakeAnalyzer();
    const coordinator = new AnalysisCoordinator(store, analyzer, 1_500, 500);
    const session = store.create("https://zoom.example/test", "session-one");

    addUtterance(store, session.id, "utt-1");
    coordinator.schedule(session.id);

    await vi.advanceTimersByTimeAsync(1_499);
    expect(analyzer.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(analyzer.calls).toHaveLength(1);
    expect(analyzer.calls[0]?.newUtterances.map((item) => item.id)).toEqual([
      "utt-1"
    ]);
    await coordinator.close();
  });

  it("batches finals that arrive before the fixed leading deadline", async () => {
    vi.useFakeTimers();
    const store = new SessionStore();
    const analyzer = new FakeAnalyzer();
    const coordinator = new AnalysisCoordinator(store, analyzer, 1_500, 500);
    const session = store.create("https://zoom.example/test", "session-batch");

    for (const id of ["utt-1", "utt-2", "utt-3"]) {
      addUtterance(store, session.id, id);
      coordinator.schedule(session.id);
    }
    await vi.advanceTimersByTimeAsync(1_500);

    expect(analyzer.calls).toHaveLength(1);
    expect(analyzer.calls[0]?.newUtterances.map((item) => item.id)).toEqual([
      "utt-1",
      "utt-2",
      "utt-3"
    ]);
    await coordinator.close();
  });

  it("cannot be starved by a continuous stream of finalized fragments", async () => {
    vi.useFakeTimers();
    const store = new SessionStore();
    const analyzer = new FakeAnalyzer();
    const coordinator = new AnalysisCoordinator(store, analyzer, 1_500, 500);
    const session = store.create(
      "https://zoom.example/test",
      "session-continuous"
    );

    addUtterance(store, session.id, "utt-1");
    coordinator.schedule(session.id);
    for (const id of ["utt-2", "utt-3", "utt-4"]) {
      await vi.advanceTimersByTimeAsync(400);
      addUtterance(store, session.id, id);
      coordinator.schedule(session.id);
    }
    await vi.advanceTimersByTimeAsync(299);
    addUtterance(store, session.id, "utt-5");
    coordinator.schedule(session.id);

    expect(analyzer.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(analyzer.calls).toHaveLength(1);
    expect(analyzer.calls[0]?.newUtterances.map((item) => item.id)).toEqual([
      "utt-1",
      "utt-2",
      "utt-3",
      "utt-4",
      "utt-5"
    ]);
    await coordinator.close();
  });

  it("runs accumulated finals within the shorter post-turn delay", async () => {
    vi.useFakeTimers();
    const store = new SessionStore();
    const analyzer = new BlockingAnalyzer();
    const coordinator = new AnalysisCoordinator(store, analyzer, 1_500, 500);
    const session = store.create("https://zoom.example/test", "session-rerun");

    addUtterance(store, session.id, "utt-1");
    coordinator.schedule(session.id);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(analyzer.calls).toHaveLength(1);

    addUtterance(store, session.id, "utt-2");
    coordinator.schedule(session.id);
    addUtterance(store, session.id, "utt-3");
    coordinator.schedule(session.id);
    analyzer.releaseFirst();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(499);
    expect(analyzer.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(analyzer.calls).toHaveLength(2);
    expect(analyzer.calls[1]?.newUtterances.map((item) => item.id)).toEqual([
      "utt-2",
      "utt-3"
    ]);
    await coordinator.close();
  });

  it("lets Analyze now bypass a pending automatic timer", async () => {
    vi.useFakeTimers();
    const store = new SessionStore();
    const analyzer = new FakeAnalyzer();
    const coordinator = new AnalysisCoordinator(store, analyzer, 1_500, 500);
    const session = store.create("https://zoom.example/test", "session-manual");

    addUtterance(store, session.id, "utt-1");
    coordinator.schedule(session.id);
    await coordinator.analyzeNow(session.id);

    expect(analyzer.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(analyzer.calls).toHaveLength(1);
    await coordinator.close();
  });
});
