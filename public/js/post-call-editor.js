export const POST_CALL_VIEW_KINDS = ["process", "organization", "architecture"];

export const POST_CALL_NODE_KINDS = Object.freeze({
  process: [
    "pool",
    "lane",
    "start",
    "end",
    "activity",
    "subprocess",
    "exclusive_gateway",
    "parallel_gateway",
    "inclusive_gateway",
    "event_gateway",
    "intermediate_event",
    "document",
    "data_store"
  ],
  organization: ["person", "position", "unit"],
  architecture: [
    "person",
    "external_system",
    "software_system",
    "service",
    "application",
    "api",
    "gateway",
    "worker",
    "database",
    "data_store",
    "queue",
    "event_bus",
    "file_store",
    "integration",
    "device",
    "network",
    "boundary"
  ]
});

const clone = (value) =>
  typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));

const stateFor = (scope, certainty) => {
  if (certainty === "hypothesis") return "hypothesis";
  if (certainty === "unknown" || certainty === "conflicted") return "unknown";
  return scope === "desired" ? "desired" : "current";
};

const effectiveScope = (entity) =>
  entity.scope ?? (entity.state === "desired" ? "desired" : "current");

const scopeValues = (entity) => {
  const scope = effectiveScope(entity);
  return scope === "both" ? ["current", "desired"] : [scope];
};

const commonScope = (...entities) => {
  const values = new Set(scopeValues(entities[0]));
  for (const entity of entities.slice(1)) {
    const next = new Set(scopeValues(entity));
    for (const value of values) if (!next.has(value)) values.delete(value);
  }
  if (values.size === 2) return "both";
  return [...values][0];
};

const baseKindFor = (viewKind) =>
  viewKind === "process" ? "process" : viewKind === "organization" ? "actor" : "system";

const defaultFacetFor = (viewKind) => {
  if (viewKind === "process") {
    return { process: { kind: "activity", taskType: "unknown" } };
  }
  if (viewKind === "organization") {
    return { organization: { kind: "position" } };
  }
  return { architecture: { kind: "service" } };
};

