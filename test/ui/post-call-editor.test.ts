import { describe, expect, it, vi } from "vitest";
import {
  addGraphEdge,
  addGraphNode,
  addGraphPain,
  isPostCallReviewPath,
  postCallReviewView,
  removeGraphEdge,
  removeGraphNode,
  removeGraphPain,
  savePostCallReview,
  updateGraphEdge,
  updateGraphNode,
  updateGraphPain
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
      targetNodeIds: ["orders-api", "worker"],
      targetEdgeIds: ["connection"],
      severity: "high",
      state: "current",
      scope: "current",
      certainty: "asserted",
      evidenceUtteranceIds: ["utt-1"]
    });

    const removed = removeGraphNode(source, "orders-api");
    expect(removed.nodes.map((node: BusinessGraph["nodes"][number]) => node.id)).toEqual(["worker"]);
    expect(removed.edges).toEqual([]);
    expect(removed.pains).toEqual([
      expect.objectContaining({
        id: "pain",
        targetNodeIds: ["worker"]
      })
    ]);
    expect(removed.pains[0]).not.toHaveProperty("targetEdgeIds");
    expect(removed.nodes[0].facets.architecture.parentBoundaryNodeIdByScope).toBeUndefined();
    expect(validateGraphSemantics(removed)).toEqual([]);
  });

  it("cleans pain edge targets when a connection is removed directly", () => {
    const source = graph();
    source.nodes.push({
      id: "worker",
      kind: "system",
      label: "Worker",
      state: "current",
      scope: "current",
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
      facets: { architecture: { kind: "connection" } },
      evidenceUtteranceIds: ["utt-1"]
    });
    source.pains.push({
      id: "pain",
      description: "Slow allocation",
      targetNodeIds: ["orders-api", "worker"],
      targetEdgeIds: ["connection"],
      severity: "high",
      state: "current",
      scope: "current",
      certainty: "asserted",
      evidenceUtteranceIds: ["utt-1"]
    });

    const removed = removeGraphEdge(source, "connection");
    expect(removed.edges).toEqual([]);
    expect(removed.pains[0]).not.toHaveProperty("targetEdgeIds");
    expect(validateGraphSemantics(removed)).toEqual([]);
  });

  it("adds an evidence-free editorial pain and preserves meeting evidence while amending it", () => {
    const source = graph();
    source.nodes.push({
      id: "worker", kind: "system", label: "Worker", state: "current", scope: "current",
      certainty: "asserted", confidence: 1, facets: { architecture: { kind: "worker" } }, evidenceUtteranceIds: ["utt-1"]
    });
    source.pains.push({
      id: "meeting-pain", description: "Manual allocation", targetNodeIds: ["orders-api"],
      severity: "high", category: "rework", state: "current", scope: "current", certainty: "asserted", provenance: "meeting", evidenceUtteranceIds: ["utt-1"]
    });
    const added = addGraphPain(source, {
      description: "Possible queue delay", targetNodeIds: ["worker"], severity: "low", category: "delay",
      diagnosis: { failureMode: "Queue waits" }
    }, () => "editorial");
    expect(added.graph.pains.at(-1)).toMatchObject({
      id: "pain-editorial", provenance: "post_call_editorial", certainty: "hypothesis", state: "hypothesis",
      evidenceUtteranceIds: [], targetNodeIds: ["worker"], category: "delay"
    });
    const amended = updateGraphPain(added.graph, "meeting-pain", {
      description: "Confirmed manual allocation", targetNodeIds: ["orders-api", "worker"], severity: "medium",
      diagnosis: { consequence: "Slower fulfilment" }
    });
    expect(amended.pains[0]).toMatchObject({
      provenance: "meeting", evidenceUtteranceIds: ["utt-1"], targetNodeIds: ["orders-api", "worker"],
      category: "rework", diagnosis: { consequence: "Slower fulfilment" }
    });
    expect(validateGraphSemantics(amended)).toEqual([]);
    expect(BusinessGraphSchema.safeParse(amended).success).toBe(true);
  });

  it("requires a target for a review finding and makes removal reversible by the caller", () => {
    expect(() => addGraphPain(graph(), { description: "No target" })).toThrow("affected element");
    const added = addGraphPain(graph(), { targetNodeIds: ["orders-api"] }, () => "remove-me");
    const removed = removeGraphPain(added.graph, "pain-remove-me");
    expect(removed.pains).toEqual([]);
    expect(added.graph.pains).toHaveLength(1);
    const meeting = graph();
    meeting.pains = [{
      id: "meeting-pain",
      description: "Confirmed pain",
      targetNodeIds: ["orders-api"],
      severity: "high",
      state: "current",
      evidenceUtteranceIds: ["utt-1"]
    }];
    expect(() => removeGraphPain(meeting, "meeting-pain")).toThrow(
      "marked unsupported"
    );
  });

  it("rejects cross-scope and disconnected review pain targets before save", () => {
    const source = graph();
    source.nodes.push({
      id: "future-worker", kind: "system", label: "Future worker", state: "desired",
      scope: "desired", certainty: "asserted", confidence: 1,
      facets: { architecture: { kind: "worker" } }, evidenceUtteranceIds: ["utt-1"]
    });
    source.edges.push({
      id: "future-edge", from: "future-worker", to: "future-worker", kind: "feeds",
      state: "desired", scope: "desired", certainty: "asserted", confidence: 1,
      evidenceUtteranceIds: ["utt-1"]
    });
    expect(() => addGraphPain(source, {
      targetNodeIds: ["orders-api"], scope: "desired"
    })).toThrow("desired scope");
    expect(() => addGraphPain(source, {
      targetNodeIds: ["orders-api"], targetEdgeIds: ["future-edge"], scope: "current"
    })).toThrow("current scope");

    source.nodes.push({
      id: "other", kind: "system", label: "Other", state: "current",
      scope: "current", certainty: "asserted", confidence: 1,
      facets: { architecture: { kind: "service" } }, evidenceUtteranceIds: ["utt-1"]
    });
    source.edges.push({
      id: "other-edge", from: "orders-api", to: "other", kind: "feeds",
      state: "current", scope: "current", certainty: "asserted", confidence: 1,
      evidenceUtteranceIds: ["utt-1"]
    });
    expect(() => addGraphPain(source, {
      targetNodeIds: ["future-worker"],
      targetEdgeIds: ["other-edge"],
      scope: "desired"
    })).toThrow();
  });

  it("preserves desired and unknown semantics on legacy pain edits", () => {
    const desired = graph();
    desired.nodes[0]!.state = "desired";
    desired.nodes[0]!.scope = "desired";
    desired.pains = [{
      id: "legacy-desired",
      description: "Future allocation risk",
      targetNodeIds: ["orders-api"],
      severity: "medium",
      state: "desired",
      evidenceUtteranceIds: ["utt-1"]
    }];
    expect(updateGraphPain(desired, "legacy-desired", {
      description: "Reviewed future allocation risk"
    }).pains[0]).toMatchObject({
      scope: "desired",
      state: "desired",
      certainty: "asserted"
    });

    const unknown = graph();
    unknown.pains = [{
      id: "legacy-unknown",
      description: "Unclear allocation behavior",
      targetNodeIds: ["orders-api"],
      severity: "medium",
      state: "unknown",
      evidenceUtteranceIds: ["utt-1"]
    }];
    expect(updateGraphPain(unknown, "legacy-unknown", {
      description: "Still unclear"
    }).pains[0]).toMatchObject({
      state: "unknown",
      certainty: "unknown"
    });
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

  it("resizes an edge-targeted pain when the other endpoint narrows the edge scope", () => {
    const source = graph();
    source.nodes[0]!.scope = "both";
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
      scope: "both",
      certainty: "asserted",
      confidence: 1,
      facets: { architecture: { kind: "connection" } },
      evidenceUtteranceIds: ["utt-1"]
    });
    source.pains.push({
      id: "pain",
      description: "Slow allocation",
      targetNodeIds: ["worker"],
      targetEdgeIds: ["connection"],
      severity: "high",
      state: "current",
      scope: "both",
      certainty: "asserted",
      evidenceUtteranceIds: ["utt-1"]
    });

    const updated = updateGraphNode(source, "orders-api", "architecture", {
      scope: "current"
    });
    expect(updated.edges[0]).toMatchObject({ scope: "current" });
    expect(updated.pains[0]).toMatchObject({ scope: "current" });
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
  });
});
