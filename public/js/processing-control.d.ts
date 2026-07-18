export interface ProcessingControlState {
  paused?: boolean;
}

export interface ProcessingControlView {
  paused: boolean;
  statusText: "Paused" | "Live";
  buttonText: string;
  note: string;
}

export function processingControlView(
  processing?: ProcessingControlState,
  submitting?: boolean,
  requestedPaused?: boolean
): ProcessingControlView;
