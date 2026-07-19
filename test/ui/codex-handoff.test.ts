import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  loadCodexHandoff,
  launchCodexHandoff
} from "../../public/js/codex-handoff-api.js";

describe("Codex handoff browser API", () => {
  it("presents one concise map-derived plan and the real Codex action", async () => {
    const [html, source] = await Promise.all([
      readFile(new URL("../../public/handoff.html", import.meta.url), "utf8"),
      readFile(new URL("../../public/js/codex-handoff.js", import.meta.url), "utf8")
    ]);

    expect(html).toContain("Specialist work for this map");
    expect(html).toContain("Let Codex do its thing");
    expect(html).not.toContain('id="handoff-outcomes"');
    expect(source).toContain("handoff.orchestration.tasks.length");
    expect(source).toContain("Codex is underway");
  });

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
        directory: "/tmp/scout-workspace",
        launchUrl: "codex://threads/lead-thread-1",
        lead: { threadId: "lead-thread-1" },
        tasks: [{ threadId: "work-thread-1" }]
      }), {
        status: 201,
        headers: { "Content-Type": "application/json" }
      })
    );
    await expect(launchCodexHandoff(
      "session-1234567890",
      { graphRevision: 7, reviewRevision: 2 },
      fetchImpl as typeof fetch
    ))
      .resolves.toMatchObject({ directory: "/tmp/scout-workspace", lead: { threadId: "lead-thread-1" } });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/handoffs/session-1234567890/launch");
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ expectedGraphRevision: 7, expectedReviewRevision: 2 })
    });
  });
});
