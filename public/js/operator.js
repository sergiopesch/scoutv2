import { parseSessionId, sessionApiPath } from "./session-id.js";
import {
  formatClock,
  loadSession,
  subscribeToSession
} from "./session-stream.js";

const elements = {
  topic: document.querySelector("#meeting-heading"),
  integrations: document.querySelector("#integrations"),
  participants: document.querySelector("#participants"),
  participantCount: document.querySelector("#participant-count"),
  transcript: document.querySelector("#transcript"),
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
    row.append(avatar, name);
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
  const finalized = utterances
    .filter((utterance) => utterance.finalized)
    .sort((left, right) => left.sequence - right.sequence);
  const rows = finalized.map((utterance) => {
    const row = document.createElement("li");
    row.className = "utterance";
    const meta = document.createElement("div");
    meta.className = "utterance-meta";
    const speaker = document.createElement("span");
    speaker.className = "utterance-speaker";
    speaker.textContent = text(utterance.participantName, "Unknown speaker");
    const time = document.createElement("time");
    if (Number.isFinite(utterance.startedAt)) {
      time.dateTime = new Date(utterance.startedAt).toISOString();
    }
    time.textContent = formatClock(utterance.startedAt);
    meta.append(speaker, time);
    const body = document.createElement("p");
    body.textContent = text(utterance.text, "[No transcript text]");
    const id = document.createElement("div");
    id.className = "utterance-id";
    id.textContent = text(utterance.id, "missing evidence ID");
    row.append(meta, body, id);
    return row;
  });
  if (!rows.length) {
    const empty = document.createElement("li");
    empty.className = "empty-copy";
    empty.textContent = "Finalized, speaker-attributed transcript will appear here.";
    rows.push(empty);
  }
  elements.transcript.replaceChildren(...rows);
  elements.transcript.scrollTop = elements.transcript.scrollHeight;
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
