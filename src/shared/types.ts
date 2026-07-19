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

export const graphViewKinds = [
  "process",
  "organization",
  "architecture"
] as const;

export const graphScopes = ["current", "desired", "both"] as const;
export const graphCertainties = [
  "asserted",
  "hypothesis",
  "unknown",
  "conflicted"
] as const;

export const processNodeKinds = [
  "pool",
  "lane",
  "start",
  "end",
  "activity",
  "subprocess",
  "exclusive_gateway",
  "parallel_gateway",
  "inclusive_gateway",
  "event_gateway",
  "intermediate_event",
  "document",
  "data_store"
] as const;

export const processTaskTypes = [
  "user",
  "manual",
  "service",
  "script",
  "business_rule",
  "send",
  "receive",
  "call_activity",
  "unknown"
] as const;

export const organizationNodeKinds = ["person", "position", "unit"] as const;

export const architectureNodeKinds = [
  "person",
  "external_system",
  "software_system",
  "service",
  "application",
  "api",
  "gateway",
  "worker",
  "database",
  "data_store",
  "queue",
  "event_bus",
  "file_store",
  "integration",
  "device",
  "network",
  "boundary"
] as const;

export const processEdgeKinds = ["sequence", "message", "association"] as const;
export const organizationEdgeKinds = [
  "primary_report",
  "secondary_report"
] as const;
export const architectureEdgeKinds = ["connection"] as const;

export type GraphNodeKind = (typeof graphNodeKinds)[number];
export type GraphState = (typeof graphStates)[number];
export type GraphEdgeKind = (typeof graphEdgeKinds)[number];
export type GraphViewKind = (typeof graphViewKinds)[number];
export type GraphScope = (typeof graphScopes)[number];
export type GraphCertainty = (typeof graphCertainties)[number];
export type ProcessNodeKind = (typeof processNodeKinds)[number];
export type ProcessTaskType = (typeof processTaskTypes)[number];
export type OrganizationNodeKind = (typeof organizationNodeKinds)[number];
export type ArchitectureNodeKind = (typeof architectureNodeKinds)[number];
export type ProcessEdgeKind = (typeof processEdgeKinds)[number];
export type OrganizationEdgeKind = (typeof organizationEdgeKinds)[number];
export type ArchitectureEdgeKind = (typeof architectureEdgeKinds)[number];

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

export interface ProcessNodeFacet {
  kind: ProcessNodeKind;
  placement?: {
    current?: ProcessPlacement;
    desired?: ProcessPlacement;
  };
  taskType?: ProcessTaskType;
}

export interface ProcessPlacement {
  ownerNodeId?: string;
  laneNodeId?: string;
  poolNodeId?: string;
}

export interface OrganizationNodeFacet {
  kind: OrganizationNodeKind;
  unitNodeIdByScope?: {
    current?: string;
    desired?: string;
  };
  positionStatusByScope?: {
    current?: "filled" | "vacant" | "unknown";
    desired?: "filled" | "vacant" | "unknown";
  };
}

export interface ArchitectureNodeFacet {
  kind: ArchitectureNodeKind;
  parentBoundaryNodeIdByScope?: {
    current?: string;
    desired?: string;
  };
  boundaryKind?:
    | "organization"
    | "domain"
    | "cloud"
    | "account"
    | "region"
    | "environment"
    | "network"
    | "vpc"
    | "subnet"
    | "cluster"
    | "namespace"
    | "security_zone";
  vendor?: string;
  product?: string;
  technology?: string;
}

export interface GraphNodeFacets {
  process?: ProcessNodeFacet;
  organization?: OrganizationNodeFacet;
  architecture?: ArchitectureNodeFacet;
}

export interface ProcessEdgeFacet {
  kind: ProcessEdgeKind;
  condition?: string;
  isDefault?: boolean;
}

export interface OrganizationEdgeFacet {
  kind: OrganizationEdgeKind;
  relationship?: string;
}

export interface ArchitectureEdgeFacet {
  kind: ArchitectureEdgeKind;
  interaction?: "synchronous" | "asynchronous" | "batch" | "stream" | "unknown";
  protocol?: string;
  dataDescription?: string;
}

export interface GraphEdgeFacets {
  process?: ProcessEdgeFacet;
  organization?: OrganizationEdgeFacet;
  architecture?: ArchitectureEdgeFacet;
}

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  shortLabel?: string;
  aliases?: string[];
  state: GraphState;
  scope?: GraphScope;
  certainty?: GraphCertainty;
  confidence: number;
  provenance?: "meeting" | "post_call_editorial";
  facets?: GraphNodeFacets;
  evidenceUtteranceIds: string[];
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  label?: string;
  state: GraphState;
  scope?: GraphScope;
  certainty?: GraphCertainty;
  confidence: number;
  provenance?: "meeting" | "post_call_editorial";
  facets?: GraphEdgeFacets;
  evidenceUtteranceIds: string[];
}

