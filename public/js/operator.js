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
import { reconcileKeyedChildren } from "./keyed-list.js";
import {
  markQuestionAsked,
  mergeSuggestedQuestion,
  questionQueueStorageKey,
  readQuestionQueue,
  writeQuestionQueue
} from "./question-dock.js";
import {
  analysisErrorMessage,
  analysisActionView,
  identitySelectionView,
  isTerminalStatus,
  sessionStreamView,
  shouldAcceptSnapshot
} from "./ui-state.js";

const elements = {
  shell: document.querySelector(".operator-shell"),
  topic: document.querySelector("#meeting-heading"),
  integrations: document.querySelector("#integrations"),
  participants: document.querySelector("#participants"),
  participantCount: document.querySelector("#participant-count"),
  identityCard: document.querySelector(".identity-card"),
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
  questionDockTrigger: document.querySelector("#operator-question-trigger"),
  questionDockBadge: document.querySelector("#operator-question-badge"),
  questionDock: document.querySelector("#operator-question-dock"),
  questionDockClose: document.querySelector("#operator-question-close"),
  questionDockList: document.querySelector("#operator-question-list"),
  questionDockProgress: document.querySelector("#operator-question-progress"),
  analyzeButton: document.querySelector("#analyze-button"),
  resetButton: document.querySelector("#reset-button"),
  resetDialog: document.querySelector("#reset-dialog"),
  resetCancel: document.querySelector("#reset-cancel"),
  resetConfirm: document.querySelector("#reset-confirm"),
  resetError: document.querySelector("#reset-error"),
  resetStatus: document.querySelector("#reset-status"),
  actionNote: document.querySelector("#action-note"),
  postCallActions: document.querySelector("#post-call-actions"),
  postCallNote: document.querySelector("#post-call-note"),
  postCallReview: document.querySelector("#post-call-review"),
  postCallHandoff: document.querySelector("#post-call-handoff"),
  error: document.querySelector("#operator-error")
};

const sessionId = parseSessionId();
const questionStorage = globalThis.sessionStorage;
const questionStorageId = questionQueueStorageKey(sessionId);
let snapshot;
let submitting = false;
let processingSubmitting = false;
let processingRequestedPaused;
let streamConnectionState = "connecting";
let resetting = false;
let operatorSelection;
let operatorSelectionTimer;
let renderedTranscriptSignature = "";
let stopStream;
let questionQueue = readQuestionQueue(questionStorage, questionStorageId);
let questionDockOpen = false;

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
  const terminal = isTerminalStatus(next.status);
  const postCallReviewReady =
    next.status === "ended" &&
    next.analysis?.status !== "running" &&
    next.analysis?.status !== "queued" &&
    Number(next.analysis?.pendingUtteranceCount ?? 0) === 0;
  const postCallReady = postCallReviewReady && Boolean(next.postCall?.approvedAt);
  elements.shell.dataset.postCallReady = String(postCallReviewReady);
  elements.postCallActions.hidden = next.status !== "ended";
  elements.postCallReview.href = `/review/${encodeURIComponent(sessionId)}`;
  elements.postCallHandoff.href = `/handoff/${encodeURIComponent(sessionId)}`;
  elements.postCallHandoff.setAttribute("aria-disabled", String(!postCallReady));
  elements.postCallHandoff.tabIndex = postCallReady ? 0 : -1;
  elements.postCallNote.textContent = postCallReady
    ? "The diagrams are approved. You can edit them again or open the complete Codex delivery package."
    : postCallReviewReady
      ? "Review and approve the accepted diagrams and notes before the Codex delivery package opens."
      : "Scout is finishing the last accepted map before editing and handoff become available.";
  elements.integrations.replaceChildren(
    integrationRow("Recall", next.recall),
    integrationRow("Codex", next.codex?.status === "error"
      ? { ...next.codex, detail: analysisErrorMessage(next.codex?.detail) }
      : next.codex),
    integrationRow("Processing", {
      status: next.status === "error"
        ? "error"
        : terminal
          ? "idle"
          : next.processing?.paused
            ? "paused"
            : "active",
      detail: next.status === "ended"
        ? "Meeting ended; the accepted transcript and map are retained"
        : next.processing?.paused
          ? "Incoming transcript events are discarded"
          : "Live transcription and automatic analysis enabled"
    }),
    integrationRow("Analysis", {
      status: next.analysis?.status,
      detail: next.analysis?.status === "error"
        ? analysisErrorMessage(next.analysis?.lastError)
        : `${next.analysis?.pendingUtteranceCount ?? 0} utterances pending`
    })
  );
}

