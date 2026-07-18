import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  createSession,
  loadReadiness,
  validateMeetingUrl
} from "../../public/js/new-session-api.js";
import { newSessionView } from "../../public/js/new-session-view.js";

describe("validateMeetingUrl", () => {
  it("accepts and normalizes secure meeting links", () => {
    expect(validateMeetingUrl(" https://meet.google.com/abc-defg-hij ")).toEqual({
      valid: true,
      meetingUrl: "https://meet.google.com/abc-defg-hij"
    });
  });

  it.each(["", "meet.google.com/abc", "http://zoom.us/j/123", "not a url"])(
    "rejects an invalid or insecure meeting link: %s",
    (value) => {
      expect(validateMeetingUrl(value)).toMatchObject({ valid: false });
    }
  );
});

describe("createSession", () => {
  it("posts only the meeting URL and returns operator links from a 201", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        sessionId: "session-12345678",
        operatorUrl: "/operator/session-12345678",
        whiteboardUrl: "/whiteboard/whiteboard-123456",
        mode: "rehearsal"
      })
    });

    await expect(
      createSession("https://zoom.us/j/123", fetchImpl)
    ).resolves.toMatchObject({
      operatorUrl: "/operator/session-12345678",
      whiteboardUrl: "/whiteboard/whiteboard-123456",
      mode: "rehearsal"
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith("/api/sessions", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ meetingUrl: "https://zoom.us/j/123" })
    });
  });

  it("shows the API failure without creating a real bot", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: "Meeting service is unavailable." })
    });

    await expect(
      createSession("https://teams.microsoft.com/l/meetup-join/123", fetchImpl)
    ).rejects.toThrow("Meeting service is unavailable.");
  });

  it("rejects incomplete success responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ operatorUrl: "/operator/session-1" })
    });

    await expect(
      createSession("https://zoom.us/j/123", fetchImpl)
    ).rejects.toThrow("incomplete session");
  });

  it.each([
    {
      sessionId: "session-12345678",
      operatorUrl: "//evil.example/operator",
      whiteboardUrl: "/whiteboard/whiteboard-123456",
      mode: "rehearsal"
    },
    {
      sessionId: "session-12345678",
      operatorUrl: "/\\evil.example/operator",
      whiteboardUrl: "/whiteboard/whiteboard-123456",
      mode: "rehearsal"
    },
    {
      sessionId: "session-12345678",
      operatorUrl: "/operator/different-session",
      whiteboardUrl: "/whiteboard/whiteboard-123456",
      mode: "live"
    },
    {
      sessionId: "session-12345678",
      operatorUrl: "/operator/session-12345678",
      whiteboardUrl: "/whiteboard/session-12345678",
      mode: "live"
    }
  ])("rejects unsafe or mismatched capability links: $operatorUrl", async (payload) => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => payload
    });

    await expect(
      createSession("https://zoom.us/j/123", fetchImpl)
    ).rejects.toThrow("incomplete session");
  });
});

describe("loadReadiness", () => {
  it("loads a ready live or rehearsal mode from /readyz", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        mode: "rehearsal",
        codex: { ready: true },
        recall: {
          ready: true,
          detail: "Recall bypassed in explicit rehearsal mode"
        }
      })
    });

    await expect(loadReadiness(fetchImpl)).resolves.toEqual({
      ok: true,
      mode: "rehearsal",
      codex: { ready: true, detail: undefined },
      recall: {
        ready: true,
        detail: "Recall bypassed in explicit rehearsal mode"
      }
    });
    expect(fetchImpl).toHaveBeenCalledWith("/readyz", {
      headers: { Accept: "application/json" }
    });
  });

  it("returns a structured unavailable response even when /readyz uses 503", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        ok: false,
        mode: "unavailable",
        codex: { ready: false, detail: "Codex authentication is unavailable." },
        recall: { ready: false, detail: "Recall is not configured." }
      })
    });

    await expect(loadReadiness(fetchImpl)).resolves.toMatchObject({
      ok: false,
      mode: "unavailable",
      codex: { ready: false },
      recall: { ready: false }
    });
  });

  it("rejects an unreadable or unreachable readiness response", async () => {
    await expect(loadReadiness(vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: "proxy failure" })
    }))).rejects.toThrow("readiness could not be checked (502)");
    await expect(loadReadiness(vi.fn().mockRejectedValue(
      new Error("network unavailable")
    ))).rejects.toThrow("network unavailable");
    await expect(loadReadiness(vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, mode: "live" })
    }))).rejects.toThrow("unreadable readiness response");
  });

  it("does not trust an inconsistent ready flag when a dependency is down", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        mode: "live",
        codex: { ready: true },
        recall: { ready: false, detail: "Recall cannot be reached." }
      })
    });
    await expect(loadReadiness(fetchImpl)).resolves.toMatchObject({
      ok: false,
      mode: "live",
      recall: { ready: false }
    });
  });
});

