import type { MeetingAnalyzer } from "./contracts.js";
import { SessionStore } from "./session-store.js";

interface SessionAnalysisState {
  processedUtteranceIds: Set<string>;
  timer?: NodeJS.Timeout;
  running: boolean;
  runAgain: boolean;
}

export class AnalysisCoordinator {
  private readonly sessions = new Map<string, SessionAnalysisState>();

  constructor(
    private readonly store: SessionStore,
    private readonly analyzer: MeetingAnalyzer,
    private readonly initialDelayMs = 500,
    private readonly rerunDelayMs = 250
  ) {}

  schedule(sessionId: string): void {
    const state = this.stateFor(sessionId);
    const pendingCount = this.pendingUtteranceIds(sessionId, state).length;
    if (pendingCount === 0) return;

    if (state.running) {
      state.runAgain = true;
      this.updateQueuedCount(sessionId, pendingCount);
      return;
    }

    this.updateQueuedCount(sessionId, pendingCount);
    this.scheduleAfter(sessionId, state, this.initialDelayMs);
  }

  async analyzeNow(sessionId: string): Promise<void> {
    const state = this.stateFor(sessionId);
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }

    if (state.running) {
      state.runAgain = true;
      return;
    }

    const snapshot = this.store.getRequired(sessionId);
    const newUtterances = snapshot.utterances.filter(
      (utterance) =>
        utterance.finalized && !state.processedUtteranceIds.has(utterance.id)
    );
    if (newUtterances.length === 0) return;

    state.running = true;
    state.runAgain = false;
    this.store.setStatus(sessionId, "analyzing");
    this.store.setAnalysis(sessionId, {
      status: "running",
      pendingUtteranceCount: newUtterances.length
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

      for (const utterance of newUtterances) {
        state.processedUtteranceIds.add(utterance.id);
      }
      this.store.setCodex(sessionId, {
        status: "connected",
        threadId: result.threadId
      });
      this.store.acceptGraph(sessionId, result.graph);
      this.store.setStatus(sessionId, "listening");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.setCodex(sessionId, {
        status: "error",
        detail: message,
        threadId: snapshot.codex.threadId
      });
      this.store.setAnalysis(sessionId, {
        status: "error",
        pendingUtteranceCount: newUtterances.length,
        lastError: message
      });
      this.store.setStatus(sessionId, "listening");
    } finally {
      state.running = false;
      const pendingCount = this.pendingUtteranceIds(sessionId, state).length;
      if (state.runAgain && pendingCount > 0) {
        state.runAgain = false;
        this.updateQueuedCount(sessionId, pendingCount);
        this.scheduleAfter(sessionId, state, this.rerunDelayMs);
      } else {
        state.runAgain = false;
      }
    }
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
      runAgain: false
    };
    this.sessions.set(sessionId, created);
    return created;
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
      lastError: undefined
    });
  }

  private scheduleAfter(
    sessionId: string,
    state: SessionAnalysisState,
    delayMs: number
  ): void {
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.analyzeNow(sessionId);
    }, delayMs);
  }
}
