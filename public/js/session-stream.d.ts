export interface SessionStreamHandlers {
  onSnapshot?(snapshot: unknown): void;
  onConnection?(state: "live" | "reconnecting"): void;
  onError?(error: Error): void;
}

export function loadSession(sessionId: string): Promise<unknown>;
export function subscribeToSession(
  sessionId: string,
  handlers: SessionStreamHandlers
): () => void;
export function loadWhiteboard(sessionId: string): Promise<unknown>;
export function subscribeToWhiteboard(
  sessionId: string,
  handlers: SessionStreamHandlers
): () => void;
export function formatClock(timestamp: number): string;
