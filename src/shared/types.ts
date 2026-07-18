export const graphNodeKinds = [
  "actor",
  "team",
  "system",
  "process",
  "artifact",
  "decision",
  "goal",
  "unknown"
] as const;

export const graphStates = [
  "current",
  "desired",
  "hypothesis",
  "unknown"
] as const;

export const graphEdgeKinds = [
  "hands_off_to",
  "uses",
  "feeds",
  "produces",
  "approves",
  "owns",
  "blocks",
  "depends_on"
] as const;

export type GraphNodeKind = (typeof graphNodeKinds)[number];
export type GraphState = (typeof graphStates)[number];
export type GraphEdgeKind = (typeof graphEdgeKinds)[number];

export interface Participant {
  id: string;
  name: string;
  isBot?: boolean;
  platform?: string;
  platformIdentity?: string;
  joinedAt?: number;
  leftAt?: number;
  present?: boolean;
  role?: ParticipantRole;
}

export type ParticipantRole = "customer" | "operator";

export interface Utterance {
  id: string;
  sequence: number;
  participantId: string;
  participantName: string;
  text: string;
  startedAt: number;
  endedAt: number;
  finalized: boolean;
}

export interface Topic {
  id: string;
  label: string;
  evidenceUtteranceIds: string[];
}

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  state: GraphState;
  confidence: number;
  evidenceUtteranceIds: string[];
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  label?: string;
  state: GraphState;
  confidence: number;
  evidenceUtteranceIds: string[];
}

export interface PainPoint {
  id: string;
  description: string;
  targetNodeIds: string[];
  severity: "low" | "medium" | "high";
  state: GraphState;
  evidenceUtteranceIds: string[];
}

export interface Contradiction {
  id: string;
  description: string;
  evidenceUtteranceIds: string[];
}

export interface SuggestedQuestion {
  text: string;
  evidenceUtteranceIds: string[];
}

export interface BusinessGraph {
  topic: Topic;
  nodes: GraphNode[];
  edges: GraphEdge[];
  pains: PainPoint[];
  contradictions: Contradiction[];
  suggestedQuestion?: SuggestedQuestion;
}

export interface WhiteboardBusinessGraph {
  topic: Omit<Topic, "evidenceUtteranceIds">;
  nodes: Array<Omit<GraphNode, "evidenceUtteranceIds">>;
  edges: Array<Omit<GraphEdge, "evidenceUtteranceIds">>;
  pains: Array<Omit<PainPoint, "evidenceUtteranceIds">>;
  contradictions: Array<Omit<Contradiction, "evidenceUtteranceIds">>;
  suggestedQuestion?: Omit<SuggestedQuestion, "evidenceUtteranceIds">;
}

export type SessionStatus =
  | "creating"
  | "waiting_for_admission"
  | "listening"
  | "analyzing"
  | "ended"
  | "error";

export type IntegrationStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "waiting"
  | "active"
  | "error";

export interface IntegrationState {
  status: IntegrationStatus;
  detail?: string;
  lastEventAt?: number;
}

export interface SessionSnapshot {
  id: string;
  meetingUrl: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  roleRevision: number;
  status: SessionStatus;
  operatorParticipantId?: string;
  participants: Participant[];
  utterances: Utterance[];
  graph: BusinessGraph;
  recall: IntegrationState & { botId?: string };
  codex: IntegrationState & {
    threadId?: string;
    activeTurnId?: string;
  };
  processing: {
    paused: boolean;
    changedAt: number;
    incomingTranscriptPolicy: "discard";
  };
  analysis: {
    status: "idle" | "queued" | "running" | "error";
    pendingUtteranceCount: number;
    automaticTurnsStarted?: number;
    automaticTurnBudget?: number;
    throttled?: boolean;
    blockedReason?: string;
    lastCompletedAt?: number;
    lastError?: string;
  };
}

export interface WhiteboardSnapshot {
  id: string;
  updatedAt: number;
  revision: number;
  roleRevision: number;
  status: SessionStatus;
  graph: WhiteboardBusinessGraph;
  analysis: Pick<SessionSnapshot["analysis"], "status">;
  processing: Pick<SessionSnapshot["processing"], "paused">;
}

export const toWhiteboardSnapshot = (
  snapshot: SessionSnapshot,
  publicId = snapshot.id
): WhiteboardSnapshot => ({
  id: publicId,
  updatedAt: snapshot.updatedAt,
  revision: snapshot.revision,
  roleRevision: snapshot.roleRevision,
  status: snapshot.status,
  graph: {
    topic: {
      id: snapshot.graph.topic.id,
      label: snapshot.graph.topic.label
    },
    nodes: snapshot.graph.nodes.map(({ evidenceUtteranceIds: _, ...node }) => node),
    edges: snapshot.graph.edges.map(({ evidenceUtteranceIds: _, ...edge }) => edge),
    pains: snapshot.graph.pains.map(({ evidenceUtteranceIds: _, ...pain }) => pain),
    contradictions: snapshot.graph.contradictions.map(
      ({ evidenceUtteranceIds: _, ...contradiction }) => contradiction
    ),
    ...(snapshot.graph.suggestedQuestion
      ? {
          suggestedQuestion: {
            text: snapshot.graph.suggestedQuestion.text
          }
        }
      : {})
  },
  analysis: { status: snapshot.analysis.status },
  processing: { paused: snapshot.processing.paused }
});

export const emptyBusinessGraph = (): BusinessGraph => ({
  topic: {
    id: "discovery",
    label: "Business discovery",
    evidenceUtteranceIds: []
  },
  nodes: [],
  edges: [],
  pains: [],
  contradictions: []
});
