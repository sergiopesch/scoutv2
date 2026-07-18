export interface ProcessingControlState {
  paused?: boolean;
}

export interface ProcessingControlView {
  paused: boolean;
  disabled: boolean;
  statusText: "Paused" | "Live" | "Meeting ended";
  buttonText: string;
  note: string;
}

export function processingControlView(
  processing?: ProcessingControlState,
  submitting?: boolean,
  requestedPaused?: boolean,
  sessionStatus?:
    | "creating"
    | "waiting_for_admission"
    | "listening"
    | "analyzing"
    | "ended"
    | "error"
): ProcessingControlView;