const entityId = (prefix, idFactory) => {
  const raw = String(idFactory?.() ?? crypto.randomUUID())
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${prefix}-${raw || Date.now().toString(36)}`.slice(0, 64);
};

export function isPostCallReviewPath(pathname = globalThis.location?.pathname ?? "") {
  return /^\/review\/[A-Za-z0-9_-]+\/?$/.test(pathname);
}

export function postCallReviewView(snapshot, saving = false) {
  if (!snapshot) {
    return { ready: false, editable: false, label: "Loading review…", blocker: "Loading the meeting." };
  }
  const blocker = snapshot.postCallBlocker || (
    snapshot.status !== "ended"
      ? "The meeting must end before post-call review begins."
      : snapshot.analysis?.status === "running"
        ? "Scout is still finalizing the accepted map."
        : snapshot.analysis?.status === "queued" || Number(snapshot.analysis?.pendingUtteranceCount ?? 0) > 0
          ? "Analyze the remaining finalized utterances before editing."
          : undefined
  );
  return {
    ready: !blocker,
    editable: !blocker && !saving,
    approved: Boolean(snapshot.postCall?.approvedAt),
    label: saving
      ? "Saving review…"
      : blocker
        ? "Review waiting"
        : snapshot.postCall?.approvedAt
          ? `Approved · review ${Number(snapshot.postCall?.revision ?? 0)}`
          : "Ready for review · approval required",
    blocker
  };
}

export async function loadPostCallReview(sessionId, fetchImpl = fetch) {
  const response = await fetchImpl(`/api/reviews/${encodeURIComponent(sessionId)}`, {
    headers: { Accept: "application/json" }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `Post-call review could not be loaded (${response.status}).`);
  }
  return result;
}

export async function savePostCallReview(
  sessionId,
  { expectedRevision, graph, notes },
  fetchImpl = fetch
) {
  const response = await fetchImpl(`/api/reviews/${encodeURIComponent(sessionId)}`, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ expectedRevision, graph, notes })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const issues = Array.isArray(result.issues)
      ? result.issues.map((issue) =>
          typeof issue === "string" ? issue : issue?.message
        ).filter(Boolean)
      : [];
    const error = new Error(
      issues.length > 0
        ? `${result.error || "Post-call edit was rejected"} ${issues.join(" ")}`
        : result.error || `Post-call edit could not be saved (${response.status}).`
    );
    error.status = response.status;
    error.current = result.current;
    throw error;
  }
  return result;
}

export function addGraphNode(graph, viewKind, scope, _evidenceId, idFactory) {
  if (!POST_CALL_VIEW_KINDS.includes(viewKind)) throw new Error("Unknown diagram view.");
  const next = clone(graph);
  const id = entityId(viewKind, idFactory);
  const label = viewKind === "process"
    ? "New activity"
    : viewKind === "organization"
      ? "New position"
      : "New service";
  next.nodes.push({
    id,
    kind: baseKindFor(viewKind),
    label,
    state: stateFor(scope, "hypothesis"),
    scope,
    certainty: "hypothesis",
    confidence: 0.5,
    provenance: "post_call_editorial",
    facets: defaultFacetFor(viewKind),
    evidenceUtteranceIds: []
  });
  return { graph: next, entityId: id };
}

const withoutReference = (values, removedId) => {
  if (!values) return values;
  const next = Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== removedId)
  );
  return Object.keys(next).length > 0 ? next : undefined;
};

const cleanPlacement = (placement, removedId) => {
  if (!placement) return placement;
  const next = {};
  for (const scope of ["current", "desired"]) {
    const cleaned = withoutReference(placement[scope], removedId);
    if (cleaned) next[scope] = cleaned;
  }
  return Object.keys(next).length > 0 ? next : undefined;
};

export function removeGraphNode(graph, nodeId) {
  const next = clone(graph);
  next.nodes = next.nodes
    .filter((node) => node.id !== nodeId)
    .map((node) => {
      const facets = node.facets;
      if (!facets) return node;
      const updated = clone(node);
      if (updated.facets?.process) {
        updated.facets.process.placement = cleanPlacement(
          updated.facets.process.placement,
          nodeId
        );
        if (!updated.facets.process.placement) delete updated.facets.process.placement;
      }
      if (updated.facets?.organization) {
        updated.facets.organization.unitNodeIdByScope = withoutReference(
          updated.facets.organization.unitNodeIdByScope,
          nodeId
        );
        if (!updated.facets.organization.unitNodeIdByScope) {
          delete updated.facets.organization.unitNodeIdByScope;
        }
      }
      if (updated.facets?.architecture) {
        updated.facets.architecture.parentBoundaryNodeIdByScope = withoutReference(
          updated.facets.architecture.parentBoundaryNodeIdByScope,
          nodeId
        );
        if (!updated.facets.architecture.parentBoundaryNodeIdByScope) {
          delete updated.facets.architecture.parentBoundaryNodeIdByScope;
        }
      }
      return updated;
    });
  next.edges = next.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
  next.pains = next.pains
    .map((pain) => ({
      ...pain,
      targetNodeIds: pain.targetNodeIds.filter((targetId) => targetId !== nodeId)
    }))
    .filter((pain) => pain.targetNodeIds.length > 0);
  return next;
}

export function updateGraphNode(graph, nodeId, viewKind, changes) {
  const next = clone(graph);
  const node = next.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error("The selected diagram element no longer exists.");
  if (typeof changes.label === "string") node.label = changes.label.trim();
  if (typeof changes.shortLabel === "string") {
    const shortLabel = changes.shortLabel.trim();
    if (shortLabel) node.shortLabel = shortLabel;
    else delete node.shortLabel;
  }
  if (["current", "desired", "both"].includes(changes.scope)) {
    node.scope = changes.scope;
    for (const edge of next.edges.filter((candidate) => candidate.from === nodeId || candidate.to === nodeId)) {
      const otherId = edge.from === nodeId ? edge.to : edge.from;
      const other = next.nodes.find((candidate) => candidate.id === otherId);
      const allowed = other && commonScope(node, other);
      if (!allowed) {
        throw new Error(`Remove or rescope the connection with “${other?.label ?? otherId}” first.`);
      }
      const currentEdgeScopes = scopeValues(edge);
      const allowedScopes = new Set(allowed === "both" ? ["current", "desired"] : [allowed]);
      if (currentEdgeScopes.some((scope) => !allowedScopes.has(scope))) {
        edge.scope = allowed;
        edge.state = stateFor(allowed, edge.certainty);
      }
    }
    for (const pain of next.pains.filter((candidate) => candidate.targetNodeIds.includes(nodeId))) {
      const targets = pain.targetNodeIds
        .map((targetId) => next.nodes.find((candidate) => candidate.id === targetId))
        .filter(Boolean);
      const allowed = targets.length > 0 ? commonScope(...targets) : undefined;
      if (!allowed) throw new Error(`Remove or rescope the pain point “${pain.description}” first.`);
      const currentPainScopes = scopeValues(pain);
      const allowedScopes = new Set(allowed === "both" ? ["current", "desired"] : [allowed]);
      if (currentPainScopes.some((scope) => !allowedScopes.has(scope))) {
        pain.scope = allowed;
        pain.state = stateFor(allowed, pain.certainty);
      }
    }
  }
  if (
    node.provenance !== "post_call_editorial" &&
    ["asserted", "hypothesis", "unknown", "conflicted"].includes(changes.certainty)
  ) {
    node.certainty = changes.certainty;
  }
  if (node.provenance === "post_call_editorial") node.certainty = "hypothesis";
  node.state = stateFor(node.scope, node.certainty);
  if (changes.semanticType && node.facets?.[viewKind]) {
    node.facets[viewKind].kind = changes.semanticType;
  }
  return next;
}

const edgeFacet = (viewKind) => {
  if (viewKind === "process") return { process: { kind: "sequence" } };
  if (viewKind === "organization") return { organization: { kind: "primary_report" } };
  return { architecture: { kind: "connection", interaction: "unknown" } };
};

const edgeKind = (viewKind) =>
  viewKind === "process" ? "hands_off_to" : "depends_on";

export function addGraphEdge(graph, viewKind, from, to, scope, _evidenceId, idFactory) {
  if (from === to) throw new Error("A connection needs two different elements.");
  const next = clone(graph);
  const fromNode = next.nodes.find((node) => node.id === from);
  const toNode = next.nodes.find((node) => node.id === to);
  if (!fromNode?.facets?.[viewKind] || !toNode?.facets?.[viewKind]) {
    throw new Error("Both elements must belong to the active diagram view.");
  }
  const id = entityId(`${viewKind}-edge`, idFactory);
  next.edges.push({
    id,
    from,
    to,
    kind: edgeKind(viewKind),
    state: stateFor(scope, "hypothesis"),
    scope,
    certainty: "hypothesis",
    confidence: 0.5,
    provenance: "post_call_editorial",
    facets: edgeFacet(viewKind),
    evidenceUtteranceIds: []
  });
  return { graph: next, entityId: id };
}

export function removeGraphEdge(graph, edgeId) {
  const next = clone(graph);
  next.edges = next.edges.filter((edge) => edge.id !== edgeId);
  return next;
}

export function updateGraphEdge(graph, edgeId, viewKind, changes) {
  const next = clone(graph);
  const edge = next.edges.find((candidate) => candidate.id === edgeId);
  if (!edge?.facets?.[viewKind]) throw new Error("The selected connection no longer exists in this view.");
  if (typeof changes.label === "string") {
    const label = changes.label.trim();
    if (label) edge.label = label;
    else delete edge.label;
  }
  if (changes.reverse === true) [edge.from, edge.to] = [edge.to, edge.from];
  if (viewKind === "process" && ["sequence", "message", "association"].includes(changes.relationKind)) {
    edge.facets.process.kind = changes.relationKind;
  }
  if (viewKind === "organization" && ["primary_report", "secondary_report"].includes(changes.relationKind)) {
    edge.facets.organization.kind = changes.relationKind;
  }
  if (
    viewKind === "architecture" &&
    ["synchronous", "asynchronous", "batch", "stream", "unknown"].includes(changes.interaction)
  ) {
    edge.facets.architecture.interaction = changes.interaction;
  }
  if (viewKind === "architecture" && typeof changes.protocol === "string") {
    const protocol = changes.protocol.trim();
    if (protocol) edge.facets.architecture.protocol = protocol;
    else delete edge.facets.architecture.protocol;
  }
  return next;
}
