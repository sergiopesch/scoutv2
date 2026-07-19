import type { DiagramProjection } from "./diagram-projections.js";
export interface MermaidCandidate {
  id: string;
  source: string;
  expectedSemanticEdgeIds: string[];
  renderedSemanticEdgeIds: string[];
  omittedSemanticEdgeIds: string[];
}
export function renderIdForEntity(entityId: string, prefix?: string): string;
export function compileProjectionCandidates(projection: DiagramProjection): MermaidCandidate[];
export function compileProjection(projection: DiagramProjection): MermaidCandidate;
