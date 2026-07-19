import { z } from "zod";
import {
  architectureEdgeKinds,
  architectureNodeKinds,
  graphCertainties,
  graphEdgeKinds,
  graphNodeKinds,
  graphScopes,
  graphStates,
  organizationEdgeKinds,
  organizationNodeKinds,
  processEdgeKinds,
  processNodeKinds,
  processTaskTypes,
  type BusinessGraph
} from "./types.js";

const id = z.string().min(1).max(64);
const evidenceIds = z.array(z.string().min(1).max(120)).max(12);
const requiredEvidenceIds = evidenceIds.min(1);
const topicEvidenceIds = z.array(z.string().min(1).max(120)).max(12);

const processPlacement = z
  .object({
    ownerNodeId: id.optional(),
    laneNodeId: id.optional(),
    poolNodeId: id.optional()
  })
  .strict();

const processNodeFacet = z
  .object({
    kind: z.enum(processNodeKinds),
    placement: z
      .object({
        current: processPlacement.optional(),
        desired: processPlacement.optional()
      })
      .strict()
      .optional(),
    taskType: z.enum(processTaskTypes).optional()
  })
  .strict();

const organizationNodeFacet = z
  .object({
    kind: z.enum(organizationNodeKinds),
    unitNodeIdByScope: z
      .object({
        current: id.optional(),
        desired: id.optional()
      })
      .strict()
      .optional(),
    positionStatusByScope: z
      .object({
        current: z.enum(["filled", "vacant", "unknown"]).optional(),
        desired: z.enum(["filled", "vacant", "unknown"]).optional()
      })
      .strict()
      .optional()
  })
  .strict();

const architectureNodeFacet = z
  .object({
    kind: z.enum(architectureNodeKinds),
    parentBoundaryNodeIdByScope: z
      .object({
        current: id.optional(),
        desired: id.optional()
      })
      .strict()
      .optional(),
    boundaryKind: z
      .enum([
        "organization",
        "domain",
        "cloud",
        "account",
        "region",
        "environment",
        "network",
        "vpc",
        "subnet",
        "cluster",
        "namespace",
        "security_zone"
      ])
      .optional(),
    vendor: z.string().min(1).max(48).optional(),
    product: z.string().min(1).max(64).optional(),
    technology: z.string().min(1).max(64).optional()
  })
  .strict();

const nodeFacets = z
  .object({
    process: processNodeFacet.optional(),
    organization: organizationNodeFacet.optional(),
    architecture: architectureNodeFacet.optional()
  })
  .strict()
  .refine((facets) => Object.values(facets).some(Boolean), {
    message: "At least one node facet is required."
  });

const processEdgeFacet = z
  .object({
    kind: z.enum(processEdgeKinds),
    condition: z.string().min(1).max(80).optional(),
    isDefault: z.boolean().optional()
  })
  .strict();

const organizationEdgeFacet = z
  .object({
    kind: z.enum(organizationEdgeKinds),
    relationship: z.string().min(1).max(64).optional()
  })
  .strict();

const architectureEdgeFacet = z
  .object({
    kind: z.enum(architectureEdgeKinds),
    interaction: z
      .enum(["synchronous", "asynchronous", "batch", "stream", "unknown"])
      .optional(),
    protocol: z.string().min(1).max(48).optional(),
    dataDescription: z.string().min(1).max(100).optional()
  })
  .strict();

const edgeFacets = z
  .object({
    process: processEdgeFacet.optional(),
    organization: organizationEdgeFacet.optional(),
    architecture: architectureEdgeFacet.optional()
  })
  .strict()
  .refine((facets) => Object.values(facets).some(Boolean), {
    message: "At least one edge facet is required."
  });

