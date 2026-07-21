import mermaid from "/vendor/mermaid/mermaid.esm.min.mjs";
import { escapeMermaidLabel } from "/js/mermaid-graph.js";
import { createRevisionRenderer } from "/js/revision-renderer.js";

const TRIAL_SECONDS = 120;
const WRAP_AT_SECONDS = 15;

const page = document.body;
const timerValue = document.querySelector("#timer-value");
const timerLabel = document.querySelector("#timer-label");
const transcript = document.querySelector("#transcript");
const transcriptEmpty = document.querySelector("#transcript-empty");
const interviewButton = document.querySelector("#interview-button");
const interviewButtonLabel = document.querySelector("#interview-button-label");
const trialError = document.querySelector("#trial-error");
const scoutAudio = document.querySelector("#scout-audio");
const mapStatus = document.querySelector("#map-status span:last-child");
const mapEmpty = document.querySelector("#map-empty");
const graphTrack = document.querySelector("#graph-track");
const zoomValue = document.querySelector("#zoom-value");
const handoffPanel = document.querySelector("#handoff-panel");
const handoffProblem = document.querySelector("#handoff-problem");
const handoffEvidence = document.querySelector("#handoff-evidence");
const handoffStructure = document.querySelector("#handoff-structure");
const handoffQuestions = document.querySelector("#handoff-questions");
const packageDialog = document.querySelector("#package-dialog");
const packageDialogTitle = document.querySelector("#package-dialog-title");
const packagePreview = document.querySelector("#package-preview");

const progress = {
  conversation: document.querySelector('[data-progress="conversation"]'),
  map: document.querySelector('[data-progress="map"]'),
  handoff: document.querySelector('[data-progress="handoff"]'),
};

const progressCopy = {
  conversation: document.querySelector("#progress-conversation"),
  map: document.querySelector("#progress-map"),
  handoff: document.querySelector("#progress-handoff"),
};

const state = {
  phase: "idle",
  view: "process",
  zoom: 100,
  elapsed: 0,
  startedAt: 0,
  wrapRequested: false,
  demoMode: false,
  transcript: [],
  transcriptItemIds: new Set(),
  insights: [],
  peerConnection: null,
  dataChannel: null,
  mediaStream: null,
  trialId: null,
  timerId: null,
  mapRevision: 0,
};

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  deterministicIds: true,
  deterministicIDSeed: "scout-public-trial",
  fontFamily: "Avenir Next, Avenir, Segoe UI, sans-serif",
  flowchart: {
    curve: "linear",
    htmlLabels: false,
    nodeSpacing: 50,
    rankSpacing: 72,
    padding: 18,
    useMaxWidth: false,
  },
  themeVariables: {
    background: "transparent",
    primaryColor: "#fafaf7",
    primaryTextColor: "#101115",
    primaryBorderColor: "#101115",
    lineColor: "#101115",
    textColor: "#101115",
    edgeLabelBackground: "#fafaf7",
    fontSize: "16px",
  },
});

function mermaidSource(items, view) {
  const lines = [
    "flowchart LR",
    `accTitle: Scout ${escapeMermaidLabel(view)} map`,
    "accDescr: Evidence-backed business structure captured during this interview",
  ];
  items.forEach((item, index) => {
    lines.push(`  insight_${index}["${escapeMermaidLabel(item.label)}"]`);
    if (index > 0) lines.push(`  insight_${index - 1} --> insight_${index}`);
  });
  lines.push(
    "  classDef supported fill:#fafaf7,stroke:#101115,color:#101115,stroke-width:2px",
    "  classDef pain fill:#fafaf7,stroke:#101115,color:#101115,stroke-width:2px,stroke-dasharray:7 4",
    "  classDef outcome fill:#101115,stroke:#101115,color:#fafaf7,stroke-width:2px",
  );
  items.forEach((item, index) => {
    const className = item.category === "pain" ? "pain" : item.category === "outcome" ? "outcome" : "supported";
    lines.push(`  class insight_${index} ${className}`);
  });
  return lines.join("\n");
}

