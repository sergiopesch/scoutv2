import mermaid from "/vendor/mermaid/mermaid.esm.min.mjs";
import { businessGraphToMermaid } from "./mermaid-graph.js";
import { createRevisionRenderer } from "./revision-renderer.js";
import { parseSessionId } from "./session-id.js";
import {
  loadWhiteboard,
  subscribeToWhiteboard
} from "./session-stream.js";
import {
  shouldAcceptSnapshot,
  whiteboardStatusView
} from "./ui-state.js";

const elements = {
  topic: document.querySelector("#topic"),
  statusDot: document.querySelector("#whiteboard-status-dot"),
  statusLabel: document.querySelector("#whiteboard-status-label"),
  frame: document.querySelector("#graph-frame"),
  alert: document.querySelector("#render-alert"),
  followUp: document.querySelector("#follow-up"),
  followUpText: document.querySelector("#follow-up-text")
};

const sessionId = parseSessionId();
let currentSnapshot;
let streamConnectionState = "connecting";
let stopStream;

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  fontFamily: "Avenir Next, Avenir, Segoe UI, sans-serif",
  flowchart: {
    curve: "basis",
    htmlLabels: false,
    nodeSpacing: 48,
    rankSpacing: 68,
    padding: 14,
    useMaxWidth: true
  },
  themeVariables: {
    background: "transparent",
    primaryColor: "#101115",
    primaryTextColor: "#FAFAF7",
    primaryBorderColor: "#101115",
    lineColor: "#62656C",
    edgeLabelBackground: "#FAFAF7",
    clusterBkg: "#F7F7F3",
    clusterBorder: "#B8B9B5",
    fontSize: "17px"
  }
});

function setStatus(snapshot, connectionState = "live") {
  const view = whiteboardStatusView(snapshot, connectionState);
  elements.statusDot.dataset.state = view.state;
  elements.statusLabel.textContent = view.label;
}

function showRenderError(error) {
  if (!error) {
    elements.alert.hidden = true;
    elements.alert.textContent = "";
    return;
  }
  elements.alert.hidden = false;
  elements.alert.textContent = `Map update paused — keeping the last valid view. ${
    error instanceof Error ? error.message : String(error)
  }`;
}

async function stageGraph(snapshot, renderSequence) {
  const revision = Number(snapshot.revision ?? 0);
  const source = businessGraphToMermaid(snapshot.graph);
  const { svg, bindFunctions } = await mermaid.render(
    `scout-graph-${revision}-${renderSequence}`,
    source
  );
  const staging = document.createElement("div");
  staging.innerHTML = svg;
  const renderedSvg = staging.querySelector("svg");
  if (!renderedSvg) throw new Error("Mermaid returned no SVG.");
  renderedSvg.setAttribute("role", "img");
  renderedSvg.setAttribute(
    "aria-label",
    `Business workflow, revision ${revision}`
  );
  return { renderedSvg, bindFunctions };
}

function commitGraph(snapshot, staged) {
  elements.frame.replaceChildren(staged.renderedSvg);
  staged.bindFunctions?.(elements.frame);
  elements.frame.dataset.revision = String(snapshot.revision ?? 0);
  elements.topic.textContent =
    snapshot.graph?.topic?.label || "Business discovery in progress";
  const question = snapshot.graph?.suggestedQuestion?.text;
  elements.followUp.hidden = !question;
  elements.followUpText.textContent = question || "";
}

const graphRenderer = createRevisionRenderer({
  render: stageGraph,
  commit: commitGraph,
  keyOf(snapshot) {
    return `${snapshot.revision ?? 0}:${JSON.stringify(snapshot.graph ?? {})}`;
  },
  orderOf(snapshot) {
    return Number(snapshot.updatedAt ?? snapshot.revision ?? 0);
  },
  onError: showRenderError,
  onBusy(busy) {
    elements.frame.setAttribute("aria-busy", String(busy));
  }
});

function renderSnapshot(next) {
  if (!shouldAcceptSnapshot(currentSnapshot, next)) return;
  currentSnapshot = next;
  setStatus(next, streamConnectionState);
  void graphRenderer.offer(next);
  if (next.status === "error") stopStream?.();
}

async function start() {
  if (!sessionId) {
    setStatus({ status: "error" });
    showRenderError(new Error("The whiteboard URL has no valid session ID."));
    return;
  }
  try {
    stopStream = subscribeToWhiteboard(sessionId, {
      onSnapshot: renderSnapshot,
      onConnection(state) {
        streamConnectionState = state;
        setStatus(currentSnapshot, state);
      },
      onError: showRenderError
    });
    renderSnapshot(await loadWhiteboard(sessionId));
  } catch (error) {
    if (!currentSnapshot) {
      setStatus({ status: "error" });
      showRenderError(error);
    }
  }
}

window.addEventListener("pagehide", () => {
  stopStream?.();
  graphRenderer.dispose();
});

start();
