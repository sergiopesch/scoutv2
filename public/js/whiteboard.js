import mermaid from "/vendor/mermaid/mermaid.esm.min.mjs";
import {
  projectBusinessGraph,
  projectionEntityDetail,
  projectionSummary,
  semanticProjectionHash,
  VIEW_DEFINITIONS
} from "./diagram-projections.js";
import {
  compileProjectionCandidates,
  renderIdForEntity
} from "./multi-view-mermaid.js";
import {
  evaluateGeometryCandidate,
  geometryCandidateFromSvg
} from "./geometry-gate.js";
import {
  createViewRenderCoordinator,
  DIAGRAM_VIEW_KINDS
} from "./view-render-coordinator.js";
import { parseSessionId } from "./session-id.js";
import { loadWhiteboard, subscribeToWhiteboard } from "./session-stream.js";
import { shouldAcceptSnapshot, whiteboardStatusView } from "./ui-state.js";
import {
  POST_CALL_NODE_KINDS,
  addGraphEdge,
  addGraphNode,
  isPostCallReviewPath,
  loadPostCallReview,
  postCallReviewView,
  removeGraphEdge,
  removeGraphNode,
  savePostCallReview,
  updateGraphEdge,
  updateGraphNode
} from "./post-call-editor.js";

const bySelector = (selector) => document.querySelector(selector);
const bySelectorAll = (selector) => [...document.querySelectorAll(selector)];

const elements = {
  topic: bySelector("#topic"),
  statusDot: bySelector("#whiteboard-status-dot"),
  statusLabel: bySelector("#whiteboard-status-label"),
  alert: bySelector("#render-alert"),
  alertText: bySelector("#render-alert-text"),
  retry: bySelector("#render-retry"),
  followUp: bySelector("#follow-up"),
  followUpText: bySelector("#follow-up-text"),
  summary: bySelector("#view-summary"),
  revision: bySelector("#view-revision"),
  search: bySelector("#outline-search"),
  outline: bySelector("#view-outline"),
  selection: bySelector("#inspector-selection"),
  zoomIn: bySelector("#zoom-in"),
  zoomOut: bySelector("#zoom-out"),
  zoomFit: bySelector("#zoom-fit"),
  followLive: bySelector("#follow-live"),
  reviewToolbar: bySelector("#review-toolbar"),
  reviewState: bySelector("#review-state"),
  reviewUndo: bySelector("#review-undo"),
  reviewRedo: bySelector("#review-redo"),
  reviewAdd: bySelector("#review-add"),
  reviewSave: bySelector("#review-save"),
  reviewHandoff: bySelector("#review-handoff"),
  reviewNotes: bySelector("#review-notes"),
  reviewTopic: bySelector("#review-topic"),
  reviewNotesText: bySelector("#review-notes-text"),
  elementEditor: bySelector("#element-editor"),
  editorKicker: bySelector("#editor-kicker"),
  editorLabel: bySelector("#editor-label"),
  editorShortLabel: bySelector("#editor-short-label"),
  editorKind: bySelector("#editor-kind"),
  editorScope: bySelector("#editor-scope"),
  editorCertainty: bySelector("#editor-certainty"),
  editorConnectionCount: bySelector("#editor-connection-count"),
  editorConnectionList: bySelector("#editor-connection-list"),
  editorConnectionTarget: bySelector("#editor-connection-target"),
  editorAddConnection: bySelector("#editor-add-connection"),
  editorDeleteConfirmation: bySelector("#editor-delete-confirmation"),
  editorDelete: bySelector("#editor-delete"),
  tabs: new Map(bySelectorAll("[data-view]").map((element) => [element.dataset.view, element])),
  panels: new Map(bySelectorAll("[data-view-panel]").map((element) => [element.dataset.viewPanel, element])),
  frames: new Map(bySelectorAll("[data-graph-frame]").map((element) => [element.dataset.graphFrame, element])),
  updates: new Map(bySelectorAll("[data-view-update]").map((element) => [element.dataset.viewUpdate, element])),
  scopes: bySelectorAll("[data-scope]")
};

