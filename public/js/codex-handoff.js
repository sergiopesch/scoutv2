import { parseSessionId } from "./session-id.js";
import {
  loadCodexHandoff,
  prepareCodexHandoff
} from "./codex-handoff-api.js";

const elements = {
  topic: document.querySelector("#handoff-topic"),
  status: document.querySelector("#handoff-status"),
  statusDot: document.querySelector("#handoff-status-dot"),
  outcomes: document.querySelector("#handoff-outcomes"),
  inventory: document.querySelector("#handoff-inventory"),
  revision: document.querySelector("#handoff-revision"),
  tasks: document.querySelector("#handoff-tasks"),
  transcript: document.querySelector("#handoff-transcript"),
  notes: document.querySelector("#handoff-notes"),
  diagrams: document.querySelector("#handoff-diagrams"),
  directory: document.querySelector("#handoff-directory"),
  raw: document.querySelector("#handoff-json"),
  error: document.querySelector("#handoff-error"),
  retry: document.querySelector("#handoff-retry"),
  back: document.querySelector("#handoff-back"),
  copy: document.querySelector("#handoff-copy"),
  download: document.querySelector("#handoff-download"),
  open: document.querySelector("#handoff-open")
};

const sessionId = parseSessionId();
let preview;
let prepared;
let preparing;

const pluginName = (value) => {
  const match = String(value).match(/\[@([^\]]+)\]/);
  return match?.[1] ?? String(value);
};

function outcomeCard(outcome, index) {
  const article = document.createElement("article");
  article.className = "outcome-card";
  const number = document.createElement("span");
  number.textContent = String(index + 1).padStart(2, "0");
  const title = document.createElement("h2");
  title.textContent = outcome.title;
  const deliverable = document.createElement("p");
  deliverable.textContent = outcome.deliverable;
  const guardrail = document.createElement("small");
  guardrail.textContent = outcome.guardrail;
  article.append(number, title, deliverable, guardrail);
  return article;
}

function inventoryItem(name, detail) {
  const item = document.createElement("article");
  item.className = "inventory-item";
  const mark = document.createElement("span");
  mark.textContent = "✓";
  const copy = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = name;
  const paragraph = document.createElement("p");
  paragraph.textContent = detail;
  copy.append(heading, paragraph);
  item.append(mark, copy);
  return item;
}

function taskRow(task) {
  const row = document.createElement("tr");
  for (const value of [
    task.title,
    task.model,
    task.reasoning,
    task.plugins.map(pluginName).join(", ") || "None",
    task.dependsOn.join(", ") || "—"
  ]) {
    const cell = document.createElement("td");
    cell.textContent = value;
    row.append(cell);
  }
  return row;
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
  elements.outcomes.replaceChildren(
    ...handoff.outcomes.map(outcomeCard)
  );
  elements.revision.textContent = `Graph r${handoff.diagrams.graphRevision} · review ${handoff.diagrams.reviewRevision}`;
  const transcriptCount = handoff.evidence.transcript.length;
  const noteLength = handoff.evidence.notes.trim().length;
  elements.inventory.replaceChildren(
    inventoryItem("Immutable transcript", `${transcriptCount} finalized attributed utterances`),
    inventoryItem("Curated business graph", `${handoff.diagrams.graph.nodes.length} elements · ${handoff.diagrams.graph.edges.length} connections`),
    inventoryItem("Semantic diagram source", "Process, Organisation and Architecture · current and target projections"),
    inventoryItem("Human notes", noteLength ? `${noteLength} reviewed characters` : "No additional notes"),
    inventoryItem("Open questions", `${handoff.openQuestions.length} explicit gaps or contradictions`),
    inventoryItem("Integrity manifest", "SHA-256 hashes bind every published artifact to this review revision")
  );
  elements.tasks.replaceChildren(
    taskRow(handoff.orchestration.lead),
    ...handoff.orchestration.tasks.map(taskRow)
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
  elements.copy.disabled = !result.ready;
  elements.open.disabled = !result.ready;
}

function showError(error, { retry = false } = {}) {
  elements.error.hidden = false;
  elements.error.textContent = error instanceof Error ? error.message : String(error);
  elements.retry.hidden = !retry;
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {}
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("The prompt is ready, but Scout could not copy it. Select it from the machine-readable package instead.");
}

async function ensurePrepared() {
  if (prepared) return prepared;
  if (preparing) return preparing;
  elements.error.hidden = true;
  elements.open.disabled = true;
  elements.copy.disabled = true;
  elements.open.textContent = "Preparing local project…";
  preparing = prepareCodexHandoff(sessionId, {
    graphRevision: preview.package.diagrams.graphRevision,
    reviewRevision: preview.package.diagrams.reviewRevision
  })
    .then((result) => {
      prepared = result;
      elements.directory.hidden = false;
      elements.directory.textContent = `Prepared locally: ${result.directory}`;
      return result;
    })
    .finally(() => {
      preparing = undefined;
      elements.open.disabled = !preview?.ready;
      elements.copy.disabled = !preview?.ready;
      elements.open.textContent = "Open project in Codex →";
    });
  return preparing;
}

elements.open.addEventListener("click", async () => {
  try {
    const result = await ensurePrepared();
    globalThis.location.href = result.launchUrl;
  } catch (error) {
    showError(error);
  }
});

elements.copy.addEventListener("click", async () => {
  try {
    const result = await ensurePrepared();
    await copyText(result.prompt);
    elements.copy.textContent = "Prompt copied";
    setTimeout(() => { elements.copy.textContent = "Prepare & copy prompt"; }, 2_000);
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
    showError(new Error("The Codex package URL has no valid session ID."));
    return;
  }
  try {
    render(await loadCodexHandoff(sessionId));
  } catch (error) {
    showError(error, { retry: true });
  }
}

elements.retry.addEventListener("click", () => {
  elements.error.hidden = true;
  elements.retry.hidden = true;
  start();
});

start();