export const BusinessGraphSchema = z
  .object({
    topic: z
      .object({
        id,
        label: z.string().min(1).max(100),
        evidenceUtteranceIds: topicEvidenceIds
      })
      .strict(),
    nodes: z
      .array(
        z
          .object({
            id,
            kind: z.enum(graphNodeKinds),
            label: z.string().min(1).max(100),
            shortLabel: z.string().min(1).max(48).optional(),
            aliases: z.array(z.string().min(1).max(100)).max(8).optional(),
            state: z.enum(graphStates),
            scope: z.enum(graphScopes).optional(),
            certainty: z.enum(graphCertainties).optional(),
            confidence: z.number().min(0).max(1),
            provenance: z.enum(["meeting", "post_call_editorial"]).optional(),
            facets: nodeFacets.optional(),
            evidenceUtteranceIds: evidenceIds
          })
          .strict()
          .superRefine((node, context) => {
            if (node.evidenceUtteranceIds.length === 0 && node.provenance !== "post_call_editorial") {
              context.addIssue({ code: "custom", message: "Meeting-derived nodes require utterance evidence." });
            }
            if (node.provenance === "post_call_editorial" && (node.evidenceUtteranceIds.length > 0 || node.certainty !== "hypothesis")) {
              context.addIssue({ code: "custom", message: "Post-call editorial nodes must be evidence-free hypotheses." });
            }
          })
      )
      .max(32),
    edges: z
      .array(
        z
          .object({
            id,
            from: id,
            to: id,
            kind: z.enum(graphEdgeKinds),
            label: z.string().min(1).max(80).optional(),
            state: z.enum(graphStates),
            scope: z.enum(graphScopes).optional(),
            certainty: z.enum(graphCertainties).optional(),
            confidence: z.number().min(0).max(1),
            provenance: z.enum(["meeting", "post_call_editorial"]).optional(),
            facets: edgeFacets.optional(),
            evidenceUtteranceIds: evidenceIds
          })
          .strict()
          .superRefine((edge, context) => {
            if (edge.evidenceUtteranceIds.length === 0 && edge.provenance !== "post_call_editorial") {
              context.addIssue({ code: "custom", message: "Meeting-derived edges require utterance evidence." });
            }
            if (edge.provenance === "post_call_editorial" && (edge.evidenceUtteranceIds.length > 0 || edge.certainty !== "hypothesis")) {
              context.addIssue({ code: "custom", message: "Post-call editorial edges must be evidence-free hypotheses." });
            }
          })
      )
      .max(64),
    pains: z
      .array(
        z
          .object({
            id,
            description: z.string().min(1).max(180),
            targetNodeIds: z.array(id).min(1).max(8),
            severity: z.enum(["low", "medium", "high"]),
            state: z.enum(graphStates),
            scope: z.enum(graphScopes).optional(),
            certainty: z.enum(graphCertainties).optional(),
            evidenceUtteranceIds: requiredEvidenceIds
          })
          .strict()
      )
      .max(12),
    contradictions: z
      .array(
        z
          .object({
            id,
            description: z.string().min(1).max(180),
            evidenceUtteranceIds: requiredEvidenceIds
          })
          .strict()
      )
      .max(10),
    suggestedQuestion: z
      .object({
        text: z.string().min(1).max(240),
        evidenceUtteranceIds: requiredEvidenceIds
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((graph, context) => {
    const isBootstrap =
      graph.topic.id === "discovery" &&
      graph.topic.label === "Business discovery" &&
      graph.topic.evidenceUtteranceIds.length === 0 &&
      graph.nodes.length === 0 &&
      graph.edges.length === 0 &&
      graph.pains.length === 0 &&
      graph.contradictions.length === 0 &&
      graph.suggestedQuestion === undefined;

    if (!isBootstrap && graph.topic.evidenceUtteranceIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["topic", "evidenceUtteranceIds"],
        message: "Only the empty bootstrap graph may omit topic evidence."
      });
    }

    const unique = (values: string[] | undefined): boolean =>
      values === undefined || new Set(values).size === values.length;
    graph.nodes.forEach((node, index) => {
      if (!unique(node.aliases)) {
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "aliases"],
          message: "Aliases must be unique."
        });
      }
    });
    graph.pains.forEach((pain, index) => {
      if (!unique(pain.targetNodeIds)) {
        context.addIssue({
          code: "custom",
          path: ["pains", index, "targetNodeIds"],
          message: "Pain point targets must be unique."
        });
      }
    });
    const evidenceGroups = [
      ["topic", graph.topic.evidenceUtteranceIds] as const,
      ...graph.nodes.map((item) => [item.id, item.evidenceUtteranceIds] as const),
      ...graph.edges.map((item) => [item.id, item.evidenceUtteranceIds] as const),
      ...graph.pains.map((item) => [item.id, item.evidenceUtteranceIds] as const),
      ...graph.contradictions.map((item) => [item.id, item.evidenceUtteranceIds] as const),
      ...(graph.suggestedQuestion
        ? [["suggestedQuestion", graph.suggestedQuestion.evidenceUtteranceIds] as const]
        : [])
    ];
    for (const [entity, evidence] of evidenceGroups) {
      if (!unique(evidence)) {
        context.addIssue({
          code: "custom",
          message: `${entity} evidence IDs must be unique.`
        });
      }
    }
  });

