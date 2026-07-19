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
  tabs: new Map(bySelectorAll("[data-view]").map((element) => [element.dataset.view, element])),
  panels: new Map(bySelectorAll("[data-view-panel]").map((element) => [element.dataset.viewPanel, element])),
  frames: new Map(bySelectorAll("[data-graph-frame]").map((element) => [element.dataset.graphFrame, element])),
  updates: new Map(bySelectorAll("[data-view-update]").map((element) => [element.dataset.viewUpdate, element])),
  scopes: bySelectorAll("[data-scope]")
};

const sessionId = parseSessionId();
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
    return;
  }
  const label = VIEW_DEFINITIONS[viewKind]?.label ?? "Map";
  elements.alert.hidden = false;
  elements.alertText.textContent = `${label} update paused — keeping its last valid view. ${
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
  selectedEntityId = entityId;
  for (const frame of elements.frames.values()) {
    for (const element of frame.querySelectorAll("[data-entity-id]")) {
      element.dataset.selected = String(element.dataset.entityId === entityId);
    }
  }
  renderActiveMetadata();
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
  const detail = selectedEntityId ? inspectorCopy(projection, selectedEntityId) : undefined;
  if (detail) {
    elements.selection.replaceChildren(detail);
  } else {
    const hint = document.createElement("p");
    hint.textContent = "Select an element to see its state, relationships and friction.";
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
  if (coordinator.retry(activeView)) showRenderError(activeView);
});

async function start() {
  if (!sessionId) {
    setStatus({ status: "error" });
    showRenderError(activeView, new Error("The whiteboard URL has no valid session ID."));
    return;
  }
  try {
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
