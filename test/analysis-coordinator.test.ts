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
  readonly resetCalls: string[] = [];

  async analyze(input: AnalyzeMeetingInput): Promise<AnalyzeMeetingResult> {
    this.calls.push(input);
    const customerIds = new Set(
      input.participants
        .filter((participant) => participant.role === "customer")
        .map((participant) => participant.id)
    );
    const customerEvidence = input.newUtterances.filter((utterance) =>
      customerIds.has(utterance.participantId)
    );
    return resultFor({
      ...input,
      newUtterances: customerEvidence.length > 0 ? customerEvidence : input.newUtterances
    });
  }

  async close(): Promise<void> {}

  async resetSession(sessionId: string): Promise<void> {
    this.resetCalls.push(sessionId);
  }
}

class ResetFailingAnalyzer extends FakeAnalyzer {
  failReset = false;

  override async resetSession(sessionId: string): Promise<void> {
    if (this.failReset) throw new Error("quarantine unavailable");
    await super.resetSession(sessionId);
  }
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

  async resetSession(): Promise<void> {}

  async close(): Promise<void> {}
}

class FailingBlockingAnalyzer implements MeetingAnalyzer {
  readonly calls: AnalyzeMeetingInput[] = [];
  private releaseFirstCall?: () => void;
  private readonly firstCallGate = new Promise<void>((resolve) => {
    this.releaseFirstCall = resolve;
  });

  async analyze(input: AnalyzeMeetingInput): Promise<AnalyzeMeetingResult> {
    this.calls.push(input);
    await this.firstCallGate;
    throw new Error("Codex unavailable");
  }

  releaseFirst(): void {
    this.releaseFirstCall?.();
  }

  async resetSession(): Promise<void> {}

  async close(): Promise<void> {}
}

class OperatorEvidenceAnalyzer implements MeetingAnalyzer {
  async analyze(input: AnalyzeMeetingInput): Promise<AnalyzeMeetingResult> {
    return resultFor({
      ...input,
      newUtterances: [input.newUtterances[0]!]
    });
  }

  async resetSession(): Promise<void> {}

  async close(): Promise<void> {}
}

