import mermaid from "/vendor/mermaid/mermaid.esm.min.mjs";
import { businessGraphToMermaid } from "./mermaid-graph.js";
import { parseSessionId } from "./session-id.js";
import { loadSession, subscribeToSession } from "./session-stream.js";

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
let lastRenderedRevision = -1;
let renderSequence = 0;
let currentSnapshot;

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
    primaryColor: "#172c29",
    primaryTextColor: "#eef5f2",
    primaryBorderColor: "#53d6ae",
    lineColor: "#6f837b",
    edgeLabelBackground: "#09100f",
    clusterBkg: "#101917",
    clusterBorder: "#273530",
    fontSize: "17px"
  }
});

function setStatus(snapshot, connectionState = "live") {
  const status =
    snapshot?.analysis?.status === "running" || snapshot?.status === "analyzing"
      ? "analyzing"
      : snapshot?.analysis?.status === "error" || snapshot?.status === "error"
        ? "error"
        : connectionState === "reconnecting"
          ? "reconnecting"
          : "listening";
  const labels = {
    listening: "Listening · updates live",
    analyzing: "Analyzing conversation",
    error: "Needs operator attention",
    reconnecting: "Reconnecting"
  };
  elements.statusDot.dataset.state = status;
  elements.statusLabel.textContent = labels[status];
}

function showRenderError(error) {
  elements.alert.hidden = false;
  elements.alert.textContent = `Map update paused — keeping the last valid view. ${
    error instanceof Error ? error.message : String(error)
  }`;
}

async function renderGraph(snapshot) {
  const revision = Number(snapshot.revision ?? 0);
  if (revision === lastRenderedRevision) return;
  const thisRender = ++renderSequence;
  const source = businessGraphToMermaid(snapshot.graph);
  try {
    const { svg, bindFunctions } = await mermaid.render(
      `scout-graph-${revision}-${thisRender}`,
      source
    );
    if (thisRender !== renderSequence) return;
    const staging = document.createElement("div");
    staging.innerHTML = svg;
    const renderedSvg = staging.querySelector("svg");
    if (!renderedSvg) throw new Error("Mermaid returned no SVG.");
    renderedSvg.setAttribute("role", "img");
    renderedSvg.setAttribute(
      "aria-label",
      `Business workflow, revision ${revision}`
    );
    elements.frame.replaceChildren(renderedSvg);
    bindFunctions?.(elements.frame);
    lastRenderedRevision = revision;
    elements.alert.hidden = true;
  } catch (error) {
    showRenderError(error);
  }
}

function renderSnapshot(snapshot) {
  currentSnapshot = snapshot;
  elements.topic.textContent =
    snapshot.graph?.topic?.label || "Business discovery in progress";
  setStatus(snapshot);
  const question = snapshot.graph?.suggestedQuestion?.text;
  elements.followUp.hidden = !question;
  elements.followUpText.textContent = question || "";
  renderGraph(snapshot);
}

async function start() {
  if (!sessionId) {
    setStatus({ status: "error" });
    showRenderError(new Error("The whiteboard URL has no valid session ID."));
    return;
  }
  try {
    const initial = await loadSession(sessionId);
    renderSnapshot(initial);
    subscribeToSession(sessionId, {
      onSnapshot: renderSnapshot,
      onConnection(state) {
        setStatus(currentSnapshot ?? initial, state);
      },
      onError: showRenderError
    });
  } catch (error) {
    setStatus({ status: "error" });
    showRenderError(error);
  }
}

start();