function renderStreamState() {
  const view = sessionStreamView(snapshot, streamConnectionState);
  elements.streamDot.dataset.state = view.state;
  elements.streamState.textContent = view.label;
}

function createParticipantRow(participant) {
  if (participant.empty) {
    const empty = document.createElement("li");
    empty.className = "empty-copy";
    return empty;
  }
  const row = document.createElement("li");
  row.className = "participant-row";
    const avatar = document.createElement("span");
    avatar.className = "participant-avatar";
    const copy = document.createElement("div");
    copy.className = "participant-copy";
    const name = document.createElement("span");
    name.className = "participant-name";
    const role = document.createElement("span");
    role.className = "participant-role-label";
    copy.append(name, role);
    const button = document.createElement("button");
    button.className = "identity-button";
    button.type = "button";
    button.addEventListener("click", () => {
      const participantId = button.dataset.participantId;
      if (participantId) void chooseOperator(participantId);
    });
    row.append(avatar, copy, button);
    return row;
  }

function updateParticipantRow(row, participant) {
  if (participant.empty) {
    row.textContent = "Waiting for participants to join.";
    return;
  }
  const avatar = row.querySelector(".participant-avatar");
  const name = row.querySelector(".participant-name");
  const role = row.querySelector(".participant-role-label");
  const button = row.querySelector(".identity-button");
  const selectionState =
    operatorSelection?.participantId === participant.id
      ? operatorSelection.phase
      : "idle";
  row.dataset.role = participant.selected ? "operator" : participant.role;
  row.dataset.selectionState = selectionState;
  row.setAttribute("aria-busy", String(selectionState === "pending"));
  avatar.textContent = initials(participant.name);
  name.textContent = text(participant.name, "Unknown participant");
  role.textContent = `${participant.roleLabel}${
    selectionState === "pending"
      ? " · Saving"
      : selectionState === "saved"
        ? " · Saved"
        : selectionState === "error"
          ? " · Save failed"
          : ""
  }`;
  button.dataset.participantId = participant.id;
  button.textContent = participant.buttonText;
  button.disabled =
    participant.disabled ||
    snapshot?.status === "ended" ||
    snapshot?.status === "error" ||
    streamConnectionState === "reconnecting";
  button.setAttribute("aria-pressed", String(participant.selected));
}

