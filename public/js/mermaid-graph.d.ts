export interface BrowserBusinessGraph {
  nodes?: Array<{
    id?: unknown;
    kind?: string;
    label?: unknown;
    state?: string;
  }>;
  edges?: Array<{
    id?: unknown;
    from?: unknown;
    to?: unknown;
    kind?: unknown;
    label?: unknown;
    state?: string;
  }>;
  pains?: Array<{
    id?: unknown;
    description?: unknown;
    targetNodeIds?: unknown[];
    severity?: string;
  }>;
}

export function escapeMermaidLabel(value: unknown, fallback?: string): string;
export function businessGraphToMermaid(graph?: BrowserBusinessGraph): string;
