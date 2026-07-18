import { describe, expect, it } from "vitest";
import { processingControlView } from "../../public/js/processing-control.js";

describe("processing control", () => {
  it("communicates the live and paused discard states", () => {
    expect(processingControlView({ paused: false })).toMatchObject({
      paused: false,
      disabled: false,
      statusText: "Live",
      buttonText: "Pause live processing"
    });
    expect(processingControlView({ paused: true })).toMatchObject({
      paused: true,
      statusText: "Paused",
      buttonText: "Continue live processing",
      note: expect.stringContaining("discarded")
    });
  });

  it("disables live processing controls after the meeting ends", () => {
    expect(
      processingControlView({ paused: false }, false, true, "ended")
    ).toMatchObject({
      disabled: true,
      statusText: "Meeting ended",
      buttonText: "Live processing ended",
      note: expect.stringContaining("analysis remain available")
    });
  });

  it("shows loading copy for both transitions", () => {
    expect(
      processingControlView({ paused: false }, true, true).buttonText
    ).toBe("Pausing live processing…");
    expect(
      processingControlView({ paused: true }, true, false).buttonText
    ).toBe("Continuing live processing…");
    expect(
      processingControlView({ paused: true }, true, true).buttonText
    ).toBe("Pausing live processing…");
  });
});
