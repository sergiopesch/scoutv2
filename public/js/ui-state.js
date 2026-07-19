const TERMINAL_STATUSES = new Set(["ended", "error"]);

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

export function shouldAcceptSnapshot(current, incoming) {
  if (!current) return true;
  const currentUpdatedAt = Number(current.updatedAt);
  const incomingUpdatedAt = Number(incoming?.updatedAt);
  if (Number.isFinite(currentUpdatedAt) && Number.isFinite(incomingUpdatedAt)) {
    if (incomingUpdatedAt < currentUpdatedAt) return false;
    if (incomingUpdatedAt > currentUpdatedAt) return true;
  }
  const currentRoleRevision = Number(current.roleRevision);
  const incomingRoleRevision = Number(incoming?.roleRevision);
  if (
    Number.isFinite(currentRoleRevision) &&
    Number.isFinite(incomingRoleRevision) &&
    incomingRoleRevision !== currentRoleRevision
  ) {
    return incomingRoleRevision > currentRoleRevision;
  }
  return Number(incoming?.revision ?? 0) >= Number(current.revision ?? 0);
}

export function analysisErrorMessage() {
  return "Scout could not validate the latest map update. Your transcript and last accepted map are safe; retry when ready.";
}

export function sessionStreamView(snapshot, connectionState = "connecting") {
  if (!snapshot) return { state: "connecting", label: "Loading meeting" };
  const status = snapshot?.status;
  if (
    status === "ended" &&
    snapshot?.analysis?.status === "running"
  ) {
    return { state: "analyzing", label: "Finalizing meeting map" };
  }
  if (status === "ended" && snapshot?.analysis?.status === "queued") {
    return { state: "waiting", label: "Final analysis queued" };
  }
  if (status === "ended" && snapshot?.analysis?.status === "error") {
    return { state: "error", label: "Final analysis needs attention" };
  }
  if (status === "ended" && snapshot?.processing?.paused === true) {
    return { state: "paused", label: "Final analysis paused" };
  }
  if (status === "ended") return { state: "ended", label: "Meeting ended" };
  if (status === "error") {
    return { state: "error", label: "Session needs attention" };
  }
  if (snapshot?.processing?.paused === true) {
    return { state: "paused", label: "Processing paused" };
  }
  if (connectionState === "reconnecting") {
    return { state: "reconnecting", label: "Reconnecting to Scout" };
  }
  if (connectionState === "connecting") {
    return { state: "connecting", label: "Connecting to Scout" };
  }
  if (status === "creating") {
    return { state: "connecting", label: "Preparing meeting" };
  }
  if (status === "waiting_for_admission") {
    return { state: "waiting", label: "Waiting for admission" };
  }
  if (snapshot?.analysis?.status === "running" || status === "analyzing") {
    return { state: "analyzing", label: "Analyzing conversation" };
  }
  return { state: "live", label: "Updates live" };
}

