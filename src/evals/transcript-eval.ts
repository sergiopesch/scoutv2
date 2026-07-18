import { z } from "zod";
import type { AnalyzeMeetingInput } from "../server/contracts.js";
import {
  BusinessGraphSchema,
  validateCustomerEvidence,
  validateGraphReferences
} from "../shared/schemas.js";
import {
  emptyBusinessGraph,
  graphEdgeKinds,
  graphNodeKinds,
  type BusinessGraph
} from "../shared/types.js";

const conceptSchema = z
  .object({
    name: z.string().min(1),
    anyOf: z.array(z.string().min(1)).min(1)
  })
  .strict();

const nodeConceptSchema = conceptSchema
  .extend({
    kinds: z.array(z.enum(graphNodeKinds)).min(1).optional()
  })
  .strict();

const edgeConceptSchema = z
  .object({
    name: z.string().min(1),
    fromAnyOf: z.array(z.string().min(1)).min(1),
    toAnyOf: z.array(z.string().min(1)).min(1),
    kinds: z.array(z.enum(graphEdgeKinds)).min(1).optional()
  })
  .strict();

const painConceptSchema = conceptSchema
  .extend({
    severities: z.array(z.enum(["low", "medium", "high"])).min(1).optional()
  })
  .strict();

export const TranscriptEvalFixtureSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    description: z.string().min(1).optional(),
    participants: z
      .array(
        z
          .object({
            id: z.string().min(1),
            name: z.string().min(1),
            role: z.enum(["operator", "customer"])
          })
          .strict()
      )
      .min(2),
    utterances: z
      .array(
        z
          .object({
            id: z.string().min(1),
            participantId: z.string().min(1),
            text: z.string().min(1)
          })
          .strict()
      )
      .min(1),
    expectations: z
      .object({
        minNodes: z.number().int().nonnegative().optional(),
        minEdges: z.number().int().nonnegative().optional(),
        minPains: z.number().int().nonnegative().optional(),
        topicIncludes: z.array(z.string().min(1)).min(1).optional(),
        requiredNodeConcepts: z.array(nodeConceptSchema).optional(),
        requiredEdgeConcepts: z.array(edgeConceptSchema).optional(),
        requiredPainConcepts: z.array(painConceptSchema).optional(),
        forbiddenConcepts: z.array(conceptSchema).optional(),
        requireSuggestedQuestion: z.boolean().optional()
      })
      .strict()
  })
  .strict()
  .superRefine((fixture, context) => {
    const participantIds = new Set(fixture.participants.map(({ id }) => id));
    const utteranceIds = new Set<string>();

    if (!fixture.participants.some(({ role }) => role === "operator")) {
      context.addIssue({
        code: "custom",
        path: ["participants"],
        message: "At least one operator is required."
      });
    }
    if (!fixture.participants.some(({ role }) => role === "customer")) {
      context.addIssue({
        code: "custom",
        path: ["participants"],
        message: "At least one customer is required."
      });
    }

    for (const [index, utterance] of fixture.utterances.entries()) {
      if (!participantIds.has(utterance.participantId)) {
        context.addIssue({
          code: "custom",
          path: ["utterances", index, "participantId"],
          message: `Unknown participant ${utterance.participantId}.`
        });
      }
      if (utteranceIds.has(utterance.id)) {
        context.addIssue({
          code: "custom",
          path: ["utterances", index, "id"],
          message: `Duplicate utterance ID ${utterance.id}.`
        });
      }
      utteranceIds.add(utterance.id);
    }
  });

export type TranscriptEvalFixture = z.infer<
  typeof TranscriptEvalFixtureSchema
>;

export interface EvalAssertion {
  name: string;
  passed: boolean;
  detail: string;
}

export interface TranscriptEvalResult {
  fixtureId: string;
  passed: boolean;
  assertions: EvalAssertion[];
  graph: BusinessGraph;
}

const normalize = (value: string): string =>
  value
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const includesAny = (value: string, terms: string[]): boolean => {
  const normalizedValue = normalize(value);
  return terms.some((term) => normalizedValue.includes(normalize(term)));
};

const assertion = (
  name: string,
  passed: boolean,
  detail: string
): EvalAssertion => ({ name, passed, detail });

export const buildAnalyzeMeetingInput = (
  fixture: TranscriptEvalFixture,
  runId = `${fixture.id}-${Date.now()}`
): AnalyzeMeetingInput => {
  const participantsById = new Map(
    fixture.participants.map((participant) => [participant.id, participant])
  );

  return {
    sessionId: `transcript-eval-${runId}`,
    currentGraph: emptyBusinessGraph(),
    participants: fixture.participants.map((participant) => ({ ...participant })),
    newUtterances: fixture.utterances.map((utterance, index) => {
      const participant = participantsById.get(utterance.participantId);
      if (!participant) {
        throw new Error(
          `Utterance ${utterance.id} references unknown participant ${utterance.participantId}.`
        );
      }
      return {
        ...utterance,
        participantName: participant.name,
        participantRole: participant.role,
        sequence: index + 1,
        startedAt: index * 1_000,
        endedAt: index * 1_000 + 900,
        finalized: true
      };
    })
  };
};

