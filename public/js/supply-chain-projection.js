const arrays = (value) => Array.isArray(value) ? value : [];
const idOf = (value) => String(value?.id ?? "");
const sortById = (left, right) => idOf(left).localeCompare(idOf(right));

const SUPPLY_NODE_KINDS = new Set(["actor", "team", "system", "artifact", "process"]);
const SUPPLY_EDGE_KINDS = new Set(["produces", "feeds", "hands_off_to"]);

function normalizedKind(item) {
  return String(item?.kind ?? "").toLowerCase().replace(/[\s-]+/g, "_");
}

function matchesScope(item, scope) {
  if (["current", "desired", "both"].includes(item?.scope)) {
    return item.scope === "both" || item.scope === scope;
  }
  return scope === "desired" ? item?.state === "desired" : item?.state !== "desired";
}

/**
 * Derives a deliberately small beta view from only explicit canonical facts.
 * It does not infer suppliers, logistics, inventory, locations, or lead times.
 */
export function projectSupplyChain(graph = {}, scope = "current") {
  const resolvedScope = scope === "desired" ? "desired" : "current";
  const nodesById = new Map(arrays(graph.nodes).map((node) => [idOf(node), node]));
  const edges = arrays(graph.edges)
    .filter((edge) => SUPPLY_EDGE_KINDS.has(normalizedKind(edge)))
    .filter((edge) => matchesScope(edge, resolvedScope))
    .filter((edge) => {
      const from = nodesById.get(String(edge?.from));
      const to = nodesById.get(String(edge?.to));
      return from && to && matchesScope(from, resolvedScope) && matchesScope(to, resolvedScope) &&
        SUPPLY_NODE_KINDS.has(normalizedKind(from)) && SUPPLY_NODE_KINDS.has(normalizedKind(to));
    })
    .map((edge) => ({
      id: idOf(edge),
      from: String(edge.from),
      to: String(edge.to),
      kind: normalizedKind(edge),
      label: String(edge.label ?? "").trim(),
      state: edge.state,
      scope: edge.scope,
      certainty: edge.certainty
    }))
    .sort(sortById);
  const endpointIds = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  const nodes = [...endpointIds]
    .map((id) => nodesById.get(id))
    .filter(Boolean)
    .map((node) => ({
      id: idOf(node),
      label: String(node.shortLabel ?? node.label ?? "Untitled"),
      kind: normalizedKind(node),
      state: node.state,
      scope: node.scope,
      certainty: node.certainty
    }))
    .sort(sortById);
  const topic = String(graph?.topic?.label || "Business discovery");
  return {
    viewKind: "supply-chain",
    scope: resolvedScope,
    title: `Supply chain · ${topic}`,
    description: "Explicit production, feed, and handoff connections heard in this discovery.",
    emptyMessage: resolvedScope === "desired"
      ? "No target supply-chain connections have been captured yet."
      : "No explicit supply-chain connections have been heard yet.",
    nodes,
    edges
  };
}

export function supplyChainProjectionHash(projection) {
  return JSON.stringify({
    scope: projection.scope,
    title: projection.title,
    description: projection.description,
    emptyMessage: projection.emptyMessage,
    nodes: projection.nodes.map((node) => [node.id, node.label, node.kind, node.state, node.scope, node.certainty]),
    edges: projection.edges.map((edge) => [edge.id, edge.from, edge.to, edge.kind, edge.label, edge.state, edge.scope, edge.certainty])
  });
}
