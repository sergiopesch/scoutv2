import type { MeetingAnalyzer } from "./contracts.js";
import { validateCustomerEvidence } from "../shared/schemas.js";
import { SessionStore } from "./session-store.js";

interface SessionAnalysisState {
  processedUtteranceIds: Set<string>;
  timer?: NodeJS.Timeout;
  running: boolean;
  runAgain: boolean;
  automaticTurnsStarted: number;
  generation: number;
}

const customerSelectionRequired =
  "Select at least one prospective customer before analysis can start.";

export class AnalysisCoordinator {
  private readonly sessions = new Map<string, SessionAnalysisState>();

  constructor(
    private readonly store: SessionStore,
    private readonly analyzer: MeetingAnalyzer,
    private readonly initialDelayMs = 500,
    private readonly rerunDelayMs = 250,
    private readonly automaticTurnBudget = 20
  ) {}

  schedule(sessionId: string): void {
    if (this.store.getRequired(sessionId).processing.paused) return;
    const state = this.stateFor(sessionId);
    const snapshot = this.store.getRequired(sessionId);
    if (this.isTerminal(snapshot.status)) return;
    const pendingCount = this.pendingUtteranceIds(sessionId, state).length;
    if (pendingCount === 0) return;

    if (!this.hasCustomer(snapshot)) {
      this.setBlockedForCustomerSelection(sessionId, pendingCount, state);
      return;
    }

    if (!this.canRunAutomatically(state)) {
      this.setThrottled(sessionId, pendingCount, state);
      return;
    }

    if (state.running) {
      state.runAgain = true;
      this.updateQueuedCount(sessionId, pendingCount);
      return;
    }

    this.updateQueuedCount(sessionId, pendingCount);
    this.scheduleAfter(sessionId, state, this.initialDelayMs);
  }

  async analyzeNow(sessionId: string): Promise<void> {
    await this.runAnalysis(sessionId, false);
  }

