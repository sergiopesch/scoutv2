import { describe, expect, it, vi } from "vitest";
import {
  addGraphEdge,
  addGraphNode,
  isPostCallReviewPath,
  postCallReviewView,
  removeGraphNode,
  savePostCallReview,
  updateGraphEdge,
  updateGraphNode
} from "../../public/js/post-call-editor.js";
import {
  BusinessGraphSchema,
  validateGraphReferences,
  validateGraphSemantics
} from "../../src/shared/schemas.js";
import type { BusinessGraph } from "../../src/shared/types.js";

const graph = (): BusinessGraph => ({
  topic: {
    id: "orders",
    label: "Order fulfilment",
    evidenceUtteranceIds: ["utt-1"]
  },
  nodes: [
    {
      id: "orders-api",
      kind: "system",
      label: "Orders API",
      state: "current",
      scope: "current",
      certainty: "asserted",
      confidence: 1,
      facets: { architecture: { kind: "api" } },
      evidenceUtteranceIds: ["utt-1"]
    }
  ],
  edges: [],
  pains: [],
  contradictions: []
});

describe("post-call diagram editor", () => {
  it("recognizes only the explicit review surface", () => {
    expect(isPostCallReviewPath("/review/session-1234567890")).toBe(true);
    expect(isPostCallReviewPath("/whiteboard/session-1234567890")).toBe(false);
  });

  it("adds, amends and connects complete schema-valid graph entities", () => {
    const added = addGraphNode(
      graph(),
      "architecture",
      "current",
      "utt-1",
      () => "new-worker"
    );
    const amended = updateGraphNode(
      added.graph,
      added.entityId,
      "architecture",
      {
        label: "Allocation worker",
        shortLabel: "Allocator",
        semanticType: "worker",
        technology: "Node.js",
        vendor: "Internal",
        scope: "current",
        certainty: "asserted"
      }
    );
    const connected = addGraphEdge(
      amended,
      "architecture",
      "orders-api",
      added.entityId,
      "current",
      "utt-1",
      () => "api-worker"
    );

    expect(BusinessGraphSchema.safeParse(connected.graph).success).toBe(true);
    expect(validateGraphSemantics(connected.graph)).toEqual([]);
    expect(
      validateGraphReferences(connected.graph, new Set(["utt-1"]))
    ).toEqual([]);
    expect(connected.graph.nodes.at(-1)).toMatchObject({
      label: "Allocation worker",
      shortLabel: "Allocator",
      certainty: "hypothesis",
      provenance: "post_call_editorial",
      evidenceUtteranceIds: [],
      facets: { architecture: { kind: "worker", technology: "Node.js", vendor: "Internal" } }
    });
    const relabelled = updateGraphEdge(
      connected.graph,
      connected.entityId,
      "architecture",
      { label: "allocation event", interaction: "asynchronous", protocol: "NATS", dataDescription: "Order allocated", reverse: true }
    );
    expect(relabelled.edges[0]).toMatchObject({
      from: added.entityId,
      to: "orders-api",
      label: "allocation event",
      facets: { architecture: { interaction: "asynchronous", protocol: "NATS", dataDescription: "Order allocated" } }
    });
  });

  it("cascades deletion through edges, pain targets and placement references", () => {
    const source = graph();
    source.nodes.push(
      {
        id: "worker",
        kind: "system",
        label: "Worker",
        state: "current",
        scope: "current",
        certainty: "asserted",
        confidence: 1,
        facets: {
          architecture: {
            kind: "worker",
            parentBoundaryNodeIdByScope: { current: "orders-api" }
          }
        },
        evidenceUtteranceIds: ["utt-1"]
      }
    );
    source.edges.push({
      id: "connection",
      from: "orders-api",
      to: "worker",
      kind: "depends_on",
      state: "current",
      scope: "current",
      certainty: "asserted",
      confidence: 1,
      facets: { architecture: { kind: "connection" } },
      evidenceUtteranceIds: ["utt-1"]
    });
    source.pains.push({
      id: "pain",
      description: "Slow allocation",
      targetNodeIds: ["orders-api"],
      severity: "high",
      state: "current",
      scope: "current",
      certainty: "asserted",
      evidenceUtteranceIds: ["utt-1"]
    });

    const removed = removeGraphNode(source, "orders-api");
    expect(removed.nodes.map((node: BusinessGraph["nodes"][number]) => node.id)).toEqual(["worker"]);
    expect(removed.edges).toEqual([]);
    expect(removed.pains).toEqual([]);
    expect(removed.nodes[0].facets.architecture.parentBoundaryNodeIdByScope).toBeUndefined();
    expect(validateGraphSemantics(removed)).toEqual([]);
  });

  it("keeps connected relationships semantically compatible when a node is rescaled", () => {
    const source = graph();
    source.nodes.push({
      id: "worker",
      kind: "system",
      label: "Worker",
      state: "current",
      scope: "both",
      certainty: "asserted",
      confidence: 1,
      facets: { architecture: { kind: "worker" } },
      evidenceUtteranceIds: ["utt-1"]
    });
    source.edges.push({
      id: "connection",
      from: "orders-api",
      to: "worker",
      kind: "depends_on",
      state: "current",
      scope: "current",
      certainty: "asserted",
      confidence: 1,
      facets: { architecture: { kind: "connection", interaction: "synchronous" } },
      evidenceUtteranceIds: ["utt-1"]
    });
    const updated = updateGraphNode(source, "orders-api", "architecture", { scope: "desired" });
    expect(updated.edges[0]).toMatchObject({ scope: "desired", state: "desired" });
    expect(validateGraphSemantics(updated)).toEqual([]);
  });

  it("distinguishes waiting, dirty-capable and saving UI states", () => {
    expect(postCallReviewView({ status: "listening" }).editable).toBe(false);
    const ready = {
      status: "ended",
      analysis: { status: "idle", pendingUtteranceCount: 0 },
      postCall: { revision: 2 }
    };
    expect(postCallReviewView(ready)).toMatchObject({ editable: true, ready: true, approved: false });
    expect(postCallReviewView({
      ...ready,
      postCall: { revision: 3, approvedAt: 123 }
    })).toMatchObject({ approved: true, label: "Approved · review 3" });
    expect(postCallReviewView(ready, true)).toMatchObject({ editable: false, label: "Saving review…" });
  });

  it("submits the complete graph with its expected revision", async () => {
    const fetchImpl = vi.fn(async (_url, init) =>
      new Response(JSON.stringify({ revision: 5, graph: graph() }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    await savePostCallReview(
      "session-1234567890",
      {
        expectedRevision: 4,
        graph: graph(),
        notes: "Approved",
        annotations: {
          "orders-api": { targetType: "node", disposition: "accepted", note: "Confirmed by owner" }
        },
        intervention: {
          painId: "manual-allocation",
          desiredOutcome: "Remove re-keying",
          proposal: "Add an adapter",
          constraints: ["Keep the API"],
          acceptanceCriteria: ["No duplicate entry"],
          nonGoals: ["Replace the warehouse"],
          decision: "candidate"
        }
      },
      fetchImpl as typeof fetch
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/reviews/session-1234567890",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining('"expectedRevision":4')
      })
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toContain('"disposition":"accepted"');
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toContain('"painId":"manual-allocation"');
  });
});