export const evaluateTranscriptGraph = (
  fixture: TranscriptEvalFixture,
  graph: BusinessGraph
): TranscriptEvalResult => {
  const assertions: EvalAssertion[] = [];
  const parsedGraph = BusinessGraphSchema.safeParse(graph);
  assertions.push(
    assertion(
      "valid business graph schema",
      parsedGraph.success,
      parsedGraph.success
        ? "Graph matches the production BusinessGraph schema."
        : z.prettifyError(parsedGraph.error)
    )
  );

  const validUtteranceIds = new Set(
    fixture.utterances.map((utterance) => utterance.id)
  );
  const customerIds = new Set(
    fixture.participants
      .filter(({ role }) => role === "customer")
      .map(({ id }) => id)
  );
  const customerUtteranceIds = new Set(
    fixture.utterances
      .filter(({ participantId }) => customerIds.has(participantId))
      .map(({ id }) => id)
  );
  const referenceErrors = validateGraphReferences(graph, validUtteranceIds);
  assertions.push(
    assertion(
      "valid graph references",
      referenceErrors.length === 0,
      referenceErrors.length === 0
        ? "All graph and evidence references resolve."
        : referenceErrors.join(" ")
    )
  );
  const customerEvidenceErrors = validateCustomerEvidence(
    graph,
    customerUtteranceIds
  );
  assertions.push(
    assertion(
      "customer-only evidence",
      customerEvidenceErrors.length === 0,
      customerEvidenceErrors.length === 0
        ? "Every finding cites designated-customer evidence."
        : customerEvidenceErrors.join(" ")
    )
  );

  const expectations = fixture.expectations;
  for (const [name, actual, minimum] of [
    ["minimum node count", graph.nodes.length, expectations.minNodes],
    ["minimum edge count", graph.edges.length, expectations.minEdges],
    ["minimum pain count", graph.pains.length, expectations.minPains]
  ] as const) {
    if (minimum !== undefined) {
      assertions.push(
        assertion(
          name,
          actual >= minimum,
          `Expected at least ${minimum}; received ${actual}.`
        )
      );
    }
  }

  if (expectations.topicIncludes) {
    assertions.push(
      assertion(
        "topic concept",
        includesAny(graph.topic.label, expectations.topicIncludes),
        `Topic "${graph.topic.label}" should include one of: ${expectations.topicIncludes.join(", ")}.`
      )
    );
  }

  for (const expected of expectations.requiredNodeConcepts ?? []) {
    const matches = graph.nodes.filter(
      (node) =>
        includesAny(node.label, expected.anyOf) &&
        (!expected.kinds || expected.kinds.includes(node.kind))
    );
    assertions.push(
      assertion(
        `node concept: ${expected.name}`,
        matches.length > 0,
        matches.length > 0
          ? `Matched: ${matches.map(({ label }) => label).join(", ")}.`
          : `No node matched ${expected.anyOf.join(", ")}${expected.kinds ? ` with kind ${expected.kinds.join(", ")}` : ""}.`
      )
    );
  }

  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const expected of expectations.requiredEdgeConcepts ?? []) {
    const matches = graph.edges.filter((edge) => {
      const from = nodesById.get(edge.from);
      const to = nodesById.get(edge.to);
      return (
        from !== undefined &&
        to !== undefined &&
        includesAny(from.label, expected.fromAnyOf) &&
        includesAny(to.label, expected.toAnyOf) &&
        (!expected.kinds || expected.kinds.includes(edge.kind))
      );
    });
    assertions.push(
      assertion(
        `edge concept: ${expected.name}`,
        matches.length > 0,
        matches.length > 0
          ? `Matched: ${matches
              .map((edge) => {
                const from = nodesById.get(edge.from)?.label ?? edge.from;
                const to = nodesById.get(edge.to)?.label ?? edge.to;
                return `${from} ${edge.kind} ${to}`;
              })
              .join(", ")}.`
          : "No edge matched the expected endpoints and kind."
      )
    );
  }

  for (const expected of expectations.requiredPainConcepts ?? []) {
    const matches = graph.pains.filter(
      (pain) =>
        includesAny(
          [
            pain.description,
            ...pain.targetNodeIds.map((id) => nodesById.get(id)?.label ?? "")
          ].join(" "),
          expected.anyOf
        ) &&
        (!expected.severities ||
          expected.severities.includes(pain.severity))
    );
    assertions.push(
      assertion(
        `pain concept: ${expected.name}`,
        matches.length > 0,
        matches.length > 0
          ? `Matched: ${matches.map(({ description }) => description).join(" | ")}.`
          : `No pain matched ${expected.anyOf.join(", ")}.`
      )
    );
  }

  const searchableGraphText = [
    graph.topic.label,
    ...graph.nodes.map(({ label }) => label),
    ...graph.edges.map(({ label }) => label ?? ""),
    ...graph.pains.map(({ description }) => description),
    ...graph.contradictions.map(({ description }) => description),
    graph.suggestedQuestion?.text ?? ""
  ].join(" ");
  for (const forbidden of expectations.forbiddenConcepts ?? []) {
    assertions.push(
      assertion(
        `forbidden concept: ${forbidden.name}`,
        !includesAny(searchableGraphText, forbidden.anyOf),
        `Graph should not include: ${forbidden.anyOf.join(", ")}.`
      )
    );
  }

  if (expectations.requireSuggestedQuestion !== undefined) {
    const hasQuestion = Boolean(graph.suggestedQuestion?.text.trim());
    assertions.push(
      assertion(
        "suggested question presence",
        hasQuestion === expectations.requireSuggestedQuestion,
        expectations.requireSuggestedQuestion
          ? "Expected a suggested follow-up question."
          : "Expected no suggested follow-up question."
      )
    );
  }

  return {
    fixtureId: fixture.id,
    passed: assertions.every(({ passed }) => passed),
    assertions,
    graph
  };
};

export const parseTranscriptEvalFixture = (
  input: unknown
): TranscriptEvalFixture => TranscriptEvalFixtureSchema.parse(input);