const sessionId = parseSessionId();
const reviewMode = isPostCallReviewPath();
const scopes = Object.fromEntries(DIAGRAM_VIEW_KINDS.map((kind) => [kind, "current"]));
const zoom = Object.fromEntries(DIAGRAM_VIEW_KINDS.map((kind) => [kind, 1]));
const followLive = Object.fromEntries(DIAGRAM_VIEW_KINDS.map((kind) => [kind, true]));
const projections = new Map();
const unseenViews = new Set();
let activeView = "process";
let selectedEntityId;
let currentSnapshot;
let streamConnectionState = "connecting";
let stopStream;
let savingReview = false;
let reviewDirty = false;
let undoStack = [];
let redoStack = [];
let editorTextSession;
let deleteArmedEntityId;
let notesTextSession = false;
let recoveryAction;

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  deterministicIds: true,
  deterministicIDSeed: "scout-live-views",
  fontFamily: "Avenir Next, Avenir, Segoe UI, sans-serif",
  flowchart: {
    curve: "linear",
    htmlLabels: false,
    nodeSpacing: 56,
    rankSpacing: 82,
    padding: 14,
    useMaxWidth: true
  },
  architecture: {
    randomize: false,
    seed: 1,
    nodeSeparation: 90,
    idealEdgeLengthMultiplier: 2,
    numIter: 1200,
    useMaxWidth: true
  },
  themeVariables: {
    background: "transparent",
    primaryColor: "#101115",
    primaryTextColor: "#FAFAF7",
    nodeTextColor: "#FAFAF7",
    textColor: "#101115",
    primaryBorderColor: "#101115",
    lineColor: "#62656C",
    edgeLabelBackground: "#FAFAF7",
    clusterBkg: "#F7F7F3",
    clusterBorder: "#B8B9B5",
    fontSize: "16px"
  }
});

function setStatus(snapshot, connectionState = "live") {
  const view = whiteboardStatusView(snapshot, connectionState);
  elements.statusDot.dataset.state = view.state;
  elements.statusLabel.textContent = view.label;
}

