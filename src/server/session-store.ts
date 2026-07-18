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

export type SessionEvent =
  | {
      sequence: number;
      occurredAt: number;
      type: "session.created";
      sessionId: string;
      meetingUrl: string;
    }
  | {
      sequence: number;
      occurredAt: number;
      type: "session.status-set";
      status: SessionStatus;
    }
  | {
      sequence: number;
      occurredAt: number;
      type: "participant.upserted";
      participant: Participant;
    }
  | {
      sequence: number;
      occurredAt: number;
      type: "operator.selected";
      participantId: string;
      platformIdentity?: string;
    }
  | {
      sequence: number;
      occurredAt: number;
      type: "utterance.recorded";
      utterance: Utterance;
    }
  | {
      sequence: number;
      occurredAt: number;
      type: "recall.state-set";
      state: IntegrationState & { botId?: string };
    }
  | {
      sequence: number;
      occurredAt: number;
      type: "codex.state-set";
      state: IntegrationState & {
        threadId?: string;
        activeTurnId?: string;
      };
    }
  | {
      sequence: number;
      occurredAt: number;
      type: "analysis.state-set";
      analysis: SessionSnapshot["analysis"];
    }
  | {
      sequence: number;
      occurredAt: number;
      type: "processing.paused-set";
      paused: boolean;
    }
  | {
      sequence: number;
      occurredAt: number;
      type: "graph.accepted";
      graph: BusinessGraph;
    }
  | {
      sequence: number;
      occurredAt: number;
      type: "session.context-reset";
    };

type NewSessionEvent = SessionEvent extends infer Event
  ? Event extends SessionEvent
    ? Omit<Event, "sequence" | "occurredAt">
    : never
  : never;

const projectSession = (events: SessionEvent[]): SessionSnapshot => {
  const created = events[0];
  if (!created || created.type !== "session.created") {
    throw new Error("Session event log must begin with session.created.");
  }

  const snapshot: SessionSnapshot = {
    id: created.sessionId,
    meetingUrl: created.meetingUrl,
    createdAt: created.occurredAt,
    updatedAt: created.occurredAt,
    revision: 0,
    status: "creating",
    operatorParticipantId: undefined,
    participants: [],
    utterances: [],
    graph: emptyBusinessGraph(),
    recall: { status: "idle" },
    codex: { status: "idle" },
    processing: {
      paused: false,
      changedAt: created.occurredAt,
      incomingTranscriptPolicy: "discard"
    },
    analysis: { status: "idle", pendingUtteranceCount: 0 }
  };

  let selectedOperatorPlatformIdentity: string | undefined;
  for (const event of events.slice(1)) {
    snapshot.updatedAt = event.occurredAt;
    switch (event.type) {
      case "session.status-set":
        snapshot.status = event.status;
        break;
      case "participant.upserted": {
        const index = snapshot.participants.findIndex(
          (participant) => participant.id === event.participant.id
        );
        if (index === -1) snapshot.participants.push(event.participant);
        else {
          snapshot.participants[index] = {
            ...snapshot.participants[index],
            ...event.participant
          };
        }
        if (
          selectedOperatorPlatformIdentity &&
          event.participant.platformIdentity === selectedOperatorPlatformIdentity
        ) {
          snapshot.operatorParticipantId = event.participant.id;
        }
        break;
      }
      case "operator.selected":
        snapshot.operatorParticipantId = event.participantId;
        selectedOperatorPlatformIdentity = event.platformIdentity;
        break;
      case "utterance.recorded": {
        if (event.utterance.finalized) {
          snapshot.utterances = snapshot.utterances.filter(
            (utterance) =>
              utterance.finalized ||
              utterance.participantId !== event.utterance.participantId ||
              utterance.startedAt < event.utterance.startedAt - 0.5 ||
              utterance.startedAt > event.utterance.endedAt + 0.5
          );
        } else if (
          snapshot.utterances.some(
            (utterance) =>
              utterance.finalized &&
              utterance.participantId === event.utterance.participantId &&
              event.utterance.startedAt >= utterance.startedAt - 0.5 &&
              event.utterance.startedAt <= utterance.endedAt + 0.5
          )
        ) {
          break;
        }
        const index = snapshot.utterances.findIndex(
          (utterance) => utterance.id === event.utterance.id
        );
        if (index === -1) {
          snapshot.utterances.push(event.utterance);
          if (event.utterance.finalized) {
            snapshot.analysis.pendingUtteranceCount += 1;
          }
        } else {
          snapshot.utterances[index] = event.utterance;
        }
        snapshot.utterances.sort((left, right) => left.sequence - right.sequence);
        break;
      }
      case "recall.state-set":
        snapshot.recall = event.state;
        break;
      case "codex.state-set":
        snapshot.codex = event.state;
        break;
      case "analysis.state-set":
        snapshot.analysis = event.analysis;
        break;
      case "processing.paused-set":
        snapshot.processing = {
          paused: event.paused,
          changedAt: event.occurredAt,
          incomingTranscriptPolicy: "discard"
        };
        break;
      case "graph.accepted":
        snapshot.graph = event.graph;
        snapshot.revision += 1;
        snapshot.analysis = {
          status: "idle",
          pendingUtteranceCount: 0,
          lastCompletedAt: event.occurredAt
        };
        break;
      case "session.context-reset":
        snapshot.utterances = [];
        snapshot.graph = emptyBusinessGraph();
        snapshot.revision = 0;
        snapshot.codex = { status: "idle" };
        snapshot.analysis = { status: "idle", pendingUtteranceCount: 0 };
        break;
      case "session.created":
        throw new Error("session.created may only be the first event.");
    }
  }

  snapshot.participants = snapshot.participants.map((participant) => ({
    ...participant,
    role: participant.isBot
      ? "unknown"
      : snapshot.operatorParticipantId === undefined
        ? "unknown"
        : participant.id === snapshot.operatorParticipantId ||
            (selectedOperatorPlatformIdentity !== undefined &&
              participant.platformIdentity === selectedOperatorPlatformIdentity)
          ? "operator"
          : "client"
  }));

  return snapshot;
};

