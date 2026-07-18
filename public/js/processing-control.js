export function processingControlView(
  processing = {},
  submitting = false,
  requestedPaused = !processing.paused,
  sessionStatus
) {
  const paused = processing.paused === true;
  if (sessionStatus === "error") {
    return {
      paused,
      disabled: true,
      statusText: "Unavailable",
      buttonText: "Session unavailable",
      note: "Resolve the session error before changing processing."
    };
  }
  if (sessionStatus === "ended") {
    return {
      paused,
      disabled: !paused || submitting,
      statusText: "Ended",
      buttonText: submitting
        ? "Enabling final analysis…"
        : paused
          ? "Enable final analysis"
          : "Final processing enabled",
      note: paused
        ? "Enable processing to analyze finalized evidence captured before the meeting ended."
        : "The meeting ended; pending finalized evidence can still update the accepted map."
    };
  }
  return {
    paused,
    disabled: submitting,
    statusText: paused ? "Paused" : "Live",
    buttonText: submitting
      ? requestedPaused
        ? "Pausing live processing…"
        : "Continuing live processing…"
      : paused
        ? "Continue live processing"
        : "Pause live processing",
    note: paused
      ? "Incoming speech is discarded while paused and will not be replayed."
      : "Pausing keeps this session, bot, transcript, graph, and Codex thread intact."
  };
}
