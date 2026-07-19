import { parseSessionId } from "./session-id.js";
import {
  loadCodexHandoff,
  launchCodexHandoff
} from "./codex-handoff-api.js";

const elements = {
  topic: document.querySelector("#handoff-topic"),
  status: document.querySelector("#handoff-status"),
  statusDot: document.querySelector("#handoff-status-dot"),
  inventory: document.querySelector("#handoff-inventory"),
  revision: document.querySelector("#handoff-revision"),
  taskCount: document.querySelector("#handoff-task-count"),
  tasks: document.querySelector("#handoff-tasks"),
  transcript: document.querySelector("#handoff-transcript"),
  notes: document.querySelector("#handoff-notes"),
  diagrams: document.querySelector("#handoff-diagrams"),
  directory: document.querySelector("#handoff-directory"),
  raw: document.querySelector("#handoff-json"),
  error: document.querySelector("#handoff-error"),
  retry: document.querySelector("#handoff-retry"),
  back: document.querySelector("#handoff-back"),
  download: document.querySelector("#handoff-download"),
  open: document.querySelector("#handoff-open"),
  openStatus: document.querySelector("#handoff-open small"),
  openLabel: document.querySelector("#handoff-open strong")
};

const sessionId = parseSessionId();
let preview;
let launched;
let launching;

function inventoryItem(name, detail) {
  const item = document.createElement("article");
  item.className = "inventory-item";
  const copy = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = name;
  const paragraph = document.createElement("p");
  paragraph.textContent = detail;
  copy.append(heading, paragraph);
  item.append(copy);
  return item;
}

function taskCard(task, index) {
  const card = document.createElement("article");
  card.className = `task-card${index === 0 ? " task-card-lead" : ""}`;
  const ordinal = document.createElement("span");
  ordinal.className = "task-ordinal";
  ordinal.textContent = index === 0 ? "Lead" : String(index).padStart(2, "0");
  const title = document.createElement("h3");
  title.textContent = index === 0 ? "Lead task brief" : task.title;
  const setup = document.createElement("p");
  setup.className = "task-setup";
  setup.textContent = index === 0
    ? "Keeps the delivery coherent and coordinates the approved work tasks."
    : task.objective.split(/(?<=[.!?])\s/, 1)[0];
  const meta = document.createElement("div");
  meta.className = "task-meta";
  for (const value of [task.model, `${task.reasoning} reasoning`]) {
    if (!value) continue;
    const chip = document.createElement("span");
    chip.textContent = value;
    meta.append(chip);
  }
  const execution = document.createElement("details");
  execution.className = "task-execution";
  const executionSummary = document.createElement("summary");
  executionSummary.textContent = "Execution details";
  execution.append(executionSummary, meta);
  card.append(ordinal, title, setup, execution);
  return card;
}

