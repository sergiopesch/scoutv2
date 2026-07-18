/**
 * Coordinates asynchronous whole-revision rendering. Nothing is committed
 * until render() succeeds, so callers can atomically swap every visible field.
 */
export function createRevisionRenderer({
  render,
  commit,
  onError = () => {},
  onBusy = () => {},
  keyOf = (snapshot) => snapshot?.revision ?? 0,
  orderOf = (snapshot) => snapshot?.revision ?? 0,
  retryDelayMs = 1_500,
  maxAutomaticRetries = 1,
  schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
  cancel = (timer) => globalThis.clearTimeout(timer)
}) {
  let committedRevision = -1;
  let committedKey;
  let latestKey;
  let latestOrder = Number.NEGATIVE_INFINITY;
  let inFlightKey;
  let sequence = 0;
  let latestSnapshot;
  let retryTimer;
  const retryCounts = new Map();

  function clearRetry() {
    if (retryTimer !== undefined) cancel(retryTimer);
    retryTimer = undefined;
  }

  async function offer(snapshot) {
    const revision = Number(snapshot?.revision ?? 0);
    if (!Number.isFinite(revision) || revision < 0) return false;
    const order = Number(orderOf(snapshot));
    if (Number.isFinite(order) && order < latestOrder) return false;
    if (Number.isFinite(order) && order > latestOrder) latestOrder = order;
    const key = String(keyOf(snapshot));
    latestKey = key;
    latestSnapshot = snapshot;
    if (key === committedKey || key === inFlightKey) {
      return false;
    }
    clearRetry();
    const thisSequence = ++sequence;
    inFlightKey = key;
    onBusy(true, revision);

    try {
      const staged = await render(snapshot, thisSequence);
      if (thisSequence !== sequence) return false;
      await commit(snapshot, staged);
      committedRevision = revision;
      committedKey = key;
      retryCounts.delete(key);
      onError(undefined, revision);
      return true;
    } catch (error) {
      if (thisSequence !== sequence) return false;
      onError(error, revision);
      const attempts = retryCounts.get(key) ?? 0;
      if (attempts < maxAutomaticRetries) {
        retryCounts.set(key, attempts + 1);
        retryTimer = schedule(() => {
          retryTimer = undefined;
          if (
            latestSnapshot &&
            latestKey === key &&
            committedKey !== key
          ) {
            void offer(latestSnapshot);
          }
        }, retryDelayMs);
      }
      return false;
    } finally {
      if (thisSequence === sequence) {
        inFlightKey = undefined;
        onBusy(false, revision);
      }
    }
  }

  function dispose() {
    sequence += 1;
    inFlightKey = undefined;
    clearRetry();
    onBusy(false);
  }

  return {
    offer,
    dispose,
    get committedRevision() {
      return committedRevision;
    }
  };
}
