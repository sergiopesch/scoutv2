export interface ProcessingControlState {
  paused?: boolean;
}

export interface ProcessingControlView {
  paused: boolean;
  disabled: boolean;
  statusText: "Paused" | "Live" | "Ended" | "Unavailable";
  buttonText: string;
  note: string;
}

export function processingControlView(
  processing?: ProcessingControlState,
  submitting?: boolean,
  requestedPaused?: boolean,
  sessionStatus?: string
): ProcessingControlView;
