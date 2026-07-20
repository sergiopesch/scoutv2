export interface SupplyChainProjection {
  viewKind: "supply-chain";
  scope: "current" | "desired";
  title: string;
  description: string;
  emptyMessage: string;
  nodes: Array<{ id: string; label: string; kind: string; state?: string; scope?: string; certainty?: string }>;
  edges: Array<{ id: string; from: string; to: string; kind: string; label: string; state?: string; scope?: string; certainty?: string }>;
}
export function projectSupplyChain(graph?: unknown, scope?: "current" | "desired"): SupplyChainProjection;
export function supplyChainProjectionHash(projection: SupplyChainProjection): string;
