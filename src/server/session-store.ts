import { randomUUID } from "node:crypto";
import {
  emptyBusinessGraph,
  type BusinessGraph,
  type IntegrationState,
  type Participant,
  type ParticipantRole,
  type SessionSnapshot,
  type SessionStatus,
  type Utterance,
  type WhiteboardSnapshot,
  toWhiteboardSnapshot
} from "../shared/types.js";

type Listener = (snapshot: SessionSnapshot) => void;
type WhiteboardListener = (snapshot: WhiteboardSnapshot) => void;

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
      type: "participant.role-set";
      participantId: string;
      role?: ParticipantRole;
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
      type: "post-call.edited";
      graph: BusinessGraph;
      notes: string;
    }
  | {
      sequence: number;
      occurredAt: number;
      type: "session.context-reset";
      roleRevision: number;
    };

type NewSessionEvent = SessionEvent extends infer Event
  ? Event extends SessionEvent
    ? Omit<Event, "sequence" | "occurredAt">
    : never
  : never;

interface ProjectionState {
  selectedOperatorPlatformIdentity?: string;
}

const newProjection = (
  created: Extract<SessionEvent, { type: "session.created" }>
): SessionSnapshot => ({
  id: created.sessionId,
  meetingUrl: created.meetingUrl,
  createdAt: created.occurredAt,
  updatedAt: created.occurredAt,
  revision: 0,
  roleRevision: 0,
  status: "creating",
  operatorParticipantId: undefined,
  participants: [],
  utterances: [],
  graph: emptyBusinessGraph(),
  postCall: { revision: 0, notes: "" },
  recall: { status: "idle" },
  codex: { status: "idle" },
  processing: {
    paused: false,
    changedAt: created.occurredAt,
    incomingTranscriptPolicy: "discard"
  },
  analysis: { status: "idle", pendingUtteranceCount: 0 }
});

const projectionStateFor = (snapshot: SessionSnapshot): ProjectionState => ({
  selectedOperatorPlatformIdentity: snapshot.participants.find(
    (participant) => participant.id === snapshot.operatorParticipantId
  )?.platformIdentity
});

const resolveParticipantRoles = (
  snapshot: SessionSnapshot,
  state: ProjectionState
): void => {
  if (snapshot.operatorParticipantId === undefined) return;
  snapshot.participants = snapshot.participants.map((participant) => {
    if (participant.isBot) {
      const { role: _role, ...bot } = participant;
      return bot;
    }
    const isOperator =
      participant.id === snapshot.operatorParticipantId ||
      (state.selectedOperatorPlatformIdentity !== undefined &&
        participant.platformIdentity === state.selectedOperatorPlatformIdentity);
    return { ...participant, role: isOperator ? "operator" : "customer" };
  });
};

const invalidateAnalysisForRoleChange = (snapshot: SessionSnapshot): void => {
  snapshot.roleRevision += 1;
  snapshot.graph = emptyBusinessGraph();
  snapshot.revision = 0;
  snapshot.codex = { status: "idle" };
  snapshot.analysis = {
    status: "idle",
    pendingUtteranceCount: snapshot.utterances.filter(
      (utterance) => utterance.finalized
    ).length
  };
  snapshot.postCall = { revision: 0, notes: "" };
  if (snapshot.status === "analyzing") snapshot.status = "listening";
};