describe("new session readiness presentation", () => {
  const ready = (mode: "live" | "rehearsal") => ({
    phase: "ready" as const,
    readiness: {
      ok: true,
      mode,
      codex: { ready: true },
      recall: { ready: true }
    }
  });

  it("does not enable or promise a session while checking", () => {
    expect(newSessionView({ phase: "checking" })).toMatchObject({
      canCreate: false,
      mode: "checking",
      statusLabel: "Checking availability",
      startButton: "Checking Scout…"
    });
  });

  it("uses live bot and admission copy only in live mode", () => {
    const view = newSessionView(ready("live"));
    expect(view).toMatchObject({
      canCreate: true,
      mode: "live",
      statusLabel: "Ready for live meeting",
      submittingButton: "Creating Live Architect…",
      successTitle: "Scout is ready to join."
    });
    expect(view.admissionText).toContain("Live Architect");
    expect(view.admissionText).toContain("admit");
  });

  it("states that rehearsal creates views without a bot or admission", () => {
    const view = newSessionView(ready("rehearsal"));
    expect(view).toMatchObject({
      canCreate: true,
      mode: "rehearsal",
      statusLabel: "Rehearsal mode",
      startButton: "Start rehearsal",
      submittingButton: "Creating rehearsal…",
      successTitle: "Rehearsal views are ready."
    });
    expect(view.admissionText).toContain("No participant will join");
    expect(view.admissionText).toContain("no host admission");
    expect(view.submittingMessage).toContain("No meeting participant");
    expect(view.submittingMessage).not.toContain("Live Architect");
  });

  it("disables creation and includes dependency detail when unavailable", () => {
    expect(newSessionView({
      phase: "unavailable",
      readiness: {
        ok: false,
        mode: "unavailable",
        codex: { ready: false, detail: "Codex is unavailable." },
        recall: { ready: false, detail: "Recall is not configured." }
      }
    })).toMatchObject({
      canCreate: false,
      mode: "unavailable",
      statusLabel: "Scout unavailable",
      readinessMessage: "Codex is unavailable. Recall is not configured."
    });
  });

  it("ships neutral checking copy before JavaScript resolves readiness", async () => {
    const html = await readFile(
      new URL("../../public/operator/new/index.html", import.meta.url),
      "utf8"
    );
    expect(html).toContain('data-mode="checking"');
    expect(html).toContain("Checking availability");
    expect(html).not.toContain("Ready to join");
    expect(html).not.toContain("A participant named");
  });

  it("does not retain the meeting URL through browser autocomplete or spellcheck", async () => {
    const html = await readFile(
      new URL("../../public/operator/new/index.html", import.meta.url),
      "utf8"
    );
    expect(html).toMatch(/id="meeting-url"[\s\S]*?autocomplete="off"/);
    expect(html).toMatch(/id="meeting-url"[\s\S]*?spellcheck="false"/);
    expect(html).not.toContain('autocomplete="url"');
  });

  it("keeps both capability links available for deliberate open or copy actions", async () => {
    const [html, script] = await Promise.all([
      readFile(
        new URL("../../public/operator/new/index.html", import.meta.url),
        "utf8"
      ),
      readFile(
        new URL("../../public/js/new-session.js", import.meta.url),
        "utf8"
      )
    ]);

    expect(html).toContain('id="operator-link"');
    expect(html).toContain('id="copy-operator"');
    expect(html).toContain('id="whiteboard-link"');
    expect(html).toContain('id="copy-whiteboard"');
    expect(html).toContain('aria-labelledby="session-ready-title"');
    expect(script).toContain("ready.focus()");
    expect(script).not.toContain("window.setTimeout");
    expect(script).not.toContain("window.location.assign");
  });

  it("uses success copy that waits for the user to choose a destination", () => {
    for (const mode of ["live", "rehearsal"] as const) {
      const view = newSessionView(ready(mode));
      expect(view.successMessage).toContain("Save both private links");
      expect(view.successMessage).not.toContain("Opening");
    }
  });
});