const graphRenderer = createRevisionRenderer({
  keyOf: (snapshot) => `${snapshot.view}:${snapshot.revision}`,
  orderOf: (snapshot) => snapshot.revision,
  async render(snapshot, sequence) {
    const rendered = await mermaid.render(
      `scout-trial-${snapshot.revision}-${sequence}`,
      mermaidSource(snapshot.items, snapshot.view),
    );
    const staging = document.createElement("div");
    staging.innerHTML = rendered.svg;
    const svg = staging.querySelector("svg");
    if (!svg) throw new Error("Mermaid returned no SVG for the trial map.");
    svg.removeAttribute("height");
    svg.removeAttribute("width");
    svg.removeAttribute("style");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Scout ${snapshot.view} map, revision ${snapshot.revision}`);
    return { svg, bindFunctions: rendered.bindFunctions };
  },
  async commit(_snapshot, rendered) {
    graphTrack.replaceChildren(rendered.svg);
    rendered.bindFunctions?.(graphTrack);
    mapEmpty.hidden = true;
    graphTrack.hidden = false;
  },
  onBusy(busy) {
    if (busy) mapStatus.textContent = "Updating the business map";
  },
  onError(error) {
    mapStatus.textContent = error
      ? "Map update paused · keeping the last valid view"
      : state.phase === "complete"
        ? "Interview map complete"
        : "Building from this conversation";
  },
  maxAutomaticRetries: 1,
});

const demoTranscript = [
  {
    speaker: "Scout",
    text: "Pick one workflow you know well. What starts it, and what should be true when it is finished?",
    seconds: 3,
  },
  {
    speaker: "You",
    text: "When a customer signs, sales posts the details in Slack and our operations lead copies everything into Notion.",
    seconds: 17,
  },
  {
    speaker: "Scout",
    text: "Where does that handoff slow down or lose information?",
    seconds: 31,
  },
  {
    speaker: "You",
    text: "The operations lead often has to chase sales for the contract scope before onboarding can begin.",
    seconds: 43,
  },
];

const demoInsights = [
  {
    category: "process",
    label: "Customer signs",
    detail: "A signed customer agreement starts the onboarding workflow.",
  },
  {
    category: "organisation",
    label: "Sales → Operations",
    detail: "Sales hands customer context to the operations lead.",
  },
  {
    category: "system",
    label: "Slack + Notion",
    detail: "Details are posted in Slack and manually copied into Notion.",
  },
  {
    category: "pain",
    label: "Scope is missing",
    detail: "Operations chases sales for contract scope before onboarding begins.",
  },
];

function setPhase(phase) {
  state.phase = phase;
  page.dataset.phase = phase;
  interviewButton.disabled = phase === "connecting";
  trialError.hidden = true;

  if (phase === "idle") {
    interviewButtonLabel.textContent = "Start the 2-minute interview";
    timerLabel.textContent = "ready";
    mapStatus.textContent = "Your map will appear here";
  } else if (phase === "connecting") {
    interviewButtonLabel.textContent = "Connecting Scout…";
    timerLabel.textContent = "connecting";
    mapStatus.textContent = "Opening the interview";
  } else if (phase === "active") {
    interviewButtonLabel.textContent = "End interview and create handoff";
    timerLabel.textContent = "remaining";
    mapStatus.textContent = state.insights.length ? "Building from this conversation" : "Listening for business structure";
  } else if (phase === "complete") {
    interviewButtonLabel.textContent = "Start another interview";
    timerLabel.textContent = "complete";
    mapStatus.textContent = "Interview map complete";
  } else if (phase === "error") {
    interviewButton.disabled = false;
    interviewButtonLabel.textContent = "Try connecting again";
    timerLabel.textContent = "not started";
    mapStatus.textContent = "Map paused";
  }

  renderProgress();
}

function showError(message) {
  trialError.textContent = message;
  trialError.hidden = false;
  setPhase("error");
  trialError.hidden = false;
}

function formatTime(seconds) {
  const bounded = Math.max(0, Math.min(TRIAL_SECONDS, Math.ceil(seconds)));
  return `${String(Math.floor(bounded / 60)).padStart(2, "0")}:${String(bounded % 60).padStart(2, "0")}`;
}

function updateTimer() {
  const remaining = state.demoMode
    ? TRIAL_SECONDS - state.elapsed
    : TRIAL_SECONDS - (Date.now() - state.startedAt) / 1000;
  state.elapsed = Math.min(TRIAL_SECONDS, TRIAL_SECONDS - Math.max(0, remaining));
  timerValue.textContent = formatTime(remaining);
  progressCopy.conversation.textContent = `${formatTime(remaining)} remaining`;

  if (!state.wrapRequested && remaining <= WRAP_AT_SECONDS && remaining > 0) {
    state.wrapRequested = true;
    sendEvent({
      type: "response.create",
      response: {
        instructions:
          "The interview has about 15 seconds left. Briefly confirm the most important point, ask no more than one essential closing question, and close the conversation.",
      },
    });
  }

  if (!state.demoMode && remaining <= 0) finishInterview();
}

function renderProgress() {
  for (const item of Object.values(progress)) item.className = "";

  if (state.phase === "complete") {
    progress.conversation.classList.add("is-complete");
    progress.map.classList.add("is-complete");
    progress.handoff.classList.add("is-active");
    progressCopy.conversation.textContent = "Interview complete";
    progressCopy.map.textContent = `${state.insights.length} supported insight${state.insights.length === 1 ? "" : "s"}`;
    progressCopy.handoff.textContent = "Preview ready";
    return;
  }

  progress.conversation.classList.add("is-active");
  if (state.insights.length) {
    progress.map.classList.add("is-active");
    progressCopy.map.textContent = `${state.insights.length} insight${state.insights.length === 1 ? "" : "s"} captured`;
  } else {
    progressCopy.map.textContent = "Builds live from your answers";
  }
  progressCopy.handoff.textContent = "Ready after the interview";
}

function addTranscriptTurn(speaker, text, seconds = state.elapsed, itemId = null) {
  const clean = String(text || "").trim();
  if (!clean || (itemId && state.transcriptItemIds.has(itemId))) return;
  if (itemId) state.transcriptItemIds.add(itemId);

  const duplicate = state.transcript.at(-1);
  if (duplicate?.speaker === speaker && duplicate.text === clean) return;

  const turn = { speaker, text: clean, seconds };
  state.transcript.push(turn);
  transcriptEmpty.hidden = true;

  const article = document.createElement("article");
  article.className = "transcript-turn";
  const header = document.createElement("header");
  const label = document.createElement("strong");
  const time = document.createElement("time");
  const copy = document.createElement("p");
  label.textContent = speaker;
  time.textContent = formatTime(seconds);
  copy.textContent = clean;
  header.append(label, time);
  article.append(header, copy);
  transcript.append(article);
  transcript.scrollTop = transcript.scrollHeight;
}

function addInsight(insight) {
  if (!insight || !["process", "organisation", "system", "pain", "outcome"].includes(insight.category)) return;
  const label = String(insight.label || "").trim();
  const detail = String(insight.detail || "").trim();
  if (!label || !detail) return;

  const exists = state.insights.some(
    (item) => item.category === insight.category && item.label.toLowerCase() === label.toLowerCase(),
  );
  if (!exists) state.insights.push({ category: insight.category, label, detail });
  renderMap();
  renderProgress();
}

function insightsForView() {
  if (state.view === "organisation") return state.insights.filter((item) => item.category === "organisation");
  if (state.view === "architecture") return state.insights.filter((item) => item.category === "system");
  return state.insights.filter((item) => ["process", "pain", "outcome"].includes(item.category));
}

function renderMap() {
  const visible = insightsForView();
  graphTrack.style.setProperty("--graph-scale", String(state.zoom / 100));
  zoomValue.textContent = `${state.zoom}%`;

  if (!visible.length) {
    graphRenderer.dispose();
    mapEmpty.hidden = false;
    graphTrack.hidden = true;
    const title = mapEmpty.querySelector("h2");
    const copy = mapEmpty.querySelector("p");
    if (state.view === "organisation") {
      title.textContent = "Owners will appear here.";
      copy.textContent = "Scout is listening for teams, roles and the handoffs between them.";
    } else if (state.view === "architecture") {
      title.textContent = "Systems will appear here.";
      copy.textContent = "Scout is listening for tools, data and manual transfers in the workflow.";
    } else {
      title.textContent = "Start with one workflow.";
      copy.textContent = "As you speak, Scout will organise what it hears into process, organisation and architecture views.";
    }
    return;
  }
  state.mapRevision += 1;
  void graphRenderer.offer({
    revision: state.mapRevision,
    view: state.view,
    items: visible.map((item) => ({ ...item })),
  });
}

function sendEvent(event) {
  if (state.dataChannel?.readyState === "open") state.dataChannel.send(JSON.stringify(event));
}

function acknowledgeFunctionCalls(output = []) {
  let captured = false;
  for (const item of output) {
    if (item.type !== "function_call" || item.name !== "capture_business_insight") continue;
    try {
      const insight = JSON.parse(item.arguments || "{}");
      addInsight(insight);
      sendEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: item.call_id,
          output: JSON.stringify({ recorded: true }),
        },
      });
      captured = true;
    } catch {
      sendEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: item.call_id,
          output: JSON.stringify({ recorded: false, reason: "Invalid structured insight" }),
        },
      });
      captured = true;
    }
  }
  if (captured) sendEvent({ type: "response.create" });
}

function handleRealtimeEvent(event) {
  if (!event || typeof event.type !== "string") return;

  if (event.type === "conversation.item.input_audio_transcription.completed") {
    addTranscriptTurn("You", event.transcript, state.elapsed, event.item_id);
  } else if (event.type === "response.output_audio_transcript.done") {
    addTranscriptTurn("Scout", event.transcript, state.elapsed, event.item_id || event.response_id);
  } else if (event.type === "response.output_text.done") {
    addTranscriptTurn("Scout", event.text, state.elapsed, event.item_id || event.response_id);
  } else if (event.type === "response.done") {
    acknowledgeFunctionCalls(event.response?.output);
  } else if (event.type === "error") {
    const message = event.error?.message || "The live interview encountered an error.";
    if (!/cancel|interrupt/i.test(message)) showError(message);
  }
}

function waitForDataChannel(channel, timeoutMs = 12000) {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Scout took too long to connect.")), timeoutMs);
    channel.addEventListener("open", () => {
      window.clearTimeout(timeout);
      resolve();
    }, { once: true });
    channel.addEventListener("error", () => {
      window.clearTimeout(timeout);
      reject(new Error("Scout could not open the live conversation."));
    }, { once: true });
  });
}

async function startInterview() {
  resetExperience();
  state.demoMode = false;
  setPhase("connecting");

  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
      throw new Error("This browser does not support a live microphone interview.");
    }

    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    state.peerConnection = new RTCPeerConnection();
    state.peerConnection.addEventListener("track", (event) => {
      scoutAudio.srcObject = event.streams[0];
      scoutAudio.play().catch(() => {});
    });
    state.peerConnection.addEventListener("connectionstatechange", () => {
      if (["failed", "disconnected"].includes(state.peerConnection?.connectionState) && state.phase === "active") {
        showError("The live interview connection was lost. You can try again.");
        closeRealtimeConnection();
      }
    });

    state.dataChannel = state.peerConnection.createDataChannel("oai-events");
    state.dataChannel.addEventListener("message", (message) => {
      try {
        handleRealtimeEvent(JSON.parse(message.data));
      } catch {
        // Ignore provider events that are not JSON.
      }
    });
    for (const track of state.mediaStream.getTracks()) state.peerConnection.addTrack(track, state.mediaStream);

    const offer = await state.peerConnection.createOffer();
    await state.peerConnection.setLocalDescription(offer);
    const response = await fetch("/api/trial/realtime", {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: offer.sdp,
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || detail.message || "Scout could not start a Realtime interview.");
    }

    state.trialId = response.headers.get("X-Scout-Trial-Id");
    const answerSdp = await response.text();
    await state.peerConnection.setRemoteDescription({ type: "answer", sdp: answerSdp });
    await waitForDataChannel(state.dataChannel);

    state.startedAt = Date.now();
    state.elapsed = 0;
    setPhase("active");
    updateTimer();
    state.timerId = window.setInterval(updateTimer, 250);
    sendEvent({
      type: "response.create",
      response: {
        instructions:
          "Welcome the visitor in one sentence, explain that this is a two-minute interview, and ask them to choose one business workflow they know well.",
      },
    });
  } catch (error) {
    closeRealtimeConnection();
    showError(error instanceof Error ? error.message : "Scout could not start the interview.");
  }
}

function releaseTrial() {
  if (!state.trialId) return;
  const url = `/api/trial/realtime/${encodeURIComponent(state.trialId)}/end`;
  if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob([], { type: "text/plain" }));
  else fetch(url, { method: "POST", keepalive: true }).catch(() => {});
  state.trialId = null;
}

function closeRealtimeConnection() {
  if (state.timerId) window.clearInterval(state.timerId);
  state.timerId = null;
  for (const track of state.mediaStream?.getTracks() || []) track.stop();
  state.mediaStream = null;
  if (state.dataChannel && state.dataChannel.readyState !== "closed") state.dataChannel.close();
  state.dataChannel = null;
  state.peerConnection?.close();
  state.peerConnection = null;
  scoutAudio.srcObject = null;
  releaseTrial();
}

function finishInterview() {
  if (!["active", "connecting"].includes(state.phase)) return;
  closeRealtimeConnection();
  state.elapsed = Math.min(TRIAL_SECONDS, Math.max(state.elapsed, 1));
  timerValue.textContent = "00:00";
  setPhase("complete");
  renderMap();
  renderHandoff();
  handoffPanel.hidden = false;
}

function resetExperience() {
  closeRealtimeConnection();
  state.phase = "idle";
  state.elapsed = 0;
  state.startedAt = 0;
  state.wrapRequested = false;
  state.transcript = [];
  state.transcriptItemIds.clear();
  state.insights = [];
  transcript.querySelectorAll(".transcript-turn").forEach((node) => node.remove());
  transcriptEmpty.hidden = false;
  handoffPanel.hidden = true;
  timerValue.textContent = "02:00";
  state.view = "process";
  state.zoom = 100;
  document.querySelectorAll("[role=tab]").forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.view === state.view));
  });
  renderMap();
  setPhase("idle");
}

function getOpenQuestions() {
  const categories = new Set(state.insights.map((item) => item.category));
  const questions = [];
  if (!categories.has("process")) questions.push("What event starts the workflow, and what marks it complete?");
  if (!categories.has("organisation")) questions.push("Which role owns the workflow and its key handoffs?");
  if (!categories.has("system")) questions.push("Which systems hold the source data or receive the final output?");
  if (!categories.has("pain")) questions.push("Where does the workflow slow down, fail, or require rework?");
  if (!categories.has("outcome")) questions.push("How would the team measure a better outcome?");
  return questions.slice(0, 2);
}

function getProblemSummary() {
  const preferred = state.insights.find((item) => item.category === "pain")
    || state.insights.find((item) => item.category === "process")
    || state.insights[0];
  if (preferred) return `${preferred.label}: ${preferred.detail}`;
  const userTurn = state.transcript.find((turn) => turn.speaker === "You");
  return userTurn?.text || "Scout captured an initial workflow, ready for further discovery.";
}

function renderHandoff() {
  const userTurns = state.transcript.filter((turn) => turn.speaker === "You");
  const categories = new Set(state.insights.map((item) => item.category));
  const structures = [
    ["Process map", ["process", "pain", "outcome"].some((category) => categories.has(category))],
    ["Organisation map", categories.has("organisation")],
    ["Architecture map", categories.has("system")],
  ];

  handoffProblem.textContent = getProblemSummary();
  handoffEvidence.textContent = `${userTurns.length} attributed utterance${userTurns.length === 1 ? "" : "s"} and ${state.insights.length} structured insight${state.insights.length === 1 ? "" : "s"}`;
  handoffStructure.replaceChildren();
  for (const [label, captured] of structures) {
    if (!captured) continue;
    const item = document.createElement("li");
    item.textContent = label;
    handoffStructure.append(item);
  }
  if (!handoffStructure.children.length) {
    const item = document.createElement("li");
    item.textContent = "Initial discovery context";
    handoffStructure.append(item);
  }

  handoffQuestions.replaceChildren();
  const questions = getOpenQuestions();
  for (const question of questions.length ? questions : ["Which improvement should Codex prototype first?"]) {
    const item = document.createElement("li");
    item.textContent = question;
    handoffQuestions.append(item);
  }
}

function buildPackage() {
  const transcriptMarkdown = [
    "# Scout interview transcript",
    "",
    ...state.transcript.flatMap((turn) => [
      `## ${turn.speaker} · ${formatTime(turn.seconds)}`,
      "",
      turn.text,
      "",
    ]),
  ].join("\n").trim();
  const questions = getOpenQuestions();
  const graph = {
    revision: 1,
    source: "two-minute-scout-trial",
    views: {
      process: state.insights.filter((item) => ["process", "pain", "outcome"].includes(item.category)),
      organisation: state.insights.filter((item) => item.category === "organisation"),
      architecture: state.insights.filter((item) => item.category === "system"),
    },
  };
  const insightLines = state.insights.length
    ? state.insights.map((item) => `- **${item.label}** (${item.category}): ${item.detail}`)
    : ["- No structured insight was captured in this short trial."];

  return {
    "transcript.md": transcriptMarkdown || "# Scout interview transcript\n\nNo attributed utterances were captured.",
    "business-graph.json": JSON.stringify(graph, null, 2),
    "open-questions.md": ["# Open questions", "", ...(questions.length ? questions : ["Which improvement should Codex prototype first?"]).map((question) => `- ${question}`)].join("\n"),
    "codex-brief.md": [
      "# Codex build brief",
      "",
      "## Problem understood",
      "",
      getProblemSummary(),
      "",
      "## Evidence-backed structure",
      "",
      ...insightLines,
      "",
      "## Suggested first move",
      "",
      "Prototype the highest-value workflow represented in the business graph, then validate it against the attributed transcript before expanding scope.",
      "",
      "## Guardrails",
      "",
      "- Treat the transcript as evidence, not permission to invent missing requirements.",
      "- Keep open questions explicit.",
      "- This package is a preview and has not been sent to Codex.",
    ].join("\n"),
  };
}

