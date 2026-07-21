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

const setScopedReference = (facet, field, scope, value) => {
  const scopes = scope === "both" ? ["current", "desired"] : [scope];
  const next = { ...(facet[field] ?? {}) };
  for (const key of scopes) {
    if (value) next[key] = value;
    else delete next[key];
  }
  if (Object.keys(next).length > 0) facet[field] = next;
  else delete facet[field];
};

const setOptionalText = (target, field, value) => {
  if (typeof value !== "string") return;
  const clean = value.trim();
  if (clean) target[field] = clean;
  else delete target[field];
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

const PAIN_CATEGORIES = new Set([
  "delay", "rework", "error", "cost", "risk", "capacity", "experience", "interoperability", "other"
]);

const painScope = (value) => ["current", "desired", "both"].includes(value) ? value : "current";
const painSeverity = (value) => ["low", "medium", "high"].includes(value) ? value : "medium";
const uniqueIds = (values) => [...new Set((Array.isArray(values) ? values : [])
  .map((value) => String(value).trim()).filter(Boolean))].slice(0, 8);
const optionalText = (value, maximum) => {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maximum) : undefined;
};

function diagnosisFor(input = {}) {
  const diagnosis = {
    failureMode: optionalText(input.failureMode, 180),
    consequence: optionalText(input.consequence, 180),
    causeHypothesis: optionalText(input.causeHypothesis, 180),
    frequency: optionalText(input.frequency, 100)
  };
  return Object.values(diagnosis).some(Boolean) ? diagnosis : undefined;
}

function painFields(input, existing = {}) {
  const scope = painScope(
    input.scope ??
      existing.scope ??
      (existing.state === "desired" ? "desired" : "current")
  );
  const editorial = existing.provenance === "post_call_editorial" || input.provenance === "post_call_editorial";
  const certainty = editorial
    ? "hypothesis"
    : input.certainty ??
      existing.certainty ??
      (existing.state === "unknown"
        ? "unknown"
        : existing.state === "hypothesis"
          ? "hypothesis"
          : "asserted");
  const categoryInput =
    input.category === undefined ? existing.category : input.category;
  const category = PAIN_CATEGORIES.has(categoryInput)
    ? categoryInput
    : undefined;
  const targetEdgeIds = uniqueIds(input.targetEdgeIds ?? existing.targetEdgeIds);
  const diagnosis = diagnosisFor(input.diagnosis ?? existing.diagnosis);
  const result = {
    ...existing,
    description: optionalText(input.description ?? existing.description, 180) ?? existing.description,
    targetNodeIds: uniqueIds(input.targetNodeIds ?? existing.targetNodeIds),
    ...(targetEdgeIds.length > 0
      ? { targetEdgeIds }
      : {}),
    ...(category ? { category } : {}),
    ...(diagnosis ? { diagnosis } : {}),
    severity: painSeverity(input.severity ?? existing.severity),
    scope,
    state: editorial ? "hypothesis" : stateFor(scope, certainty),
    certainty
  };
  if (!targetEdgeIds.length) delete result.targetEdgeIds;
  if (!category) delete result.category;
  if (!diagnosis) delete result.diagnosis;
  return result;
}

const supportsScope = (entity, scope) => {
  const values = scopeValues(entity);
  return scope === "both"
    ? values.includes("current") && values.includes("desired")
    : values.includes(scope);
};

function assertPainTargets(graph, pain) {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgesById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  for (const nodeId of pain.targetNodeIds) {
    const node = nodesById.get(nodeId);
    if (!node || !supportsScope(node, pain.scope)) {
      throw new Error(`Choose affected elements available in the ${pain.scope} scope.`);
    }
  }
  for (const edgeId of pain.targetEdgeIds ?? []) {
    const edge = edgesById.get(edgeId);
    if (!edge || !supportsScope(edge, pain.scope)) {
      throw new Error(`Choose connections available in the ${pain.scope} scope.`);
    }
    if (
      !pain.targetNodeIds.includes(edge.from) &&
      !pain.targetNodeIds.includes(edge.to)
    ) {
      throw new Error("Each affected connection must touch an affected element.");
    }
  }
}

