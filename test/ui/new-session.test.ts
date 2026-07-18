import { describe, expect, it, vi } from "vitest";
import {
  createSession,
  validateMeetingUrl
} from "../../public/js/new-session-api.js";

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
        sessionId: "session-1",
        operatorUrl: "/operator/session-1",
        whiteboardUrl: "/whiteboard/session-1"
      })
    });

    await expect(
      createSession("https://zoom.us/j/123", fetchImpl)
    ).resolves.toMatchObject({
      operatorUrl: "/operator/session-1",
      whiteboardUrl: "/whiteboard/session-1"
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
});
