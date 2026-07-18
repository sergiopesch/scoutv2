import { createSession, validateMeetingUrl } from "./new-session-api.js";

const form = document.querySelector("#start-form");
const input = document.querySelector("#meeting-url");
const button = document.querySelector("#start-button");
const message = document.querySelector("#form-message");
const ready = document.querySelector("#session-ready");
const operatorLink = document.querySelector("#operator-link");
const whiteboardLink = document.querySelector("#whiteboard-link");
const copyButton = document.querySelector("#copy-whiteboard");
const copyFeedback = document.querySelector("#copy-feedback");
const redirectMessage = document.querySelector("#redirect-message");

let submitting = false;
let whiteboardUrl = "";

function setFormState(state, text = "") {
  form.dataset.state = state;
  message.textContent = text;
  input.setAttribute("aria-invalid", state === "error" ? "true" : "false");
  button.disabled = state === "submitting" || state === "success";
  input.disabled = state === "submitting" || state === "success";

  const labels = {
    idle: "Start Scout",
    error: "Start Scout",
    submitting: "Creating Live Architect…",
    success: "Scout started"
  };
  button.firstElementChild.textContent = labels[state] ?? labels.idle;
}

function absoluteUrl(pathname) {
  return new URL(pathname, window.location.origin).href;
}

async function copyWhiteboardLink() {
  if (!whiteboardUrl) return;
  try {
    await navigator.clipboard.writeText(absoluteUrl(whiteboardUrl));
    copyFeedback.textContent = "Whiteboard link copied.";
  } catch {
    copyFeedback.textContent =
      "Copy was blocked. Open the whiteboard and copy its address instead.";
  }
}

async function submit(event) {
  event.preventDefault();
  if (submitting) return;

  const validation = validateMeetingUrl(input.value);
  if (!validation.valid) {
    setFormState("error", validation.message);
    input.focus();
    return;
  }

  submitting = true;
  ready.hidden = true;
  setFormState(
    "submitting",
    "Creating the Live Architect participant and preparing your views…"
  );

  try {
    const session = await createSession(validation.meetingUrl);
    whiteboardUrl = session.whiteboardUrl;
    operatorLink.href = session.operatorUrl;
    whiteboardLink.href = session.whiteboardUrl;
    ready.hidden = false;
    setFormState("success", "Session created. Opening the operator view…");

    window.setTimeout(() => {
      try {
        window.location.assign(session.operatorUrl);
      } catch {
        redirectMessage.textContent =
          "Automatic redirect was blocked. Open the operator below.";
      }
    }, 350);
  } catch (error) {
    submitting = false;
    const detail = error instanceof Error ? error.message : String(error);
    setFormState("error", detail);
    input.disabled = false;
    input.focus();
  }
}

form.addEventListener("submit", submit);
input.addEventListener("input", () => {
  if (form.dataset.state === "error") setFormState("idle");
});
copyButton.addEventListener("click", copyWhiteboardLink);
setFormState("idle");