/** Adds an explicitly editorial, evidence-free hypothesis without changing meeting evidence. */
export function addGraphPain(graph, input = {}, idFactory) {
  const next = clone(graph);
  const targetNodeIds = uniqueIds(input.targetNodeIds);
  if (targetNodeIds.length === 0) throw new Error("Choose at least one affected element.");
  const scope = painScope(input.scope);
  const pain = {
    ...painFields({ ...input, targetNodeIds, provenance: "post_call_editorial", scope }, {
      id: entityId("pain", idFactory),
      description: "New review hypothesis",
      severity: "medium",
      scope,
      provenance: "post_call_editorial",
      evidenceUtteranceIds: []
    }),
    provenance: "post_call_editorial",
    certainty: "hypothesis",
    state: "hypothesis",
    evidenceUtteranceIds: []
  };
  assertPainTargets(next, pain);
  next.pains.push(pain);
  return { graph: next, entityId: next.pains.at(-1).id };
}

/** Edits a finding while deliberately retaining its provenance and evidence. */
export function updateGraphPain(graph, painId, input = {}) {
  const next = clone(graph);
  const index = next.pains.findIndex((pain) => pain.id === painId);
  if (index < 0) throw new Error("That pain point is no longer available.");
  const existing = next.pains[index];
  const updated = painFields(input, existing);
  if (updated.targetNodeIds.length === 0) throw new Error("Choose at least one affected element.");
  assertPainTargets(next, updated);
  next.pains[index] = {
    ...updated,
    id: existing.id,
    provenance: existing.provenance,
    evidenceUtteranceIds: [...(existing.evidenceUtteranceIds ?? [])]
  };
  return next;
}

