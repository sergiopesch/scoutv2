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
  platform?: string;
  joinedAt?: number;
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
}

export interface SessionSnapshot {
  id: string;
  meetingUrl: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  status: SessionStatus;
  participants: Participant[];
  utterances: Utterance[];
  graph: BusinessGraph;
  recall: IntegrationState & { botId?: string };
  codex: IntegrationState & {
    threadId?: string;
    activeTurnId?: string;
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
  status: SessionStatus;
  graph: BusinessGraph;
  analysis: Pick<SessionSnapshot["analysis"], "status">;
}

export const toWhiteboardSnapshot = (
  snapshot: SessionSnapshot
): WhiteboardSnapshot => ({
  id: snapshot.id,
  updatedAt: snapshot.updatedAt,
  revision: snapshot.revision,
  status: snapshot.status,
  graph: structuredClone(snapshot.graph),
  analysis: { status: snapshot.analysis.status }
});

export const emptyBusinessGraph = (): BusinessGraph => ({
  topic: { id: "discovery", label: "Business discovery" },
  nodes: [],
  edges: [],
  pains: [],
  contradictions: []
});
