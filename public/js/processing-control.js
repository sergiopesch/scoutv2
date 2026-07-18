export function processingControlView(
  processing = {},
  submitting = false,
  requestedPaused = !processing.paused,
  sessionStatus
) {
  const paused = processing.paused === true;
  const unavailable = sessionStatus === "ended" || sessionStatus === "error";
  return {
    paused,
    disabled: unavailable,
    statusText: unavailable ? "Meeting ended" : paused ? "Paused" : "Live",
    buttonText: unavailable
      ? "Live processing ended"
      : submitting
        ? requestedPaused
          ? "Pausing live processing…"
          : "Continuing live processing…"
        : paused
          ? "Continue live processing"
          : "Pause live processing",
    note: unavailable
      ? "The meeting has ended. Transcript and graph analysis remain available."
      : paused
        ? "Incoming speech is discarded while paused and will not be replayed."
        : "Pausing keeps this session, bot, transcript, graph, and Codex thread intact."
  };
}
