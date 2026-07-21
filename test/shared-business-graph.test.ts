import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BusinessGraphDiagnosticModelOutputSchema,
  BusinessGraphModelOutputSchema,
  BusinessGraphSchema,
  validateCustomerEvidence,
  validateGraphReferences,
  validateGraphSemantics
} from "../src/shared/schemas.js";
import {
  emptyBusinessGraph,
  toWhiteboardSnapshot,
  type BusinessGraph,
  type SessionSnapshot
} from "../src/shared/types.js";

const baseGraph = (): BusinessGraph => ({
  topic: {
    id: "order-fulfilment",
    label: "Order fulfilment",
    evidenceUtteranceIds: ["utt-1"]
  },
  nodes: [],
  edges: [],
  pains: [],
  contradictions: []
});

const node = (
  id: string,
  facets: NonNullable<BusinessGraph["nodes"][number]["facets"]>
): BusinessGraph["nodes"][number] => ({
  id,
  kind: facets.organization ? "actor" : facets.process ? "process" : "system",
  label: id,
  state: "current",
  confidence: 0.9,
  facets,
  evidenceUtteranceIds: ["utt-1"]
});

describe("multi-view BusinessGraph foundation", () => {
  it("accepts only the exact evidence-free bootstrap graph", () => {
    expect(BusinessGraphSchema.safeParse(emptyBusinessGraph()).success).toBe(true);
    expect(
      BusinessGraphSchema.safeParse({
        ...emptyBusinessGraph(),
        topic: { id: "orders", label: "Orders", evidenceUtteranceIds: [] }
      }).success
    ).toBe(false);

    expect(BusinessGraphModelOutputSchema.safeParse(emptyBusinessGraph()).success).toBe(false);
    const modelSchema = z.toJSONSchema(BusinessGraphModelOutputSchema);
    const topicEvidenceSchema = modelSchema as unknown as {
      properties: {
        topic: { properties: { evidenceUtteranceIds: { minItems?: number } } };
        nodes: { items: { required: string[] } };
      };
    };
    expect(
      topicEvidenceSchema.properties.topic.properties.evidenceUtteranceIds.minItems
    ).toBe(1);
    expect(topicEvidenceSchema.properties.nodes.items.required).toEqual(
      expect.arrayContaining(["scope", "certainty"])
    );
  });

  it("accepts typed semantic facets without presentation coordinates", () => {
    const graph = baseGraph();
    graph.nodes = [
      node("order-pool", { process: { kind: "pool" } }),
      node("sales", {
        organization: { kind: "unit" },
        process: {
          kind: "lane",
          placement: { current: { poolNodeId: "order-pool" } }
        }
      }),
      node("capture", {
        process: {
          kind: "activity",
          placement: {
            current: { ownerNodeId: "sales", laneNodeId: "sales" }
          }
        }
      }),
      node("crm", {
        architecture: { kind: "software_system", technology: "SaaS" }
      })
    ];

    expect(BusinessGraphSchema.safeParse(graph).success).toBe(true);
    expect(validateGraphSemantics(graph)).toEqual([]);
    expect(JSON.stringify(graph)).not.toMatch(/\b(?:x|y|width|height|route)\b/);
  });

  it("represents temporal scope independently from certainty", () => {
    const graph = baseGraph();
    graph.nodes = [
      {
        ...node("shared-crm", { architecture: { kind: "software_system" } }),
        scope: "both",
        certainty: "asserted"
      },
      {
        ...node("proposed-ai", { architecture: { kind: "service" } }),
        scope: "desired",
        certainty: "hypothesis",
        state: "hypothesis"
      }
    ];

    expect(BusinessGraphSchema.safeParse(graph).success).toBe(true);
    expect(validateGraphSemantics(graph)).toEqual([]);
  });

  it("relocates one stable architecture identity between scoped boundaries", () => {
    const graph = baseGraph();
    graph.nodes = [
      {
        ...node("on-prem", {
          architecture: { kind: "boundary", boundaryKind: "environment" }
        }),
        scope: "current"
      },
      {
        ...node("cloud", {
          architecture: { kind: "boundary", boundaryKind: "cloud" }
        }),
        scope: "desired"
      },
      {
        ...node("orders-api", {
          architecture: {
            kind: "api",
            parentBoundaryNodeIdByScope: {
              current: "on-prem",
              desired: "cloud"
            }
          }
        }),
        scope: "both"
      }
    ];

    expect(validateGraphSemantics(graph)).toEqual([]);
  });

  it("validates current and desired reporting forests independently", () => {
    const graph = baseGraph();
    graph.nodes = [
      {
        ...node("alex", { organization: { kind: "position" } }),
        scope: "both"
      },
      {
        ...node("sam", { organization: { kind: "position" } }),
        scope: "both"
      }
    ];
    graph.edges = [
      {
        id: "current-report",
        from: "alex",
        to: "sam",
        kind: "depends_on",
        state: "current",
        scope: "current",
        confidence: 1,
        facets: { organization: { kind: "primary_report" } },
        evidenceUtteranceIds: ["utt-1"]
      },
      {
        id: "desired-report",
        from: "sam",
        to: "alex",
        kind: "depends_on",
        state: "desired",
        scope: "desired",
        confidence: 1,
        facets: { organization: { kind: "primary_report" } },
        evidenceUtteranceIds: ["utt-1"]
      }
    ];

    expect(validateGraphSemantics(graph)).toEqual([]);
  });

  it("rejects contradictory legacy state and explicit scope/certainty", () => {
    const graph = baseGraph();
    graph.nodes = [
      {
        ...node("contradictory", { architecture: { kind: "service" } }),
        state: "desired",
        scope: "current",
        certainty: "asserted"
      }
    ];

    expect(validateGraphSemantics(graph)).toContain(
      "contradictory legacy state must be current for its scope and certainty."
    );
  });

  it("rejects cross-scope and conflicting process placement", () => {
    const graph = baseGraph();
    graph.nodes = [
      { ...node("pool-a", { process: { kind: "pool" } }), scope: "current" },
      { ...node("pool-b", { process: { kind: "pool" } }), scope: "current" },
      {
        ...node("desired-lane", {
          process: {
            kind: "lane",
            placement: { desired: { poolNodeId: "pool-a" } }
          }
        }),
        state: "desired",
        scope: "desired"
      },
      {
        ...node("current-lane", {
          process: {
            kind: "lane",
            placement: { current: { poolNodeId: "pool-a" } }
          }
        }),
        scope: "current"
      },
      {
        ...node("activity", {
          process: {
            kind: "activity",
            placement: {
              current: {
                laneNodeId: "desired-lane",
                poolNodeId: "pool-b"
              }
            }
          }
        }),
        scope: "current"
      },
      {
        ...node("conflict", {
          process: {
            kind: "activity",
            placement: {
              current: {
                laneNodeId: "current-lane",
                poolNodeId: "pool-b"
              }
            }
          }
        }),
        scope: "current"
      }
    ];

    expect(validateGraphSemantics(graph)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("process lane must reference a lane node"),
        expect.stringContaining("lane and pool references conflict")
      ])
    );
  });

  it("moves one stable organization identity between scoped units", () => {
    const graph = baseGraph();
    graph.nodes = [
      {
        ...node("sales", { organization: { kind: "unit" } }),
        scope: "current"
      },
      {
        ...node("revenue", { organization: { kind: "unit" } }),
        state: "desired",
        scope: "desired"
      },
      {
        ...node("ops-lead", {
          organization: {
            kind: "position",
            unitNodeIdByScope: { current: "sales", desired: "revenue" },
            positionStatusByScope: { current: "filled", desired: "filled" }
          }
        }),
        scope: "both"
      }
    ];

    expect(validateGraphSemantics(graph)).toEqual([]);
  });

  it("rejects cyclic primary reporting and multiple primary managers", () => {
    const graph = baseGraph();
    graph.nodes = [
      node("alex", { organization: { kind: "person" } }),
      node("sam", { organization: { kind: "person" } }),
      node("jo", { organization: { kind: "person" } })
    ];
    graph.edges = [
      {
        id: "report-a",
        from: "alex",
        to: "sam",
        kind: "depends_on",
        state: "current",
        confidence: 1,
        facets: { organization: { kind: "primary_report" } },
        evidenceUtteranceIds: ["utt-1"]
      },
      {
        id: "report-b",
        from: "sam",
        to: "alex",
        kind: "depends_on",
        state: "current",
        confidence: 1,
        facets: { organization: { kind: "primary_report" } },
        evidenceUtteranceIds: ["utt-1"]
      },
      {
        id: "report-c",
        from: "alex",
        to: "jo",
        kind: "depends_on",
        state: "current",
        confidence: 1,
        facets: { organization: { kind: "primary_report" } },
        evidenceUtteranceIds: ["utt-1"]
      }
    ];

    expect(validateGraphSemantics(graph)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("multiple primary managers"),
        expect.stringContaining("must be acyclic")
      ])
    );
  });

  it("rejects invalid and cyclic architecture containment", () => {
    const graph = baseGraph();
    graph.nodes = [
      node("cloud", {
        architecture: {
          kind: "boundary",
          boundaryKind: "cloud",
          parentBoundaryNodeIdByScope: { current: "vpc" }
        }
      }),
      node("vpc", {
        architecture: {
          kind: "boundary",
          boundaryKind: "vpc",
          parentBoundaryNodeIdByScope: { current: "cloud" }
        }
      }),
      node("api", {
        architecture: {
          kind: "api",
          parentBoundaryNodeIdByScope: { current: "missing" }
        }
      })
    ];

    expect(validateGraphSemantics(graph)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("missing architecture boundary"),
        expect.stringContaining("containment must be acyclic")
      ])
    );
  });

  it("checks semantic references as part of graph acceptance", () => {
    const graph = baseGraph();
    graph.nodes = [
      node("capture", {
        process: {
          kind: "activity",
          placement: { current: { ownerNodeId: "missing" } }
        }
      })
    ];

    expect(validateGraphReferences(graph, new Set(["utt-1"]))).toContain(
      "Node capture references a missing process owner in current scope."
    );
  });

  it("rejects wrong-kind scoped process references and invalid endpoints", () => {
    const graph = baseGraph();
    graph.nodes = [
      node("pool", { process: { kind: "pool" } }),
      node("not-a-lane", { process: { kind: "activity" } }),
      node("start", { process: { kind: "start" } }),
      node("end", { process: { kind: "end" } })
    ];
    graph.edges = [
      {
        id: "backwards",
        from: "end",
        to: "start",
        kind: "hands_off_to",
        state: "current",
        confidence: 1,
        facets: { process: { kind: "sequence" } },
        evidenceUtteranceIds: ["utt-1"]
      }
    ];
    graph.nodes[2]!.facets!.process!.placement = {
      current: { laneNodeId: "not-a-lane" }
    };

    expect(validateGraphSemantics(graph)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("must reference a lane node"),
        expect.stringContaining("cannot have an outgoing edge"),
        expect.stringContaining("cannot have an incoming edge")
      ])
    );
  });

  it("rejects architecture connections with non-architecture endpoints", () => {
    const graph = baseGraph();
    graph.nodes = [
      node("api", { architecture: { kind: "api" } }),
      node("manual-review", { process: { kind: "activity" } })
    ];
    graph.edges = [
      {
        id: "invalid-connection",
        from: "api",
        to: "manual-review",
        kind: "feeds",
        state: "current",
        confidence: 1,
        facets: { architecture: { kind: "connection" } },
        evidenceUtteranceIds: ["utt-1"]
      }
    ];

    expect(validateGraphSemantics(graph)).toContain(
      "Architecture edge invalid-connection must connect architecture nodes."
    );
  });

  it("treats isDefault false as an ordinary sequence edge", () => {
    const graph = baseGraph();
    graph.nodes = [
      node("capture", { process: { kind: "activity" } }),
      node("review", { process: { kind: "activity" } })
    ];
    graph.edges = [
      {
        id: "ordinary-sequence",
        from: "capture",
        to: "review",
        kind: "hands_off_to",
        state: "current",
        confidence: 1,
        facets: { process: { kind: "sequence", isDefault: false } },
        evidenceUtteranceIds: ["utt-1"]
      }
    ];

    expect(validateGraphSemantics(graph)).toEqual([]);
  });

  it("rejects pain targets that do not exist in the pain scope", () => {
    const graph = baseGraph();
    graph.nodes = [
      {
        ...node("future-step", { process: { kind: "activity" } }),
        state: "desired",
        scope: "desired"
      }
    ];
    graph.pains = [
      {
        id: "current-pain",
        description: "Today is slow",
        targetNodeIds: ["future-step"],
        severity: "high",
        state: "current",
        scope: "current",
        certainty: "asserted",
        evidenceUtteranceIds: ["utt-1"]
      }
    ];

    expect(validateGraphSemantics(graph)).toContain(
      "Pain point current-pain target future-step must exist in current scope."
    );
  });

  it("adds optional evidence-backed diagnosis without changing the legacy model contract", () => {
    const graph = baseGraph();
    graph.nodes = [
      node("crm", { architecture: { kind: "software_system" } }),
      node("erp", { architecture: { kind: "software_system" } })
    ].map((item) => ({
      ...item,
      scope: "current" as const,
      certainty: "asserted" as const
    }));
    graph.edges = [
      {
        id: "crm-to-erp",
        from: "crm",
        to: "erp",
        kind: "feeds",
        state: "current",
        scope: "current",
        certainty: "asserted",
        confidence: 0.95,
        facets: {
          architecture: {
            kind: "connection",
            interaction: "batch",
            dataDescription: "customer records"
          }
        },
        evidenceUtteranceIds: ["utt-1"]
      }
    ];
    graph.pains = [
      {
        id: "sync-failures",
        description: "Customer records fail to synchronize",
        targetNodeIds: ["crm", "erp"],
        targetEdgeIds: ["crm-to-erp"],
        category: "interoperability",
        diagnosis: {
          failureMode: "The nightly transfer drops changed records",
          consequence: "Operations re-enters customer updates",
          causeHypothesis: "The batch export may omit late updates",
          frequency: "Nightly"
        },
        severity: "high",
        state: "current",
        scope: "current",
        certainty: "asserted",
        evidenceUtteranceIds: ["utt-1"]
      }
    ];

    expect(BusinessGraphSchema.safeParse(graph).success).toBe(true);
    expect(validateGraphReferences(graph, new Set(["utt-1"]))).toEqual([]);
    expect(validateGraphSemantics(graph)).toEqual([]);
    expect(BusinessGraphModelOutputSchema.safeParse(graph).success).toBe(false);
    expect(
      BusinessGraphDiagnosticModelOutputSchema.safeParse(graph).success
    ).toBe(true);
  });

  it("rejects duplicate, missing, and cross-scope pain edge targets", () => {
    const graph = baseGraph();
    graph.nodes = [
      {
        ...node("current-system", {
          architecture: { kind: "software_system" }
        }),
        scope: "current"
      },
      {
        ...node("future-system", {
          architecture: { kind: "software_system" }
        }),
        state: "desired",
        scope: "desired"
      }
    ];
    graph.edges = [
      {
        id: "future-feed",
        from: "future-system",
        to: "future-system",
        kind: "feeds",
        state: "desired",
        scope: "desired",
        certainty: "asserted",
        confidence: 0.9,
        evidenceUtteranceIds: ["utt-1"]
      }
    ];
    graph.pains = [
      {
        id: "current-interface-pain",
        description: "The current integration is unreliable",
        targetNodeIds: ["current-system"],
        targetEdgeIds: ["future-feed", "future-feed"],
        severity: "high",
        state: "current",
        scope: "current",
        certainty: "asserted",
        evidenceUtteranceIds: ["utt-1"]
      }
    ];

    expect(BusinessGraphSchema.safeParse(graph).success).toBe(false);
    expect(validateGraphSemantics(graph)).toContain(
      "Pain point current-interface-pain edge target future-feed must exist in current scope."
    );
    graph.pains[0]!.targetEdgeIds = ["missing-edge"];
    expect(validateGraphReferences(graph, new Set(["utt-1"]))).toContain(
      "Pain point current-interface-pain references a missing edge."
    );
  });

  it("rejects pain edge targets disconnected from every node target", () => {
    const graph = baseGraph();
    graph.nodes = ["a", "b", "c"].map((id) => ({
      ...node(id, { architecture: { kind: "software_system" } }),
      scope: "current" as const,
      certainty: "asserted" as const
    }));
    graph.edges = [{
      id: "a-to-b",
      from: "a",
      to: "b",
      kind: "feeds",
      state: "current",
      scope: "current",
      certainty: "asserted",
      confidence: 0.9,
      evidenceUtteranceIds: ["utt-1"]
    }];
    graph.pains = [{
      id: "disconnected-pain",
      description: "The interface is unreliable",
      targetNodeIds: ["c"],
      targetEdgeIds: ["a-to-b"],
      severity: "high",
      state: "current",
      scope: "current",
      certainty: "asserted",
      evidenceUtteranceIds: ["utt-1"]
    }];

    expect(validateGraphSemantics(graph)).toContain(
      "Pain point disconnected-pain edge target a-to-b must connect to one of its node targets."
    );
  });

  it("rejects empty facets and duplicate evidence or targets", () => {
    const graph = baseGraph();
    graph.nodes = [
      {
        ...node("duplicate", { architecture: { kind: "service" } }),
        facets: {},
        evidenceUtteranceIds: ["utt-1", "utt-1"]
      }
    ];
    graph.pains = [
      {
        id: "pain",
        description: "Repeated work",
        targetNodeIds: ["duplicate", "duplicate"],
        severity: "high",
        state: "current",
        evidenceUtteranceIds: ["utt-1"]
      }
    ];

    expect(BusinessGraphSchema.safeParse(graph).success).toBe(false);
  });

  it("allows evidence-free editorial hypotheses only in the post-call boundary", () => {
    const graph = baseGraph();
    graph.nodes = [{
      id: "editorial-service",
      kind: "system",
      label: "Proposed service",
      state: "hypothesis",
      scope: "desired",
      certainty: "hypothesis",
      confidence: 0.5,
      provenance: "post_call_editorial",
      facets: { architecture: { kind: "service" } },
      evidenceUtteranceIds: []
    }];
    graph.pains = [
      {
        id: "editorial-pain",
        description: "This interface may need additional validation",
        targetNodeIds: ["editorial-service"],
        category: "interoperability",
        diagnosis: {
          causeHypothesis: "The proposed service may lack a retry boundary"
        },
        severity: "medium",
        state: "hypothesis",
        scope: "desired",
        certainty: "hypothesis",
        provenance: "post_call_editorial",
        evidenceUtteranceIds: []
      }
    ];
    expect(BusinessGraphSchema.safeParse(graph).success).toBe(true);
    expect(validateCustomerEvidence(graph, new Set(["utt-1"]))).toContain(
      "editorial-service cannot use post-call editorial provenance during live analysis."
    );
    expect(validateCustomerEvidence(graph, new Set(["utt-1"]))).toContain(
      "editorial-pain cannot use post-call editorial provenance during live analysis."
    );
    expect(validateCustomerEvidence(graph, new Set(["utt-1"]), {
      allowPostCallEditorial: true
    })).toEqual([]);
  });

  it("projects browser state through an explicit recursive allowlist", () => {
    const graph = baseGraph();
    graph.nodes = [
      {
        ...node("crm", {
          architecture: { kind: "software_system", vendor: "Example" }
        }),
        aliases: ["secret customer codename"],
        shortLabel: "CRM",
        privateNotes: { evidenceUtteranceIds: ["utt-private"] }
      } as BusinessGraph["nodes"][number]
    ];
    graph.pains = [{
      id: "integration-pain",
      description: "The CRM integration is unreliable",
      targetNodeIds: ["crm"],
      diagnosis: {
        failureMode: "Records are dropped",
        evidenceUtteranceIds: ["secret-evidence"]
      },
      severity: "high",
      state: "current",
      evidenceUtteranceIds: ["utt-1"]
    } as BusinessGraph["pains"][number]];
    const snapshot = {
      id: "session-private",
      meetingUrl: "https://meeting.example/private",
      createdAt: 1,
      updatedAt: 2,
      revision: 3,
      roleRevision: 4,
      status: "listening",
      participants: [],
      utterances: [],
      graph,
      postCall: { revision: 0, notes: "", annotations: {} },
      recall: { status: "active", botId: "private-bot" },
      codex: { status: "active", threadId: "private-thread" },
      processing: { paused: false, changedAt: 1, incomingTranscriptPolicy: "discard" },
      analysis: { status: "idle", pendingUtteranceCount: 0 }
    } satisfies SessionSnapshot;

    const publicSnapshot = toWhiteboardSnapshot(snapshot, "public-id");
    const publicJson = JSON.stringify(publicSnapshot);
    expect(publicJson).toContain('"shortLabel":"CRM"');
    expect(publicJson).toContain('"vendor":"Example"');
    for (const forbidden of [
      "evidenceUtteranceIds",
      "secret customer codename",
      "privateNotes",
      "meeting.example",
      "private-bot",
      "private-thread"
    ]) {
      expect(publicJson).not.toContain(forbidden);
    }

    publicSnapshot.graph.nodes[0]!.label = "mutated in browser";
    publicSnapshot.graph.nodes[0]!.facets!.architecture!.vendor = "mutated vendor";
    expect(graph.nodes[0]!.label).toBe("crm");
    expect(graph.nodes[0]!.facets!.architecture!.vendor).toBe("Example");
  });
});