  private async runAnalysis(
    sessionId: string,
    automatic: boolean
  ): Promise<void> {
    const state = this.stateFor(sessionId);
    if (this.store.getRequired(sessionId).processing.paused) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      return;
    }
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }

    if (state.running) {
      state.runAgain = true;
      return;
    }

    const snapshot = this.store.getRequired(sessionId);
    if (this.isTerminal(snapshot.status)) return;
    const rolesByParticipantId = new Map(
      snapshot.participants.map((participant) => [
        participant.id,
        participant.role
      ])
    );
    const newUtterances = snapshot.utterances
      .filter(
        (utterance) =>
          utterance.finalized && !state.processedUtteranceIds.has(utterance.id)
      )
      .map((utterance) => ({
        ...utterance,
        participantRole:
          rolesByParticipantId.get(utterance.participantId) ?? ("unknown" as const)
      }));
    if (newUtterances.length === 0) return;

    if (!this.hasCustomer(snapshot)) {
      this.setBlockedForCustomerSelection(sessionId, newUtterances.length, state);
      return;
    }

    if (automatic && !this.canRunAutomatically(state)) {
      this.setThrottled(sessionId, newUtterances.length, state);
      return;
    }

    state.running = true;
    state.runAgain = false;
    if (automatic) state.automaticTurnsStarted += 1;
    const generation = state.generation;
    this.store.setStatus(sessionId, "analyzing");
    this.store.setAnalysis(sessionId, {
      status: "running",
      pendingUtteranceCount: newUtterances.length,
      automaticTurnsStarted: state.automaticTurnsStarted,
      automaticTurnBudget: this.automaticTurnBudget,
      throttled: false,
      blockedReason: undefined
    });
    this.store.setCodex(sessionId, {
      status: "active",
      threadId: snapshot.codex.threadId
    });

    try {
      const result = await this.analyzer.analyze({
        sessionId,
        threadId: snapshot.codex.threadId,
        currentGraph: snapshot.graph,
        participants: snapshot.participants,
        newUtterances
      });

      if (!this.isCurrent(sessionId, state, generation)) return;
      for (const utterance of newUtterances) {
        state.processedUtteranceIds.add(utterance.id);
      }
      this.store.setCodex(sessionId, {
        status: "connected",
        threadId: result.threadId
      });
      const currentSnapshot = this.store.getRequired(sessionId);
      const customerParticipantIds = new Set(
        currentSnapshot.participants
          .filter((participant) => participant.role === "customer")
          .map((participant) => participant.id)
      );
      const customerUtteranceIds = new Set(
        currentSnapshot.utterances
          .filter((utterance) => customerParticipantIds.has(utterance.participantId))
          .map((utterance) => utterance.id)
      );
      const customerEvidenceErrors = validateCustomerEvidence(
        result.graph,
        customerUtteranceIds
      );
      if (customerEvidenceErrors.length > 0) {
        throw new Error(
          `Codex analysis returned non-customer evidence: ${customerEvidenceErrors.join(" ")}`
        );
      }
      this.store.acceptGraph(sessionId, result.graph);
      this.restoreListeningIfStillAnalyzing(sessionId);
    } catch (error) {
      if (!this.isCurrent(sessionId, state, generation)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.store.setCodex(sessionId, {
        status: "error",
        detail: message,
        threadId: snapshot.codex.threadId
      });
      this.store.setAnalysis(sessionId, {
        status: "error",
        pendingUtteranceCount: newUtterances.length,
        automaticTurnsStarted: state.automaticTurnsStarted,
        automaticTurnBudget: this.automaticTurnBudget,
        throttled: false,
        blockedReason: undefined,
        lastError: message
      });
      this.restoreListeningIfStillAnalyzing(sessionId);
    } finally {
      state.running = false;
      if (!this.isCurrent(sessionId, state, generation)) return;
      const pendingCount = this.pendingUtteranceIds(sessionId, state).length;
      if (
        !this.store.getRequired(sessionId).processing.paused &&
        state.runAgain &&
        pendingCount > 0
      ) {
        state.runAgain = false;
        if (this.canRunAutomatically(state)) {
          this.updateQueuedCount(sessionId, pendingCount);
          this.scheduleAfter(sessionId, state, this.rerunDelayMs, true);
        } else {
          this.setThrottled(sessionId, pendingCount, state);
        }
      } else {
        state.runAgain = false;
      }
    }
  }

  setPaused(sessionId: string, paused: boolean): void {
    const state = this.stateFor(sessionId);
    if (paused) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      state.runAgain = false;
      const pendingCount = this.pendingUtteranceIds(sessionId, state).length;
      const current = this.store.getRequired(sessionId).analysis;
      if (!state.running && pendingCount > 0) {
        this.store.setAnalysis(sessionId, {
          ...current,
          status: "idle",
          pendingUtteranceCount: pendingCount
        });
      }
      return;
    }
    this.schedule(sessionId);
  }

  async resetSession(sessionId: string): Promise<void> {
    const current = this.sessions.get(sessionId);
    if (current?.timer) clearTimeout(current.timer);
    this.sessions.set(sessionId, {
      processedUtteranceIds: new Set<string>(),
      running: false,
      runAgain: false,
      automaticTurnsStarted: 0,
      generation: (current?.generation ?? 0) + 1
    });
    await this.analyzer.resetSession?.(sessionId);
  }

  async close(): Promise<void> {
    for (const state of this.sessions.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.sessions.clear();
    await this.analyzer.close();
  }

  private stateFor(sessionId: string): SessionAnalysisState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created: SessionAnalysisState = {
      processedUtteranceIds: new Set<string>(),
      running: false,
      runAgain: false,
      automaticTurnsStarted: 0,
      generation: 0
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  private isCurrent(
    sessionId: string,
    state: SessionAnalysisState,
    generation: number
  ): boolean {
    return this.sessions.get(sessionId) === state && state.generation === generation;
  }

  private pendingUtteranceIds(
    sessionId: string,
    state: SessionAnalysisState
  ): string[] {
    return this.store
      .getRequired(sessionId)
      .utterances.filter(
        (utterance) =>
          utterance.finalized && !state.processedUtteranceIds.has(utterance.id)
      )
      .map((utterance) => utterance.id);
  }

  private updateQueuedCount(sessionId: string, pendingCount: number): void {
    const current = this.store.getRequired(sessionId).analysis;
    this.store.setAnalysis(sessionId, {
      ...current,
      status: "queued",
      pendingUtteranceCount: pendingCount,
      automaticTurnsStarted: this.stateFor(sessionId).automaticTurnsStarted,
      automaticTurnBudget: this.automaticTurnBudget,
      throttled: false,
      blockedReason: undefined,
      lastError: undefined
    });
  }

  private scheduleAfter(
    sessionId: string,
    state: SessionAnalysisState,
    delayMs: number,
    automatic = true
  ): void {
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.runAnalysis(sessionId, automatic);
    }, delayMs);
  }

  private hasCustomer(snapshot: ReturnType<SessionStore["getRequired"]>): boolean {
    return snapshot.participants.some((participant) => participant.role === "customer");
  }

  private canRunAutomatically(state: SessionAnalysisState): boolean {
    return state.automaticTurnsStarted < this.automaticTurnBudget;
  }

  private isTerminal(status: ReturnType<SessionStore["getRequired"]>["status"]): boolean {
    return status === "ended" || status === "error";
  }

  private restoreListeningIfStillAnalyzing(sessionId: string): void {
    if (this.store.getRequired(sessionId).status === "analyzing") {
      this.store.setStatus(sessionId, "listening");
    }
  }

  private setBlockedForCustomerSelection(
    sessionId: string,
    pendingUtteranceCount: number,
    state: SessionAnalysisState
  ): void {
    const current = this.store.getRequired(sessionId).analysis;
    this.store.setAnalysis(sessionId, {
      ...current,
      status: "idle",
      pendingUtteranceCount,
      automaticTurnsStarted: state.automaticTurnsStarted,
      automaticTurnBudget: this.automaticTurnBudget,
      throttled: false,
      blockedReason: customerSelectionRequired,
      lastError: undefined
    });
  }

  private setThrottled(
    sessionId: string,
    pendingUtteranceCount: number,
    state: SessionAnalysisState
  ): void {
    const current = this.store.getRequired(sessionId).analysis;
    this.store.setAnalysis(sessionId, {
      ...current,
      status: "idle",
      pendingUtteranceCount,
      automaticTurnsStarted: state.automaticTurnsStarted,
      automaticTurnBudget: this.automaticTurnBudget,
      throttled: true,
      blockedReason: undefined,
      lastError: undefined
    });
  }
}
