export function validateMeetingUrl(value) {
  const meetingUrl = typeof value === "string" ? value.trim() : "";
  if (!meetingUrl) {
    return { valid: false, message: "Paste a meeting join link to continue." };
  }

  try {
    const url = new URL(meetingUrl);
    if (url.protocol !== "https:" || !url.hostname) {
      throw new Error("Meeting URL must use HTTPS.");
    }
    return { valid: true, meetingUrl: url.href };
  } catch {
    return {
      valid: false,
      message: "Enter a complete HTTPS Zoom, Google Meet or Teams link."
    };
  }
}

const capabilityId = /^[A-Za-z0-9_-]{16,128}$/;

const isSessionResponse = (value) => {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.sessionId !== "string" ||
    !capabilityId.test(value.sessionId) ||
    (value.mode !== "live" && value.mode !== "rehearsal")
  ) {
    return false;
  }
  if (value.operatorUrl !== `/operator/${value.sessionId}`) return false;
  if (typeof value.whiteboardUrl !== "string") return false;
  const whiteboardMatch = value.whiteboardUrl.match(
    /^\/whiteboard\/([A-Za-z0-9_-]{16,128})$/
  );
  return Boolean(
    whiteboardMatch?.[1] && whiteboardMatch[1] !== value.sessionId
  );
};

const readinessModes = new Set(["live", "rehearsal", "unavailable"]);

const dependencyState = (value) => ({
  ready: value?.ready === true,
  detail:
    typeof value?.detail === "string" && value.detail.trim()
      ? value.detail.trim()
      : undefined
});

const isReadinessResponse = (value) =>
  value &&
  typeof value === "object" &&
  typeof value.ok === "boolean" &&
  readinessModes.has(value.mode) &&
  typeof value.codex?.ready === "boolean" &&
  typeof value.recall?.ready === "boolean";

export async function loadReadiness(fetchImpl = fetch) {
  const response = await fetchImpl("/readyz", {
    headers: { Accept: "application/json" }
  });
  const result = await response.json().catch(() => ({}));
  if (!isReadinessResponse(result)) {
    throw new Error(
      response.ok
        ? "Scout returned an unreadable readiness response."
        : `Scout readiness could not be checked (${response.status}).`
    );
  }
  const codex = dependencyState(result.codex);
  const recall = dependencyState(result.recall);
  return {
    ok:
      result.ok &&
      result.mode !== "unavailable" &&
      codex.ready &&
      recall.ready,
    mode: result.mode,
    codex,
    recall
  };
}

export async function createSession(meetingUrl, fetchImpl = fetch) {
  const response = await fetchImpl("/api/sessions", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ meetingUrl })
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      typeof result.error === "string" && result.error.trim()
        ? result.error
        : `Scout could not start this session (${response.status}).`
    );
  }
  if (response.status !== 201 || !isSessionResponse(result)) {
    throw new Error("Scout returned an incomplete session. Please try again.");
  }
  return result;
}
