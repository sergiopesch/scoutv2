import type { ScoutReadiness } from "./new-session-api.js";

export interface NewSessionView {
  canCreate: boolean;
  mode: "checking" | "live" | "rehearsal" | "unavailable";
  statusState: string;
  statusLabel: string;
  sessionEyebrow: string;
  lede: string;
  stepOneTitle: string;
  stepOneText: string;
  stepTwoTitle: string;
  stepTwoText: string;
  stepThreeTitle: string;
  stepThreeText: string;
  formTitle: string;
  fieldLabel: string;
  fieldHint: string;
  readinessMessage: string;
  admissionText: string;
  startButton: string;
  submittingButton: string;
  submittingMessage: string;
  successButton: string;
  successTitle: string;
  successMessage: string;
  footerMode: string;
}

export function newSessionView(state?: {
  phase: "checking" | "ready" | "unavailable";
  readiness?: ScoutReadiness;
  errorMessage?: string;
}): NewSessionView;
