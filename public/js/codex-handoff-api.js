export async function loadCodexHandoff(sessionId, fetchImpl = fetch) {
  const response = await fetchImpl(`/api/handoffs/${encodeURIComponent(sessionId)}`, {
    headers: { Accept: "application/json" }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `Codex package could not be loaded (${response.status}).`);
  }
  return result;
}

export async function launchCodexHandoff(sessionId, expected, fetchImpl = fetch) {
  const response = await fetchImpl(
    `/api/handoffs/${encodeURIComponent(sessionId)}/launch`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        expectedGraphRevision: expected.graphRevision,
        expectedReviewRevision: expected.reviewRevision
      })
    }
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `The approved Codex plan could not be started (${response.status}).`);
  }
  if (
    typeof result.directory !== "string" ||
    !String(result.launchUrl ?? "").startsWith("codex://threads/") ||
    typeof result.lead?.threadId !== "string" ||
    !Array.isArray(result.tasks)
  ) {
    throw new Error("Scout returned an incomplete Codex task launch.");
  }
  return result;
}
