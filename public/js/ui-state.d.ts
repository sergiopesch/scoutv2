export interface BrowserSnapshot {
  updatedAt?: number;
  revision?: number;
  roleRevision?: number;
  status?: string;
  operatorParticipantId?: string;
  participants?: Array<{ isBot?: boolean; present?: boolean; role?: string }>;
  processing?: { paused?: boolean };
  recall?: { detail?: string };
  analysis?: {
    status?: string;
    pendingUtteranceCount?: number;
    blockedReason?: string;
    throttled?: boolean;
    automaticTurnsStarted?: number;
    automaticTurnBudget?: number;
    lastError?: string;
  };
}

export interface StatusView { state: string; label: string }
export interface ActionView { disabled: boolean; buttonText: string; note: string }

export function isTerminalStatus(status?: string): boolean;
export function shouldAcceptSnapshot(current: BrowserSnapshot | undefined, incoming: BrowserSnapshot): boolean;
export function sessionStreamView(snapshot?: BrowserSnapshot, connectionState?: string): StatusView;
export function analysisActionView(snapshot?: BrowserSnapshot, state?: { submitting?: boolean; resetting?: boolean; connectionState?: string }): ActionView;
export function identitySelectionView(snapshot?: BrowserSnapshot, selection?: { phase?: string }): { state: string; text: string };
export function whiteboardStatusView(snapshot?: BrowserSnapshot, connectionState?: string): StatusView;
