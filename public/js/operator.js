import { parseSessionId, sessionApiPath } from "./session-id.js";
import {
  formatClock,
  loadSession,
  subscribeToSession
} from "./session-stream.js";
import {
  prepareTranscriptUpdate,
  transcriptScrollTop
} from "./transcript-view.js";
import { processingControlView } from "./processing-control.js";
import { resetSession } from "./reset-session-api.js";
import {
  operatorIdentityView,
  selectOperator
} from "./operator-identity.js";

const elements = {
  topic: document.querySelector("#meeting-heading"),
  integrations: document.querySelector("#integrations"),
  participants: document.querySelector("#participants"),
  participantCount: document.querySelector("#participant-count"),
  identityStatus: document.querySelector("#identity-status"),
  transcript: document.querySelector("#transcript"),
  newTranscript: document.querySelector("#new-transcript"),
  streamDot: document.querySelector("#stream-dot"),
  streamState: document.querySelector("#stream-state"),
  processingCard: document.querySelector("#processing-card"),
  processingState: document.querySelector("#processing-state"),
  processingButton: document.querySelector("#processing-button"),
  processingNote: document.querySelector("#processing-note"),
  revision: document.querySelector("#revision"),
  pendingCount: document.querySelector("#pending-count"),
  analysisUpdated: document.querySelector("#analysis-updated"),
  question: document.querySelector("#suggested-question"),
  evidence: document.querySelector("#question-evidence"),
  analyzeButton: document.querySelector("#analyze-button"),
  resetButton: document.querySelector("#reset-button"),
  resetDialog: document.querySelector("#reset-dialog"),
  resetCancel: document.querySelector("#reset-cancel"),
  resetConfirm: document.querySelector("#reset-confirm"),
  resetError: document.querySelector("#reset-error"),
  resetStatus: document.querySelector("#reset-status"),
  actionNote: document.querySelector("#action-note"),
  error: document.querySelector("#operator-error")
};

const sessionId = parseSessionId();
let snapshot;
let submitting = false;
let processingSubmitting = false;
let processingRequestedPaused;
let streamConnectionState = "connecting";
let resetting = false;
let operatorSelectingId;
let renderedTranscriptSignature = "";

