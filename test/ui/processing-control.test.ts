import { describe, expect, it } from "vitest";
import { processingControlView } from "../../public/js/processing-control.js";

describe("processing control", () => {
  it("communicates the live and paused discard states", () => {
    expect(processingControlView({ paused: false })).toMatchObject({
      paused: false,
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

  it("can unlock pending final analysis after a paused meeting ends", () => {
    expect(
      processingControlView({ paused: true }, false, false, "ended")
    ).toMatchObject({
      disabled: false,
      statusText: "Ended",
      buttonText: "Enable final analysis"
    });
    expect(
      processingControlView({ paused: false }, false, true, "ended")
    ).toMatchObject({
      disabled: true,
      buttonText: "Final processing enabled"
    });
  });

  it("does not offer processing controls for a failed session", () => {
    expect(processingControlView({ paused: false }, false, true, "error"))
      .toMatchObject({ disabled: true, statusText: "Unavailable" });
  });
});
