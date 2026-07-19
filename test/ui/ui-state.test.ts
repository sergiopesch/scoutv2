import { describe, expect, it } from "vitest";
import {
  analysisErrorMessage,
  analysisActionView,
  identitySelectionView,
  sessionStreamView,
  shouldAcceptSnapshot,
  whiteboardStatusView
} from "../../public/js/ui-state.js";

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  updatedAt: 100,
  revision: 2,
  roleRevision: 1,
  status: "listening",
  operatorParticipantId: "operator",
  participants: [
    { isBot: false, present: true, role: "operator" },
    { isBot: false, present: true, role: "customer" }
  ],
  processing: { paused: false },
  analysis: { status: "idle", pendingUtteranceCount: 2 },
  ...overrides
});

describe("stream status views", () => {
  it("reports setup, admission, paused, reconnecting and terminal states truthfully", () => {
    expect(sessionStreamView(undefined, "live")).toEqual({
      state: "connecting",
      label: "Loading meeting"
    });
    expect(sessionStreamView(snapshot({ status: "creating" }), "live").label)
      .toBe("Preparing meeting");
    expect(sessionStreamView(snapshot({ status: "waiting_for_admission" }), "live").label)
      .toBe("Waiting for admission");
    expect(sessionStreamView(snapshot({ processing: { paused: true } }), "live").label)
      .toBe("Processing paused");
    expect(sessionStreamView(snapshot(), "reconnecting").label)
      .toBe("Reconnecting to Scout");
    expect(sessionStreamView(snapshot({ status: "ended" }), "reconnecting")).toEqual({
      state: "ended",
      label: "Meeting ended"
    });
    expect(whiteboardStatusView(snapshot({ status: "ended" }), "reconnecting").label)
      .toBe("Meeting ended · final map");
  });

  it("rejects snapshots older than the already rendered state", () => {
    expect(shouldAcceptSnapshot(snapshot(), snapshot({ updatedAt: 99, revision: 9 })))
      .toBe(false);
    expect(shouldAcceptSnapshot(snapshot(), snapshot({ updatedAt: 101, revision: 1 })))
      .toBe(true);
    expect(shouldAcceptSnapshot(snapshot(), snapshot({ updatedAt: 100, revision: 1 })))
      .toBe(false);
    expect(shouldAcceptSnapshot(
      snapshot({ revision: 5, roleRevision: 1 }),
      snapshot({ revision: 0, roleRevision: 2 })
    )).toBe(true);
  });
});

describe("operator action views", () => {
  it("disables analysis with actionable copy for blocked and unavailable states", () => {
    expect(analysisActionView(snapshot({
      analysis: {
        status: "idle",
        pendingUtteranceCount: 2,
        blockedReason: "Select an operator before analysis can start."
      }
    }))).toMatchObject({
      disabled: true,
      buttonText: "Analysis blocked",
      note: "Select an operator before analysis can start."
    });
    expect(analysisActionView(snapshot({ status: "ended" }))).toMatchObject({
      disabled: false,
      buttonText: "Analyze final utterances"
    });
    expect(analysisActionView(snapshot(), { connectionState: "reconnecting" }))
      .toMatchObject({ disabled: true, buttonText: "Waiting for connection…" });
    expect(analysisActionView(snapshot({ processing: { paused: true } })))
      .toMatchObject({ disabled: true, buttonText: "Analysis paused" });
  });

  it("allows pending final evidence to complete after the meeting ends", () => {
    expect(sessionStreamView(snapshot({
      status: "ended",
      analysis: { status: "running", pendingUtteranceCount: 2 }
    }), "live")).toEqual({
      state: "analyzing",
      label: "Finalizing meeting map"
    });
    expect(analysisActionView(snapshot({
      status: "ended",
      analysis: { status: "idle", pendingUtteranceCount: 0 }
    }))).toMatchObject({ disabled: true, buttonText: "Meeting ended" });
    expect(analysisActionView(snapshot({
      status: "ended",
      processing: { paused: true }
    }))).toMatchObject({ disabled: true, buttonText: "Final analysis paused" });
    expect(whiteboardStatusView(snapshot({
      status: "ended",
      processing: { paused: true }
    }), "live")).toEqual({ state: "paused", label: "Final analysis paused" });
  });

  it("lets the operator bypass a queued automatic-analysis timer", () => {
    expect(analysisActionView(snapshot({
      analysis: { status: "queued", pendingUtteranceCount: 2 }
    }))).toEqual({
      disabled: false,
      buttonText: "Analyze now",
      note: "2 finalized utterances queued. Start now to bypass the automatic timer."
    });
    expect(analysisActionView(snapshot({
      status: "ended",
      analysis: { status: "queued", pendingUtteranceCount: 2 }
    }))).toMatchObject({
      disabled: false,
      buttonText: "Analyze final utterances"
    });
    expect(whiteboardStatusView(snapshot({
      status: "ended",
      analysis: { status: "queued", pendingUtteranceCount: 2 }
    }), "live")).toEqual({ state: "waiting", label: "Final analysis queued" });
  });

  it("makes analysis errors retryable when finalized evidence remains", () => {
    expect(analysisActionView(snapshot({
      analysis: {
        status: "error",
        pendingUtteranceCount: 2,
        lastError: "Codex timed out."
      }
    }))).toEqual({
      disabled: false,
      buttonText: "Retry analysis",
      note: analysisErrorMessage()
    });
  });

  it("never offers analysis before operator and customer identity are known", () => {
    expect(analysisActionView(snapshot({ operatorParticipantId: undefined })))
      .toMatchObject({ disabled: true, buttonText: "Choose the operator" });
    expect(analysisActionView(snapshot({
      participants: [{ isBot: false, present: true, role: "operator" }]
    }))).toMatchObject({ disabled: true, buttonText: "Waiting for a client" });
  });

  it("announces pending, saved and failed identity writes", () => {
    expect(identitySelectionView(snapshot(), { phase: "pending" }).state).toBe("pending");
    expect(identitySelectionView(snapshot(), { phase: "saved" }).text).toContain("saved");
    expect(identitySelectionView(snapshot(), { phase: "error" }).text).toContain("not saved");
  });
});