function text(value, fallback = "—") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function initials(name) {
  return text(name, "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function integrationRow(name, integration) {
  const row = document.createElement("li");
  row.className = "integration-row";
  const dot = document.createElement("span");
  dot.className = "status-dot";
  dot.dataset.state = integration?.status ?? "idle";
  const copy = document.createElement("div");
  copy.className = "integration-copy";
  const title = document.createElement("span");
  title.className = "integration-name";
  title.textContent = `${name} · ${text(integration?.status, "idle")}`;
  const detail = document.createElement("span");
  detail.className = "integration-detail";
  detail.textContent = text(integration?.detail, "No detail reported");
  copy.append(title, detail);
  row.append(dot, copy);
  return row;
}

function renderIntegrations(next) {
  elements.integrations.replaceChildren(
    integrationRow("Recall", next.recall),
    integrationRow("Codex", next.codex),
    integrationRow("Processing", {
      status: next.processing?.paused ? "paused" : "active",
      detail: next.processing?.paused
        ? "Incoming transcript events are discarded"
        : "Live transcription and automatic analysis enabled"
    }),
    integrationRow("Analysis", {
      status: next.analysis?.status,
      detail:
        next.analysis?.lastError ??
        `${next.analysis?.pendingUtteranceCount ?? 0} utterances pending`
    })
  );
}

function renderStreamState() {
  const paused = snapshot?.processing?.paused === true;
  elements.streamDot.dataset.state = paused ? "paused" : streamConnectionState;
  elements.streamState.textContent = paused
    ? "Processing paused"
    : streamConnectionState === "live"
      ? "Updates live"
      : streamConnectionState === "reconnecting"
        ? "Reconnecting"
        : "Connecting";
}

function renderParticipants(next) {
  const participants = operatorIdentityView(
    next.participants,
    next.operatorParticipantId,
    operatorSelectingId
  );
  elements.participantCount.textContent = `${participants.length} present`;
  elements.identityStatus.textContent = next.operatorParticipantId
    ? "Operator selected. Everyone else is treated as a client."
    : participants.length
      ? "Choose your meeting identity."
      : "Waiting for people to join.";
  const rows = participants.map((participant) => {
    const row = document.createElement("li");
    row.className = "participant-row";
    row.dataset.role = participant.selected ? "operator" : participant.role;
    const avatar = document.createElement("span");
    avatar.className = "participant-avatar";
    avatar.textContent = initials(participant.name);
    const copy = document.createElement("div");
    copy.className = "participant-copy";
    const name = document.createElement("span");
    name.className = "participant-name";
    name.textContent = text(participant.name, "Unknown participant");
    const role = document.createElement("span");
    role.className = "participant-role-label";
    role.textContent = participant.roleLabel;
    copy.append(name, role);
    const button = document.createElement("button");
    button.className = "identity-button";
    button.type = "button";
    button.textContent = participant.buttonText;
    button.disabled = participant.disabled;
    button.setAttribute("aria-pressed", String(participant.selected));
    button.addEventListener("click", () => chooseOperator(participant.id));
    row.append(avatar, copy, button);
    return row;
  });
  if (!rows.length) {
    const empty = document.createElement("li");
    empty.className = "empty-copy";
    empty.textContent = "Waiting for participants to join.";
    rows.push(empty);
  }
  elements.participants.replaceChildren(...rows);
}

function renderTranscript(utterances = []) {
  const update = prepareTranscriptUpdate(
    utterances,
    renderedTranscriptSignature,
    {
      scrollTop: elements.transcript.scrollTop,
      scrollHeight: elements.transcript.scrollHeight,
      clientHeight: elements.transcript.clientHeight
    }
  );
  if (!update.changed) return;

  const rows = update.turns.map((turn) => {
    const row = document.createElement("li");
    row.className = "utterance";
    row.dataset.participantId = turn.participantId;
    row.dataset.evidenceIds = turn.fragments
      .map((fragment) => fragment.id)
      .join(" ");
    const meta = document.createElement("div");
    meta.className = "utterance-meta";
    const speaker = document.createElement("span");
    speaker.className = "utterance-speaker";
    speaker.textContent = turn.participantName;
    const time = document.createElement("time");
    if (
      Number.isFinite(turn.startedAt) &&
      turn.startedAt >= 100_000_000_000
    ) {
      time.dateTime = new Date(turn.startedAt).toISOString();
    }
    time.textContent = formatClock(turn.startedAt);
    meta.append(speaker, time);
    const body = document.createElement("p");
    body.className = "utterance-body";
    turn.fragments.forEach((fragment, index) => {
      const fragmentText = document.createElement("span");
      fragmentText.className = "utterance-fragment";
      fragmentText.classList.toggle("is-partial", !fragment.finalized);
      fragmentText.dataset.utteranceId = fragment.id;
      fragmentText.dataset.sequence = String(fragment.sequence);
      fragmentText.dataset.finalized = String(fragment.finalized);
      fragmentText.textContent = fragment.text;
      if (index > 0) body.append(document.createTextNode(" "));
      body.append(fragmentText);
    });
    const id = document.createElement("div");
    id.className = "utterance-id";
    id.textContent = turn.fragments
      .map((fragment) => fragment.id)
      .join(" · ");
    row.append(meta, body, id);
    return row;
  });
  if (!rows.length) {
    const empty = document.createElement("li");
    empty.className = "empty-copy";
    empty.textContent = "Speaker-attributed transcript will appear here as people talk.";
    rows.push(empty);
  }
  elements.transcript.replaceChildren(...rows);
  renderedTranscriptSignature = update.signature;
  elements.transcript.scrollTop = transcriptScrollTop(
    update,
    elements.transcript.scrollHeight
  );
  elements.newTranscript.hidden = update.follow;
}

function renderEvidence(ids = []) {
  const chips = ids.map((id) => {
    const item = document.createElement("li");
    item.className = "evidence-chip";
    item.textContent = id;
    item.title = id;
    return item;
  });
  elements.evidence.replaceChildren(...chips);
}

function render(next) {
  snapshot = next;
  renderStreamState();
  elements.topic.textContent = text(next.graph?.topic?.label, "Business discovery");
  renderIntegrations(next);
  renderParticipants(next);
  renderTranscript(next.utterances);
  elements.revision.textContent = `r${next.revision ?? 0}`;
  elements.pendingCount.textContent = String(
    next.analysis?.pendingUtteranceCount ?? 0
  );
  elements.analysisUpdated.textContent = next.analysis?.lastCompletedAt
    ? formatClock(next.analysis.lastCompletedAt)
    : "Not analyzed";
  const question = next.graph?.suggestedQuestion;
  elements.question.textContent = text(
    question?.text,
    "Waiting for enough evidence to suggest a follow-up."
  );
  renderEvidence(question?.evidenceUtteranceIds);
  const processingView = processingControlView(
    next.processing,
    processingSubmitting,
    processingRequestedPaused
  );
  elements.processingCard.dataset.paused = String(processingView.paused);
  elements.processingState.textContent = processingView.statusText;
  elements.processingButton.textContent = processingView.buttonText;
  elements.processingButton.setAttribute(
    "aria-pressed",
    String(processingView.paused)
  );
  elements.processingButton.disabled = processingSubmitting || resetting;
  elements.processingNote.textContent = processingView.note;
  const busy =
    submitting ||
    resetting ||
    processingView.paused ||
    ["queued", "running"].includes(next.analysis?.status);
  elements.analyzeButton.disabled = busy;
  elements.analyzeButton.textContent = processingView.paused
    ? "Analysis paused"
    : busy
      ? "Analysis in progress…"
      : "Analyze now";
  elements.resetButton.disabled = resetting || processingSubmitting;
  elements.resetButton.textContent = resetting
    ? "Clearing conversation…"
    : "Clear conversation";
  elements.actionNote.textContent = next.analysis?.lastError
    ? next.analysis.lastError
    : processingView.paused
      ? "Continue live processing before starting another analysis."
      : next.analysis?.blockedReason
        ? next.analysis.blockedReason
        : next.analysis?.throttled
          ? `Automatic analysis budget reached (${next.analysis?.automaticTurnsStarted ?? 0}/${next.analysis?.automaticTurnBudget ?? 0}). Analyze now remains available.`
          : "Sends finalized utterances not yet included in the accepted graph.";
}

async function chooseOperator(participantId) {
  if (!sessionId || operatorSelectingId) return;
  operatorSelectingId = participantId;
  elements.error.hidden = true;
  if (snapshot) render(snapshot);
  try {
    render(await selectOperator(sessionId, participantId));
  } catch (error) {
    showError(error);
  } finally {
    operatorSelectingId = undefined;
    if (snapshot) render(snapshot);
  }
}

function showError(error) {
  elements.error.hidden = false;
  elements.error.textContent = error instanceof Error ? error.message : String(error);
}

async function analyzeNow() {
  if (!sessionId || submitting) return;
  submitting = true;
  elements.error.hidden = true;
  elements.analyzeButton.disabled = true;
  elements.analyzeButton.textContent = "Queuing analysis…";
  try {
    const response = await fetch(`${sessionApiPath(sessionId)}/analyze`, {
      method: "POST",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || `Analysis request failed (${response.status}).`);
    }
  } catch (error) {
    showError(error);
  } finally {
    submitting = false;
    if (snapshot) render(snapshot);
  }
}

async function toggleProcessing() {
  if (!sessionId || !snapshot || processingSubmitting || resetting) return;
  processingSubmitting = true;
  processingRequestedPaused = !snapshot.processing?.paused;
  elements.error.hidden = true;
  render(snapshot);
  try {
    const response = await fetch(`${sessionApiPath(sessionId)}/processing`, {
      method: "PUT",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ paused: processingRequestedPaused })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        result.error || `Processing request failed (${response.status}).`
      );
    }
    render(result);
  } catch (error) {
    showError(error);
  } finally {
    processingSubmitting = false;
    processingRequestedPaused = undefined;
    if (snapshot) render(snapshot);
  }
}