const resultFor = (input: AnalyzeMeetingInput): AnalyzeMeetingResult => ({
  threadId: input.threadId ?? "thread-1",
  graph: {
    ...input.currentGraph,
    topic: {
      id: "billing",
      label: "Billing workflow",
      evidenceUtteranceIds: input.newUtterances.map((item) => item.id)
    },
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
  if (!store.getRequired(sessionId).operatorParticipantId) {
    store.upsertParticipant(sessionId, {
      id: "test-operator",
      name: "Morgan"
    });
    store.selectOperator(sessionId, "test-operator");
  }
  store.upsertParticipant(sessionId, { id: "person-1", name: "Alex" });
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

  it("attaches the current participant role to finalized analysis evidence", async () => {
    const store = new SessionStore();
    const analyzer = new FakeAnalyzer();
    const coordinator = new AnalysisCoordinator(store, analyzer, 1);
    const session = store.create(
      "https://zoom.example/test",
      "session-roles"
    );
    store.upsertParticipant(session.id, {
      id: "person-1",
      name: "Alex"
    });
    store.upsertParticipant(session.id, {
      id: "person-2",
      name: "Maya"
    });
    store.selectOperator(session.id, "person-1");
    store.appendUtterance(session.id, {
      id: "utt-1",
      sequence: 1,
      participantId: "person-2",
      participantName: "Maya",
      text: "Finance manually copies invoices.",
      startedAt: 1,
      endedAt: 2,
      finalized: true
    });

    await coordinator.analyzeNow(session.id);

    expect(analyzer.calls[0]?.participants).toMatchObject([
      { id: "person-1", role: "operator" },
      { id: "person-2", role: "customer" }
    ]);
    expect(analyzer.calls[0]?.newUtterances).toMatchObject([
      { id: "utt-1", participantRole: "customer" }
    ]);
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

  it("keeps ended status when a successful in-flight analysis completes", async () => {
    const store = new SessionStore();
    const analyzer = new BlockingAnalyzer();
    const coordinator = new AnalysisCoordinator(store, analyzer, 1);
    const session = store.create("https://zoom.example/test", "session-ended-success");

    addUtterance(store, session.id, "utt-1");
    const analysis = coordinator.analyzeNow(session.id);
    expect(analyzer.calls).toHaveLength(1);
    store.setStatus(session.id, "ended");
    analyzer.releaseFirst();
    await analysis;

    expect(store.getRequired(session.id).status).toBe("ended");
    await coordinator.close();
  });

  it("flushes a queued final after the meeting ends", async () => {
    vi.useFakeTimers();
    const store = new SessionStore();
    const analyzer = new FakeAnalyzer();
    const coordinator = new AnalysisCoordinator(store, analyzer, 500, 100);
    const session = store.create("https://zoom.example/test", "session-ended-queued");
    addUtterance(store, session.id, "utt-1");
    coordinator.schedule(session.id);
    store.setStatus(session.id, "ended");

    await vi.advanceTimersByTimeAsync(500);

    expect(analyzer.calls).toHaveLength(1);
    expect(store.getRequired(session.id).status).toBe("ended");
    expect(store.getRequired(session.id).revision).toBe(1);
    await coordinator.close();
  });

  it("allows pending end-of-meeting evidence to run after processing resumes", async () => {
    vi.useFakeTimers();
    const store = new SessionStore();
    const analyzer = new FakeAnalyzer();
    const coordinator = new AnalysisCoordinator(store, analyzer, 500, 100);
    const session = store.create("https://zoom.example/test", "session-ended-paused");
    addUtterance(store, session.id, "utt-1");
    store.setProcessingPaused(session.id, true);
    coordinator.setPaused(session.id, true);
    store.setStatus(session.id, "ended");
    store.setProcessingPaused(session.id, false);
    coordinator.setPaused(session.id, false);

    await vi.advanceTimersByTimeAsync(500);

    expect(analyzer.calls).toHaveLength(1);
    expect(store.getRequired(session.id).status).toBe("ended");
    expect(store.getRequired(session.id).revision).toBe(1);
    await coordinator.close();
  });

  it("keeps error status when an in-flight analysis fails", async () => {
    const store = new SessionStore();
    const analyzer = new FailingBlockingAnalyzer();
    const coordinator = new AnalysisCoordinator(store, analyzer, 1);
    const session = store.create("https://zoom.example/test", "session-ended-error");

    addUtterance(store, session.id, "utt-1");
    const analysis = coordinator.analyzeNow(session.id);
    expect(analyzer.calls).toHaveLength(1);
    store.setStatus(session.id, "error");
    analyzer.releaseFirst();
    await analysis;

    expect(store.getRequired(session.id).status).toBe("error");
    expect(store.getRequired(session.id).analysis.lastError).toBe("Codex unavailable");
    await coordinator.close();
  });

  it("waits for a customer selection and uses a customer's confirmation as evidence", async () => {
    const store = new SessionStore();
    const analyzer = new FakeAnalyzer();
    const coordinator = new AnalysisCoordinator(store, analyzer, 1);
    const session = store.create("https://zoom.example/test", "session-roles");
    store.upsertParticipant(session.id, { id: "operator", name: "Morgan" });
    store.appendUtterance(session.id, {
      id: "operator-1",
      sequence: 1,
      participantId: "operator",
      participantName: "Morgan",
      text: "Is manual billing painful for you?",
      startedAt: 1,
      endedAt: 2,
      finalized: true
    });

    await coordinator.analyzeNow(session.id);
    expect(analyzer.calls).toHaveLength(0);
    expect(store.getRequired(session.id).analysis.blockedReason).toMatch(/operator/);

    store.selectOperator(session.id, "operator");
    store.upsertParticipant(session.id, { id: "customer", name: "Taylor" });
    store.appendUtterance(session.id, {
      id: "customer-1",
      sequence: 2,
      participantId: "customer",
      participantName: "Taylor",
      text: "Yes, our finance team spends Friday reconciling invoices.",
      startedAt: 3,
      endedAt: 4,
      finalized: true
    });

    await coordinator.analyzeNow(session.id);
    expect(analyzer.calls).toHaveLength(1);
    expect(store.getRequired(session.id).graph.nodes[0]?.evidenceUtteranceIds).toEqual([
      "customer-1"
    ]);
    await coordinator.close();
  });

  it("rejects graph claims supported only by an operator", async () => {
    const store = new SessionStore();
    const coordinator = new AnalysisCoordinator(
      store,
      new OperatorEvidenceAnalyzer(),
      1
    );
    const session = store.create("https://zoom.example/test", "session-operator-evidence");
    store.upsertParticipant(session.id, { id: "operator", name: "Morgan" });
    store.upsertParticipant(session.id, { id: "customer", name: "Taylor" });
    store.selectOperator(session.id, "operator");
    store.appendUtterance(session.id, {
      id: "operator-1",
      sequence: 1,
      participantId: "operator",
      participantName: "Morgan",
      text: "You are losing money because billing is manual.",
      startedAt: 1,
      endedAt: 2,
      finalized: true
    });
    store.appendUtterance(session.id, {
      id: "customer-1",
      sequence: 2,
      participantId: "customer",
      participantName: "Taylor",
      text: "We reconcile invoices every Friday.",
      startedAt: 3,
      endedAt: 4,
      finalized: true
    });

    await coordinator.analyzeNow(session.id);
    expect(store.getRequired(session.id).revision).toBe(0);
    expect(store.getRequired(session.id).analysis.lastError).toMatch(/non-customer evidence/);

    await coordinator.analyzeNow(session.id);
    expect(store.getRequired(session.id).revision).toBe(0);
    expect(store.getRequired(session.id).analysis.pendingUtteranceCount).toBe(2);
    await coordinator.close();
  });

  it("rebuilds the complete graph from all finals after correcting the operator", async () => {
    const store = new SessionStore();
    const analyzer = new FakeAnalyzer();
    const coordinator = new AnalysisCoordinator(store, analyzer, 1);
    const session = store.create("https://zoom.example/test", "session-role-rebuild");
    store.upsertParticipant(session.id, { id: "person-1", name: "Morgan" });
    store.upsertParticipant(session.id, { id: "person-2", name: "Taylor" });
    store.selectOperator(session.id, "person-1");
    for (const [id, participantId, participantName] of [
      ["operator-1", "person-1", "Morgan"],
      ["customer-1", "person-2", "Taylor"]
    ] as const) {
      store.appendUtterance(session.id, {
        id,
        sequence: store.getRequired(session.id).utterances.length + 1,
        participantId,
        participantName,
        text: `${participantName} described the billing workflow.`,
        startedAt: 1,
        endedAt: 2,
        finalized: true
      });
    }

    await coordinator.analyzeNow(session.id);
    expect(store.getRequired(session.id).revision).toBe(1);
    expect(store.getRequired(session.id).graph.nodes[0]?.evidenceUtteranceIds).toEqual([
      "customer-1"
    ]);

    const corrected = store.selectOperator(session.id, "person-2");
    expect(corrected.revision).toBe(0);
    expect(corrected.graph.nodes).toEqual([]);
    await coordinator.rolesChanged(session.id);
    await coordinator.analyzeNow(session.id);

    expect(analyzer.resetCalls).toEqual([session.id]);
    expect(analyzer.calls[1]?.currentGraph.nodes).toEqual([]);
    expect(analyzer.calls[1]?.newUtterances.map((item) => item.id)).toEqual([
      "operator-1",
      "customer-1"
    ]);
    expect(store.getRequired(session.id).graph.nodes[0]?.evidenceUtteranceIds).toEqual([
      "operator-1"
    ]);
    await coordinator.close();
  });

  it("bounds a turn batch and carries remaining finals into the next turn", async () => {
    const store = new SessionStore();
    const analyzer = new FakeAnalyzer();
    const coordinator = new AnalysisCoordinator(store, analyzer, 10_000, 10_000, 20, 2, 48_000);
    const session = store.create("https://zoom.example/test", "session-bounded-batch");
    for (const id of ["utt-1", "utt-2", "utt-3"]) addUtterance(store, session.id, id);

    await coordinator.analyzeNow(session.id);
    await coordinator.analyzeNow(session.id);

    expect(analyzer.calls.map((call) => call.newUtterances.map((item) => item.id))).toEqual([
      ["utt-1", "utt-2"],
      ["utt-3"]
    ]);
    expect(store.getRequired(session.id).revision).toBe(2);
    await coordinator.close();
  });

  it("supports multiple customer stakeholders with one authoritative operator", async () => {
    const store = new SessionStore();
    const analyzer = new FakeAnalyzer();
    const coordinator = new AnalysisCoordinator(store, analyzer, 1);
    const session = store.create("https://zoom.example/test", "session-multiple-roles");
    for (const [id, name] of [
      ["operator-1", "Morgan"],
      ["customer-1", "Taylor"],
      ["customer-2", "Jordan"]
    ] as const) {
      store.upsertParticipant(session.id, { id, name });
    }
    store.selectOperator(session.id, "operator-1");
    for (const [id, participantId, participantName, text] of [
      ["operator-question", "operator-1", "Morgan", "Is billing reconciliation slow?"],
      ["customer-confirmation", "customer-1", "Taylor", "Yes, it takes us a day every week."],
      ["customer-impact", "customer-2", "Jordan", "It delays our financial close."]
    ] as const) {
      store.appendUtterance(session.id, {
        id,
        sequence: store.getRequired(session.id).utterances.length + 1,
        participantId,
        participantName,
        text,
        startedAt: 1,
        endedAt: 2,
        finalized: true
      });
    }

    await coordinator.analyzeNow(session.id);
    expect(analyzer.calls).toHaveLength(1);
    expect(store.getRequired(session.id).graph.nodes[0]?.evidenceUtteranceIds).toEqual([
      "customer-confirmation",
      "customer-impact"
    ]);
    await coordinator.close();
  });

  it("retains operator context without consuming a turn until customer evidence arrives", async () => {
    vi.useFakeTimers();
    const store = new SessionStore();
    const analyzer = new FakeAnalyzer();
    const coordinator = new AnalysisCoordinator(store, analyzer, 100, 25, 20);
    const session = store.create("https://zoom.example/test", "session-operator-only");
    store.upsertParticipant(session.id, { id: "operator", name: "Morgan" });
    store.upsertParticipant(session.id, { id: "customer", name: "Taylor" });
    store.selectOperator(session.id, "operator");
    store.appendUtterance(session.id, {
      id: "operator-question",
      sequence: 1,
      participantId: "operator",
      participantName: "Morgan",
      text: "How does billing work today?",
      startedAt: 1,
      endedAt: 2,
      finalized: true
    });

    coordinator.schedule(session.id);
    await vi.advanceTimersByTimeAsync(500);
    expect(analyzer.calls).toHaveLength(0);
    expect(store.getRequired(session.id).analysis.automaticTurnsStarted).toBe(0);

    store.appendUtterance(session.id, {
      id: "customer-answer",
      sequence: 2,
      participantId: "customer",
      participantName: "Taylor",
      text: "Finance reconciles invoices manually every Friday.",
      startedAt: 3,
      endedAt: 4,
      finalized: true
    });
    coordinator.schedule(session.id);
    await vi.advanceTimersByTimeAsync(100);

    expect(analyzer.calls).toHaveLength(1);
    expect(analyzer.calls[0]?.newUtterances.map((item) => item.id)).toEqual([
      "operator-question",
      "customer-answer"
    ]);
    expect(store.getRequired(session.id).analysis.automaticTurnsStarted).toBe(1);
    await coordinator.close();
  });

  it("rejects a finalized utterance that exceeds the hard batch byte limit", async () => {
    const store = new SessionStore();
    const analyzer = new FakeAnalyzer();
    const coordinator = new AnalysisCoordinator(store, analyzer, 1, 1, 20, 40, 32);
    const session = store.create("https://zoom.example/test", "session-oversized");
    store.upsertParticipant(session.id, { id: "operator", name: "Morgan" });
    store.upsertParticipant(session.id, { id: "customer", name: "Taylor" });
    store.selectOperator(session.id, "operator");
    store.appendUtterance(session.id, {
      id: "oversized-customer-answer",
      sequence: 1,
      participantId: "customer",
      participantName: "Taylor",
      text: "x".repeat(33),
      startedAt: 1,
      endedAt: 2,
      finalized: true
    });

    await coordinator.analyzeNow(session.id);

    expect(analyzer.calls).toHaveLength(0);
    expect(store.getRequired(session.id).analysis).toMatchObject({
      status: "error",
      pendingUtteranceCount: 0,
      lastError: expect.stringContaining("exceeded the 32-byte")
    });
    store.appendUtterance(session.id, {
      id: "valid-customer-answer",
      sequence: 2,
      participantId: "customer",
      participantName: "Taylor",
      text: "A valid answer follows.",
      startedAt: 3,
      endedAt: 4,
      finalized: true
    });
    await coordinator.analyzeNow(session.id);

    expect(analyzer.calls).toHaveLength(1);
    expect(analyzer.calls[0]?.newUtterances.map((item) => item.id)).toEqual([
      "valid-customer-answer"
    ]);
    expect(store.getRequired(session.id).analysis.pendingUtteranceCount).toBe(0);
    await coordinator.close();
  });

  it("blocks all later analysis when a role-correction quarantine fails", async () => {
    const store = new SessionStore();
    const analyzer = new ResetFailingAnalyzer();
    const coordinator = new AnalysisCoordinator(store, analyzer, 1);
    const session = store.create("https://zoom.example/test", "session-reset-failure");
    for (const [id, name] of [
      ["operator-1", "Morgan"],
      ["operator-2", "Sam"],
      ["customer", "Taylor"]
    ] as const) {
      store.upsertParticipant(session.id, { id, name });
    }
    store.selectOperator(session.id, "operator-1");
    store.appendUtterance(session.id, {
      id: "customer-1",
      sequence: 1,
      participantId: "customer",
      participantName: "Taylor",
      text: "We reconcile invoices manually.",
      startedAt: 1,
      endedAt: 2,
      finalized: true
    });
    await coordinator.analyzeNow(session.id);
    expect(analyzer.calls).toHaveLength(1);

    analyzer.failReset = true;
    store.selectOperator(session.id, "operator-2");
    await expect(coordinator.rolesChanged(session.id)).rejects.toThrow(
      "Codex reset failed"
    );
    store.appendUtterance(session.id, {
      id: "customer-2",
      sequence: 2,
      participantId: "customer",
      participantName: "Taylor",
      text: "Late approvals wait another week.",
      startedAt: 3,
      endedAt: 4,
      finalized: true
    });
    coordinator.schedule(session.id);
    await coordinator.analyzeNow(session.id);

    expect(analyzer.calls).toHaveLength(1);
    expect(coordinator.manualBlocker(session.id)).toMatch(/reset failed/);
    expect(store.getRequired(session.id).analysis.status).toBe("error");
    await coordinator.close();
  });

  it("stops automatic turns at the per-session budget while keeping manual analysis", async () => {
    vi.useFakeTimers();
    const store = new SessionStore();
    const analyzer = new FakeAnalyzer();
    const coordinator = new AnalysisCoordinator(store, analyzer, 100, 100, 1);
    const session = store.create("https://zoom.example/test", "session-budget");

    addUtterance(store, session.id, "utt-1");
    coordinator.schedule(session.id);
    await vi.advanceTimersByTimeAsync(100);
    expect(analyzer.calls).toHaveLength(1);

    for (const id of ["utt-2", "utt-3", "utt-4", "utt-5"]) {
      addUtterance(store, session.id, id);
      coordinator.schedule(session.id);
    }
    expect(store.getRequired(session.id).analysis.throttled).toBe(true);
    expect(store.getRequired(session.id).analysis.pendingUtteranceCount).toBe(4);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(analyzer.calls).toHaveLength(1);

    await coordinator.analyzeNow(session.id);
    expect(analyzer.calls).toHaveLength(2);
    expect(store.getRequired(session.id).analysis.automaticTurnsStarted).toBe(1);
    await coordinator.close();
  });

  it("cancels automatic analysis while paused and processes pending work on resume", async () => {
    vi.useFakeTimers();
    const store = new SessionStore();
    const analyzer = new FakeAnalyzer();
    const coordinator = new AnalysisCoordinator(store, analyzer, 1_500, 500);
    const session = store.create("https://zoom.example/test", "session-paused");

    addUtterance(store, session.id, "utt-1");
    coordinator.schedule(session.id);
    store.setProcessingPaused(session.id, true);
    coordinator.setPaused(session.id, true);
    await vi.advanceTimersByTimeAsync(1_500);
    await coordinator.analyzeNow(session.id);

    expect(analyzer.calls).toHaveLength(0);
    expect(store.getRequired(session.id).analysis.pendingUtteranceCount).toBe(1);

    store.setProcessingPaused(session.id, false);
    coordinator.setPaused(session.id, false);
    await vi.advanceTimersByTimeAsync(1_500);

    expect(analyzer.calls).toHaveLength(1);
    expect(analyzer.calls[0]?.newUtterances.map((item) => item.id)).toEqual([
      "utt-1"
    ]);
    await coordinator.close();
  });

  it("rejects an in-flight result after reset and starts fresh next time", async () => {
    const store = new SessionStore();
    const analyzer = new BlockingAnalyzer();
    const coordinator = new AnalysisCoordinator(store, analyzer, 1);
    const session = store.create("https://zoom.example/test", "session-reset");

    addUtterance(store, session.id, "utt-1");
    const staleAnalysis = coordinator.analyzeNow(session.id);
    await vi.waitFor(() => expect(analyzer.calls).toHaveLength(1));

    await coordinator.resetSession(session.id);
    store.resetContext(session.id);
    analyzer.releaseFirst();
    await staleAnalysis;

    expect(store.getRequired(session.id)).toMatchObject({
      revision: 0,
      utterances: [],
      codex: { status: "idle" },
      analysis: { status: "idle", pendingUtteranceCount: 0 }
    });

    addUtterance(store, session.id, "utt-2");
    await coordinator.analyzeNow(session.id);

    expect(analyzer.calls).toHaveLength(2);
    expect(analyzer.calls[1]).toMatchObject({
      threadId: undefined,
      currentGraph: { nodes: [], edges: [] }
    });
    expect(store.getRequired(session.id).revision).toBe(1);
    await coordinator.close();
  });
});
