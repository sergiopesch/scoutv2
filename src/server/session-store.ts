import { randomUUID } from "node:crypto";
import {
  emptyBusinessGraph,
  type BusinessGraph,
  type IntegrationState,
  type Participant,
  type SessionSnapshot,
  type SessionStatus,
  type Utterance
} from "../shared/types.js";

type Listener = (snapshot: SessionSnapshot) => void;

export class SessionStore {
  private readonly sessions = new Map<string, SessionSnapshot>();
  private readonly listeners = new Map<string, Set<Listener>>();

  create(meetingUrl: string, id: string = randomUUID()): SessionSnapshot {
    const now = Date.now();
    const snapshot: SessionSnapshot = {
      id,
      meetingUrl,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      status: "creating",
      participants: [],
      utterances: [],
      graph: emptyBusinessGraph(),
      recall: { status: "idle" },
      codex: { status: "idle" },
      analysis: {
        status: "idle",
        pendingUtteranceCount: 0
      }
    };

    this.sessions.set(id, snapshot);
    this.emit(id);
    return this.getRequired(id);
  }

  get(id: string): SessionSnapshot | undefined {
    const snapshot = this.sessions.get(id);
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  getRequired(id: string): SessionSnapshot {
    const snapshot = this.get(id);
    if (!snapshot) {
      throw new Error(`Unknown session: ${id}`);
    }
    return snapshot;
  }

  setStatus(id: string, status: SessionStatus): SessionSnapshot {
    return this.update(id, (snapshot) => {
      snapshot.status = status;
    });
  }

  upsertParticipant(id: string, participant: Participant): SessionSnapshot {
    return this.update(id, (snapshot) => {
      const index = snapshot.participants.findIndex(
        (existing) => existing.id === participant.id
      );
      if (index === -1) {
        snapshot.participants.push(participant);
      } else {
        snapshot.participants[index] = participant;
      }
    });
  }

  appendUtterance(id: string, utterance: Utterance): SessionSnapshot {
    return this.update(id, (snapshot) => {
      const index = snapshot.utterances.findIndex(
        (existing) => existing.id === utterance.id
      );
      if (index === -1) {
        snapshot.utterances.push(utterance);
      } else {
        snapshot.utterances[index] = utterance;
      }
      snapshot.utterances.sort((a, b) => a.sequence - b.sequence);
      snapshot.analysis.pendingUtteranceCount = snapshot.utterances.filter(
        (item) => item.finalized
      ).length;
    });
  }

  setRecall(
    id: string,
    state: IntegrationState & { botId?: string }
  ): SessionSnapshot {
    return this.update(id, (snapshot) => {
      snapshot.recall = state;
    });
  }

  setCodex(
    id: string,
    state: IntegrationState & {
      threadId?: string;
      activeTurnId?: string;
    }
  ): SessionSnapshot {
    return this.update(id, (snapshot) => {
      snapshot.codex = state;
    });
  }

  setAnalysis(
    id: string,
    analysis: SessionSnapshot["analysis"]
  ): SessionSnapshot {
    return this.update(id, (snapshot) => {
      snapshot.analysis = analysis;
    });
  }

  acceptGraph(id: string, graph: BusinessGraph): SessionSnapshot {
    return this.update(id, (snapshot) => {
      snapshot.graph = graph;
      snapshot.revision += 1;
      snapshot.analysis = {
        status: "idle",
        pendingUtteranceCount: 0,
        lastCompletedAt: Date.now()
      };
    });
  }

  subscribe(id: string, listener: Listener): () => void {
    if (!this.sessions.has(id)) {
      throw new Error(`Unknown session: ${id}`);
    }
    const listeners = this.listeners.get(id) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    listener(this.getRequired(id));
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(id);
      }
    };
  }

  private update(
    id: string,
    mutation: (snapshot: SessionSnapshot) => void
  ): SessionSnapshot {
    const snapshot = this.sessions.get(id);
    if (!snapshot) {
      throw new Error(`Unknown session: ${id}`);
    }
    mutation(snapshot);
    snapshot.updatedAt = Date.now();
    this.emit(id);
    return this.getRequired(id);
  }

  private emit(id: string): void {
    const snapshot = this.sessions.get(id);
    if (!snapshot) return;
    for (const listener of this.listeners.get(id) ?? []) {
      listener(structuredClone(snapshot));
    }
  }
}
