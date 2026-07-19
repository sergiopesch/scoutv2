import { describe, expect, it } from "vitest";
import {
  evaluateGeometryCandidate,
  geometryCandidateFromSvg,
  rectanglesOverlap,
  segmentIntersectsRectangle
} from "../../public/js/geometry-gate.js";

describe("geometry primitives", () => {
  it("treats clearance as part of the no-overlap contract", () => {
    const left = { x: 0, y: 0, width: 20, height: 20 };
    const right = { x: 23, y: 0, width: 20, height: 20 };
    expect(rectanglesOverlap(left, right)).toBe(false);
    expect(rectanglesOverlap(left, right, 2)).toBe(true);
  });

  it("detects a line passing through a rectangle", () => {
    const rect = { x: 10, y: 10, width: 20, height: 20 };
    expect(segmentIntersectsRectangle({ x: 0, y: 20 }, { x: 40, y: 20 }, rect)).toBe(true);
    expect(segmentIntersectsRectangle({ x: 0, y: 4 }, { x: 40, y: 4 }, rect)).toBe(false);
  });

  it("detects collinear boundary travel and corner tangency", () => {
    const rect = { x: 10, y: 10, width: 20, height: 20 };
    expect(segmentIntersectsRectangle({ x: 0, y: 10 }, { x: 40, y: 10 }, rect)).toBe(true);
    expect(segmentIntersectsRectangle({ x: 0, y: 0 }, { x: 10, y: 10 }, rect)).toBe(true);
  });
});

describe("evaluateGeometryCandidate", () => {
  it("rejects node overlap, edge-through-node and header collisions", () => {
    const result = evaluateGeometryCandidate({
      nodes: [
        { id: "a", x: 0, y: 20, width: 20, height: 20 },
        { id: "b", x: 15, y: 20, width: 20, height: 20 },
        { id: "obstacle", x: 50, y: 20, width: 20, height: 20 }
      ],
      titleBounds: [{ id: "lane-title", x: 80, y: 20, width: 20, height: 20 }],
      edges: [{
        id: "edge",
        sourceId: "a",
        targetId: "b",
        points: [{ x: 20, y: 30 }, { x: 110, y: 30 }]
      }]
    });

    expect(result.accepted).toBe(false);
    expect(result.hardFailures.map(({ type }) => type)).toEqual(
      expect.arrayContaining(["node-overlap", "edge-through-node", "edge-through-title"])
    );
  });

  it("accepts an orthogonally routed, separated candidate", () => {
    const result = evaluateGeometryCandidate({
      nodes: [
        { id: "a", x: 0, y: 0, width: 20, height: 20 },
        { id: "b", x: 80, y: 40, width: 20, height: 20 }
      ],
      edges: [{
        id: "edge",
        sourceId: "a",
        targetId: "b",
        points: [{ x: 20, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 50 }, { x: 80, y: 50 }]
      }]
    });
    expect(result).toMatchObject({
      accepted: true,
      metrics: { edgeNodeIntersections: 0, primaryLabelCollisions: 0 }
    });
  });

  it("scores nonincident edge crossings without making them an automatic hard failure", () => {
    const result = evaluateGeometryCandidate({
      edges: [
        { id: "one", sourceId: "a", targetId: "b", points: [{ x: 0, y: 0 }, { x: 20, y: 20 }] },
        { id: "two", sourceId: "c", targetId: "d", points: [{ x: 20, y: 0 }, { x: 0, y: 20 }] }
      ]
    });
    expect(result.accepted).toBe(true);
    expect(result.metrics.edgeCrossings).toBe(1);
  });

  it("can enforce zero primary hierarchy crossings without rejecting secondary-only crossings", () => {
    const crossing = [
      { id: "primary", importance: "primary" as const, sourceId: "a", targetId: "b", points: [{ x: 0, y: 0 }, { x: 20, y: 20 }] },
      { id: "secondary", importance: "secondary" as const, sourceId: "c", targetId: "d", points: [{ x: 20, y: 0 }, { x: 0, y: 20 }] }
    ];
    const result = evaluateGeometryCandidate({ edges: crossing }, { rejectPrimaryEdgeCrossings: true });
    expect(result.accepted).toBe(false);
    expect(result.metrics.primaryEdgeCrossings).toBe(1);
    expect(result.hardFailures).toContainEqual({ type: "primary-edge-crossing", count: 1 });
  });

  it("rejects nonfinite edge points", () => {
    const result = evaluateGeometryCandidate({
      edges: [{ id: "bad", points: [{ x: 0, y: 0 }, { x: Number.NaN, y: 4 }] }]
    });
    expect(result.accepted).toBe(false);
    expect(result.hardFailures).toContainEqual({ type: "invalid-edge-geometry" });
  });

  it("rejects primary text that escapes its owner bounds", () => {
    const result = evaluateGeometryCandidate({
      nodes: [{ id: "task", x: 0, y: 0, width: 80, height: 40 }],
      labels: [{
        id: "task-label",
        ownerId: "task",
        importance: "primary",
        x: 10,
        y: 10,
        width: 90,
        height: 16
      }]
    });
    expect(result.accepted).toBe(false);
    expect(result.hardFailures).toContainEqual(expect.objectContaining({ type: "clipped-primary-label" }));
  });

  it("recognizes architecture and swimlane variant selectors with diagnostics", () => {
    const service = {
      id: "service-api",
      dataset: {},
      getBoundingClientRect: () => ({ left: 10, top: 10, width: 60, height: 60 }),
      closest: () => undefined
    };
    const architectureSvg = {
      querySelector(selector: string) {
        if (selector === ".architecture-services") return {};
        return undefined;
      },
      querySelectorAll(selector: string) {
        if (selector.includes("architecture-service") && selector.startsWith("g.node")) return [service];
        return [];
      }
    };
    const architecture = geometryCandidateFromSvg(architectureSvg as unknown as SVGElement);
    expect(architecture.diagnostics).toMatchObject({
      variant: "architecture",
      counts: { nodes: 1 }
    });

    const swimlaneSvg = {
      querySelector(selector: string) {
        if (selector === ".swimlane") return {};
        return undefined;
      },
      querySelectorAll: () => []
    };
    expect(geometryCandidateFromSvg(swimlaneSvg as unknown as SVGElement).diagnostics)
      .toMatchObject({ variant: "swimlane" });
  });
});
