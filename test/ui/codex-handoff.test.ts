import { describe, expect, it, vi } from "vitest";
import {
  loadCodexHandoff,
  prepareCodexHandoff
} from "../../public/js/codex-handoff-api.js";

describe("Codex handoff browser API", () => {
  it("loads a reviewable package without creating a local project", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ready: true, package: { topic: "Orders" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    await expect(loadCodexHandoff("session-1234567890", fetchImpl as typeof fetch))
      .resolves.toMatchObject({ ready: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/handoffs/session-1234567890",
      expect.objectContaining({ headers: { Accept: "application/json" } })
    );
  });

  it("accepts only the supported Codex deep-link launch response", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        directory: "/tmp/scout-project",
        prompt: "Read SCOUT_CONTEXT.md",
        launchUrl: "codex://new?path=%2Ftmp%2Fscout-project&prompt=Read"
      }), {
        status: 201,
        headers: { "Content-Type": "application/json" }
      })
    );
    await expect(prepareCodexHandoff(
      "session-1234567890",
      { graphRevision: 7, reviewRevision: 2 },
      fetchImpl as typeof fetch
    ))
      .resolves.toMatchObject({ directory: "/tmp/scout-project" });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ expectedGraphRevision: 7, expectedReviewRevision: 2 })
    });
  });
});
