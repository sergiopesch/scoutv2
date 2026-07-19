export function loadCodexHandoff(sessionId: string, fetchImpl?: typeof fetch): Promise<any>;
export function prepareCodexHandoff(
  sessionId: string,
  expected: { graphRevision: number; reviewRevision: number },
  fetchImpl?: typeof fetch
): Promise<any>;
