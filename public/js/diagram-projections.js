import { DIAGRAM_VIEW_KINDS } from "./view-render-coordinator.js";

export const VIEW_DEFINITIONS = Object.freeze({
  process: {
    label: "Process",
    shortLabel: "Flow",
    description: "Activities, decisions, responsibility and handoffs",
    emptyMessage: "No explicit business process has been heard yet."
  },
  organization: {
    label: "Organisation",
    shortLabel: "Org",
    description: "People, positions, units and evidenced reporting structure",
    emptyMessage: "No explicit reporting structure has been heard yet."
  },
  architecture: {
    label: "Architecture",
    shortLabel: "Systems",
    description: "Systems, boundaries, data stores and technical connections",
    emptyMessage: "No explicit system architecture has been heard yet."
  }
});

const TARGET_EMPTY_MESSAGES = Object.freeze({
  process: "No target process has been captured yet.",
  organization: "No target organisation has been captured yet.",
  architecture: "No target architecture has been captured yet."
});

const LEGACY_NODE_VIEWS = Object.freeze({
  actor: ["organization"],
  team: ["organization"],
  system: ["architecture"],
  process: ["process"],
  artifact: ["process", "architecture"],
  decision: ["process"],
  goal: ["process"],
  unknown: []
});

const LEGACY_EDGE_VIEWS = Object.freeze({
  hands_off_to: ["process"],
  uses: ["architecture"],
  feeds: ["architecture"],
  produces: ["process", "architecture"],
  approves: ["process"],
  owns: ["organization"],
  blocks: ["process"],
  depends_on: ["architecture"]
});

const arrays = (value) => Array.isArray(value) ? value : [];
const idOf = (value) => String(value?.id ?? "");
const sortById = (left, right) => idOf(left).localeCompare(idOf(right));

const facetFor = (item, viewKind) => item?.facets?.[viewKind];

function itemViews(item, legacyMap) {
  if (item?.facets) return DIAGRAM_VIEW_KINDS.filter((kind) => facetFor(item, kind));
  return legacyMap[item?.kind] ?? [];
}

function stateMatchesScope(item, scope) {
  if (!scope || scope === "all") return true;
  if (["current", "desired", "both"].includes(item?.scope)) {
    return item.scope === "both" || item.scope === scope;
  }
  const state = String(item?.state ?? "unknown");
  if (scope === "desired") return state === "desired";
  return state !== "desired";
}

function legacySemanticType(item) {
  const type = String(item?.kind ?? "unknown").toLowerCase().replace(/[\s-]+/g, "_");
  if (type === "decision") return "exclusive_gateway";
  if (type === "process") return "activity";
  if (type === "team") return "unit";
  if (type === "system") return "software_system";
  return type;
}

function scopedValue(values, scope, entityScope) {
  if (!values) return undefined;
  if (scope === "desired") return values.desired ?? (entityScope === "both" ? values.current : undefined);
  return values.current;
}

function nodeForView(node, viewKind, scope) {
  const facet = facetFor(node, viewKind);
  const normalized = {
    ...node,
    id: idOf(node),
    semanticType: facet?.kind ?? legacySemanticType(node)
  };
  if (viewKind === "process") {
    const placement = scopedValue(facet?.placement, scope, node.scope);
    return {
      ...normalized,
      laneId: placement?.laneNodeId,
      ownerNodeId: placement?.ownerNodeId,
      poolId: placement?.poolNodeId,
      taskType: facet?.taskType
    };
  }
  if (viewKind === "organization") {
    return {
      ...normalized,
      unitNodeId: scopedValue(facet?.unitNodeIdByScope, scope, node.scope),
      positionStatus: scopedValue(facet?.positionStatusByScope, scope, node.scope)
    };
  }
  return {
    ...normalized,
    parentBoundaryNodeId: scopedValue(facet?.parentBoundaryNodeIdByScope, scope, node.scope),
    boundaryKind: facet?.boundaryKind,
    vendor: facet?.vendor,
    product: facet?.product,
    technology: facet?.technology
  };
}

function edgeForView(edge, viewKind) {
  const facet = facetFor(edge, viewKind);
  return {
    ...edge,
    id: idOf(edge),
    from: String(edge?.from ?? ""),
    to: String(edge?.to ?? ""),
    semanticType: facet?.kind ?? legacySemanticType(edge),
    condition: facet?.condition,
    isDefault: facet?.isDefault,
    relationshipType: facet?.relationship,
    interaction: facet?.interaction,
    protocol: facet?.protocol,
    dataDescription: facet?.dataDescription
  };
}

function processGroups(processNodes, scope) {
  const byId = new Map(processNodes.map((node) => [idOf(node), node]));
  return processNodes
    .filter((node) => node.facets?.process?.kind === "lane")
    .map((node) => {
      const placement = scopedValue(node.facets?.process?.placement, scope, node.scope);
      const poolId = placement?.poolNodeId;
      const pool = poolId ? byId.get(poolId) : undefined;
      return {
        ...nodeForView(node, "process", scope),
        id: idOf(node),
        label: pool ? `${pool.shortLabel ?? pool.label} · ${node.shortLabel ?? node.label}` : node.shortLabel ?? node.label,
        semanticType: "lane",
        poolId
      };
    })
    .sort(sortById);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
  );
}

