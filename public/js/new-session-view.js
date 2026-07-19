const checkingView = {
  canCreate: false,
  mode: "checking",
  statusState: "connecting",
  statusLabel: "Checking availability",
  sessionEyebrow: "New Scout session",
  lede:
    "Scout is checking whether this server can join a live meeting or run a local rehearsal.",
  stepOneTitle: "Add the meeting link",
  stepOneText: "Scout will use it according to the available session mode.",
  stepTwoTitle: "Confirm the session mode",
  stepTwoText: "Live and rehearsal sessions use different meeting behavior.",
  stepThreeTitle: "Open the working views",
  stepThreeText: "Scout will prepare an operator view and a shared whiteboard.",
  formTitle: "Checking Scout…",
  fieldLabel: "Meeting URL",
  fieldHint: "Checking whether Scout can join live or start a rehearsal.",
  readinessMessage: "Checking Recall and Codex readiness…",
  admissionText:
    "Checking whether Scout will join the meeting or create rehearsal views only.",
  startButton: "Checking Scout…",
  submittingButton: "Preparing session…",
  submittingMessage: "Preparing your Scout session…",
  successButton: "Scout started",
  successTitle: "Scout is ready.",
  successMessage:
    "Session created. Save both private links, then open either view when you are ready.",
  footerMode: "Checking live or rehearsal availability"
};

const liveView = {
  canCreate: true,
  mode: "live",
  statusState: "live",
  statusLabel: "Ready for live meeting",
  sessionEyebrow: "New live session",
  lede:
    "Paste a Zoom, Google Meet or Microsoft Teams link. Scout joins the meeting and builds the workflow as your team talks.",
  stepOneTitle: "Paste the join link",
  stepOneText: "Use the secure link from your calendar invitation.",
  stepTwoTitle: "Admit Live Architect",
  stepTwoText: "The host may see a waiting-room prompt for Scout's meeting participant.",
  stepThreeTitle: "Watch the map emerge",
  stepThreeText: "Finalized, attributed customer speech updates the shared whiteboard.",
  formTitle: "Where should Scout join?",
  fieldLabel: "Zoom, Google Meet or Teams URL",
  fieldHint: "Use the secure HTTPS join link from the meeting invitation.",
  readinessMessage: "Live meeting mode is ready.",
  admissionText:
    "A participant named Live Architect will join. The meeting host may need to admit it.",
  startButton: "Start Scout",
  submittingButton: "Creating Live Architect…",
  submittingMessage:
    "Creating the Live Architect participant and preparing your views…",
  successButton: "Scout started",
  successTitle: "Scout is ready to join.",
  successMessage:
    "Live session created. Save both private links, then open either view when you are ready.",
  footerMode: "Live · attributed · revision-aware"
};

const rehearsalView = {
  canCreate: true,
  mode: "rehearsal",
  statusState: "rehearsal",
  statusLabel: "Workspace mode",
  sessionEyebrow: "New Scout workspace",
  lede:
    "Open the operator workspace and shared canvas without adding a participant to the meeting.",
  stepOneTitle: "Add a meeting reference",
  stepOneText: "The link identifies this workspace and will not be opened.",
  stepTwoTitle: "Open the working views",
  stepTwoText: "Scout prepares the operator workspace and shared canvas.",
  stepThreeTitle: "Add finalized inputs",
  stepThreeText: "Attributed inputs update the business map as they arrive.",
  formTitle: "Create a Scout workspace",
  fieldLabel: "Meeting reference",
  fieldHint:
    "Used only to identify this workspace. Scout will not open or join the link.",
  readinessMessage: "Workspace mode is ready. No meeting participant will be created.",
  admissionText: "No participant joins the meeting in workspace mode.",
  startButton: "Create workspace",
  submittingButton: "Creating workspace…",
  submittingMessage: "Preparing the operator workspace and shared canvas…",
  successButton: "Workspace ready",
  successTitle: "Scout workspace is ready.",
  successMessage:
    "Workspace created. Save both private links, then open the operator view or share the canvas.",
  footerMode: "Workspace · finalized · revision-aware"
};

function unavailableDetail(readiness, fallback) {
  if (fallback) return fallback;
  const failed = [readiness?.codex, readiness?.recall]
    .filter((dependency) => dependency && dependency.ready !== true)
    .map((dependency) => dependency.detail)
    .filter(Boolean);
  return failed.length > 0
    ? failed.join(" ")
    : "Required Scout services are not ready.";
}

export function newSessionView(state = { phase: "checking" }) {
  if (state.phase === "checking") return { ...checkingView };
  const readiness = state.readiness;
  if (state.phase === "ready" && readiness?.ok && readiness.mode === "live") {
    return { ...liveView };
  }
  if (
    state.phase === "ready" &&
    readiness?.ok &&
    readiness.mode === "rehearsal"
  ) {
    return { ...rehearsalView };
  }
  return {
    ...checkingView,
    canCreate: false,
    mode: "unavailable",
    statusState: "error",
    statusLabel: "Scout unavailable",
    sessionEyebrow: "Session unavailable",
    lede:
      "Scout cannot create a session until its required services are ready.",
    stepOneTitle: "Keep the meeting link ready",
    stepOneText: "Scout will not use it until required services recover.",
    stepTwoTitle: "Resolve readiness",
    stepTwoText: "Check the reported service status, then try the readiness check again.",
    stepThreeTitle: "Start when ready",
    stepThreeText: "Session controls remain disabled so Scout cannot promise a bot or rehearsal it cannot create.",
    formTitle: "Scout is unavailable",
    fieldHint: "You can keep the meeting link here and retry the readiness check.",
    readinessMessage: unavailableDetail(readiness, state.errorMessage),
    admissionText:
      "No session or meeting participant will be created until Scout reports ready.",
    startButton: "Scout unavailable",
    submittingButton: "Scout unavailable",
    submittingMessage: "Scout is unavailable.",
    successButton: "Scout started",
    successTitle: "Scout is ready.",
    successMessage:
      "Session created. Save both private links, then open either view when you are ready.",
    footerMode: "Waiting for required services"
  };
}
