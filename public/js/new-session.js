import {
  createSession,
  loadReadiness,
  validateMeetingUrl
} from "./new-session-api.js";
import { newSessionView } from "./new-session-view.js";

const form = document.querySelector("#start-form");
const input = document.querySelector("#meeting-url");
const button = document.querySelector("#start-button");
const message = document.querySelector("#form-message");
const readinessStatus = document.querySelector("#readiness-status");
const readinessDot = document.querySelector("#readiness-dot");
const readinessLabel = document.querySelector("#readiness-label");
const readinessMessage = document.querySelector("#readiness-message");
const readinessRetry = document.querySelector("#readiness-retry");
const sessionEyebrow = document.querySelector("#session-eyebrow");
const lede = document.querySelector("#start-lede");
const stepOneTitle = document.querySelector("#step-one-title");
const stepOneText = document.querySelector("#step-one-text");
const stepTwoTitle = document.querySelector("#step-two-title");
const stepTwoText = document.querySelector("#step-two-text");
const stepThreeTitle = document.querySelector("#step-three-title");
const stepThreeText = document.querySelector("#step-three-text");
const formTitle = document.querySelector("#form-title");
const fieldLabel = document.querySelector("#meeting-url-label");
const fieldHint = document.querySelector("#meeting-url-hint");
const admissionNote = document.querySelector("#admission-note");
const admissionCopy = document.querySelector("#admission-copy");
const ready = document.querySelector("#session-ready");
const readyTitle = document.querySelector("#session-ready-title");
const operatorLink = document.querySelector("#operator-link");
const whiteboardLink = document.querySelector("#whiteboard-link");
const copyOperatorButton = document.querySelector("#copy-operator");
const copyWhiteboardButton = document.querySelector("#copy-whiteboard");
const copyFeedback = document.querySelector("#copy-feedback");
const successMessage = document.querySelector("#session-success-message");
const modeFooter = document.querySelector("#mode-footer");

let submitting = false;
let operatorUrl = "";
let whiteboardUrl = "";
let formState = "idle";
let formMessage = "";
let readinessSequence = 0;
let readinessState = { phase: "checking" };
let pageView = newSessionView(readinessState);

function setFormState(state, text = "") {
  formState = state;
  formMessage = text;
  form.dataset.state = state;
  form.dataset.mode = pageView.mode;
  message.textContent = text;
  input.setAttribute("aria-invalid", state === "error" ? "true" : "false");
  button.disabled =
    !pageView.canCreate || state === "submitting" || state === "success";
  input.disabled = state === "submitting" || state === "success";

  const labels = {
    idle: pageView.startButton,
    error: pageView.startButton,
    submitting: pageView.submittingButton,
    success: pageView.successButton
  };
  button.firstElementChild.textContent = labels[state] ?? pageView.startButton;
}

function renderReadiness() {
  pageView = newSessionView(readinessState);
  readinessStatus.dataset.mode = pageView.mode;
  readinessDot.dataset.state = pageView.statusState;
  readinessLabel.textContent = pageView.statusLabel;
  readinessMessage.textContent = pageView.readinessMessage;
  readinessRetry.hidden = pageView.mode !== "unavailable";
  readinessRetry.disabled = pageView.mode === "checking";
  sessionEyebrow.textContent = pageView.sessionEyebrow;
  lede.textContent = pageView.lede;
  stepOneTitle.textContent = pageView.stepOneTitle;
  stepOneText.textContent = pageView.stepOneText;
  stepTwoTitle.textContent = pageView.stepTwoTitle;
  stepTwoText.textContent = pageView.stepTwoText;
  stepThreeTitle.textContent = pageView.stepThreeTitle;
  stepThreeText.textContent = pageView.stepThreeText;
  formTitle.textContent = pageView.formTitle;
  fieldLabel.textContent = pageView.fieldLabel;
  fieldHint.textContent = pageView.fieldHint;
  admissionNote.dataset.mode = pageView.mode;
  admissionCopy.textContent = pageView.admissionText;
  modeFooter.textContent = pageView.footerMode;
  setFormState(formState, formMessage);
}

async function refreshReadiness() {
  const thisCheck = ++readinessSequence;
  formState = "idle";
  formMessage = "";
  readinessState = { phase: "checking" };
  renderReadiness();
  try {
    const readiness = await loadReadiness();
    if (thisCheck !== readinessSequence) return;
    readinessState = {
      phase: readiness.ok ? "ready" : "unavailable",
      readiness
    };
  } catch (error) {
    if (thisCheck !== readinessSequence) return;
    readinessState = {
      phase: "unavailable",
      errorMessage:
        error instanceof Error
          ? `${error.message} Check the server connection and try again.`
          : "Could not verify Scout readiness. Check the server connection and try again."
    };
  }
  renderReadiness();
}

function applyCreatedSessionMode(mode) {
  if (!new Set(["live", "rehearsal"]).has(mode) || mode === pageView.mode) {
    return;
  }
  readinessState = {
    phase: "ready",
    readiness: {
      ok: true,
      mode,
      codex: { ready: true },
      recall: { ready: mode === "live" }
    }
  };
  renderReadiness();
}

function absoluteUrl(pathname) {
  return new URL(pathname, window.location.origin).href;
}

async function copySessionLink(pathname, label) {
  if (!pathname) return;
  try {
    await navigator.clipboard.writeText(absoluteUrl(pathname));
    copyFeedback.textContent = `${label} link copied.`;
  } catch {
    copyFeedback.textContent =
      `Copy was blocked. Open the ${label.toLowerCase()} and copy its address instead.`;
  }
}

async function submit(event) {
  event.preventDefault();
  if (submitting || !pageView.canCreate) return;

  const validation = validateMeetingUrl(input.value);
  if (!validation.valid) {
    setFormState("error", validation.message);
    input.focus();
    return;
  }

  submitting = true;
  operatorUrl = "";
  whiteboardUrl = "";
  copyFeedback.textContent = "";
  ready.hidden = true;
  setFormState("submitting", pageView.submittingMessage);

  try {
    const session = await createSession(validation.meetingUrl);
    applyCreatedSessionMode(session.mode);
    operatorUrl = session.operatorUrl;
    whiteboardUrl = session.whiteboardUrl;
    operatorLink.href = session.operatorUrl;
    whiteboardLink.href = session.whiteboardUrl;
    readyTitle.textContent = pageView.successTitle;
    successMessage.textContent = pageView.successMessage;
    ready.hidden = false;
    setFormState("success", pageView.successMessage);
    ready.focus();
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
copyOperatorButton.addEventListener("click", () =>
  void copySessionLink(operatorUrl, "Operator")
);
copyWhiteboardButton.addEventListener("click", () =>
  void copySessionLink(whiteboardUrl, "Whiteboard")
);
readinessRetry.addEventListener("click", () => void refreshReadiness());
renderReadiness();
void refreshReadiness();
