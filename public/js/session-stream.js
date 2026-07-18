import {
  sessionApiPath,
  sessionEventsPath
} from "./session-id.js";

export async function loadSession(sessionId) {
  const response = await fetch(sessionApiPath(sessionId), {
    headers: { Accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "This meeting session was not found."
        : `Could not load the meeting (${response.status}).`
    );
  }
  return response.json();
}

export function subscribeToSession(sessionId, handlers) {
  const source = new EventSource(sessionEventsPath(sessionId));
  source.addEventListener("open", () => handlers.onConnection?.("live"));
  source.addEventListener("error", () => handlers.onConnection?.("reconnecting"));
  source.addEventListener("session", (event) => {
    try {
      handlers.onSnapshot?.(JSON.parse(event.data));
    } catch {
      handlers.onError?.(new Error("Received an unreadable session update."));
    }
  });
  return () => source.close();
}

export function formatClock(timestamp) {
  if (!Number.isFinite(timestamp)) return "—";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(timestamp));
}
