export interface TranscriptFragment {
  id: string;
  sequence: number;
  text: string;
  startedAt: number;
  endedAt: number;
}

export interface TranscriptTurn {
  speakerKey: string;
  participantId: string;
  participantName: string;
  startedAt: number;
  endedAt: number;
  fragments: TranscriptFragment[];
}

export interface TranscriptScrollState {
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
}

export interface TranscriptUpdate {
  changed: boolean;
  signature: string;
  turns: TranscriptTurn[];
  follow: boolean;
  preservedScrollTop: number;
}

export function transcriptSignature(utterances?: unknown[]): string;
export function groupTranscriptTurns(utterances?: unknown[]): TranscriptTurn[];
export function prepareTranscriptUpdate(
  utterances: unknown[],
  previousSignature: string,
  scrollState?: TranscriptScrollState
): TranscriptUpdate;
export function transcriptScrollTop(
  update: TranscriptUpdate,
  nextScrollHeight: number
): number;
