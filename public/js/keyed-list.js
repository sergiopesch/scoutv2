/**
 * Reconcile a list without replacing nodes whose keys are still present.
 * Keeping those nodes alive preserves focus, pointer interaction and assistive
 * technology context while high-frequency SSE snapshots arrive.
 */
export function reconcileKeyedChildren(
  container,
  items,
  { keyOf, create, update }
) {
  const existing = new Map(
    [...container.children].map((child) => [child.dataset.key, child])
  );
  const desired = [];

  for (const item of items) {
    const key = String(keyOf(item));
    const child = existing.get(key) ?? create(item);
    child.dataset.key = key;
    update(child, item);
    desired.push(child);
    existing.delete(key);
  }

  desired.forEach((child, index) => {
    const current = container.children[index] ?? null;
    if (current !== child) container.insertBefore(child, current);
  });

  for (const child of existing.values()) child.remove();
  return desired;
}
