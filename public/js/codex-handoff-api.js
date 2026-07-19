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

export async function prepareCodexHandoff(sessionId, expected, fetchImpl = fetch) {
  const response = await fetchImpl(
    `/api/handoffs/${encodeURIComponent(sessionId)}/prepare`,
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
    throw new Error(result.error || `Codex project could not be prepared (${response.status}).`);
  }
  if (
    typeof result.directory !== "string" ||
    typeof result.prompt !== "string" ||
    !String(result.launchUrl ?? "").startsWith("codex://new?")
  ) {
    throw new Error("Scout returned an incomplete Codex launch package.");
  }
  return result;
}