export function removeGraphPain(graph, painId) {
  const next = clone(graph);
  const pain = next.pains.find((item) => item.id === painId);
  if (pain && pain.provenance !== "post_call_editorial") {
    throw new Error(
      "Meeting-derived findings must be marked unsupported instead of removed."
    );
  }
  next.pains = next.pains.filter((pain) => pain.id !== painId);
  return next;
}

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
  { expectedRevision, graph, notes, annotations = {} },
  fetchImpl = fetch
) {
  const response = await fetchImpl(`/api/reviews/${encodeURIComponent(sessionId)}`, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ expectedRevision, graph, notes, annotations })
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
  const removedEdgeIds = new Set(
    next.edges
      .filter((edge) => edge.from === nodeId || edge.to === nodeId)
      .map((edge) => edge.id)
  );
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
    .map((pain) => {
      const targetEdgeIds = pain.targetEdgeIds?.filter(
        (targetId) => !removedEdgeIds.has(targetId)
      );
      const updated = {
        ...pain,
        targetNodeIds: pain.targetNodeIds.filter(
          (targetId) => targetId !== nodeId
        )
      };
      if (targetEdgeIds?.length) updated.targetEdgeIds = targetEdgeIds;
      else delete updated.targetEdgeIds;
      return updated;
    })
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
    const rescaledEdgeIds = new Set();
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
        rescaledEdgeIds.add(edge.id);
      }
    }
    for (const pain of next.pains.filter(
      (candidate) =>
        candidate.targetNodeIds.includes(nodeId) ||
        candidate.targetEdgeIds?.some((edgeId) => rescaledEdgeIds.has(edgeId))
    )) {
      const targets = [
        ...pain.targetNodeIds.map((targetId) =>
          next.nodes.find((candidate) => candidate.id === targetId)
        ),
        ...(pain.targetEdgeIds ?? []).map((targetId) =>
          next.edges.find((candidate) => candidate.id === targetId)
        )
      ]
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
  const facet = node.facets?.[viewKind];
  if (viewKind === "process" && facet) {
    if (["user", "manual", "service", "script", "business_rule", "send", "receive", "call_activity", "unknown"].includes(changes.taskType)) {
      facet.taskType = changes.taskType;
    }
    if (typeof changes.laneNodeId === "string") {
      const lane = next.nodes.find((candidate) => candidate.id === changes.laneNodeId);
      if (changes.laneNodeId && (lane?.facets?.process?.kind !== "lane" || lane.id === node.id)) {
        throw new Error("Choose a swimlane from this process view.");
      }
      const placement = { ...(facet.placement ?? {}) };
      for (const scope of node.scope === "both" ? ["current", "desired"] : [node.scope]) {
        placement[scope] = { ...(placement[scope] ?? {}) };
        if (changes.laneNodeId) placement[scope].laneNodeId = changes.laneNodeId;
        else delete placement[scope].laneNodeId;
        if (Object.keys(placement[scope]).length === 0) delete placement[scope];
      }
      if (Object.keys(placement).length > 0) facet.placement = placement;
      else delete facet.placement;
    }
    if (typeof changes.poolNodeId === "string") {
      const pool = next.nodes.find((candidate) => candidate.id === changes.poolNodeId);
      if (changes.poolNodeId && (pool?.facets?.process?.kind !== "pool" || pool.id === node.id)) {
        throw new Error("Choose a process pool from this view.");
      }
      const placement = { ...(facet.placement ?? {}) };
      for (const scope of node.scope === "both" ? ["current", "desired"] : [node.scope]) {
        placement[scope] = { ...(placement[scope] ?? {}) };
        if (changes.poolNodeId) placement[scope].poolNodeId = changes.poolNodeId;
        else delete placement[scope].poolNodeId;
        if (Object.keys(placement[scope]).length === 0) delete placement[scope];
      }
      if (Object.keys(placement).length > 0) facet.placement = placement;
      else delete facet.placement;
    }
  }
  if (viewKind === "organization" && facet) {
    if (typeof changes.unitNodeId === "string") {
      const unit = next.nodes.find((candidate) => candidate.id === changes.unitNodeId);
      if (changes.unitNodeId && (unit?.facets?.organization?.kind !== "unit" || unit.id === node.id)) {
        throw new Error("Choose an organisation unit from this view.");
      }
      setScopedReference(facet, "unitNodeIdByScope", node.scope, changes.unitNodeId);
    }
    if (["filled", "vacant", "unknown"].includes(changes.positionStatus)) {
      if (facet.kind !== "position") delete facet.positionStatusByScope;
      else setScopedReference(facet, "positionStatusByScope", node.scope, changes.positionStatus);
    }
    if (facet.kind !== "position") delete facet.positionStatusByScope;
  }
  if (viewKind === "architecture" && facet) {
    if (typeof changes.parentBoundaryNodeId === "string") {
      const boundary = next.nodes.find((candidate) => candidate.id === changes.parentBoundaryNodeId);
      if (changes.parentBoundaryNodeId && (boundary?.facets?.architecture?.kind !== "boundary" || boundary.id === node.id)) {
        throw new Error("Choose a system boundary from this architecture view.");
      }
      setScopedReference(facet, "parentBoundaryNodeIdByScope", node.scope, changes.parentBoundaryNodeId);
    }
    for (const field of ["vendor", "product", "technology"]) {
      setOptionalText(facet, field, changes[field]);
    }
    if (facet.kind === "boundary" && ["organization", "domain", "cloud", "account", "region", "environment", "network", "vpc", "subnet", "cluster", "namespace", "security_zone"].includes(changes.boundaryKind)) {
      facet.boundaryKind = changes.boundaryKind;
    }
    if (facet.kind !== "boundary") delete facet.boundaryKind;
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
  next.pains = next.pains.map((pain) => {
    const targetEdgeIds = pain.targetEdgeIds?.filter(
      (targetId) => targetId !== edgeId
    );
    const updated = { ...pain };
    if (targetEdgeIds?.length) updated.targetEdgeIds = targetEdgeIds;
    else delete updated.targetEdgeIds;
    return updated;
  });
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
  if (viewKind === "architecture" && typeof changes.dataDescription === "string") {
    const description = changes.dataDescription.trim();
    if (description) edge.facets.architecture.dataDescription = description;
    else delete edge.facets.architecture.dataDescription;
  }
  if (viewKind === "process" && typeof changes.condition === "string") {
    const condition = changes.condition.trim();
    if (condition) edge.facets.process.condition = condition;
    else delete edge.facets.process.condition;
  }
  if (viewKind === "process" && typeof changes.isDefault === "boolean") {
    if (changes.isDefault) edge.facets.process.isDefault = true;
    else delete edge.facets.process.isDefault;
  }
  if (
    edge.provenance !== "post_call_editorial" &&
    ["asserted", "hypothesis", "unknown", "conflicted"].includes(changes.certainty)
  ) edge.certainty = changes.certainty;
  if (edge.provenance === "post_call_editorial") edge.certainty = "hypothesis";
  edge.state = stateFor(edge.scope, edge.certainty);
  return next;
}
