export interface KeyedContainer<TChild> {
  children: ArrayLike<TChild> & Iterable<TChild>;
  insertBefore(child: TChild, before: TChild | null): unknown;
}

export interface KeyedChild {
  dataset: Record<string, string | undefined>;
  remove(): void;
}

export function reconcileKeyedChildren<TItem, TChild extends KeyedChild>(
  container: KeyedContainer<TChild>,
  items: TItem[],
  operations: {
    keyOf(item: TItem): unknown;
    create(item: TItem): TChild;
    update(child: TChild, item: TItem): void;
  }
): TChild[];