export function projectBusinessGraph(graph = {}, viewKind = "process", scope = "current") {
  if (!DIAGRAM_VIEW_KINDS.includes(viewKind)) {
    throw new Error(`Unknown diagram view: ${viewKind}`);
  }
  const allNodes = arrays(graph.nodes);
  const selectedNodes = allNodes
    .filter((node) => itemViews(node, LEGACY_NODE_VIEWS).includes(viewKind))
    .filter((node) => stateMatchesScope(node, scope));
  const boundaryNodes = viewKind === "architecture"
    ? selectedNodes.filter((node) => node.facets?.architecture?.kind === "boundary")
    : [];
  const boundaryIds = new Set(boundaryNodes.map(idOf));
  const processContainerIds = new Set(viewKind === "process"
    ? selectedNodes
      .filter((node) => ["pool", "lane"].includes(node.facets?.process?.kind))
      .map(idOf)
    : []);
  const nodes = selectedNodes
    .filter((node) => !boundaryIds.has(idOf(node)))
    .filter((node) => !processContainerIds.has(idOf(node)))
    .map((node) => nodeForView(node, viewKind, scope))
    .sort(sortById);
  const groups = viewKind === "process"
    ? processGroups(selectedNodes, scope)
    : boundaryNodes.map((node) => ({
        ...nodeForView(node, "architecture", scope),
        id: idOf(node),
        semanticType: "boundary",
        parentId: scopedValue(
          node.facets?.architecture?.parentBoundaryNodeIdByScope,
          scope,
          node.scope
        )
      })).sort(sortById);

  const visibleIds = new Set([...nodes, ...groups].map(idOf));
  const edges = arrays(graph.edges)
    .filter((edge) => itemViews(edge, LEGACY_EDGE_VIEWS).includes(viewKind))
    .filter((edge) => stateMatchesScope(edge, scope))
    .filter((edge) => visibleIds.has(String(edge?.from)) && visibleIds.has(String(edge?.to)))
    .filter((edge) => !(viewKind === "architecture" && edge.facets?.architecture?.kind === "containment"))
    .map((edge) => edgeForView(edge, viewKind))
    .sort(sortById);

  if (viewKind === "organization") {
    const relationshipKeys = new Set(edges.map((edge) => `${edge.semanticType}:${edge.from}:${edge.to}`));
    for (const node of nodes) {
      if (!node.unitNodeId || !visibleIds.has(String(node.unitNodeId))) continue;
      const key = `membership:${node.id}:${node.unitNodeId}`;
      if (relationshipKeys.has(key)) continue;
      edges.push({
        id: `derived-membership:${node.id}:${node.unitNodeId}`,
        from: node.id,
        to: String(node.unitNodeId),
        kind: "owns",
        semanticType: "membership",
        state: node.state,
        scope: node.scope,
        certainty: node.certainty,
        confidence: node.confidence,
        derivedFromUnitNodeId: true
      });
      relationshipKeys.add(key);
    }
    edges.sort(sortById);
  }

  const nodeIds = new Set(nodes.map(idOf));
  const pains = arrays(graph.pains)
    .filter((pain) => stateMatchesScope(pain, scope))
    .map((pain) => ({
      ...pain,
      targetNodeIds: arrays(pain.targetNodeIds).map(String).filter((id) => nodeIds.has(id))
    }))
    .filter((pain) => pain.targetNodeIds.length > 0)
    .sort(sortById);
  const contradictions = arrays(graph.contradictions).slice().sort(sortById);
  const definition = VIEW_DEFINITIONS[viewKind];
  return {
    viewKind,
    scope: scope === "desired" ? "desired" : "current",
    title: `${definition.label} · ${String(graph?.topic?.label || "Business discovery")}`,
    description: definition.description,
    emptyMessage: scope === "desired"
      ? TARGET_EMPTY_MESSAGES[viewKind]
      : definition.emptyMessage,
    nodes,
    edges,
    groups,
    pains,
    contradictions
  };
}

export function semanticProjectionHash(projection) {
  const canonical = JSON.stringify(stableValue(projection));
  let hash = 2166136261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function projectionSummary(projection) {
  const nodeCount = arrays(projection?.nodes).length;
  const edgeCount = arrays(projection?.edges).length;
  if (nodeCount === 0) return projection?.emptyMessage ?? "Nothing mapped in this view yet.";
  const nouns = {
    process: ["step", "connection"],
    organization: ["position or team", "relationship"],
    architecture: ["system or component", "connection"]
  }[projection?.viewKind] ?? ["element", "relationship"];
  const plural = (count, singular) => `${count} ${singular}${count === 1 ? "" : "s"}`;
  return `${plural(nodeCount, nouns[0])} and ${plural(edgeCount, nouns[1])} in the ${projection.scope} view.`;
}

export function projectionEntityDetail(projection, entityId) {
  const node = arrays(projection?.nodes).find((item) => idOf(item) === String(entityId));
  if (!node) return undefined;
  return {
    node,
    incoming: arrays(projection?.edges).filter((edge) => String(edge.to) === String(entityId)),
    outgoing: arrays(projection?.edges).filter((edge) => String(edge.from) === String(entityId)),
    pains: arrays(projection?.pains).filter((pain) => arrays(pain.targetNodeIds).map(String).includes(String(entityId)))
  };
}