function openResetDialog() {
  if (resetting || processingSubmitting) return;
  elements.resetError.hidden = true;
  elements.resetDialog.showModal();
}

async function clearConversation() {
  if (!sessionId || resetting || processingSubmitting) return;
  resetting = true;
  elements.error.hidden = true;
  elements.resetError.hidden = true;
  elements.resetStatus.textContent = "";
  elements.resetCancel.disabled = true;
  elements.resetConfirm.disabled = true;
  elements.resetConfirm.textContent = "Clearing…";
  if (snapshot) render(snapshot);
  try {
    const cleared = await resetSession(sessionId);
    render(cleared);
    elements.resetDialog.close();
    elements.resetStatus.textContent =
      "Conversation cleared. Recall and live meeting connections remain active.";
  } catch (error) {
    elements.resetError.hidden = false;
    elements.resetError.textContent =
      error instanceof Error ? error.message : String(error);
  } finally {
    resetting = false;
    elements.resetCancel.disabled = false;
    elements.resetConfirm.disabled = false;
    elements.resetConfirm.textContent = "Clear conversation";
    if (snapshot) render(snapshot);
  }
}

async function start() {
  if (!sessionId) {
    showError(new Error("The operator URL is missing a valid session ID."));
    elements.analyzeButton.disabled = true;
    return;
  }
  elements.analyzeButton.addEventListener("click", analyzeNow);
  elements.processingButton.addEventListener("click", toggleProcessing);
  elements.resetButton.addEventListener("click", openResetDialog);
  elements.resetConfirm.addEventListener("click", clearConversation);
  elements.newTranscript.addEventListener("click", () => {
    elements.transcript.scrollTop = elements.transcript.scrollHeight;
    elements.newTranscript.hidden = true;
  });
  try {
    render(await loadSession(sessionId));
    subscribeToSession(sessionId, {
      onSnapshot: render,
      onConnection(state) {
        streamConnectionState = state;
        renderStreamState();
      },
      onError: showError
    });
  } catch (error) {
    showError(error);
    elements.analyzeButton.disabled = true;
    elements.processingButton.disabled = true;
    elements.resetButton.disabled = true;
  }
}

start();
