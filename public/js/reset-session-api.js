import { sessionApiPath } from "./session-id.js";

export async function resetSession(sessionId, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${sessionApiPath(sessionId)}/reset`, {
    method: "POST",
    headers: { Accept: "application/json" }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      result.error || `Clear conversation request failed (${response.status}).`
    );
  }
  return result;
}
