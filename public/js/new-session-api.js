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

const isSessionResponse = (value) =>
  value &&
  typeof value === "object" &&
  typeof value.operatorUrl === "string" &&
  value.operatorUrl.startsWith("/") &&
  typeof value.whiteboardUrl === "string" &&
  value.whiteboardUrl.startsWith("/");

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
