export interface RevisionSnapshot { revision?: number }

export function createRevisionRenderer<TSnapshot extends RevisionSnapshot, TStaged>(options: {
  render(snapshot: TSnapshot, sequence: number): Promise<TStaged> | TStaged;
  commit(snapshot: TSnapshot, staged: TStaged): Promise<void> | void;
  onError?(error: unknown | undefined, revision: number): void;
  onBusy?(busy: boolean, revision?: number): void;
  keyOf?(snapshot: TSnapshot): unknown;
  orderOf?(snapshot: TSnapshot): number;
  retryDelayMs?: number;
  maxAutomaticRetries?: number;
  schedule?(callback: () => void, delay: number): unknown;
  cancel?(timer: unknown): void;
}): {
  offer(snapshot: TSnapshot): Promise<boolean>;
  dispose(): void;
  readonly committedRevision: number;
};
