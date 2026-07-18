import type { MeetingAnalyzer } from "./contracts.js";
import { validateCustomerEvidence } from "../shared/schemas.js";
import { SessionStore } from "./session-store.js";

interface SessionAnalysisState {
  processedUtteranceIds: Set<string>;
  rejectedUtteranceIds: Set<string>;
  timer?: NodeJS.Timeout;
  running: boolean;
  resetting: boolean;
  resetFailure?: string;
  runAgain: boolean;
  automaticTurnsStarted: number;
  generation: number;
  roleRevision: number;
}

const customerSelectionRequired =
  "Select at least one prospective customer before analysis can start.";
const operatorSelectionRequired =
  "Select the meeting operator before analysis can start.";
const customerEvidenceRequired =
  "Wait for a finalized prospective-customer utterance before analysis can start.";

type AnalysisObserver = (record: Record<string, unknown>) => void;

export class AnalysisCoordinator {
  private readonly sessions = new Map<string, SessionAnalysisState>();

  constructor(
    private readonly store: SessionStore,
    private readonly analyzer: MeetingAnalyzer,
    private readonly initialDelayMs = 500,
    private readonly rerunDelayMs = 250,
    private readonly automaticTurnBudget = 20,
    private readonly maxBatchUtterances = 40,
    private readonly maxBatchBytes = 48_000,
    private readonly observe: AnalysisObserver = () => {}
  ) {}