function renderParticipants(next) {
  const participants = operatorIdentityView(
    next.participants,
    next.operatorParticipantId,
    operatorSelection?.phase === "pending"
      ? operatorSelection.participantId
      : undefined
  );
  elements.participantCount.textContent = `${participants.length} present`;
  elements.identityCard.dataset.selected = String(Boolean(next.operatorParticipantId));
  const identityView = identitySelectionView(next, operatorSelection);
  elements.identityStatus.dataset.state = identityView.state;
  elements.identityStatus.textContent = identityView.text;
  const rows = participants.length > 0
    ? participants
    : [{ id: "empty", empty: true }];
  reconcileKeyedChildren(elements.participants, rows, {
    keyOf: (participant) => participant.empty
      ? "empty"
      : `participant:${participant.id}`,
    create: createParticipantRow,
    update: updateParticipantRow
  });
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
      turn.startedAt >= 100_000_000_000 &&
      Number.isFinite(new Date(turn.startedAt).getTime())
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

function setQuestionDockOpen(open, { restoreFocus = true } = {}) {
  questionDockOpen = Boolean(open && questionQueue.length > 0);
  elements.questionDock.dataset.open = String(questionDockOpen);
  elements.questionDock.setAttribute("aria-hidden", String(!questionDockOpen));
  elements.questionDockTrigger.setAttribute("aria-expanded", String(questionDockOpen));
  if (!restoreFocus) return;
  requestAnimationFrame(() => {
    if (questionDockOpen) {
      const nextQuestion = [...elements.questionDockList.querySelectorAll("input")]
        .find((input) => !input.checked);
      (nextQuestion ?? elements.questionDockClose).focus();
    } else {
      elements.questionDockTrigger.focus();
    }
  });
}

function renderQuestionDock() {
  const hasQuestions = questionQueue.length > 0;
  elements.questionDockTrigger.hidden = !hasQuestions;
  elements.questionDock.hidden = !hasQuestions;
  if (!hasQuestions) {
    setQuestionDockOpen(false, { restoreFocus: false });
    elements.questionDockList.replaceChildren();
    return;
  }
  elements.questionDockList.replaceChildren(...questionQueue.map((question) => {
    const item = document.createElement("li");
    item.dataset.asked = String(question.asked);
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = question.asked;
    input.dataset.questionId = question.id;
    const mark = document.createElement("span");
    mark.className = "question-checkmark";
    mark.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    copy.className = "question-copy";
    copy.textContent = question.text;
    input.addEventListener("change", () => {
      questionQueue = markQuestionAsked(questionQueue, question.id, input.checked);
      writeQuestionQueue(questionStorage, questionStorageId, questionQueue);
      renderQuestionDock();
      requestAnimationFrame(() => {
        [...elements.questionDockList.querySelectorAll("input")]
          .find((candidate) => candidate.dataset.questionId === question.id)
          ?.focus();
      });
    });
    label.append(input, mark, copy);
    item.append(label);
    return item;
  }));
  const asked = questionQueue.filter((question) => question.asked).length;
  const remaining = questionQueue.length - asked;
  elements.questionDockProgress.textContent = questionQueue.length === 1
    ? asked === 1 ? "Asked" : "Not asked yet"
    : `${asked} of ${questionQueue.length} asked`;
  elements.questionDockBadge.textContent = remaining > 0 ? String(remaining) : "";
  elements.questionDockBadge.hidden = remaining === 0;
  elements.questionDockTrigger.dataset.hasUnasked = String(remaining > 0);
  elements.questionDockTrigger.setAttribute(
    "aria-label",
    remaining > 0
      ? `Open suggested questions, ${remaining} not yet asked`
      : "Open suggested questions, all asked"
  );
}

function captureSuggestedQuestion(question) {
  const next = mergeSuggestedQuestion(questionQueue, question);
  if (JSON.stringify(next) === JSON.stringify(questionQueue)) return;
  questionQueue = next;
  writeQuestionQueue(questionStorage, questionStorageId, questionQueue);
  renderQuestionDock();
}

function render(next, { force = false } = {}) {
  if (!force && !shouldAcceptSnapshot(snapshot, next)) return;
  if (operatorSelection?.phase === "saved") {
    const conflicts =
      next.operatorParticipantId !== operatorSelection.participantId;
    if (
      !force &&
      conflicts &&
      Number(next.updatedAt ?? 0) <=
        Number(operatorSelection.confirmedUpdatedAt ?? 0)
    ) {
      return;
    }
    if (conflicts) {
      if (operatorSelectionTimer !== undefined) {
        clearTimeout(operatorSelectionTimer);
      }
      operatorSelection = undefined;
    }
  }
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
  captureSuggestedQuestion(next.graph?.suggestedQuestion?.text);
  const processingView = processingControlView(
    next.processing,
    processingSubmitting,
    processingRequestedPaused,
    next.status
  );
  elements.processingCard.dataset.paused = String(processingView.paused);
  elements.processingCard.dataset.sessionStatus = next.status;
  elements.processingState.textContent = processingView.statusText;
  elements.processingButton.textContent = processingView.buttonText;
  elements.processingButton.setAttribute(
    "aria-pressed",
    String(processingView.paused)
  );
  elements.processingButton.disabled = processingView.disabled || resetting;
  elements.processingNote.textContent = processingView.note;
  const terminal = isTerminalStatus(next.status);
  elements.processingButton.disabled =
    processingView.disabled ||
    resetting ||
    streamConnectionState === "reconnecting";
  const actionView = analysisActionView(next, {
    submitting,
    resetting,
    connectionState: streamConnectionState
  });
  elements.analyzeButton.disabled = actionView.disabled;
  elements.analyzeButton.textContent = actionView.buttonText;
  elements.resetButton.disabled =
    resetting ||
    processingSubmitting ||
    !snapshot ||
    terminal ||
    streamConnectionState === "reconnecting";
  elements.resetButton.textContent = resetting
    ? "Clearing conversation…"
    : "Clear conversation";
  elements.actionNote.textContent = actionView.note;
}

function markOperatorSelectionSaved(participantId, confirmedUpdatedAt) {
  operatorSelection = {
    participantId,
    phase: "saved",
    confirmedUpdatedAt
  };
  operatorSelectionTimer = setTimeout(() => {
    if (operatorSelection?.phase === "saved") {
      operatorSelection = undefined;
      if (snapshot) render(snapshot, { force: true });
    }
  }, 3_000);
}

async function chooseOperator(participantId) {
  if (!sessionId || operatorSelection?.phase === "pending") return;
  if (operatorSelectionTimer !== undefined) clearTimeout(operatorSelectionTimer);
  operatorSelection = { participantId, phase: "pending" };
  elements.error.hidden = true;
  if (snapshot) render(snapshot, { force: true });
  try {
    const updated = await selectOperator(sessionId, participantId);
    markOperatorSelectionSaved(participantId, updated.updatedAt);
    render(updated);
  } catch (error) {
    if (snapshot?.operatorParticipantId === participantId) {
      markOperatorSelectionSaved(participantId, snapshot.updatedAt);
    } else {
      operatorSelection = { participantId, phase: "error" };
      showError(error);
    }
    if (snapshot) render(snapshot, { force: true });
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
  elements.questionDockTrigger.addEventListener("click", () => {
    setQuestionDockOpen(!questionDockOpen);
  });
  elements.questionDockClose.addEventListener("click", () => {
    setQuestionDockOpen(false);
  });
  elements.postCallHandoff.addEventListener("click", (event) => {
    if (elements.postCallHandoff.getAttribute("aria-disabled") === "true") {
      event.preventDefault();
    }
  });
  elements.newTranscript.addEventListener("click", () => {
    elements.transcript.scrollTop = elements.transcript.scrollHeight;
    elements.newTranscript.hidden = true;
  });
  elements.analyzeButton.disabled = true;
  elements.processingButton.disabled = true;
  elements.resetButton.disabled = true;
  renderQuestionDock();
  const receiveSnapshot = (next) => {
    elements.error.hidden = true;
    render(next);
    if (next.status === "error") stopStream?.();
  };
  try {
    stopStream = subscribeToSession(sessionId, {
      onSnapshot: receiveSnapshot,
      onConnection(state) {
        streamConnectionState = state;
        renderStreamState();
        if (snapshot) render(snapshot, { force: true });
      },
      onError: showError
    });
    render(await loadSession(sessionId));
  } catch (error) {
    if (!snapshot) {
      showError(error);
      elements.streamDot.dataset.state = "error";
      elements.streamState.textContent = "Meeting unavailable";
      elements.analyzeButton.disabled = true;
      elements.processingButton.disabled = true;
      elements.resetButton.disabled = true;
    }
  }
}

document.addEventListener("click", (event) => {
  if (
    !questionDockOpen ||
    elements.questionDock.contains(event.target) ||
    elements.questionDockTrigger.contains(event.target)
  ) return;
  setQuestionDockOpen(false, { restoreFocus: false });
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !questionDockOpen) return;
  event.preventDefault();
  setQuestionDockOpen(false);
});

window.addEventListener("pagehide", () => {
  stopStream?.();
  if (operatorSelectionTimer !== undefined) clearTimeout(operatorSelectionTimer);
});

start();