function openPackage(filename = "codex-brief.md") {
  const files = buildPackage();
  packageDialogTitle.textContent = filename;
  packagePreview.textContent = files[filename] || files["codex-brief.md"];
  if (typeof packageDialog.showModal === "function") packageDialog.showModal();
  else packageDialog.setAttribute("open", "");
}

function seedDemo(mode) {
  state.demoMode = true;
  resetExperience();
  state.demoMode = true;
  state.elapsed = mode === "complete" ? TRIAL_SECONDS : 36;
  for (const turn of demoTranscript) addTranscriptTurn(turn.speaker, turn.text, turn.seconds);
  for (const insight of demoInsights) addInsight(insight);
  if (mode === "complete") {
    timerValue.textContent = "00:00";
    setPhase("complete");
    renderHandoff();
    handoffPanel.hidden = false;
  } else {
    setPhase("active");
    updateTimer();
  }
}

interviewButton.addEventListener("click", () => {
  if (state.phase === "active" || state.phase === "connecting") finishInterview();
  else startInterview();
});

document.querySelectorAll("[role=tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    state.view = tab.dataset.view;
    document.querySelectorAll("[role=tab]").forEach((item) => {
      item.setAttribute("aria-selected", String(item === tab));
    });
    renderMap();
  });
});

document.querySelectorAll("[data-map-action]").forEach((button) => {
  button.addEventListener("click", () => {
    const action = button.dataset.mapAction;
    if (action === "fit") state.zoom = 100;
    else if (action === "plus") state.zoom = Math.min(130, state.zoom + 10);
    else state.zoom = Math.max(70, state.zoom - 10);
    renderMap();
  });
});

document.querySelectorAll("[data-package-file]").forEach((button) => {
  button.addEventListener("click", () => openPackage(button.dataset.packageFile));
});

document.querySelector("#handoff-preview").addEventListener("click", () => openPackage());
document.querySelector("#handoff-close").addEventListener("click", () => { handoffPanel.hidden = true; });
document.querySelector("#handoff-back").addEventListener("click", () => { handoffPanel.hidden = true; });
document.querySelector("#package-dialog-close").addEventListener("click", () => packageDialog.close());
packageDialog.addEventListener("click", (event) => {
  if (event.target === packageDialog) packageDialog.close();
});
window.addEventListener("beforeunload", closeRealtimeConnection);

resetExperience();
const demo = new URLSearchParams(window.location.search).get("demo");
if (demo === "active" || demo === "complete") seedDemo(demo);