export class SessionStore {
  private readonly eventLogs = new Map<string, SessionEvent[]>();
  private readonly projections = new Map<string, SessionSnapshot>();
  private readonly listeners = new Map<string, Set<Listener>>();

  create(meetingUrl: string, id: string = randomUUID()): SessionSnapshot {
    if (this.eventLogs.has(id)) throw new Error(`Session already exists: ${id}`);
    const occurredAt = Date.now();
    const created: SessionEvent = {
      sequence: 0,
      occurredAt,
      type: "session.created",
      sessionId: id,
      meetingUrl
    };
    this.eventLogs.set(id, [created]);
    this.rebuildProjection(id);
    this.emit(id);
    return this.getRequired(id);
  }

  get(id: string): SessionSnapshot | undefined {
    const snapshot = this.projections.get(id);
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  getRequired(id: string): SessionSnapshot {
    const snapshot = this.get(id);
    if (!snapshot) throw new Error(`Unknown session: ${id}`);
    return snapshot;
  }

  getEvents(id: string): SessionEvent[] {
    const events = this.eventLogs.get(id);
    if (!events) throw new Error(`Unknown session: ${id}`);
    return structuredClone(events);
  }

  rebuild(id: string): SessionSnapshot {
    this.rebuildProjection(id);
    return this.getRequired(id);
  }

  setStatus(id: string, status: SessionStatus): SessionSnapshot {
    return this.append(id, { type: "session.status-set", status });
  }

  upsertParticipant(id: string, participant: Participant): SessionSnapshot {
    return this.append(id, { type: "participant.upserted", participant });
  }

  selectOperator(id: string, participantId: string): SessionSnapshot {
    const participant = this.getRequired(id).participants.find(
      (candidate) => candidate.id === participantId
    );
    if (!participant) {
      throw new Error(`Unknown participant: ${participantId}`);
    }
    if (participant.isBot) {
      throw new Error("The Scout meeting bot cannot be selected as operator.");
    }
    return this.append(id, {
      type: "operator.selected",
      participantId,
      platformIdentity: participant.platformIdentity
    });
  }

  appendUtterance(id: string, utterance: Utterance): SessionSnapshot {
    return this.append(id, { type: "utterance.recorded", utterance });
  }

  setRecall(
    id: string,
    state: IntegrationState & { botId?: string }
  ): SessionSnapshot {
    return this.append(id, { type: "recall.state-set", state });
  }

  setCodex(
    id: string,
    state: IntegrationState & {
      threadId?: string;
      activeTurnId?: string;
    }
  ): SessionSnapshot {
    return this.append(id, { type: "codex.state-set", state });
  }

  setAnalysis(
    id: string,
    analysis: SessionSnapshot["analysis"]
  ): SessionSnapshot {
    return this.append(id, { type: "analysis.state-set", analysis });
  }

  setProcessingPaused(id: string, paused: boolean): SessionSnapshot {
    const current = this.getRequired(id);
    if (current.processing.paused === paused) return current;
    return this.append(id, { type: "processing.paused-set", paused });
  }

  acceptGraph(id: string, graph: BusinessGraph): SessionSnapshot {
    return this.append(id, { type: "graph.accepted", graph });
  }

  resetContext(id: string): SessionSnapshot {
    const current = this.getRequired(id);
    const created = this.eventLogs.get(id)?.[0];
    if (!created || created.type !== "session.created") {
      throw new Error(`Session event log must begin with session.created: ${id}`);
    }

    const occurredAt = Date.now();
    const retainedEvents: SessionEvent[] = [
      structuredClone(created),
      {
        sequence: 1,
        occurredAt,
        type: "session.status-set",
        status: current.status === "analyzing" ? "listening" : current.status
      },
      ...current.participants.map(
        (participant, index): SessionEvent => ({
          sequence: index + 2,
          occurredAt,
          type: "participant.upserted",
          participant
        })
      )
    ];
    if (current.operatorParticipantId) {
      const operator = current.participants.find(
        (participant) => participant.id === current.operatorParticipantId
      );
      retainedEvents.push({
        sequence: retainedEvents.length,
        occurredAt,
        type: "operator.selected",
        participantId: current.operatorParticipantId,
        platformIdentity: operator?.platformIdentity
      });
    }
    retainedEvents.push({
      sequence: retainedEvents.length,
      occurredAt,
      type: "recall.state-set",
      state: current.recall
    });
    retainedEvents.push({
      sequence: retainedEvents.length,
      occurredAt: current.processing.changedAt,
      type: "processing.paused-set",
      paused: current.processing.paused
    });
    retainedEvents.push({
      sequence: retainedEvents.length,
      occurredAt,
      type: "session.context-reset"
    });

    this.eventLogs.set(id, structuredClone(retainedEvents));
    this.rebuildProjection(id);
    this.emit(id);
    return this.getRequired(id);
  }

  subscribe(id: string, listener: Listener): () => void {
    if (!this.eventLogs.has(id)) throw new Error(`Unknown session: ${id}`);
    const listeners = this.listeners.get(id) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    listener(this.getRequired(id));
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(id);
    };
  }

  private append(id: string, event: NewSessionEvent): SessionSnapshot {
    const events = this.eventLogs.get(id);
    if (!events) throw new Error(`Unknown session: ${id}`);
    events.push(
      structuredClone({
        ...event,
        sequence: events.length,
        occurredAt: Date.now()
      }) as SessionEvent
    );
    this.rebuildProjection(id);
    this.emit(id);
    return this.getRequired(id);
  }

  private rebuildProjection(id: string): void {
    const events = this.eventLogs.get(id);
    if (!events) throw new Error(`Unknown session: ${id}`);
    this.projections.set(id, projectSession(structuredClone(events)));
  }

  private emit(id: string): void {
    const snapshot = this.projections.get(id);
    if (!snapshot) return;
    for (const listener of this.listeners.get(id) ?? []) {
      listener(structuredClone(snapshot));
    }
  }
}
