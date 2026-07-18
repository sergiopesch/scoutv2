import { z } from "zod";
import {
  graphEdgeKinds,
  graphNodeKinds,
  graphStates,
  type BusinessGraph
} from "./types.js";

const evidenceIds = z.array(z.string().min(1).max(120)).min(1).max(24);

export const BusinessGraphSchema = z
  .object({
    topic: z
      .object({
        id: z.string().min(1).max(64),
        label: z.string().min(1).max(100),
        evidenceUtteranceIds: evidenceIds
      })
      .strict(),
    nodes: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            kind: z.enum(graphNodeKinds),
            label: z.string().min(1).max(100),
            state: z.enum(graphStates),
            confidence: z.number().min(0).max(1),
            evidenceUtteranceIds: evidenceIds
          })
          .strict()
      )
      .max(10),
    edges: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            from: z.string().min(1).max(64),
            to: z.string().min(1).max(64),
            kind: z.enum(graphEdgeKinds),
            label: z.string().min(1).max(80).optional(),
            state: z.enum(graphStates),
            confidence: z.number().min(0).max(1),
            evidenceUtteranceIds: evidenceIds
          })
          .strict()
      )
      .max(20),
    pains: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            description: z.string().min(1).max(180),
            targetNodeIds: z.array(z.string().min(1).max(64)).min(1).max(5),
            severity: z.enum(["low", "medium", "high"]),
            state: z.enum(graphStates),
            evidenceUtteranceIds: evidenceIds
          })
          .strict()
      )
      .max(8),
    contradictions: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            description: z.string().min(1).max(180),
            evidenceUtteranceIds: evidenceIds
          })
          .strict()
      )
      .max(6),
    suggestedQuestion: z
      .object({
        text: z.string().min(1).max(240),
        evidenceUtteranceIds: evidenceIds
      })
      .strict()
      .optional()
  })
  .strict();

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
    if (pain.targetNodeIds.some((id) => !nodeIds.has(id))) {
      errors.push(`Pain point ${pain.id} references a missing node.`);
    }
  }

  const evidenceGroups = [
    [graph.topic.id, graph.topic.evidenceUtteranceIds] as const,
    ...graph.nodes.map((item) => [item.id, item.evidenceUtteranceIds] as const),
    ...graph.edges.map((item) => [item.id, item.evidenceUtteranceIds] as const),
    ...graph.pains.map((item) => [item.id, item.evidenceUtteranceIds] as const),
    ...graph.contradictions.map(
      (item) => [item.id, item.evidenceUtteranceIds] as const
    ),
    ...(graph.suggestedQuestion
      ? [["suggestedQuestion", graph.suggestedQuestion.evidenceUtteranceIds] as const]
      : [])
  ];

  for (const [id, evidence] of evidenceGroups) {
    if (evidence.some((utteranceId) => !validUtteranceIds.has(utteranceId))) {
      errors.push(`${id} references an unknown utterance.`);
    }
  }

  return errors;
};

/** Every business finding must be grounded in a designated customer's words. */
export const validateCustomerEvidence = (
  graph: BusinessGraph,
  customerUtteranceIds: Set<string>
): string[] => {
  const errors: string[] = [];
  const evidenceGroups = [
    [graph.topic.id, graph.topic.evidenceUtteranceIds] as const,
    ...graph.nodes.map((item) => [item.id, item.evidenceUtteranceIds] as const),
    ...graph.edges.map((item) => [item.id, item.evidenceUtteranceIds] as const),
    ...graph.pains.map((item) => [item.id, item.evidenceUtteranceIds] as const),
    ...graph.contradictions.map(
      (item) => [item.id, item.evidenceUtteranceIds] as const
    ),
    ...(graph.suggestedQuestion
      ? [["suggestedQuestion", graph.suggestedQuestion.evidenceUtteranceIds] as const]
      : [])
  ];

  for (const [id, evidence] of evidenceGroups) {
    if (evidence.some((utteranceId) => !customerUtteranceIds.has(utteranceId))) {
      errors.push(`${id} must cite designated-customer evidence only.`);
    }
  }
  return errors;
};