const applySessionEvent = (
  snapshot: SessionSnapshot,
  event: Exclude<SessionEvent, { type: "session.created" }>,
  state: ProjectionState
): void => {
  snapshot.updatedAt = event.occurredAt;
  switch (event.type) {
    case "session.status-set":
      snapshot.status = event.status;
      if (event.status === "ended" && snapshot.endedAt === undefined) {
        snapshot.endedAt = event.occurredAt;
      }
      break;
    case "participant.upserted": {
      const index = snapshot.participants.findIndex(
        (participant) => participant.id === event.participant.id
      );
      if (index === -1) snapshot.participants.push(event.participant);
      else {
        const existing = snapshot.participants[index];
        snapshot.participants[index] = {
          ...existing,
          ...event.participant,
          ...(existing?.role && !event.participant.role
            ? { role: existing.role }
            : {})
        };
      }
      if (
        state.selectedOperatorPlatformIdentity &&
        event.participant.platformIdentity ===
          state.selectedOperatorPlatformIdentity
      ) {
        snapshot.operatorParticipantId = event.participant.id;
      }
      if (
        event.participant.id === snapshot.operatorParticipantId &&
        event.participant.platformIdentity
      ) {
        state.selectedOperatorPlatformIdentity =
          event.participant.platformIdentity;
      }
      break;
    }
    case "participant.role-set": {
      const participant = snapshot.participants.find(
        (item) => item.id === event.participantId
      );
      if (!participant) {
        throw new Error(
          `Cannot set a role for unknown participant ${event.participantId}.`
        );
      }
      if (participant.role !== event.role) {
        if (event.role) participant.role = event.role;
        else delete participant.role;
        invalidateAnalysisForRoleChange(snapshot);
      }
      break;
    }
    case "operator.selected": {
      const previousIdentity =
        state.selectedOperatorPlatformIdentity ?? snapshot.operatorParticipantId;
      const nextIdentity = event.platformIdentity ?? event.participantId;
      if (previousIdentity !== nextIdentity) {
        invalidateAnalysisForRoleChange(snapshot);
      }
      snapshot.operatorParticipantId = event.participantId;
      state.selectedOperatorPlatformIdentity = event.platformIdentity;
      break;
    }
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
      delete snapshot.postCall.approvedAt;
      delete snapshot.postCall.approvedGraphRevision;
      snapshot.analysis = {
        ...snapshot.analysis,
        status: "idle",
        pendingUtteranceCount: 0,
        lastCompletedAt: event.occurredAt,
        lastError: undefined,
        blockedReason: undefined
      };
      break;
    case "post-call.edited":
      snapshot.graph = event.graph;
      snapshot.revision += 1;
      snapshot.postCall = {
        revision: snapshot.postCall.revision + 1,
        notes: event.notes,
        lastEditedAt: event.occurredAt,
        approvedAt: event.occurredAt,
        approvedGraphRevision: snapshot.revision
      };
      break;
    case "session.context-reset":
      // Resetting the conversation must not rewind the role-generation
      // barrier. Older SSE snapshots and in-flight Codex turns are ordered
      // against this monotonic value.
      snapshot.roleRevision = Math.max(
        snapshot.roleRevision,
        event.roleRevision
      );
      snapshot.utterances = [];
      snapshot.graph = emptyBusinessGraph();
      snapshot.postCall = { revision: 0, notes: "" };
      snapshot.revision = 0;
      snapshot.codex = { status: "idle" };
      snapshot.analysis = { status: "idle", pendingUtteranceCount: 0 };
      break;
  }
  resolveParticipantRoles(snapshot, state);
};

const projectSession = (events: SessionEvent[]): SessionSnapshot => {
  const created = events[0];
  if (!created || created.type !== "session.created") {
    throw new Error("Session event log must begin with session.created.");
  }
  const snapshot = newProjection(created);
  const state: ProjectionState = {};
  for (const event of events.slice(1)) {
    if (event.type === "session.created") {
      throw new Error("session.created may only be the first event.");
    }
    applySessionEvent(snapshot, event, state);
  }
  return snapshot;
};

export class SessionRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number
  ) {
    super(
      `Expected graph revision ${expectedRevision}, but revision ${currentRevision} is current.`
    );
    this.name = "SessionRevisionConflictError";
  }
}

export class SessionStore {
  private readonly eventLogs = new Map<string, SessionEvent[]>();
  private readonly projections = new Map<string, SessionSnapshot>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly whiteboardListeners = new Map<
    string,
    Set<WhiteboardListener>
  >();

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

  list(): SessionSnapshot[] {
    return [...this.projections.values()].map((snapshot) =>
      structuredClone(snapshot)
    );
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
    const current = this.getRequired(id);
    const participant = current.participants.find(
      (candidate) => candidate.id === participantId
    );
    if (!participant) {
      throw new Error(`Unknown participant: ${participantId}`);
    }
    if (participant.isBot) {
      throw new Error("The Scout meeting bot cannot be selected as operator.");
    }
    const currentOperator = current.participants.find(
      (candidate) => candidate.id === current.operatorParticipantId
    );
    const currentIdentity =
      currentOperator?.platformIdentity ?? current.operatorParticipantId;
    const nextIdentity = participant.platformIdentity ?? participant.id;
    if (currentIdentity === nextIdentity) return current;
    return this.append(id, {
      type: "operator.selected",
      participantId,
      platformIdentity: participant.platformIdentity
    });
  }

