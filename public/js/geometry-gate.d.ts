export interface GeometryRect { id?: string; x: number; y: number; width: number; height: number }
export interface GeometryEdge {
  id?: string;
  sourceId?: string;
  targetId?: string;
  points: Array<{ x: number; y: number }>;
  importance?: "primary" | "secondary";
}
export interface GeometryCandidate {
  nodes?: GeometryRect[];
  titleBounds?: GeometryRect[];
  labels?: Array<GeometryRect & { ownerId?: string; importance?: "primary" | "optional" }>;
  edges?: GeometryEdge[];
  diagnostics?: Record<string, unknown>;
}
export function rectanglesOverlap(left: GeometryRect, right: GeometryRect, clearance?: number): boolean;
export function segmentIntersectsRectangle(
  start: { x: number; y: number },
  end: { x: number; y: number },
  rect: GeometryRect,
  clearance?: number
): boolean;
export function evaluateGeometryCandidate(candidate?: GeometryCandidate, options?: {
  clearance?: number;
  rejectPrimaryEdgeCrossings?: boolean;
}): {
  accepted: boolean;
  hardFailures: Array<Record<string, unknown>>;
  metrics: Record<string, number>;
};
export function geometryCandidateFromSvg(svg: SVGElement): GeometryCandidate;
