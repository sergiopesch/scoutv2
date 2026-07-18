export function processingControlView(
  processing = {},
  submitting = false,
  requestedPaused = !processing.paused
) {
  const paused = processing.paused === true;
  return {
    paused,
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