  schedule(sessionId: string): void {
    if (this.store.getRequired(sessionId).processing.paused) return;
    const state = this.stateFor(sessionId);
    const snapshot = this.store.getRequired(sessionId);
    if (state.resetting || state.resetFailure || this.isTerminal(snapshot.status)) {
      return;
    }
    const pendingCount = this.pendingUtteranceIds(sessionId, state).length;
    if (pendingCount === 0) return;

    const roleBlocker = this.roleBlocker(snapshot);
    if (roleBlocker) {
      this.setBlocked(sessionId, pendingCount, state, roleBlocker);
      return;
    }

    if (!this.hasPendingCustomerEvidence(snapshot, state)) {
      this.setBlocked(sessionId, pendingCount, state, customerEvidenceRequired);
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

  manualBlocker(sessionId: string): string | undefined {
    const snapshot = this.store.getRequired(sessionId);
    const state = this.stateFor(sessionId);
    if (snapshot.processing.paused) return "live processing is paused";
    if (this.isTerminal(snapshot.status)) return "the session cannot be analyzed";
    if (state.resetting) return "participant roles are being applied";
    if (state.resetFailure) return state.resetFailure;
    if (state.running) return "analysis is already running";
    const pendingCount = this.pendingUtteranceIds(sessionId, state).length;
    if (pendingCount === 0) return "no finalized utterances are pending";
    const roleBlocker = this.roleBlocker(snapshot);
    if (roleBlocker) return roleBlocker;
    if (!this.hasPendingCustomerEvidence(snapshot, state)) {
      return "no finalized prospective-customer utterances are pending";
    }
    return undefined;
  }

  needsRoleReset(sessionId: string): boolean {
    return Boolean(this.sessions.get(sessionId)?.resetFailure);
  }

  async rolesChanged(sessionId: string): Promise<void> {
    const current = this.sessions.get(sessionId);
    if (current?.timer) clearTimeout(current.timer);
    const replacement: SessionAnalysisState = {
      processedUtteranceIds: new Set<string>(),
      rejectedUtteranceIds: new Set<string>(),
      running: false,
      resetting: true,
      runAgain: false,
      automaticTurnsStarted: 0,
      generation: (current?.generation ?? 0) + 1,
      roleRevision: this.store.getRequired(sessionId).roleRevision
    };
    this.sessions.set(sessionId, replacement);
    this.observe({ event: "analysis.roles_changed", sessionId });
    try {
      if (!this.analyzer.resetSession) {
        throw new Error("Codex analyzer cannot reset its meeting thread.");
      }
      await this.analyzer.resetSession(sessionId);
      this.store.setCodex(sessionId, { status: "idle" });
      this.store.setAnalysis(sessionId, {
        status: "idle",
        pendingUtteranceCount: this.pendingUtteranceIds(
          sessionId,
          replacement
        ).length,
        automaticTurnsStarted: 0,
        automaticTurnBudget: this.automaticTurnBudget,
        throttled: false,
        blockedReason: undefined,
        lastError: undefined
      });
    } catch (error) {
      const resetError = error instanceof Error ? error.message : String(error);
      replacement.resetFailure =
        `Participant roles were saved, but Codex reset failed: ${resetError}`;
      this.store.setCodex(sessionId, { status: "error", detail: resetError });
      this.store.setAnalysis(sessionId, {
        status: "error",
        pendingUtteranceCount: this.pendingUtteranceIds(sessionId, replacement).length,
        blockedReason: replacement.resetFailure,
        lastError: replacement.resetFailure
      });
      throw new Error(replacement.resetFailure, { cause: error });
    } finally {
      if (this.sessions.get(sessionId) === replacement) {
        replacement.resetting = false;
        if (!replacement.resetFailure) this.schedule(sessionId);
      }
    }
  }

  private async runAnalysis(
    sessionId: string,
    automatic: boolean
  ): Promise<void> {
    const state = this.stateFor(sessionId);
    if (state.resetting || state.resetFailure) return;
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
    const roleBlocker = this.roleBlocker(snapshot);
    const pendingCount = this.pendingUtteranceIds(sessionId, state).length;
    if (roleBlocker) {
      this.setBlocked(sessionId, pendingCount, state, roleBlocker);
      return;
    }
    if (!this.hasPendingCustomerEvidence(snapshot, state)) {
      this.setBlocked(sessionId, pendingCount, state, customerEvidenceRequired);
      return;
    }
    const rolesByParticipantId = new Map(
      snapshot.participants.map((participant) => [
        participant.id,
        participant.role
      ])
    );
    let pendingUtterances = snapshot.utterances
      .filter(
        (utterance) =>
          utterance.finalized &&
          !state.processedUtteranceIds.has(utterance.id) &&
          !state.rejectedUtteranceIds.has(utterance.id)
      )
      .map((utterance) => ({
        ...utterance,
        participantRole:
          rolesByParticipantId.get(utterance.participantId) ?? ("unknown" as const)
      }));
    const oversized = pendingUtterances.filter(
      (utterance) =>
        Buffer.byteLength(utterance.text, "utf8") > this.maxBatchBytes
    );
    if (oversized.length > 0) {
      for (const utterance of oversized) {
        state.rejectedUtteranceIds.add(utterance.id);
        this.observe({
          event: "analysis.rejected_oversized_utterance",
          sessionId,
          utteranceId: utterance.id
        });
      }
      const message =
        `${oversized.length} finalized utterance(s) exceeded the ${this.maxBatchBytes}-byte analysis limit and were quarantined.`;
      pendingUtterances = pendingUtterances.filter(
        (utterance) => !state.rejectedUtteranceIds.has(utterance.id)
      );
      if (pendingUtterances.length === 0) {
        this.store.setAnalysis(sessionId, {
          status: "error",
          pendingUtteranceCount: 0,
          automaticTurnsStarted: state.automaticTurnsStarted,
          automaticTurnBudget: this.automaticTurnBudget,
          throttled: false,
          blockedReason: message,
          lastError: message
        });
        return;
      }
      this.observe({
        event: "analysis.continuing_after_oversized_utterance",
        sessionId,
        remainingUtteranceCount: pendingUtterances.length
      });
    }
    const newUtterances = this.limitBatch(pendingUtterances);
    if (newUtterances.length === 0) return;

    if (automatic && !this.canRunAutomatically(state)) {
      this.setThrottled(sessionId, pendingUtterances.length, state);
      return;
    }

    state.running = true;
    state.runAgain = false;
    if (automatic) state.automaticTurnsStarted += 1;
    const generation = state.generation;
    const roleRevision = snapshot.roleRevision;
    if (snapshot.status !== "ended") this.store.setStatus(sessionId, "analyzing");
    this.store.setAnalysis(sessionId, {
      status: "running",
      pendingUtteranceCount: pendingUtterances.length,
      automaticTurnsStarted: state.automaticTurnsStarted,
      automaticTurnBudget: this.automaticTurnBudget,
      throttled: false,
      blockedReason: undefined
    });
    this.store.setCodex(sessionId, {
      status: "active",
      threadId: snapshot.codex.threadId
    });
    const startedAt = Date.now();
    this.observe({
      event: "analysis.started",
      sessionId,
      automatic,
      utteranceCount: newUtterances.length,
      pendingUtteranceCount: pendingUtterances.length,
      roleRevision
    });

    let accepted = false;
    let analyzerCompleted = false;
    try {
      const result = await this.analyzer.analyze({
        sessionId,
        threadId: snapshot.codex.threadId,
        currentGraph: snapshot.graph,
        participants: snapshot.participants,
        newUtterances
      });
      analyzerCompleted = true;

      if (!this.isCurrent(sessionId, state, generation)) return;
      const currentSnapshot = this.store.getRequired(sessionId);
      if (currentSnapshot.roleRevision !== roleRevision) {
        throw new Error("Participant roles changed during analysis; the result was discarded.");
      }
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
      const acceptedSnapshot = this.store.acceptGraph(sessionId, result.graph);
      for (const utterance of newUtterances) {
        state.processedUtteranceIds.add(utterance.id);
      }
      accepted = true;
      this.store.setCodex(sessionId, {
        status: "connected",
        threadId: result.threadId
      });
      this.observe({
        event: "analysis.completed",
        sessionId,
        threadId: result.threadId,
        revision: acceptedSnapshot.revision,
        durationMs: Date.now() - startedAt
      });
      this.restoreListeningIfStillAnalyzing(sessionId);
    } catch (error) {
      if (!this.isCurrent(sessionId, state, generation)) return;
      let message = error instanceof Error ? error.message : String(error);
      if (analyzerCompleted) {
        try {
          if (!this.analyzer.resetSession) {
            throw new Error("Codex analyzer cannot quarantine its meeting thread.");
          }
          await this.analyzer.resetSession(sessionId);
        } catch (resetError) {
          const resetMessage =
            resetError instanceof Error ? resetError.message : String(resetError);
          message = `${message} Codex thread quarantine also failed: ${resetMessage}`;
          state.resetFailure = message;
        }
      }
      this.store.setCodex(sessionId, {
        status: "error",
        detail: message,
        threadId: snapshot.codex.threadId
      });
      this.store.setAnalysis(sessionId, {
        status: "error",
        pendingUtteranceCount: pendingUtterances.length,
        automaticTurnsStarted: state.automaticTurnsStarted,
        automaticTurnBudget: this.automaticTurnBudget,
        throttled: false,
        blockedReason: state.resetFailure,
        lastError: message
      });
      this.observe({
        event: "analysis.failed",
        sessionId,
        durationMs: Date.now() - startedAt,
        detail: message
      });
      this.restoreListeningIfStillAnalyzing(sessionId);
    } finally {
      state.running = false;
      if (!this.isCurrent(sessionId, state, generation)) return;
      const pendingCount = this.pendingUtteranceIds(sessionId, state).length;
      if (
        !this.store.getRequired(sessionId).processing.paused &&
        !state.resetFailure &&
        (state.runAgain || (accepted && pendingCount > 0)) &&
        pendingCount > 0
      ) {
        state.runAgain = false;
        const currentSnapshot = this.store.getRequired(sessionId);
        if (!this.hasPendingCustomerEvidence(currentSnapshot, state)) {
          this.setBlocked(
            sessionId,
            pendingCount,
            state,
            customerEvidenceRequired
          );
        } else if (this.canRunAutomatically(state)) {
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
      rejectedUtteranceIds: new Set<string>(),
      running: false,
      resetting: true,
      runAgain: false,
      automaticTurnsStarted: 0,
      generation: (current?.generation ?? 0) + 1,
      roleRevision: this.store.getRequired(sessionId).roleRevision
    });
    const replacement = this.sessions.get(sessionId)!;
    try {
      if (!this.analyzer.resetSession) {
        throw new Error("Codex analyzer cannot reset its meeting thread.");
      }
      await this.analyzer.resetSession(sessionId);
    } catch (error) {
      const resetError = error instanceof Error ? error.message : String(error);
      replacement.resetFailure = `Codex reset failed: ${resetError}`;
      if (this.store.get(sessionId)) {
        this.store.setCodex(sessionId, { status: "error", detail: resetError });
        this.store.setAnalysis(sessionId, {
          status: "error",
          pendingUtteranceCount: this.pendingUtteranceIds(sessionId, replacement).length,
          blockedReason: replacement.resetFailure,
          lastError: replacement.resetFailure
        });
      }
      throw new Error(replacement.resetFailure, { cause: error });
    } finally {
      if (this.sessions.get(sessionId) === replacement) {
        replacement.resetting = false;
      }
    }
  }

  forgetSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state?.timer) clearTimeout(state.timer);
    this.sessions.delete(sessionId);
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
      rejectedUtteranceIds: new Set<string>(),
      running: false,
      resetting: false,
      runAgain: false,
      automaticTurnsStarted: 0,
      generation: 0,
      roleRevision: this.store.getRequired(sessionId).roleRevision
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
          utterance.finalized &&
          !state.processedUtteranceIds.has(utterance.id) &&
          !state.rejectedUtteranceIds.has(utterance.id)
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

  private roleBlocker(
    snapshot: ReturnType<SessionStore["getRequired"]>
  ): string | undefined {
    if (!snapshot.operatorParticipantId) return operatorSelectionRequired;
    return snapshot.participants.some(
      (participant) => participant.role === "customer"
    )
      ? undefined
      : customerSelectionRequired;
  }

  private hasPendingCustomerEvidence(
    snapshot: ReturnType<SessionStore["getRequired"]>,
    state: SessionAnalysisState
  ): boolean {
    const customerIds = new Set(
      snapshot.participants
        .filter((participant) => participant.role === "customer")
        .map((participant) => participant.id)
    );
    return snapshot.utterances.some(
      (utterance) =>
        utterance.finalized &&
        !state.processedUtteranceIds.has(utterance.id) &&
        !state.rejectedUtteranceIds.has(utterance.id) &&
        customerIds.has(utterance.participantId)
    );
  }

  private canRunAutomatically(state: SessionAnalysisState): boolean {
    return state.automaticTurnsStarted < this.automaticTurnBudget;
  }

  private isTerminal(status: ReturnType<SessionStore["getRequired"]>["status"]): boolean {
    return status === "error";
  }

  private limitBatch<
    T extends { text: string; participantRole: string }
  >(utterances: T[]): T[] {
    const selected: T[] = [];
    let bytes = 0;
    for (const utterance of utterances) {
      const utteranceBytes = Buffer.byteLength(utterance.text, "utf8");
      if (
        selected.length > 0 &&
        (selected.length >= this.maxBatchUtterances ||
          bytes + utteranceBytes > this.maxBatchBytes)
      ) {
        break;
      }
      selected.push(utterance);
      bytes += utteranceBytes;
    }
    if (selected.some((utterance) => utterance.participantRole === "customer")) {
      return selected;
    }

    // A long run of operator context must not strand the first customer answer
    // behind a batch boundary. Keep the most recent context that fits and
    // always include one customer final, without exceeding either limit.
    const customerIndex = utterances.findIndex(
      (utterance) => utterance.participantRole === "customer"
    );
    if (customerIndex < 0) return [];
    const customer = utterances[customerIndex]!;
    const contextualBatch: T[] = [customer];
    bytes = Buffer.byteLength(customer.text, "utf8");
    for (let index = customerIndex - 1; index >= 0; index -= 1) {
      const utterance = utterances[index]!;
      const utteranceBytes = Buffer.byteLength(utterance.text, "utf8");
      if (
        contextualBatch.length >= this.maxBatchUtterances ||
        bytes + utteranceBytes > this.maxBatchBytes
      ) {
        continue;
      }
      contextualBatch.unshift(utterance);
      bytes += utteranceBytes;
    }
    return contextualBatch;
  }

  private restoreListeningIfStillAnalyzing(sessionId: string): void {
    if (this.store.getRequired(sessionId).status === "analyzing") {
      this.store.setStatus(sessionId, "listening");
    }
  }

  private setBlocked(
    sessionId: string,
    pendingUtteranceCount: number,
    state: SessionAnalysisState,
    blockedReason: string
  ): void {
    const current = this.store.getRequired(sessionId).analysis;
    this.store.setAnalysis(sessionId, {
      ...current,
      status: "idle",
      pendingUtteranceCount,
      automaticTurnsStarted: state.automaticTurnsStarted,
      automaticTurnBudget: this.automaticTurnBudget,
      throttled: false,
      blockedReason,
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
