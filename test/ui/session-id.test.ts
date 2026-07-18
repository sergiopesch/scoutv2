import { describe, expect, it } from "vitest";
import {
  parseSessionId,
  sessionApiPath,
  sessionEventsPath
} from "../../public/js/session-id.js";

describe("parseSessionId", () => {
  it("reads IDs from operator and whiteboard routes", () => {
    expect(parseSessionId("/operator/session-123")).toBe("session-123");
    expect(parseSessionId("/whiteboard/meeting%20one")).toBe("meeting one");
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
  });
});