function render(result) {
  if (!result.ready || !result.package) {
    throw new Error(result.blocker || "The final package is not ready.");
  }
  preview = result;
  const handoff = result.package;
  elements.topic.textContent = handoff.topic;
  elements.statusDot.dataset.state = result.ready ? "ended" : "waiting";
  elements.status.textContent = "Approved package";
  document.body.dataset.handoffState = "ready";
  const specialistCount = handoff.orchestration.tasks.length;
  elements.taskCount.textContent = `${specialistCount} specialist ${specialistCount === 1 ? "task" : "tasks"}`;
  elements.revision.textContent = `Graph r${handoff.diagrams.graphRevision} · review ${handoff.diagrams.reviewRevision}`;
  const transcriptCount = handoff.evidence.transcript.length;
  const noteLength = handoff.evidence.notes.trim().length;
  const reviewDecisionCount = Object.keys(handoff.review.annotations ?? {}).length;
  elements.inventory.replaceChildren(
    inventoryItem("Immutable transcript", `${transcriptCount} finalized attributed utterances`),
    inventoryItem("Curated business graph", `${handoff.diagrams.graph.nodes.length} elements · ${handoff.diagrams.graph.edges.length} connections`),
    inventoryItem("Semantic diagram source", "Process, Organisation and Architecture · current and target projections"),
    inventoryItem("Human notes", noteLength ? `${noteLength} reviewed characters` : "No additional notes"),
    inventoryItem("Review decisions", reviewDecisionCount ? `${reviewDecisionCount} item-level decisions or amendments` : "No item-level amendments"),
    inventoryItem("Open questions", `${handoff.openQuestions.length} explicit gaps or contradictions`),
    inventoryItem("Integrity manifest", "SHA-256 hashes bind every published artifact to this review revision")
  );
  elements.tasks.replaceChildren(
    taskCard(handoff.orchestration.lead, 0),
    ...handoff.orchestration.tasks.map((task, index) => taskCard(task, index + 1))
  );
  elements.transcript.replaceChildren(...handoff.evidence.transcript.map((utterance) => {
    const item = document.createElement("li");
    const speaker = document.createElement("strong");
    speaker.textContent = utterance.participantName;
    const copy = document.createElement("span");
    copy.textContent = utterance.text;
    item.append(speaker, copy);
    return item;
  }));
  elements.notes.textContent = handoff.evidence.notes.trim() || "No post-call notes were added.";
  elements.diagrams.replaceChildren(...handoff.diagrams.views.map((view) => {
    const item = document.createElement("article");
    const heading = document.createElement("h3");
    heading.textContent = view.id === "organization" ? "Organisation" : `${view.id[0].toUpperCase()}${view.id.slice(1)}`;
    const count = handoff.diagrams.graph.nodes.filter((node) => node.facets?.[view.id]).length;
    const copy = document.createElement("p");
    copy.textContent = `${count} elements · current and target · ${view.description}`;
    item.append(heading, copy);
    return item;
  }));
  elements.raw.textContent = JSON.stringify(handoff, null, 2);
  elements.back.href = `/review/${encodeURIComponent(sessionId)}`;
  elements.download.href = `/api/handoffs/${encodeURIComponent(sessionId)}/download`;
  elements.download.setAttribute("aria-disabled", String(!result.ready));
  elements.download.tabIndex = result.ready ? 0 : -1;
  elements.open.disabled = !result.ready;
}

function showError(error, { retry = false } = {}) {
  elements.error.hidden = false;
  elements.error.textContent = error instanceof Error ? error.message : String(error);
  elements.retry.hidden = !retry;
}

async function ensureLaunched() {
  if (launched) return launched;
  if (launching) return launching;
  elements.error.hidden = true;
  elements.open.disabled = true;
  document.body.dataset.handoffState = "launching";
  elements.openStatus.textContent = "Creating the lead and linked tasks";
  elements.openLabel.textContent = "Codex is getting to work…";
  launching = launchCodexHandoff(sessionId, {
    graphRevision: preview.package.diagrams.graphRevision,
    reviewRevision: preview.package.diagrams.reviewRevision
  })
    .then((result) => {
      launched = result;
      elements.directory.hidden = false;
      elements.directory.textContent = `Approved context: ${result.directory}`;
      document.body.dataset.handoffState = "launched";
      return result;
    })
    .finally(() => {
      launching = undefined;
      elements.open.disabled = !preview?.ready;
      elements.openStatus.textContent = launched ? "Lead and linked tasks created" : "Creates a lead and linked tasks";
      elements.openLabel.textContent = launched ? "Codex is underway" : "Let Codex do its thing";
    });
  return launching;
}

elements.open.addEventListener("click", async () => {
  try {
    const result = await ensureLaunched();
    document.body.dataset.handoffState = "launching";
    elements.openStatus.textContent = "Opening Codex";
    elements.openLabel.textContent = "Codex is underway";
    globalThis.location.href = result.launchUrl;
  } catch (error) {
    showError(error);
  }
});

elements.download.addEventListener("click", (event) => {
  if (elements.download.getAttribute("aria-disabled") === "true") event.preventDefault();
});

async function start() {
  elements.back.href = sessionId ? `/review/${encodeURIComponent(sessionId)}` : "/";
  elements.retry.hidden = true;
  if (!sessionId) {
    document.body.dataset.handoffState = "error";
    showError(new Error("The Codex package URL has no valid session ID."));
    return;
  }
  try {
    render(await loadCodexHandoff(sessionId));
  } catch (error) {
    document.body.dataset.handoffState = "error";
    showError(error, { retry: true });
  }
}

elements.retry.addEventListener("click", () => {
  elements.error.hidden = true;
  elements.retry.hidden = true;
  start();
});

start();