function showRenderError(viewKind, error) {
  if (!error) {
    elements.alert.hidden = true;
    elements.alertText.textContent = "";
    recoveryAction = undefined;
    elements.retry.textContent = "Retry view";
    return;
  }
  const label = VIEW_DEFINITIONS[viewKind]?.label ?? "Map";
  elements.alert.hidden = false;
  elements.retry.textContent = recoveryAction === "reload" ? "Reload latest" : "Retry view";
  elements.alertText.textContent = `${recoveryAction === "reload" ? "Review action needs attention" : `${label} update paused — keeping its last valid view`} — ${
    error instanceof Error ? error.message : String(error)
  }`;
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

async function readyForMeasurement() {
  if (document.fonts?.ready) await document.fonts.ready;
  await nextFrame();
}

function tagInteractiveEntities(svg, projection) {
  const candidates = [
    ...svg.querySelectorAll("g.node"),
    ...svg.querySelectorAll("g.architecture-service")
  ];
  for (const node of projection.nodes) {
    const renderIds = [renderIdForEntity(node.id), renderIdForEntity(node.id, "service")];
    const element = candidates.find((candidate) =>
      renderIds.some((renderId) => candidate.id?.includes(renderId))
    );
    if (!element) continue;
    element.dataset.entityId = node.id;
    element.setAttribute("role", "button");
    element.setAttribute("tabindex", "0");
    element.setAttribute("aria-label", `${node.label}. ${node.semanticType}. ${node.state ?? "unknown"}.`);
  }
}

async function renderDiagram({ viewKind, projection, revision, roleRevision, semanticHash, generation }) {
  const failures = [];
  for (const [candidateIndex, candidate] of compileProjectionCandidates(projection).entries()) {
    let staging;
    try {
      if (candidate.omittedSemanticEdgeIds.length > 0) {
        throw new Error(`omits semantic edges: ${candidate.omittedSemanticEdgeIds.join(", ")}`);
      }
      const { svg, bindFunctions } = await mermaid.render(
        `scout-${viewKind}-${roleRevision}-${revision}-${generation}-${candidateIndex}`,
        candidate.source
      );
      staging = document.createElement("div");
      staging.className = "diagram-measure-stage";
      staging.setAttribute("aria-hidden", "true");
      staging.innerHTML = svg;
      document.body.append(staging);
      const renderedSvg = staging.querySelector("svg");
      if (!renderedSvg) throw new Error("Mermaid returned no SVG.");
      renderedSvg.setAttribute("role", "img");
      renderedSvg.setAttribute("aria-label", `${projection.title}, revision ${revision}`);
      renderedSvg.removeAttribute("height");
      renderedSvg.removeAttribute("width");
      tagInteractiveEntities(renderedSvg, projection);
      await readyForMeasurement();
      const geometry = geometryCandidateFromSvg(renderedSvg);
      if (viewKind === "organization") {
        const entityForDomId = (domId) => projection.nodes.find((node) =>
          [renderIdForEntity(node.id), renderIdForEntity(node.id, "service")]
            .some((renderId) => String(domId ?? "").includes(renderId))
        )?.id;
        for (const geometryEdge of geometry.edges) {
          const sourceId = entityForDomId(geometryEdge.sourceId);
          const targetId = entityForDomId(geometryEdge.targetId);
          const semanticEdge = projection.edges.find((edge) =>
            (edge.from === sourceId && edge.to === targetId) ||
            (edge.from === targetId && edge.to === sourceId)
          );
          geometryEdge.importance = semanticEdge?.semanticType === "primary_report"
            ? "primary"
            : "secondary";
        }
      }
      const gate = evaluateGeometryCandidate(geometry, {
        rejectPrimaryEdgeCrossings: viewKind === "organization"
      });
      if (projection.nodes.length > 0 && geometry.nodes.length < projection.nodes.length) {
        gate.accepted = false;
        gate.hardFailures.push({
          type: "unmeasured-nodes",
          expected: projection.nodes.length,
          measured: geometry.nodes.length
        });
      }
      if (geometry.edges.length < candidate.renderedSemanticEdgeIds.length) {
        gate.accepted = false;
        gate.hardFailures.push({
          type: "unmeasured-semantic-edges",
          expected: candidate.renderedSemanticEdgeIds.length,
          measured: geometry.edges.length
        });
      }
      if (!gate.accepted) {
        failures.push(`${candidate.id}: ${gate.hardFailures.map(({ type }) => type).join(", ")}`);
        continue;
      }
      renderedSvg.dataset.layoutProfile = candidate.id;
      renderedSvg.dataset.semanticHash = semanticHash;
      renderedSvg.dataset.edgeCrossings = String(gate.metrics.edgeCrossings);
      renderedSvg.remove();
      return { renderedSvg, bindFunctions, candidateId: candidate.id, gate };
    } catch (error) {
      failures.push(`${candidate.id}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      staging?.remove();
    }
  }
  throw new Error(`No readable layout candidate. ${failures.join(" · ")}`);
}

function handleEntityInteraction(event) {
  const target = event.target.closest?.("[data-entity-id]");
  if (!target) return;
  if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
  if (event.type === "keydown") event.preventDefault();
  selectEntity(target.dataset.entityId);
}

async function commitDiagram({ viewKind, projection, revision, roleRevision, semanticHash, artifact }) {
  const frame = elements.frames.get(viewKind);
  if (!frame) return;
  const focusedEntity = viewKind === activeView && frame.contains(document.activeElement)
    ? document.activeElement?.closest?.("[data-entity-id]")?.dataset.entityId
    : undefined;
  frame.replaceChildren(artifact.renderedSvg);
  artifact.bindFunctions?.(frame);
  frame.dataset.revision = String(revision);
  frame.dataset.roleRevision = String(roleRevision);
  frame.dataset.semanticHash = semanticHash;
  frame.dataset.committed = "true";
  frame.setAttribute("aria-busy", "false");
  artifact.renderedSvg.addEventListener("click", handleEntityInteraction);
  artifact.renderedSvg.addEventListener("keydown", handleEntityInteraction);
  projections.set(viewKind, projection);
  for (const element of frame.querySelectorAll("[data-entity-id]")) {
    element.dataset.selected = String(element.dataset.entityId === selectedEntityId);
  }
  if (focusedEntity && viewKind === activeView) {
    const focusTarget = [...frame.querySelectorAll("[data-entity-id]")]
      .find((element) => element.dataset.entityId === focusedEntity);
    focusTarget?.focus({ preventScroll: true });
  }
  if (viewKind === activeView) {
    if (followLive[viewKind]) setZoom(1);
    showRenderError(viewKind);
    unseenViews.delete(viewKind);
    renderActiveMetadata();
  } else {
    unseenViews.add(viewKind);
  }
  updateTabIndicators();
}

const coordinator = createViewRenderCoordinator({
  project(graph, viewKind, scope) {
    return projectBusinessGraph(graph, viewKind, scope);
  },
  hash: semanticProjectionHash,
  render: renderDiagram,
  commit: commitDiagram,
  onState(viewKind, state) {
    const frame = elements.frames.get(viewKind);
    frame?.setAttribute("aria-busy", String(state.status === "rendering"));
    if (viewKind !== activeView && state.status === "dirty") unseenViews.add(viewKind);
    if (viewKind === activeView) renderActiveMetadata();
    updateTabIndicators();
  },
  onError(viewKind, error) {
    if (viewKind === activeView) showRenderError(viewKind, error);
  }
});

function updateTabIndicators() {
  for (const viewKind of DIAGRAM_VIEW_KINDS) {
    const update = elements.updates.get(viewKind);
    if (update) update.hidden = viewKind === activeView || !unseenViews.has(viewKind);
  }
}

function selectEntity(entityId) {
  deleteArmedEntityId = undefined;
  selectedEntityId = entityId;
  for (const frame of elements.frames.values()) {
    for (const element of frame.querySelectorAll("[data-entity-id]")) {
      element.dataset.selected = String(element.dataset.entityId === entityId);
    }
  }
  renderActiveMetadata();
}

const cloneValue = (value) =>
  typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));

function reviewEvidenceId() {
  const topicEvidence = currentSnapshot?.graph?.topic?.evidenceUtteranceIds?.[0];
  if (topicEvidence) return topicEvidence;
  const customers = new Set(
    (currentSnapshot?.participants ?? [])
      .filter((participant) => participant.role === "customer")
      .map((participant) => participant.id)
  );
  return currentSnapshot?.utterances?.find(
    (utterance) => utterance.finalized && customers.has(utterance.participantId)
  )?.id;
}

function reviewHistoryState() {
  return {
    graph: cloneValue(currentSnapshot.graph),
    notes: currentSnapshot.postCall?.notes ?? ""
  };
}

function applyReviewState(state, { record = true } = {}) {
  if (!reviewMode || !currentSnapshot) return;
  if (record) {
    undoStack.push(reviewHistoryState());
    if (undoStack.length > 50) undoStack.shift();
    redoStack = [];
  }
  currentSnapshot = {
    ...currentSnapshot,
    graph: cloneValue(state.graph),
    postCall: {
      ...currentSnapshot.postCall,
      notes: state.notes ?? currentSnapshot.postCall?.notes ?? ""
    }
  };
  reviewDirty = true;
  coordinator.offer(currentSnapshot, scopes);
  renderReviewChrome();
  renderActiveMetadata();
}

function updateReviewGraph(nextGraph) {
  applyReviewState({
    graph: nextGraph,
    notes: currentSnapshot.postCall?.notes ?? ""
  });
}

function renderReviewChrome() {
  if (!reviewMode || !currentSnapshot) return;
  const view = postCallReviewView(currentSnapshot, savingReview);
  elements.reviewState.textContent = reviewDirty && view.editable
    ? "Unsaved review changes"
    : view.blocker || view.label;
  elements.reviewState.dataset.state = view.blocker ? "blocked" : reviewDirty || !view.approved ? "dirty" : "saved";
  elements.reviewAdd.disabled = !view.editable;
  elements.reviewSave.disabled = !view.editable || (!reviewDirty && view.approved);
  elements.reviewSave.textContent = savingReview
    ? "Saving…"
    : reviewDirty
      ? "Save & approve"
      : view.approved
        ? "Approved"
        : "Approve review";
  elements.reviewUndo.disabled = !view.editable || undoStack.length === 0;
  elements.reviewRedo.disabled = !view.editable || redoStack.length === 0;
  const canHandoff = view.ready && view.approved && !reviewDirty && !savingReview;
  elements.reviewHandoff.setAttribute("aria-disabled", String(!canHandoff));
  elements.reviewHandoff.tabIndex = canHandoff ? 0 : -1;
  elements.reviewHandoff.title = canHandoff
    ? "Review the complete Codex delivery package in a new tab"
    : reviewDirty
      ? "Save the review before preparing the Codex package"
      : !view.approved
        ? "Approve the review before preparing the Codex package"
        : view.blocker || "Codex handoff is not ready";
  if (document.activeElement !== elements.reviewTopic) {
    elements.reviewTopic.value = currentSnapshot.graph?.topic?.label ?? "";
  }
  if (document.activeElement !== elements.reviewNotesText) {
    elements.reviewNotesText.value = currentSnapshot.postCall?.notes ?? "";
  }
}

function connectionEditor(node) {
  const edges = (currentSnapshot?.graph?.edges ?? []).filter(
    (edge) =>
      edge.facets?.[activeView] &&
      (edge.from === node.id || edge.to === node.id)
  );
  elements.editorConnectionCount.textContent = String(edges.length);
  const rows = edges.map((edge) => {
    const otherId = edge.from === node.id ? edge.to : edge.from;
    const other = currentSnapshot.graph.nodes.find((candidate) => candidate.id === otherId);
    const row = document.createElement("div");
    row.className = "editor-connection-row";
    const copy = document.createElement("span");
    copy.className = "editor-connection-name";
    copy.textContent = `${edge.from === node.id ? "To" : "From"} · ${other?.label ?? otherId}`;
    const label = document.createElement("input");
    label.value = edge.label ?? "";
    label.maxLength = 80;
    label.placeholder = "Connection label";
    label.setAttribute("aria-label", `Connection label for ${other?.label ?? otherId}`);
    label.addEventListener("change", () => {
      updateReviewGraph(updateGraphEdge(currentSnapshot.graph, edge.id, activeView, { label: label.value }));
    });
    const relation = document.createElement("select");
    relation.setAttribute("aria-label", `Connection type for ${other?.label ?? otherId}`);
    const relationValues = activeView === "process"
      ? ["sequence", "message", "association"]
      : activeView === "organization"
        ? ["primary_report", "secondary_report"]
        : ["synchronous", "asynchronous", "batch", "stream", "unknown"];
    const selectedRelation = activeView === "architecture"
      ? edge.facets.architecture.interaction ?? "unknown"
      : edge.facets[activeView].kind;
    relation.replaceChildren(...relationValues.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value.replaceAll("_", " ");
      option.selected = value === selectedRelation;
      return option;
    }));
    relation.addEventListener("change", () => {
      updateReviewGraph(updateGraphEdge(currentSnapshot.graph, edge.id, activeView, activeView === "architecture"
        ? { interaction: relation.value }
        : { relationKind: relation.value }));
    });
    const protocol = document.createElement("input");
    if (activeView === "architecture") {
      protocol.value = edge.facets.architecture.protocol ?? "";
      protocol.maxLength = 40;
      protocol.placeholder = "Protocol / channel";
      protocol.setAttribute("aria-label", `Protocol for ${other?.label ?? otherId}`);
      protocol.addEventListener("change", () => {
        updateReviewGraph(updateGraphEdge(currentSnapshot.graph, edge.id, activeView, { protocol: protocol.value }));
      });
    }
    const reverse = document.createElement("button");
    reverse.type = "button";
    reverse.textContent = "Reverse";
    reverse.setAttribute("aria-label", `Reverse connection with ${other?.label ?? otherId}`);
    reverse.addEventListener("click", () => {
      updateReviewGraph(updateGraphEdge(currentSnapshot.graph, edge.id, activeView, { reverse: true }));
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      updateReviewGraph(removeGraphEdge(currentSnapshot.graph, edge.id));
    });
    row.append(copy, label, relation);
    if (activeView === "architecture") row.append(protocol);
    row.append(reverse, remove);
    return row;
  });
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "outline-empty";
    empty.textContent = "No connections in this view.";
    rows.push(empty);
  }
  elements.editorConnectionList.replaceChildren(...rows);

  const targets = (currentSnapshot?.graph?.nodes ?? []).filter(
    (candidate) =>
      candidate.id !== node.id &&
      candidate.facets?.[activeView] &&
      (scopes[activeView] === "current" ? candidate.scope !== "desired" : candidate.scope !== "current")
  );
  const options = targets.map((candidate) => {
    const option = document.createElement("option");
    option.value = candidate.id;
    option.textContent = candidate.label;
    return option;
  });
  if (options.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Add another element first";
    options.push(option);
  }
  elements.editorConnectionTarget.replaceChildren(...options);
  elements.editorAddConnection.disabled = targets.length === 0;
}

function renderElementEditor() {
  if (!reviewMode) return false;
  const node = currentSnapshot?.graph?.nodes?.find(
    (candidate) => candidate.id === selectedEntityId
  );
  const editable = postCallReviewView(currentSnapshot, savingReview).editable;
  if (!node || !node.facets?.[activeView]) {
    deleteArmedEntityId = undefined;
    elements.elementEditor.hidden = true;
    elements.selection.hidden = false;
    return false;
  }
  elements.selection.hidden = true;
  elements.elementEditor.hidden = false;
  if (deleteArmedEntityId !== node.id) {
    elements.editorDelete.textContent = "Delete element";
    elements.editorDeleteConfirmation.hidden = true;
    elements.editorDeleteConfirmation.textContent = "";
  }
  elements.elementEditor.dataset.entityId = node.id;
  elements.editorKicker.textContent = `Editing ${VIEW_DEFINITIONS[activeView].shortLabel.toLowerCase()} element${node.provenance === "post_call_editorial" ? " · post-call hypothesis" : ""}`;
  const kinds = POST_CALL_NODE_KINDS[activeView] ?? [];
  const selectedKind = node.facets[activeView]?.kind;
  elements.editorKind.replaceChildren(
    ...kinds.map((kind) => {
      const option = document.createElement("option");
      option.value = kind;
      option.textContent = kind.replaceAll("_", " ");
      option.selected = kind === selectedKind;
      return option;
    })
  );
  if (!elements.elementEditor.contains(document.activeElement)) {
    elements.editorLabel.value = node.label ?? "";
    elements.editorShortLabel.value = node.shortLabel ?? "";
    elements.editorScope.value = node.scope ?? (node.state === "desired" ? "desired" : "current");
    elements.editorCertainty.value = node.certainty ?? (
      node.state === "hypothesis" ? "hypothesis" : node.state === "unknown" ? "unknown" : "asserted"
    );
  }
  connectionEditor(node);
  for (const control of elements.elementEditor.elements) control.disabled = !editable;
  if (node.provenance === "post_call_editorial") elements.editorCertainty.disabled = true;
  return true;
}

function inspectorCopy(projection, entityId) {
  const detail = projectionEntityDetail(projection, entityId);
  if (!detail) return undefined;
  const container = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = detail.node.label ?? "Untitled";
  const state = document.createElement("p");
  state.className = "inspector-state";
  state.textContent = `${detail.node.semanticType ?? detail.node.kind ?? "element"} · ${detail.node.scope ?? detail.node.state ?? "unknown"} · ${detail.node.certainty ?? "asserted"}`;
  const relationships = document.createElement("p");
  relationships.textContent = `${detail.incoming.length} incoming · ${detail.outgoing.length} outgoing`;
  container.append(heading, state, relationships);
  if (detail.pains.length > 0) {
    const pain = document.createElement("p");
    pain.textContent = `Friction: ${detail.pains.map((item) => item.description).join("; ")}`;
    container.append(pain);
  }
  return container;
}

function renderOutline(projection) {
  const search = String(elements.search.value ?? "").trim().toLowerCase();
  const nodes = projection.nodes.filter((node) =>
    !search || `${node.label} ${node.semanticType}`.toLowerCase().includes(search)
  );
  if (nodes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "outline-empty";
    empty.textContent = search ? "No elements match this search." : projection.emptyMessage;
    elements.outline.replaceChildren(empty, issueOutline(projection));
    return;
  }
  const details = document.createElement("details");
  details.className = "outline-group";
  details.open = true;
  const summary = document.createElement("summary");
  summary.textContent = `Elements · ${nodes.length}`;
  const list = document.createElement("div");
  list.className = "outline-list";
  for (const node of nodes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "outline-item";
    button.dataset.entityId = node.id;
    button.setAttribute("aria-pressed", String(selectedEntityId === node.id));
    const name = document.createElement("span");
    name.className = "outline-item-name";
    name.textContent = node.label ?? "Untitled";
    const kind = document.createElement("span");
    kind.className = "outline-item-kind";
    kind.textContent = node.semanticType ?? node.kind ?? "element";
    button.append(name, kind);
    button.addEventListener("click", () => selectEntity(node.id));
    list.append(button);
  }
  details.append(summary, list);
  elements.outline.replaceChildren(details, issueOutline(projection));
}

function issueOutline(projection) {
  const issues = [
    ...projection.pains.map((pain) => `Friction: ${pain.description}`),
    ...projection.contradictions.map((item) => `Conflict: ${item.description}`)
  ];
  const details = document.createElement("details");
  details.className = "outline-group";
  const summary = document.createElement("summary");
  summary.textContent = `Friction and conflicts · ${issues.length}`;
  const list = document.createElement("div");
  list.className = "outline-list";
  if (issues.length === 0) {
    const empty = document.createElement("p");
    empty.className = "outline-empty";
    empty.textContent = "None identified in this view.";
    list.append(empty);
  } else {
    for (const issue of issues) {
      const item = document.createElement("p");
      item.className = "outline-empty";
      item.textContent = issue;
      list.append(item);
    }
  }
  details.append(summary, list);
  return details;
}

function renderActiveMetadata() {
  const projection = projections.get(activeView);
  if (!projection) return;
  elements.summary.textContent = projectionSummary(projection);
  const state = coordinator.state(activeView);
  elements.revision.textContent = state?.committedRevision >= 0
    ? `Revision ${state.committedRevision}`
    : "Awaiting first view";
  const editing = renderElementEditor();
  const detail = selectedEntityId ? inspectorCopy(projection, selectedEntityId) : undefined;
  if (!editing && detail) {
    elements.selection.replaceChildren(detail);
  } else if (!editing) {
    const hint = document.createElement("p");
    hint.textContent = reviewMode
      ? "Select an element to edit it, or add a new element to this view."
      : "Select an element to see its state, relationships and friction.";
    elements.selection.replaceChildren(hint);
  }
  renderOutline(projection);
}

function setZoom(next) {
  zoom[activeView] = Math.min(1.8, Math.max(0.65, next));
  elements.frames.get(activeView)?.style.setProperty("--view-scale", String(zoom[activeView]));
}

function activateView(viewKind, focus = false) {
  if (!DIAGRAM_VIEW_KINDS.includes(viewKind)) return;
  activeView = viewKind;
  for (const kind of DIAGRAM_VIEW_KINDS) {
    const selected = kind === viewKind;
    const tab = elements.tabs.get(kind);
    const panel = elements.panels.get(kind);
    tab?.setAttribute("aria-selected", String(selected));
    tab?.setAttribute("tabindex", selected ? "0" : "-1");
    if (panel) panel.hidden = !selected;
  }
  if (focus) elements.tabs.get(viewKind)?.focus();
  unseenViews.delete(viewKind);
  coordinator.activate(viewKind);
  setZoom(zoom[viewKind]);
  for (const button of elements.scopes) {
    button.setAttribute("aria-pressed", String(button.dataset.scope === scopes[viewKind]));
  }
  elements.followLive.setAttribute("aria-pressed", String(followLive[viewKind]));
  const state = coordinator.state(viewKind);
  showRenderError(viewKind, state?.status === "failed" ? state.error : undefined);
  renderActiveMetadata();
  updateTabIndicators();
}

function tabKeyboardNavigation(event) {
  const index = DIAGRAM_VIEW_KINDS.indexOf(activeView);
  let next;
  if (event.key === "ArrowRight") next = DIAGRAM_VIEW_KINDS[(index + 1) % DIAGRAM_VIEW_KINDS.length];
  if (event.key === "ArrowLeft") next = DIAGRAM_VIEW_KINDS[(index - 1 + DIAGRAM_VIEW_KINDS.length) % DIAGRAM_VIEW_KINDS.length];
  if (event.key === "Home") next = DIAGRAM_VIEW_KINDS[0];
  if (event.key === "End") next = DIAGRAM_VIEW_KINDS.at(-1);
  if (!next) return;
  event.preventDefault();
  activateView(next, true);
}

function renderSnapshot(next) {
  if (!shouldAcceptSnapshot(currentSnapshot, next)) return;
  currentSnapshot = next;
  setStatus(next, streamConnectionState);
  elements.topic.textContent = next.graph?.topic?.label || "Business discovery in progress";
  const question = next.graph?.suggestedQuestion?.text;
  elements.followUp.hidden = !question;
  elements.followUpText.textContent = question || "";
  coordinator.offer(next, scopes);
  renderReviewChrome();
  if (next.status === "error") stopStream?.();
}

for (const [viewKind, tab] of elements.tabs) {
  tab.addEventListener("click", () => activateView(viewKind));
  tab.addEventListener("keydown", tabKeyboardNavigation);
}
for (const button of elements.scopes) {
  button.addEventListener("click", () => {
    const scope = button.dataset.scope;
    if (!scope || scope === scopes[activeView]) return;
    scopes[activeView] = scope;
    if (currentSnapshot) coordinator.offer(currentSnapshot, scopes);
    activateView(activeView);
  });
}
elements.search.addEventListener("input", renderActiveMetadata);
elements.zoomIn.addEventListener("click", () => setZoom(zoom[activeView] + 0.15));
elements.zoomOut.addEventListener("click", () => setZoom(zoom[activeView] - 0.15));
elements.zoomFit.addEventListener("click", () => setZoom(1));
elements.followLive.addEventListener("click", () => {
  const next = !followLive[activeView];
  followLive[activeView] = next;
  elements.followLive.setAttribute("aria-pressed", String(next));
  if (next) setZoom(1);
});
elements.retry.addEventListener("click", () => {
  if (recoveryAction === "reload") {
    globalThis.location.reload();
    return;
  }
  if (coordinator.retry(activeView)) showRenderError(activeView);
});

function applyEditorFields() {
  if (!reviewMode || !selectedEntityId || !currentSnapshot) return;
  try {
    updateReviewGraph(
      updateGraphNode(currentSnapshot.graph, selectedEntityId, activeView, {
        label: elements.editorLabel.value,
        shortLabel: elements.editorShortLabel.value,
        semanticType: elements.editorKind.value,
        scope: elements.editorScope.value,
        certainty: elements.editorCertainty.value
      })
    );
  } catch (error) {
    showRenderError(activeView, error);
  }
}

for (const control of [
  elements.editorKind,
  elements.editorScope,
  elements.editorCertainty
]) {
  control.addEventListener("change", applyEditorFields);
}

function applyEditorTextField(field) {
  if (!reviewMode || !selectedEntityId || !currentSnapshot) return;
  const sessionKey = `${selectedEntityId}:${field}`;
  try {
    const nextGraph = updateGraphNode(
      currentSnapshot.graph,
      selectedEntityId,
      activeView,
      { [field]: field === "label" ? elements.editorLabel.value : elements.editorShortLabel.value }
    );
    applyReviewState(
      { graph: nextGraph, notes: currentSnapshot.postCall?.notes ?? "" },
      { record: editorTextSession !== sessionKey }
    );
    editorTextSession = sessionKey;
  } catch (error) {
    showRenderError(activeView, error);
  }
}

elements.editorLabel.addEventListener("input", () => applyEditorTextField("label"));
elements.editorShortLabel.addEventListener("input", () => applyEditorTextField("shortLabel"));
for (const control of [elements.editorLabel, elements.editorShortLabel]) {
  control.addEventListener("blur", () => { editorTextSession = undefined; });
}

elements.editorAddConnection.addEventListener("click", () => {
  const target = elements.editorConnectionTarget.value;
  if (!selectedEntityId || !target || !currentSnapshot) return;
  try {
    const result = addGraphEdge(
      currentSnapshot.graph,
      activeView,
      selectedEntityId,
      target,
      scopes[activeView],
      reviewEvidenceId()
    );
    updateReviewGraph(result.graph);
  } catch (error) {
    showRenderError(activeView, error);
  }
});

elements.editorDelete.addEventListener("click", () => {
  if (!selectedEntityId || !currentSnapshot) return;
  const node = currentSnapshot.graph.nodes.find((candidate) => candidate.id === selectedEntityId);
  if (!node) return;
  if (deleteArmedEntityId !== node.id) {
    deleteArmedEntityId = node.id;
    elements.editorDelete.textContent = "Confirm delete";
    elements.editorDeleteConfirmation.textContent = `Press Confirm delete to remove “${node.label}” and its connections from every diagram.`;
    elements.editorDeleteConfirmation.hidden = false;
    return;
  }
  const next = removeGraphNode(currentSnapshot.graph, selectedEntityId);
  deleteArmedEntityId = undefined;
  selectedEntityId = undefined;
  updateReviewGraph(next);
});

elements.reviewAdd.addEventListener("click", () => {
  if (!currentSnapshot) return;
  try {
    const result = addGraphNode(
      currentSnapshot.graph,
      activeView,
      scopes[activeView],
      reviewEvidenceId()
    );
    selectedEntityId = result.entityId;
    updateReviewGraph(result.graph);
    requestAnimationFrame(() => elements.editorLabel.focus());
  } catch (error) {
    showRenderError(activeView, error);
  }
});

elements.reviewUndo.addEventListener("click", () => {
  const previous = undoStack.pop();
  if (!previous || !currentSnapshot) return;
  redoStack.push(reviewHistoryState());
  applyReviewState(previous, { record: false });
});

elements.reviewRedo.addEventListener("click", () => {
  const next = redoStack.pop();
  if (!next || !currentSnapshot) return;
  undoStack.push(reviewHistoryState());
  applyReviewState(next, { record: false });
});

elements.reviewTopic.addEventListener("change", () => {
  if (!currentSnapshot) return;
  const value = elements.reviewTopic.value.trim();
  if (!value || value === currentSnapshot.graph.topic.label) return;
  const graph = cloneValue(currentSnapshot.graph);
  graph.topic.label = value;
  updateReviewGraph(graph);
});

elements.reviewNotesText.addEventListener("input", () => {
  if (!currentSnapshot) return;
  if (!notesTextSession) {
    undoStack.push(reviewHistoryState());
    redoStack = [];
    notesTextSession = true;
  }
  currentSnapshot = {
    ...currentSnapshot,
    postCall: {
      ...currentSnapshot.postCall,
      notes: elements.reviewNotesText.value
    }
  };
  reviewDirty = true;
  renderReviewChrome();
});
elements.reviewNotesText.addEventListener("blur", () => { notesTextSession = false; });

elements.reviewHandoff.addEventListener("click", (event) => {
  if (elements.reviewHandoff.getAttribute("aria-disabled") === "true") {
    event.preventDefault();
  }
});

elements.reviewSave.addEventListener("click", async () => {
  if (
    !sessionId ||
    !currentSnapshot ||
    savingReview ||
    (!reviewDirty && currentSnapshot.postCall?.approvedAt)
  ) return;
  savingReview = true;
  showRenderError(activeView);
  renderReviewChrome();
  try {
    const saved = await savePostCallReview(sessionId, {
      expectedRevision: currentSnapshot.revision,
      graph: currentSnapshot.graph,
      notes: currentSnapshot.postCall?.notes ?? ""
    });
    currentSnapshot = saved;
    reviewDirty = false;
    undoStack = [];
    redoStack = [];
    coordinator.offer(saved, scopes);
    renderActiveMetadata();
  } catch (error) {
    if (error?.status === 409) recoveryAction = "reload";
    showRenderError(
      activeView,
      error?.status === 409
        ? new Error(`${error.message} Reload the review before saving again.`)
        : error
    );
  } finally {
    savingReview = false;
    renderReviewChrome();
    renderActiveMetadata();
  }
});

window.addEventListener("beforeunload", (event) => {
  if (!reviewMode || !reviewDirty) return;
  event.preventDefault();
  event.returnValue = "";
});

window.addEventListener("keydown", (event) => {
  if (!reviewMode || !(event.metaKey || event.ctrlKey)) return;
  const key = event.key.toLowerCase();
  if (key === "s") {
    event.preventDefault();
    elements.reviewSave.click();
  } else if (key === "z" && event.shiftKey) {
    event.preventDefault();
    elements.reviewRedo.click();
  } else if (key === "z") {
    event.preventDefault();
    elements.reviewUndo.click();
  }
});

async function start() {
  if (!sessionId) {
    setStatus({ status: "error" });
    showRenderError(activeView, new Error("The whiteboard URL has no valid session ID."));
    return;
  }
  try {
    if (reviewMode) {
      document.body.classList.add("post-call-review");
      elements.reviewToolbar.hidden = false;
      elements.reviewNotes.hidden = false;
      elements.reviewHandoff.href = `/handoff/${encodeURIComponent(sessionId)}`;
      streamConnectionState = "live";
      renderSnapshot(await loadPostCallReview(sessionId));
      return;
    }
    stopStream = subscribeToWhiteboard(sessionId, {
      onSnapshot: renderSnapshot,
      onConnection(state) {
        streamConnectionState = state;
        setStatus(currentSnapshot, state);
      },
      onError(error) {
        showRenderError(activeView, error);
      }
    });
    renderSnapshot(await loadWhiteboard(sessionId));
  } catch (error) {
    if (!currentSnapshot) {
      if (reviewMode) recoveryAction = "reload";
      setStatus({ status: "error" });
      showRenderError(activeView, error);
    }
  }
}

window.addEventListener("pagehide", () => {
  stopStream?.();
  coordinator.dispose();
});

activateView(activeView);
start();
