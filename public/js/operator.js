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

const elements = {
  topic: document.querySelector("#meeting-heading"),
  integrations: document.querySelector("#integrations"),
  participants: document.querySelector("#participants"),
  participantCount: document.querySelector("#participant-count"),
  transcript: document.querySelector("#transcript"),
  newTranscript: document.querySelector("#new-transcript"),
  streamDot: document.querySelector("#stream-dot"),
  streamState: document.querySelector("#stream-state"),
  revision: document.querySelector("#revision"),
  pendingCount: document.querySelector("#pending-count"),
  analysisUpdated: document.querySelector("#analysis-updated"),
  question: document.querySelector("#suggested-question"),
  evidence: document.querySelector("#question-evidence"),
  analyzeButton: document.querySelector("#analyze-button"),
  actionNote: document.querySelector("#action-note"),
  error: document.querySelector("#operator-error")
};

const sessionId = parseSessionId();
let snapshot;
let submitting = false;
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
    integrationRow("Analysis", {
      status: next.analysis?.status,
      detail:
        next.analysis?.lastError ??
        `${next.analysis?.pendingUtteranceCount ?? 0} utterances pending`
    })
  );
}

function renderParticipants(participants = []) {
  elements.participantCount.textContent = `${participants.length} present`;
  const rows = participants.map((participant) => {
    const row = document.createElement("li");
    row.className = "participant-row";
    const avatar = document.createElement("span");
    avatar.className = "participant-avatar";
    avatar.textContent = initials(participant.name);
    const name = document.createElement("span");
    name.className = "participant-name";
    name.textContent = text(participant.name, "Unknown participant");
    const role = document.createElement("select");
    role.className = "participant-role";
    role.setAttribute("aria-label", `Role for ${name.textContent}`);
    [
      ["", "Unassigned"],
      ["customer", "Prospective customer"],
      ["operator", "Operator / interviewer"]
    ].forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = value === (participant.role ?? "");
      role.append(option);
    });
    role.addEventListener("change", () => void updateParticipantRole(participant.id, role));
    row.append(avatar, name, role);
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

async function updateParticipantRole(participantId, control) {
  if (!sessionId) return;
  control.disabled = true;
  elements.error.hidden = true;
  try {
    const response = await fetch(
      `${sessionApiPath(sessionId)}/participants/${encodeURIComponent(participantId)}/role`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ role: control.value || "unassigned" })
      }
    );
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || `Role update failed (${response.status}).`);
    }
  } catch (error) {
    showError(error);
    if (snapshot) render(snapshot);
  } finally {
    control.disabled = false;
  }
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
  elements.topic.textContent = text(next.graph?.topic?.label, "Business discovery");
  renderIntegrations(next);
  renderParticipants(next.participants);
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
  const busy = submitting || ["queued", "running"].includes(next.analysis?.status);
  elements.analyzeButton.disabled = busy;
  elements.analyzeButton.textContent = busy ? "Analysis in progress…" : "Analyze now";
  elements.actionNote.textContent = next.analysis?.lastError
    ? next.analysis.lastError
    : next.analysis?.blockedReason
      ? next.analysis.blockedReason
      : next.analysis?.throttled
        ? `Automatic analysis budget reached (${next.analysis?.automaticTurnsStarted ?? 0}/${next.analysis?.automaticTurnBudget ?? 0}). Analyze now remains available.`
    : "Sends finalized utterances not yet included in the accepted graph.";
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

async function start() {
  if (!sessionId) {
    showError(new Error("The operator URL is missing a valid session ID."));
    elements.analyzeButton.disabled = true;
    return;
  }
  elements.analyzeButton.addEventListener("click", analyzeNow);
  elements.newTranscript.addEventListener("click", () => {
    elements.transcript.scrollTop = elements.transcript.scrollHeight;
    elements.newTranscript.hidden = true;
  });
  try {
    render(await loadSession(sessionId));
    subscribeToSession(sessionId, {
      onSnapshot: render,
      onConnection(state) {
        elements.streamDot.dataset.state = state;
        elements.streamState.textContent =
          state === "live" ? "Updates live" : "Reconnecting";
      },
      onError: showError
    });
  } catch (error) {
    showError(error);
    elements.analyzeButton.disabled = true;
  }
}

start();