export interface PainPoint {
  id: string;
  description: string;
  targetNodeIds: string[];
  severity: "low" | "medium" | "high";
  state: GraphState;
  scope?: GraphScope;
  certainty?: GraphCertainty;
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

export interface PostCallReviewState {
  revision: number;
  notes: string;
  lastEditedAt?: number;
  approvedAt?: number;
  approvedGraphRevision?: number;
}

export interface WhiteboardGraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  shortLabel?: string;
  state: GraphState;
  scope?: GraphScope;
  certainty?: GraphCertainty;
  confidence: number;
  facets?: GraphNodeFacets;
}

export interface WhiteboardGraphEdge {
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  label?: string;
  state: GraphState;
  scope?: GraphScope;
  certainty?: GraphCertainty;
  confidence: number;
  facets?: GraphEdgeFacets;
}

export interface WhiteboardPainPoint
  extends Pick<PainPoint, "id" | "description" | "targetNodeIds" | "severity" | "state"> {
  scope?: GraphScope;
  certainty?: GraphCertainty;
}

export interface WhiteboardBusinessGraph {
  topic: Pick<Topic, "id" | "label">;
  nodes: WhiteboardGraphNode[];
  edges: WhiteboardGraphEdge[];
  pains: WhiteboardPainPoint[];
  contradictions: Array<Pick<Contradiction, "id" | "description">>;
  suggestedQuestion?: Pick<SuggestedQuestion, "text">;
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
  endedAt?: number;
  revision: number;
  roleRevision: number;
  status: SessionStatus;
  operatorParticipantId?: string;
  participants: Participant[];
  utterances: Utterance[];
  graph: BusinessGraph;
  postCall: PostCallReviewState;
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

const publicNode = (node: GraphNode): WhiteboardGraphNode => ({
  id: node.id,
  kind: node.kind,
  label: node.label,
  ...(node.shortLabel === undefined ? {} : { shortLabel: node.shortLabel }),
  state: node.state,
  ...(node.scope === undefined ? {} : { scope: node.scope }),
  ...(node.certainty === undefined ? {} : { certainty: node.certainty }),
  confidence: node.confidence,
  ...(node.facets === undefined
    ? {}
    : {
        facets: {
          ...(node.facets.process
            ? {
                process: {
                  kind: node.facets.process.kind,
                  ...(node.facets.process.placement === undefined
                    ? {}
                    : {
                        placement: {
                          ...(node.facets.process.placement.current
                            ? {
                                current: {
                                  ...(node.facets.process.placement.current.ownerNodeId === undefined
                                    ? {}
                                    : { ownerNodeId: node.facets.process.placement.current.ownerNodeId }),
                                  ...(node.facets.process.placement.current.laneNodeId === undefined
                                    ? {}
                                    : { laneNodeId: node.facets.process.placement.current.laneNodeId }),
                                  ...(node.facets.process.placement.current.poolNodeId === undefined
                                    ? {}
                                    : { poolNodeId: node.facets.process.placement.current.poolNodeId })
                                }
                              }
                            : {}),
                          ...(node.facets.process.placement.desired
                            ? {
                                desired: {
                                  ...(node.facets.process.placement.desired.ownerNodeId === undefined
                                    ? {}
                                    : { ownerNodeId: node.facets.process.placement.desired.ownerNodeId }),
                                  ...(node.facets.process.placement.desired.laneNodeId === undefined
                                    ? {}
                                    : { laneNodeId: node.facets.process.placement.desired.laneNodeId }),
                                  ...(node.facets.process.placement.desired.poolNodeId === undefined
                                    ? {}
                                    : { poolNodeId: node.facets.process.placement.desired.poolNodeId })
                                }
                              }
                            : {})
                        }
                      }),
                  ...(node.facets.process.taskType === undefined
                    ? {}
                    : { taskType: node.facets.process.taskType })
                }
              }
            : {}),
          ...(node.facets.organization
            ? {
                organization: {
                  kind: node.facets.organization.kind,
                  ...(node.facets.organization.unitNodeIdByScope === undefined
                    ? {}
                    : {
                        unitNodeIdByScope: {
                          ...(node.facets.organization.unitNodeIdByScope.current === undefined
                            ? {}
                            : { current: node.facets.organization.unitNodeIdByScope.current }),
                          ...(node.facets.organization.unitNodeIdByScope.desired === undefined
                            ? {}
                            : { desired: node.facets.organization.unitNodeIdByScope.desired })
                        }
                      }),
                  ...(node.facets.organization.positionStatusByScope === undefined
                    ? {}
                    : {
                        positionStatusByScope: {
                          ...(node.facets.organization.positionStatusByScope.current === undefined
                            ? {}
                            : { current: node.facets.organization.positionStatusByScope.current }),
                          ...(node.facets.organization.positionStatusByScope.desired === undefined
                            ? {}
                            : { desired: node.facets.organization.positionStatusByScope.desired })
                        }
                      })
                }
              }
            : {}),
          ...(node.facets.architecture
            ? {
                architecture: {
                  kind: node.facets.architecture.kind,
                  ...(node.facets.architecture.parentBoundaryNodeIdByScope === undefined
                    ? {}
                    : {
                        parentBoundaryNodeIdByScope: {
                          ...(node.facets.architecture.parentBoundaryNodeIdByScope.current === undefined
                            ? {}
                            : { current: node.facets.architecture.parentBoundaryNodeIdByScope.current }),
                          ...(node.facets.architecture.parentBoundaryNodeIdByScope.desired === undefined
                            ? {}
                            : { desired: node.facets.architecture.parentBoundaryNodeIdByScope.desired })
                        }
                      }),
                  ...(node.facets.architecture.boundaryKind === undefined
                    ? {}
                    : { boundaryKind: node.facets.architecture.boundaryKind }),
                  ...(node.facets.architecture.vendor === undefined
                    ? {}
                    : { vendor: node.facets.architecture.vendor }),
                  ...(node.facets.architecture.product === undefined
                    ? {}
                    : { product: node.facets.architecture.product }),
                  ...(node.facets.architecture.technology === undefined
                    ? {}
                    : { technology: node.facets.architecture.technology })
                }
              }
            : {})
        }
      })
});

const publicEdge = (edge: GraphEdge): WhiteboardGraphEdge => ({
  id: edge.id,
  from: edge.from,
  to: edge.to,
  kind: edge.kind,
  ...(edge.label === undefined ? {} : { label: edge.label }),
  state: edge.state,
  ...(edge.scope === undefined ? {} : { scope: edge.scope }),
  ...(edge.certainty === undefined ? {} : { certainty: edge.certainty }),
  confidence: edge.confidence,
  ...(edge.facets === undefined
    ? {}
    : {
        facets: {
          ...(edge.facets.process
            ? {
                process: {
                  kind: edge.facets.process.kind,
                  ...(edge.facets.process.condition === undefined
                    ? {}
                    : { condition: edge.facets.process.condition }),
                  ...(edge.facets.process.isDefault === undefined
                    ? {}
                    : { isDefault: edge.facets.process.isDefault })
                }
              }
            : {}),
          ...(edge.facets.organization
            ? {
                organization: {
                  kind: edge.facets.organization.kind,
                  ...(edge.facets.organization.relationship === undefined
                    ? {}
                    : { relationship: edge.facets.organization.relationship })
                }
              }
            : {}),
          ...(edge.facets.architecture
            ? {
                architecture: {
                  kind: edge.facets.architecture.kind,
                  ...(edge.facets.architecture.interaction === undefined
                    ? {}
                    : { interaction: edge.facets.architecture.interaction }),
                  ...(edge.facets.architecture.protocol === undefined
                    ? {}
                    : { protocol: edge.facets.architecture.protocol }),
                  ...(edge.facets.architecture.dataDescription === undefined
                    ? {}
                    : {
                        dataDescription:
                          edge.facets.architecture.dataDescription
                      })
                }
              }
            : {})
        }
      })
});

/** Explicit allowlist projection. Meeting details, aliases and evidence never reach the browser. */
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
    nodes: snapshot.graph.nodes.map(publicNode),
    edges: snapshot.graph.edges.map(publicEdge),
    pains: snapshot.graph.pains.map((pain) => ({
      id: pain.id,
      description: pain.description,
      targetNodeIds: [...pain.targetNodeIds],
      severity: pain.severity,
      state: pain.state,
      ...(pain.scope === undefined ? {} : { scope: pain.scope }),
      ...(pain.certainty === undefined ? {} : { certainty: pain.certainty })
    })),
    contradictions: snapshot.graph.contradictions.map((contradiction) => ({
      id: contradiction.id,
      description: contradiction.description
    })),
    ...(snapshot.graph.suggestedQuestion
      ? { suggestedQuestion: { text: snapshot.graph.suggestedQuestion.text } }
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

export const isEmptyBusinessGraph = (graph: BusinessGraph): boolean =>
  graph.topic.id === "discovery" &&
  graph.topic.label === "Business discovery" &&
  graph.topic.evidenceUtteranceIds.length === 0 &&
  graph.nodes.length === 0 &&
  graph.edges.length === 0 &&
  graph.pains.length === 0 &&
  graph.contradictions.length === 0 &&
  graph.suggestedQuestion === undefined;
