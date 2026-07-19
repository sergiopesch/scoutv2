export const DIAGRAM_VIEW_KINDS = Object.freeze([
  "process",
  "organization",
  "architecture"
]);

const defaultIdleSchedule = (callback) => {
  if (typeof globalThis.requestIdleCallback === "function") {
    return { kind: "idle", id: globalThis.requestIdleCallback(callback, { timeout: 500 }) };
  }
  return { kind: "timeout", id: globalThis.setTimeout(callback, 32) };
};

const defaultIdleCancel = (handle) => {
  if (!handle) return;
  if (handle.kind === "idle" && typeof globalThis.cancelIdleCallback === "function") {
    globalThis.cancelIdleCallback(handle.id);
    return;
  }
  globalThis.clearTimeout(handle.id);
};

/**
 * Coordinates one serial Mermaid queue while retaining independent artifacts
 * for each semantic view. Projection is intentionally synchronous and cheap;
 * only the active dirty view enters the render queue immediately.
 */
export function createViewRenderCoordinator({
  project,
  hash,
  render,
  commit,
  onState = () => {},
  onError = () => {},
  viewKinds = DIAGRAM_VIEW_KINDS,
  initialView = viewKinds[0],
  scheduleIdle = defaultIdleSchedule,
  cancelIdle = defaultIdleCancel
}) {
  if (!viewKinds.includes(initialView)) {
    throw new Error(`Unknown initial diagram view: ${initialView}`);
  }

  const states = new Map(
    viewKinds.map((viewKind) => [
      viewKind,
      {
        viewKind,
        status: "clean",
        latestRequestedRevision: -1,
        latestRoleRevision: -1,
        committedRevision: -1,
        semanticHash: undefined,
        committedHash: undefined,
        projection: undefined,
        artifact: undefined,
        generation: 0,
        error: undefined
      }
    ])
  );
  let activeView = initialView;
  let disposed = false;
  let rendering = false;
  let idleHandle;

  const publicState = (state) => ({
    viewKind: state.viewKind,
    status: state.status,
    latestRequestedRevision: state.latestRequestedRevision,
    latestRoleRevision: state.latestRoleRevision,
    committedRevision: state.committedRevision,
    semanticHash: state.semanticHash,
    committedHash: state.committedHash,
    hasArtifact: state.artifact !== undefined,
    error: state.error
  });

  const publish = (state) => onState(state.viewKind, publicState(state));

  const dirtyStates = () => viewKinds
    .map((kind) => states.get(kind))
    .filter((state) => state?.status === "dirty");

  function cancelScheduledIdle() {
    if (idleHandle !== undefined) cancelIdle(idleHandle);
    idleHandle = undefined;
  }

  function scheduleInactive() {
    if (disposed || rendering || idleHandle !== undefined) return;
    const next = dirtyStates().find((state) => state.viewKind !== activeView);
    if (!next) return;
    idleHandle = scheduleIdle(() => {
      idleHandle = undefined;
      void drain(true);
    });
  }

  function nextToRender() {
    const active = states.get(activeView);
    if (active?.status === "dirty") return active;
    return dirtyStates().find((state) => state.viewKind !== activeView);
  }

  async function drain(allowInactive = false) {
    if (disposed || rendering) return;
    const state = nextToRender();
    if (!state?.projection) return;
    if (state.viewKind !== activeView && !allowInactive) {
      scheduleInactive();
      return;
    }

    rendering = true;
    const generation = state.generation;
    const expectedHash = state.semanticHash;
    const expectedRevision = state.latestRequestedRevision;
    const expectedRoleRevision = state.latestRoleRevision;
    state.status = "rendering";
    state.error = undefined;
    publish(state);

    try {
      const artifact = await render({
        viewKind: state.viewKind,
        projection: state.projection,
        revision: expectedRevision,
        roleRevision: expectedRoleRevision,
        semanticHash: expectedHash,
        generation
      });
      if (
        disposed ||
        generation !== state.generation ||
        expectedHash !== state.semanticHash ||
        expectedRevision !== state.latestRequestedRevision ||
        expectedRoleRevision !== state.latestRoleRevision
      ) {
        return;
      }
      await commit({
        viewKind: state.viewKind,
        projection: state.projection,
        revision: expectedRevision,
        roleRevision: expectedRoleRevision,
        semanticHash: expectedHash,
        artifact
      });
      state.artifact = artifact;
      state.committedHash = expectedHash;
      state.committedRevision = expectedRevision;
      state.status = "clean";
      state.error = undefined;
      publish(state);
    } catch (error) {
      if (generation !== state.generation || disposed) return;
      state.status = "failed";
      state.error = error;
      publish(state);
      onError(state.viewKind, error, publicState(state));
    } finally {
      rendering = false;
      if (!disposed) {
        const active = states.get(activeView);
        if (active?.status === "dirty") {
          void drain();
        } else {
          scheduleInactive();
        }
      }
    }
  }

  function offer(snapshot, scopes = {}) {
    if (disposed) return false;
    const revision = Number(snapshot?.revision ?? 0);
    const roleRevision = Number(snapshot?.roleRevision ?? 0);
    let changed = false;
    for (const viewKind of viewKinds) {
      const state = states.get(viewKind);
      const projection = project(snapshot?.graph ?? {}, viewKind, scopes[viewKind]);
      const semanticHash = String(hash(projection));
      const supersedesInFlight = state.status === "rendering" && (
        revision !== state.latestRequestedRevision ||
        roleRevision !== state.latestRoleRevision
      );
      const epochChanged = roleRevision !== state.latestRoleRevision;
      state.latestRequestedRevision = revision;
      state.latestRoleRevision = roleRevision;
      state.projection = projection;
      if (semanticHash !== state.semanticHash || epochChanged || supersedesInFlight) {
        state.semanticHash = semanticHash;
        state.generation += 1;
        state.status = semanticHash === state.committedHash ? "clean" : "dirty";
        state.error = undefined;
        changed = true;
        publish(state);
      } else if (semanticHash === state.committedHash) {
        state.committedRevision = revision;
        publish(state);
      }
    }
    cancelScheduledIdle();
    void drain();
    return changed;
  }

  function activate(viewKind) {
    if (!states.has(viewKind) || disposed) return false;
    activeView = viewKind;
    cancelScheduledIdle();
    void drain();
    return true;
  }

  function retry(viewKind = activeView) {
    const state = states.get(viewKind);
    if (!state || disposed || state.status !== "failed") return false;
    state.status = "dirty";
    state.error = undefined;
    publish(state);
    cancelScheduledIdle();
    void drain();
    return true;
  }

  function dispose() {
    disposed = true;
    cancelScheduledIdle();
    for (const state of states.values()) state.generation += 1;
  }

  return {
    offer,
    activate,
    retry,
    dispose,
    get activeView() {
      return activeView;
    },
    state(viewKind) {
      const state = states.get(viewKind);
      return state ? publicState(state) : undefined;
    }
  };
}