export function analysisActionView(snapshot, state = {}) {
  const analysis = snapshot?.analysis ?? {};
  const pending = Number(analysis.pendingUtteranceCount ?? 0);
  const connectionState = state.connectionState ?? "live";

  if (!snapshot) {
    return {
      disabled: true,
      buttonText: "Loading meeting…",
      note: "Loading the current session state."
    };
  }
  if (state.submitting) {
    return {
      disabled: true,
      buttonText: "Queuing analysis…",
      note: "Sending the analysis request."
    };
  }
  if (state.resetting) {
    return {
      disabled: true,
      buttonText: "Analysis unavailable",
      note: "The conversation is being cleared."
    };
  }
  if (snapshot.status === "error") {
    return {
      disabled: true,
      buttonText: "Session unavailable",
      note:
        snapshot.recall?.detail ||
        "Resolve the session error before analyzing."
    };
  }
  if (connectionState === "reconnecting") {
    return {
      disabled: true,
      buttonText: "Waiting for connection…",
      note: "Scout is reconnecting before accepting another command."
    };
  }
  if (snapshot.processing?.paused === true) {
    return {
      disabled: true,
      buttonText: snapshot.status === "ended" ? "Final analysis paused" : "Analysis paused",
      note: snapshot.status === "ended"
        ? "Enable final analysis to process finalized evidence captured before the meeting ended."
        : "Continue live processing before starting another analysis."
    };
  }
  if (analysis.status === "running") {
    return {
      disabled: true,
      buttonText: snapshot.status === "ended"
        ? "Final analysis in progress…"
        : "Analysis in progress…",
      note: `${pending} finalized utterance${pending === 1 ? "" : "s"} queued for analysis.`
    };
  }
  if (analysis.blockedReason) {
    return {
      disabled: true,
      buttonText: "Analysis blocked",
      note: analysis.blockedReason
    };
  }
  if (["creating", "waiting_for_admission"].includes(snapshot.status)) {
    return {
      disabled: true,
      buttonText: snapshot.status === "creating" ? "Preparing meeting…" : "Waiting for admission…",
      note: snapshot.status === "creating"
        ? "Scout is still creating the meeting bot."
        : "Admit Scout to the meeting before analysis can begin."
    };
  }
  if (!snapshot.operatorParticipantId) {
    return {
      disabled: true,
      buttonText: "Choose the operator",
      note: "Select your meeting identity before analysis can begin."
    };
  }
  const hasCustomer = Array.isArray(snapshot.participants) &&
    snapshot.participants.some(
      (participant) => participant?.role === "customer"
    );
  if (!hasCustomer) {
    return {
      disabled: true,
      buttonText: "Waiting for a client",
      note: "Analysis needs finalized speech from at least one prospective customer."
    };
  }
  if (pending === 0) {
    return snapshot.status === "ended"
      ? {
          disabled: true,
          buttonText: "Meeting ended",
          note: "All finalized evidence has been analyzed. The final accepted map remains available."
        }
      : {
          disabled: true,
          buttonText: "Nothing new to analyze",
          note: "Waiting for new finalized customer speech."
        };
  }
  if (analysis.status === "queued") {
    return {
      disabled: false,
      buttonText: snapshot.status === "ended"
        ? "Analyze final utterances"
        : "Analyze now",
      note: `${pending} finalized utterance${pending === 1 ? "" : "s"} queued. Start now to bypass the automatic timer.`
    };
  }
  if (analysis.throttled) {
    return {
      disabled: false,
      buttonText: snapshot.status === "ended"
        ? "Analyze final utterances"
        : "Analyze now",
      note: `Automatic analysis budget reached (${analysis.automaticTurnsStarted ?? 0}/${analysis.automaticTurnBudget ?? 0}). Manual analysis remains available.`
    };
  }
  return {
    disabled: false,
    buttonText: analysis.status === "error"
      ? snapshot.status === "ended"
        ? "Retry final analysis"
        : "Retry analysis"
      : snapshot.status === "ended"
        ? "Analyze final utterances"
        : "Analyze now",
    note: analysis.status === "error" ? analysisErrorMessage() : (snapshot.status === "ended"
      ? "Processes finalized evidence captured before the meeting ended."
      : "Sends finalized utterances not yet included in the accepted graph.")
  };
}

export function identitySelectionView(snapshot, selection) {
  if (selection?.phase === "pending") {
    return { state: "pending", text: "Saving operator selection…" };
  }
  if (selection?.phase === "error") {
    return { state: "error", text: "Operator selection was not saved. Try again." };
  }
  if (selection?.phase === "saved") {
    return { state: "saved", text: "Operator selection saved. Everyone else is treated as a client." };
  }
  if (snapshot?.operatorParticipantId) {
    return { state: "saved", text: "Operator selected. Everyone else is treated as a client." };
  }
  const count = Array.isArray(snapshot?.participants)
    ? snapshot.participants.filter(
      (participant) =>
        participant?.isBot !== true && participant?.present !== false
    ).length
    : 0;
  return count > 0
    ? { state: "idle", text: "Choose your meeting identity." }
    : { state: "idle", text: "Waiting for people to join." };
}

export function whiteboardStatusView(snapshot, connectionState = "live") {
  const stream = sessionStreamView(snapshot, connectionState);
  if (snapshot?.status === "ended" && stream.state === "analyzing") {
    return { state: "analyzing", label: "Finalizing meeting map" };
  }
  if (snapshot?.status === "ended" && stream.state === "error") {
    return { state: "error", label: "Final analysis needs attention" };
  }
  if (snapshot?.status === "ended" && stream.state === "paused") {
    return { state: "paused", label: "Final analysis paused" };
  }
  if (
    snapshot?.status === "ended" &&
    snapshot?.analysis?.status === "queued"
  ) {
    return { state: "waiting", label: "Final analysis queued" };
  }
  const labels = {
    ended: "Meeting ended · final map",
    error: "Needs operator attention",
    paused: "Processing paused",
    reconnecting: "Reconnecting to Scout",
    connecting: snapshot?.status === "creating" ? "Preparing meeting" : "Connecting to Scout",
    waiting: "Waiting for admission",
    analyzing: "Analyzing conversation",
    live: "Listening · updates live"
  };
  return { state: stream.state, label: labels[stream.state] ?? stream.label };
}
