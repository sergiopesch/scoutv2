export const DIAGRAM_VIEW_KINDS: readonly ["process", "organization", "architecture"];

export interface ViewRenderState {
  viewKind: string;
  status: "clean" | "dirty" | "rendering" | "failed";
  latestRequestedRevision: number;
  latestRoleRevision: number;
  committedRevision: number;
  semanticHash?: string;
  committedHash?: string;
  hasArtifact: boolean;
  error?: unknown;
}

export function createViewRenderCoordinator<TSnapshot, TProjection, TArtifact>(options: {
  project(graph: unknown, viewKind: string, scope?: string): TProjection;
  hash(projection: TProjection): string;
  render(request: {
    viewKind: string;
    projection: TProjection;
    revision: number;
    roleRevision: number;
    semanticHash: string;
    generation: number;
  }): Promise<TArtifact> | TArtifact;
  commit(result: {
    viewKind: string;
    projection: TProjection;
    revision: number;
    roleRevision: number;
    semanticHash: string;
    artifact: TArtifact;
  }): Promise<void> | void;
  onState?(viewKind: string, state: ViewRenderState): void;
  onError?(viewKind: string, error: unknown, state: ViewRenderState): void;
  viewKinds?: readonly string[];
  initialView?: string;
  scheduleIdle?(callback: () => void): unknown;
  cancelIdle?(handle: unknown): void;
}): {
  offer(snapshot: TSnapshot, scopes?: Record<string, string>): boolean;
  activate(viewKind: string): boolean;
  retry(viewKind?: string): boolean;
  dispose(): void;
  readonly activeView: string;
  state(viewKind: string): ViewRenderState | undefined;
};
