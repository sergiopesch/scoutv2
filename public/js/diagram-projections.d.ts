export type DiagramViewKind = "process" | "organization" | "architecture";
export type DiagramScope = "current" | "desired";
export interface DiagramProjection {
  viewKind: DiagramViewKind;
  scope: DiagramScope;
  title: string;
  description: string;
  emptyMessage: string;
  nodes: Array<Record<string, unknown> & { id: string }>;
  edges: Array<Record<string, unknown> & { id: string; from: string; to: string }>;
  groups: Array<Record<string, unknown> & { id: string }>;
  pains: Array<Record<string, unknown>>;
  contradictions: Array<Record<string, unknown>>;
}
export const VIEW_DEFINITIONS: Readonly<Record<DiagramViewKind, {
  label: string;
  shortLabel: string;
  description: string;
  emptyMessage: string;
}>>;
export function projectBusinessGraph(graph?: unknown, viewKind?: DiagramViewKind, scope?: DiagramScope): DiagramProjection;
export function semanticProjectionHash(projection: DiagramProjection): string;
export function projectionSummary(projection: DiagramProjection): string;
export function projectionEntityDetail(projection: DiagramProjection, entityId: string): {
  node: Record<string, unknown>;
  incoming: Array<Record<string, unknown>>;
  outgoing: Array<Record<string, unknown>>;
  pains: Array<Record<string, unknown>>;
} | undefined;
