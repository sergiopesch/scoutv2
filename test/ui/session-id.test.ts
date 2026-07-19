import { describe, expect, it } from "vitest";
import {
  parseSessionId,
  sessionApiPath,
  sessionEventsPath,
  whiteboardApiPath,
  whiteboardEventsPath
} from "../../public/js/session-id.js";
import { formatClock } from "../../public/js/session-stream.js";

describe("parseSessionId", () => {
  it("reads IDs from operator and whiteboard routes", () => {
    expect(parseSessionId("/operator/session-123")).toBe("session-123");
    expect(parseSessionId("/whiteboard/meeting%20one")).toBe("meeting one");
  });

  it("reads IDs from post-call review and handoff routes", () => {
    expect(parseSessionId("/review/session-post-call-123")).toBe(
      "session-post-call-123"
    );
    expect(parseSessionId("/handoff/session-post-call-123")).toBe(
      "session-post-call-123"
    );
  });

  it("rejects malformed and unrelated paths", () => {
    expect(parseSessionId("/operator")).toBeNull();
    expect(parseSessionId("/whiteboard/id/extra")).toBeNull();
    expect(parseSessionId("/api/sessions/id")).toBeNull();
    expect(parseSessionId("/operator/bad%2Fid")).toBeNull();
    expect(parseSessionId("/operator/%E0%A4%A")).toBeNull();
  });
});

describe("session endpoint helpers", () => {
  it("encodes session IDs as path segments", () => {
    expect(sessionApiPath("meeting one")).toBe("/api/sessions/meeting%20one");
    expect(sessionEventsPath("meeting one")).toBe("/events/meeting%20one");
    expect(whiteboardApiPath("meeting one")).toBe(
      "/api/whiteboards/meeting%20one"
    );
    expect(whiteboardEventsPath("meeting one")).toBe(
      "/events/whiteboards/meeting%20one"
    );
  });
});

describe("formatClock", () => {
  it("formats Recall relative seconds as meeting elapsed time", () => {
    expect(formatClock(12.25)).toBe("00:00:12");
    expect(formatClock(3_661)).toBe("01:01:01");
    expect(formatClock(9e18)).toBe("—");
  });
});