/** Model turns can never emit the evidence-free server bootstrap state. */
export const BusinessGraphModelOutputSchema = BusinessGraphSchema.safeExtend({
  topic: z
    .object({
      id,
      label: z.string().min(1).max(100),
      evidenceUtteranceIds: requiredEvidenceIds
    })
    .strict(),
  nodes: z.array(
    BusinessGraphSchema.shape.nodes.element.safeExtend({
      scope: z.enum(graphScopes),
      certainty: z.enum(graphCertainties)
    })
  ).max(32),
  edges: z.array(
    BusinessGraphSchema.shape.edges.element.safeExtend({
      scope: z.enum(graphScopes),
      certainty: z.enum(graphCertainties)
    })
  ).max(64),
  pains: z.array(
    BusinessGraphSchema.shape.pains.element.safeExtend({
      scope: z.enum(graphScopes),
      certainty: z.enum(graphCertainties)
    })
  ).max(12)
});

const hasDirectedCycle = (links: Array<readonly [string, string]>): boolean => {
  const adjacency = new Map<string, string[]>();
  for (const [from, to] of links) {
    adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return [...adjacency.keys()].some(visit);
};

/** Cross-entity invariants that JSON Schema cannot express. */
export const validateGraphSemantics = (graph: BusinessGraph): string[] => {
  const errors: string[] = [];
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const scopesOf = (item: { scope?: "current" | "desired" | "both"; state: string }):
    Array<"current" | "desired"> =>
    item.scope === "both"
      ? ["current", "desired"]
      : [item.scope ?? (item.state === "desired" ? "desired" : "current")];
  const scopedValue = <T>(
    values: { current?: T; desired?: T } | undefined,
    scope: "current" | "desired",
    itemScope?: "current" | "desired" | "both"
  ): T | undefined =>
    values?.[scope] ?? (scope === "desired" && itemScope === "both" ? values?.current : undefined);
  const appliesInScope = (
    item: { scope?: "current" | "desired" | "both"; state: string } | undefined,
    scope: "current" | "desired"
  ): boolean => Boolean(item && scopesOf(item).includes(scope));
  const validateLegacyState = (
    item: { id: string; state: string; scope?: "current" | "desired" | "both"; certainty?: string }
  ): void => {
    if (!item.scope || !item.certainty) return;
    const expected =
      item.certainty === "hypothesis"
        ? "hypothesis"
        : item.certainty === "unknown" || item.certainty === "conflicted"
          ? "unknown"
          : item.scope === "desired"
            ? "desired"
            : "current";
    if (item.state !== expected) {
      errors.push(`${item.id} legacy state must be ${expected} for its scope and certainty.`);
    }
  };
  const validateScopedKeys = (
    entityId: string,
    values: { current?: unknown; desired?: unknown } | undefined,
    item: { scope?: "current" | "desired" | "both"; state: string },
    field: string
  ): void => {
    if (!values) return;
    for (const scope of ["current", "desired"] as const) {
      if (values[scope] !== undefined && !appliesInScope(item, scope)) {
        errors.push(`${entityId} ${field}.${scope} is outside the entity scope.`);
      }
    }
  };
  const reportingByScope = {
    current: [] as Array<readonly [string, string]>,
    desired: [] as Array<readonly [string, string]>
  };
  const containmentByScope = {
    current: [] as Array<readonly [string, string]>,
    desired: [] as Array<readonly [string, string]>
  };
  const unitsByScope = {
    current: [] as Array<readonly [string, string]>,
    desired: [] as Array<readonly [string, string]>
  };

  for (const node of graph.nodes) {
    validateLegacyState(node);
    const process = node.facets?.process;
    validateScopedKeys(node.id, process?.placement, node, "process placement");
    for (const scope of scopesOf(node)) {
      const placement = scopedValue(process?.placement, scope, node.scope);
      const owner = placement?.ownerNodeId;
      if (owner) {
        const ownerNode = nodesById.get(owner);
        if (!ownerNode) {
          errors.push(`Node ${node.id} references a missing process owner in ${scope} scope.`);
        } else if (
          owner === node.id ||
          !["actor", "team", "system"].includes(ownerNode.kind) ||
          !appliesInScope(ownerNode, scope)
        ) {
          errors.push(`Node ${node.id} process owner must be a different actor, team, or system.`);
        }
      }
      const lane = placement?.laneNodeId;
      if (
        lane &&
        (nodesById.get(lane)?.facets?.process?.kind !== "lane" ||
          !appliesInScope(nodesById.get(lane), scope))
      ) {
        errors.push(`Node ${node.id} process lane must reference a lane node.`);
      }
      const pool = placement?.poolNodeId;
      if (
        pool &&
        (nodesById.get(pool)?.facets?.process?.kind !== "pool" ||
          !appliesInScope(nodesById.get(pool), scope))
      ) {
        errors.push(`Node ${node.id} process pool must reference a pool node.`);
      }
      if (lane && pool) {
        const laneNode = nodesById.get(lane);
        const lanePool = scopedValue(
          laneNode?.facets?.process?.placement,
          scope,
          laneNode?.scope
        )?.poolNodeId;
        if (lanePool && lanePool !== pool) {
          errors.push(`Node ${node.id} process lane and pool references conflict in ${scope} scope.`);
        }
      }
      if (process?.kind === "lane" && !placement?.poolNodeId) {
        errors.push(`Process lane ${node.id} must reference its pool in ${scope} scope.`);
      }
      if (process?.kind === "pool" && (placement?.poolNodeId || placement?.laneNodeId)) {
        errors.push(`Process pool ${node.id} cannot belong to another pool or lane.`);
      }
    }

    const organization = node.facets?.organization;
    validateScopedKeys(
      node.id,
      organization?.unitNodeIdByScope,
      node,
      "organization unit"
    );
    for (const scope of scopesOf(node)) {
      const unit = scopedValue(organization?.unitNodeIdByScope, scope, node.scope);
      if (unit) {
        if (
          nodesById.get(unit)?.facets?.organization?.kind !== "unit" ||
          unit === node.id ||
          !appliesInScope(nodesById.get(unit), scope)
        ) {
          errors.push(`Node ${node.id} organization unit must reference a different unit node in ${scope} scope.`);
        } else if (organization?.kind === "unit") {
          unitsByScope[scope].push([node.id, unit]);
        }
      }
    }
    if (organization?.positionStatusByScope && organization.kind !== "position") {
      errors.push(`Node ${node.id} positionStatusByScope is valid only for positions.`);
    }
    validateScopedKeys(
      node.id,
      organization?.positionStatusByScope,
      node,
      "position status"
    );

    const architecture = node.facets?.architecture;
    validateScopedKeys(
      node.id,
      architecture?.parentBoundaryNodeIdByScope,
      node,
      "architecture parent"
    );
    for (const scope of scopesOf(node)) {
      const parent = scopedValue(
        architecture?.parentBoundaryNodeIdByScope,
        scope,
        node.scope
      );
      if (parent) {
        const parentNode = nodesById.get(parent);
        if (!parentNode) {
          errors.push(`Node ${node.id} references a missing architecture boundary in ${scope} scope.`);
        } else if (
          parentNode.facets?.architecture?.kind !== "boundary" ||
          !appliesInScope(parentNode, scope)
        ) {
          errors.push(`Node ${node.id} architecture parent ${parent} is not a boundary.`);
        } else if (parent === node.id) {
          errors.push(`Architecture node ${node.id} cannot contain itself.`);
        } else {
          containmentByScope[scope].push([parent, node.id]);
        }
      }
    }
    if (architecture?.boundaryKind && architecture.kind !== "boundary") {
      errors.push(`Node ${node.id} boundaryKind is valid only for boundaries.`);
    }
  }

  const semanticEdges = new Set<string>();
  const managerBySubordinateAndScope = new Map<string, string>();
  const defaultByGatewayAndScope = new Set<string>();
  const poolOf = (nodeId: string, scope: "current" | "desired"): string | undefined => {
    const node = nodesById.get(nodeId);
    const process = node?.facets?.process;
    if (!process) return undefined;
    if (process.kind === "pool") return nodeId;
    const placement = scopedValue(process.placement, scope, node?.scope);
    if (placement?.laneNodeId) {
      const lane = nodesById.get(placement.laneNodeId);
      return scopedValue(lane?.facets?.process?.placement, scope, lane?.scope)?.poolNodeId;
    }
    return placement?.poolNodeId;
  };

  for (const edge of graph.edges) {
    validateLegacyState(edge);
    for (const scope of scopesOf(edge)) {
      if (
        !appliesInScope(nodesById.get(edge.from), scope) ||
        !appliesInScope(nodesById.get(edge.to), scope)
      ) {
        errors.push(`Edge ${edge.id} endpoints must exist in ${scope} scope.`);
      }
    }
    if (edge.from === edge.to) {
      errors.push(`Edge ${edge.id} cannot connect a node to itself.`);
    }
    const semanticKey = JSON.stringify([
      edge.from,
      edge.to,
      edge.kind,
      edge.scope ?? edge.state,
      edge.facets
    ]);
    if (semanticEdges.has(semanticKey)) {
      errors.push(`Edge ${edge.id} duplicates an existing semantic edge.`);
    }
    semanticEdges.add(semanticKey);

    const organization = edge.facets?.organization;
    if (organization) {
      const fromOrganization = nodesById.get(edge.from)?.facets?.organization;
      const toOrganization = nodesById.get(edge.to)?.facets?.organization;
      if (!fromOrganization || !toOrganization) {
        errors.push(`Organization edge ${edge.id} must connect organization nodes.`);
      }
      if (
        (fromOrganization?.kind === "unit" ||
          toOrganization?.kind === "unit" ||
          fromOrganization?.kind !== toOrganization?.kind)
      ) {
        errors.push(`Reporting edge ${edge.id} must connect matching person or position nodes.`);
      }
      if (organization.kind === "primary_report") {
        for (const scope of scopesOf(edge)) {
          const managerKey = `${edge.from}\u0000${scope}`;
          const existingManager = managerBySubordinateAndScope.get(managerKey);
          if (existingManager && existingManager !== edge.to) {
            errors.push(`Organization node ${edge.from} has multiple primary managers in ${scope} scope.`);
          }
          managerBySubordinateAndScope.set(managerKey, edge.to);
          reportingByScope[scope].push([edge.from, edge.to]);
        }
      }
    }

    const process = edge.facets?.process;
    if (process) {
      const fromProcess = nodesById.get(edge.from)?.facets?.process;
      const toProcess = nodesById.get(edge.to)?.facets?.process;
      if (!fromProcess || !toProcess) {
        errors.push(`Process edge ${edge.id} must connect process nodes.`);
      }
      if (
        (process.condition !== undefined || process.isDefault === true) &&
        process.kind !== "sequence"
      ) {
        errors.push(`Process edge ${edge.id} conditions and defaults are valid only on sequence edges.`);
      }
      if (fromProcess?.kind === "end") {
        errors.push(`Process end node ${edge.from} cannot have an outgoing edge.`);
      }
      if (toProcess?.kind === "start") {
        errors.push(`Process start node ${edge.to} cannot have an incoming edge.`);
      }
      if (
        (process.condition !== undefined || process.isDefault === true) &&
        ![
          "exclusive_gateway",
          "inclusive_gateway",
          "event_gateway"
        ].includes(fromProcess?.kind ?? "")
      ) {
        errors.push(`Conditional/default edge ${edge.id} must originate at a branching gateway.`);
      }
      if (
        process.kind !== "association" &&
        [fromProcess?.kind, toProcess?.kind].some((kind) =>
          ["document", "data_store"].includes(kind ?? "")
        )
      ) {
        errors.push(`Process data nodes may connect only through association edges (${edge.id}).`);
      }
      for (const scope of scopesOf(edge)) {
        const fromPool = poolOf(edge.from, scope);
        const toPool = poolOf(edge.to, scope);
        if (process.kind === "sequence" && Boolean(fromPool) !== Boolean(toPool)) {
          errors.push(`Sequence edge ${edge.id} has incomplete process pool membership in ${scope} scope.`);
        } else if (process.kind === "sequence" && fromPool && fromPool !== toPool) {
          errors.push(`Sequence edge ${edge.id} cannot cross process pools in ${scope} scope.`);
        }
        if (process.kind === "message" && (!fromPool || !toPool || fromPool === toPool)) {
          errors.push(`Message edge ${edge.id} must cross process pools in ${scope} scope.`);
        }
      }
      if (process.isDefault) {
        for (const scope of scopesOf(edge)) {
          const key = `${edge.from}\u0000${scope}`;
          if (defaultByGatewayAndScope.has(key)) {
            errors.push(`Process node ${edge.from} has multiple default sequence edges in ${scope} scope.`);
          }
          defaultByGatewayAndScope.add(key);
        }
      }
    }

    if (edge.facets?.architecture) {
      if (!nodesById.get(edge.from)?.facets?.architecture || !nodesById.get(edge.to)?.facets?.architecture) {
        errors.push(`Architecture edge ${edge.id} must connect architecture nodes.`);
      }
    }
  }

  for (const pain of graph.pains) {
    validateLegacyState(pain);
    for (const scope of scopesOf(pain)) {
      for (const targetNodeId of pain.targetNodeIds) {
        if (!appliesInScope(nodesById.get(targetNodeId), scope)) {
          errors.push(`Pain point ${pain.id} target ${targetNodeId} must exist in ${scope} scope.`);
        }
      }
    }
  }

  for (const scope of ["current", "desired"] as const) {
    if (hasDirectedCycle(reportingByScope[scope])) {
      errors.push(`Primary organization reporting relationships must be acyclic in ${scope} scope.`);
    }
    if (hasDirectedCycle(containmentByScope[scope])) {
      errors.push(`Architecture containment must be acyclic in ${scope} scope.`);
    }
    if (hasDirectedCycle(unitsByScope[scope])) {
      errors.push(`Organization unit membership must be acyclic in ${scope} scope.`);
    }
  }
  return errors;
};

export const validateGraphReferences = (
  graph: BusinessGraph,
  validUtteranceIds: Set<string>
): string[] => {
  const errors: string[] = [];
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const entityIds = [
    ...graph.nodes.map((node) => node.id),
    ...graph.edges.map((edge) => edge.id),
    ...graph.pains.map((pain) => pain.id),
    ...graph.contradictions.map((contradiction) => contradiction.id)
  ];

  if (new Set(entityIds).size !== entityIds.length) {
    errors.push("Graph entity IDs must be unique.");
  }

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      errors.push(`Edge ${edge.id} references a missing node.`);
    }
  }

  for (const pain of graph.pains) {
    if (pain.targetNodeIds.some((targetId) => !nodeIds.has(targetId))) {
      errors.push(`Pain point ${pain.id} references a missing node.`);
    }
  }

  const evidenceGroups = [
    [graph.topic.id, graph.topic.evidenceUtteranceIds] as const,
    ...graph.nodes.map((item) => [item.id, item.evidenceUtteranceIds] as const),
    ...graph.edges.map((item) => [item.id, item.evidenceUtteranceIds] as const),
    ...graph.pains.map((item) => [item.id, item.evidenceUtteranceIds] as const),
    ...graph.contradictions.map((item) => [item.id, item.evidenceUtteranceIds] as const),
    ...(graph.suggestedQuestion
      ? [["suggestedQuestion", graph.suggestedQuestion.evidenceUtteranceIds] as const]
      : [])
  ];

  for (const [entityId, evidence] of evidenceGroups) {
    if (evidence.some((utteranceId) => !validUtteranceIds.has(utteranceId))) {
      errors.push(`${entityId} references an unknown utterance.`);
    }
  }

  return [...errors, ...validateGraphSemantics(graph)];
};

