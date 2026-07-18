import { describe, expect, it } from "vitest";
import {
  buildAnalyzeMeetingInput,
  evaluateTranscriptGraph,
  parseTranscriptEvalFixture
} from "../../src/evals/transcript-eval.js";
import type { BusinessGraph } from "../../src/shared/types.js";

const fixtureInput = {
  id: "simple-eval",
  participants: [
    { id: "operator", name: "Morgan", role: "operator" },
    { id: "customer", name: "Sergio", role: "customer" }
  ],
  utterances: [
    {
      id: "operator-question",
      participantId: "operator",
      text: "What happens today?"
    },
    {
      id: "customer-answer",
      participantId: "customer",
      text: "Guest Services manually copies member data into HubSpot."
    }
  ],
  expectations: {
    minNodes: 2,
    minEdges: 1,
    minPains: 1,
    topicIncludes: ["member"],
    requiredNodeConcepts: [
      { name: "guest services", anyOf: ["guest services"], kinds: ["team"] },
      { name: "hubspot", anyOf: ["hubspot"], kinds: ["system"] }
    ],
    requiredEdgeConcepts: [
      {
        name: "team uses CRM",
        fromAnyOf: ["guest services"],
        toAnyOf: ["hubspot"],
        kinds: ["uses"]
      }
    ],
    requiredPainConcepts: [
      { name: "manual work", anyOf: ["manual"], severities: ["medium"] }
    ],
    requireSuggestedQuestion: true
  }
} as const;

const validGraph: BusinessGraph = {
  topic: {
    id: "topic",
    label: "Member data operations",
    evidenceUtteranceIds: ["customer-answer"]
  },
  nodes: [
    {
      id: "guest-services",
      kind: "team",
      label: "Guest Services",
      state: "current",
      confidence: 0.95,
      evidenceUtteranceIds: ["customer-answer"]
    },
    {
      id: "hubspot",
      kind: "system",
      label: "HubSpot",
      state: "current",
      confidence: 0.95,
      evidenceUtteranceIds: ["customer-answer"]
    }
  ],
  edges: [
    {
      id: "guest-services-uses-hubspot",
      from: "guest-services",
      to: "hubspot",
      kind: "uses",
      state: "current",
      confidence: 0.9,
      evidenceUtteranceIds: ["customer-answer"]
    }
  ],
  pains: [
    {
      id: "manual-copying",
      description: "Manual copying of member data",
      targetNodeIds: ["hubspot"],
      severity: "medium",
      state: "current",
      evidenceUtteranceIds: ["customer-answer"]
    }
  ],
  contradictions: [],
  suggestedQuestion: {
    text: "How often is the member data copied?",
    evidenceUtteranceIds: ["customer-answer"]
  }
};

describe("transcript graph evals", () => {
  it("builds finalized, attributed analyzer input", () => {
    const fixture = parseTranscriptEvalFixture(fixtureInput);
    const input = buildAnalyzeMeetingInput(fixture, "test-run");

    expect(input.sessionId).toBe("transcript-eval-test-run");
    expect(input.newUtterances).toMatchObject([
      { participantRole: "operator", finalized: true, sequence: 1 },
      { participantRole: "customer", finalized: true, sequence: 2 }
    ]);
  });

  it("passes semantic and integrity expectations", () => {
    const fixture = parseTranscriptEvalFixture(fixtureInput);
    const result = evaluateTranscriptGraph(fixture, validGraph);

    expect(result.passed).toBe(true);
    expect(result.assertions.every(({ passed }) => passed)).toBe(true);
  });

  it("reports a missing semantic concept without requiring an exact snapshot", () => {
    const fixture = parseTranscriptEvalFixture({
      ...fixtureInput,
      expectations: {
        ...fixtureInput.expectations,
        requiredNodeConcepts: [
          { name: "mindbody", anyOf: ["mindbody"], kinds: ["system"] }
        ]
      }
    });
    const result = evaluateTranscriptGraph(fixture, validGraph);

    expect(result.passed).toBe(false);
    expect(
      result.assertions.find(({ name }) => name === "node concept: mindbody")
    ).toMatchObject({ passed: false });
  });

  it("fails findings grounded in operator words", () => {
    const fixture = parseTranscriptEvalFixture(fixtureInput);
    const graph = structuredClone(validGraph);
    graph.topic.evidenceUtteranceIds = ["operator-question"];
    const result = evaluateTranscriptGraph(fixture, graph);

    expect(
      result.assertions.find(({ name }) => name === "customer-only evidence")
    ).toMatchObject({ passed: false });
  });

  it("rejects transcript rows with unknown participants", () => {
    expect(() =>
      parseTranscriptEvalFixture({
        ...fixtureInput,
        utterances: [
          {
            id: "bad",
            participantId: "missing",
            text: "This participant does not exist."
          }
        ]
      })
    ).toThrow(/Unknown participant missing/);
  });
});
