import {
  sessionApiPath,
  sessionEventsPath,
  whiteboardApiPath,
  whiteboardEventsPath
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

export async function loadWhiteboard(sessionId) {
  const response = await fetch(whiteboardApiPath(sessionId), {
    headers: { Accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "This meeting session was not found."
        : `Could not load the whiteboard (${response.status}).`
    );
  }
  return response.json();
}

export function subscribeToWhiteboard(sessionId, handlers) {
  const source = new EventSource(whiteboardEventsPath(sessionId));
  source.addEventListener("open", () => handlers.onConnection?.("live"));
  source.addEventListener("error", () => handlers.onConnection?.("reconnecting"));
  source.addEventListener("whiteboard", (event) => {
    try {
      handlers.onSnapshot?.(JSON.parse(event.data));
    } catch {
      handlers.onError?.(new Error("Received an unreadable whiteboard update."));
    }
  });
  return () => source.close();
}

export function formatClock(timestamp) {
  if (!Number.isFinite(timestamp)) return "—";
  if (timestamp < 100_000_000_000) {
    const totalSeconds = Math.max(0, Math.floor(timestamp));
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    return [hours, minutes, seconds]
      .map((part) => String(part).padStart(2, "0"))
      .join(":");
  }
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(date);
  } catch {
    return "—";
  }
}