  setParticipantRole(
    id: string,
    participantId: string,
    role?: ParticipantRole
  ): SessionSnapshot {
    const snapshot = this.getRequired(id);
    const participant = snapshot.participants.find(
      (candidate) => candidate.id === participantId
    );
    if (!participant) {
      throw new Error(`Unknown participant: ${participantId}`);
    }
    if (snapshot.operatorParticipantId) {
      if (role === participant.role) return snapshot;
      throw new Error(
        "Participant roles are controlled by operator self-selection; select the operator instead."
      );
    }
    return this.append(id, { type: "participant.role-set", participantId, role });
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

  editPostCall(
    id: string,
    expectedRevision: number,
    graph: BusinessGraph,
    notes: string
  ): SessionSnapshot {
    const current = this.getRequired(id);
    if (current.status !== "ended") {
      throw new Error("Post-call editing is available only after the meeting ends.");
    }
    if (
      current.analysis.status === "running" ||
      current.analysis.status === "queued" ||
      current.analysis.pendingUtteranceCount > 0
    ) {
      throw new Error("Finish the final analysis before editing the accepted map.");
    }
    if (current.revision !== expectedRevision) {
      throw new SessionRevisionConflictError(expectedRevision, current.revision);
    }
    return this.append(id, { type: "post-call.edited", graph, notes });
  }

  resetContext(id: string): SessionSnapshot {
    const current = this.getRequired(id);
    const created = this.eventLogs.get(id)?.[0];
    if (!created || created.type !== "session.created") {
      throw new Error(`Session event log must begin with session.created: ${id}`);
    }

    const occurredAt = Math.max(Date.now(), current.updatedAt + 1);
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
      type: "session.context-reset",
      roleRevision: current.roleRevision
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
    try {
      listener(this.getRequired(id));
    } catch (error) {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(id);
      throw error;
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(id);
    };
  }

  subscribeWhiteboard(id: string, listener: WhiteboardListener): () => void {
    if (!this.eventLogs.has(id)) throw new Error(`Unknown session: ${id}`);
    const listeners =
      this.whiteboardListeners.get(id) ?? new Set<WhiteboardListener>();
    listeners.add(listener);
    this.whiteboardListeners.set(id, listeners);
    try {
      listener(toWhiteboardSnapshot(this.projections.get(id)!));
    } catch (error) {
      listeners.delete(listener);
      if (listeners.size === 0) this.whiteboardListeners.delete(id);
      throw error;
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.whiteboardListeners.delete(id);
    };
  }

  delete(id: string): boolean {
    const existed = this.eventLogs.delete(id);
    this.projections.delete(id);
    this.listeners.delete(id);
    this.whiteboardListeners.delete(id);
    return existed;
  }

  private append(id: string, event: NewSessionEvent): SessionSnapshot {
    const events = this.eventLogs.get(id);
    if (!events) throw new Error(`Unknown session: ${id}`);
    if (event.type === "utterance.recorded") {
      this.compactPartialHistory(events, event.utterance);
    }
    const storedEvent = structuredClone({
      ...event,
      sequence: events.length,
      occurredAt: Math.max(
        Date.now(),
        (this.projections.get(id)?.updatedAt ?? events.at(-1)?.occurredAt ?? 0) + 1
      )
    }) as SessionEvent;
    if (storedEvent.type === "session.created") {
      throw new Error("session.created may only be the first event.");
    }
    events.push(storedEvent);
    const current = this.projections.get(id);
    if (current) {
      // Projections are never exposed directly: reads and listener emissions
      // clone them. Mutating the canonical projection here avoids copying an
      // ever-growing transcript once merely to apply one event.
      applySessionEvent(current, storedEvent, projectionStateFor(current));
    } else {
      this.rebuildProjection(id);
    }
    this.emit(id);
    return this.getRequired(id);
  }

  private compactPartialHistory(
    events: SessionEvent[],
    utterance: Utterance
  ): void {
    const retained = events.filter((candidate) => {
      if (
        candidate.type !== "utterance.recorded" ||
        candidate.utterance.finalized
      ) {
        return true;
      }
      const partial = candidate.utterance;
      if (!utterance.finalized) return partial.id !== utterance.id;
      return (
        partial.participantId !== utterance.participantId ||
        partial.startedAt < utterance.startedAt - 0.5 ||
        partial.startedAt > utterance.endedAt + 0.5
      );
    });
    if (retained.length === events.length) return;
    events.splice(
      0,
      events.length,
      ...retained.map((candidate, sequence) => ({
        ...candidate,
        sequence
      }))
    );
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
      try {
        listener(structuredClone(snapshot));
      } catch {
        this.listeners.get(id)?.delete(listener);
      }
    }
    const whiteboardListeners = this.whiteboardListeners.get(id);
    if (whiteboardListeners?.size) {
      const whiteboard = toWhiteboardSnapshot(snapshot);
      for (const listener of whiteboardListeners) {
        try {
          listener(structuredClone(whiteboard));
        } catch {
          whiteboardListeners.delete(listener);
        }
      }
      if (whiteboardListeners.size === 0) this.whiteboardListeners.delete(id);
    }
    if (this.listeners.get(id)?.size === 0) this.listeners.delete(id);
  }
}