/** Every business finding must be grounded in a designated customer's words. */
export const validateCustomerEvidence = (
  graph: BusinessGraph,
  customerUtteranceIds: Set<string>,
  options: { allowPostCallEditorial?: boolean } = {}
): string[] => {
  const errors: string[] = [];
  const editorialIds = new Set(
    [...graph.nodes, ...graph.edges]
      .filter((item) => item.provenance === "post_call_editorial")
      .map((item) => item.id)
  );
  if (!options.allowPostCallEditorial) {
    for (const entityId of editorialIds) {
      errors.push(`${entityId} cannot use post-call editorial provenance during live analysis.`);
    }
  }
  const evidenceGroups = [
    [graph.topic.id, graph.topic.evidenceUtteranceIds] as const,
    ...graph.nodes.map((item) => [item.id, item.evidenceUtteranceIds] as const),
    ...graph.edges.map((item) => [item.id, item.evidenceUtteranceIds] as const),
    ...graph.pains.map((item) => [item.id, item.evidenceUtteranceIds] as const),
    ...graph.contradictions.map((item) => [item.id, item.evidenceUtteranceIds] as const),
    ...(graph.suggestedQuestion
      ? [["suggestedQuestion", graph.suggestedQuestion.evidenceUtteranceIds] as const]
      : [])
  ];

  for (const [entityId, evidence] of evidenceGroups) {
    if (options.allowPostCallEditorial && editorialIds.has(entityId)) continue;
    if (evidence.some((utteranceId) => !customerUtteranceIds.has(utteranceId))) {
      errors.push(`${entityId} must cite designated-customer evidence only.`);
    }
  }
  return errors;
};
