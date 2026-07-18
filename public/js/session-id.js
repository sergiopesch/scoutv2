const SESSION_ROUTES = new Set(["operator", "whiteboard"]);

export function parseSessionId(pathname = globalThis.location?.pathname ?? "") {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || !SESSION_ROUTES.has(parts[0])) {
    return null;
  }

  try {
    const sessionId = decodeURIComponent(parts[1]).trim();
    return sessionId && !sessionId.includes("/") ? sessionId : null;
  } catch {
    return null;
  }
}

export function sessionApiPath(sessionId) {
  return `/api/sessions/${encodeURIComponent(sessionId)}`;
}

export function sessionEventsPath(sessionId) {
  return `/events/${encodeURIComponent(sessionId)}`;
}
