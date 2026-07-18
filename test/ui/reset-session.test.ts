import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { resetSession } from "../../public/js/reset-session-api.js";

describe("resetSession", () => {
  it("posts to the session reset endpoint and returns the cleared snapshot", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "session-1", revision: 0, utterances: [] })
    });

    await expect(resetSession("session-1", fetchImpl)).resolves.toMatchObject({
      revision: 0,
      utterances: []
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/sessions/session-1/reset", {
      method: "POST",
      headers: { Accept: "application/json" }
    });
  });

  it("surfaces reset failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: "Codex context could not be retired." })
    });

    await expect(resetSession("session-1", fetchImpl)).rejects.toThrow(
      "Codex context could not be retired."
    );
  });

  it("includes explicit confirmation copy for cleared and preserved state", async () => {
    const html = await readFile(
      new URL("../../public/operator.html", import.meta.url),
      "utf8"
    );

    expect(html).toContain('id="reset-dialog"');
    expect(html).toContain("transcript (including partial speech)");
    expect(html).toContain("current Codex context");
    expect(html).toContain("existing Recall bot and meeting connection stay");
    expect(html).toContain('aria-live="polite"');
  });
});
