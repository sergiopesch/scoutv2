import { describe, expect, it } from "vitest";
import {
  projectBusinessGraph,
  projectionEntityDetail,
  projectionSummary,
  semanticProjectionHash
} from "../../public/js/diagram-projections.js";

const graph = {
  topic: { id: "topic", label: "Orders" },
  nodes: [
    { id: "sales", kind: "team", label: "Sales", state: "current" },
    { id: "capture", kind: "process", label: "Capture order", state: "current" },
    { id: "crm", kind: "system", label: "CRM", state: "current" },
    { id: "queue", kind: "system", label: "Order queue", state: "desired" }
  ],
  edges: [
    { id: "handoff", from: "capture", to: "capture", kind: "hands_off_to", state: "current" },
    { id: "system-flow", from: "crm", to: "queue", kind: "feeds", state: "desired" },
    { id: "owner", from: "sales", to: "sales", kind: "owns", state: "current" }
  ],
  pains: [{
    id: "pain",
    description: "Manual entry",
    targetNodeIds: ["capture", "crm"],
    severity: "high",
    state: "current"
  }],
  contradictions: []
};

describe("projectBusinessGraph", () => {
  it("derives conservative distinct views from the legacy graph", () => {
    expect(projectBusinessGraph(graph, "process", "current").nodes.map((node) => node.id)).toEqual(["capture"]);
    expect(projectBusinessGraph(graph, "organization", "current").nodes.map((node) => node.id)).toEqual(["sales"]);
    expect(projectBusinessGraph(graph, "architecture", "desired").nodes.map((node) => node.id)).toEqual(["queue"]);
    expect(projectBusinessGraph(graph, "architecture", "current").nodes.map((node) => node.id)).toEqual(["crm"]);
  });

  it("never invents reporting lines from process handoffs", () => {
    const organization = projectBusinessGraph(graph, "organization", "current");
    expect(organization.edges.map((edge) => edge.id)).toEqual(["owner"]);
    expect(organization.edges.some((edge) => edge.id === "handoff")).toBe(false);
  });

  it("derives unit membership and unit hierarchy without inventing reports", () => {
    const organization = projectBusinessGraph({
      topic: { label: "Company" },
      nodes: [
        { id: "company", kind: "team", label: "Company", state: "current", facets: { organization: { kind: "unit" } } },
        { id: "finance", kind: "team", label: "Finance", state: "current", facets: { organization: { kind: "unit", unitNodeIdByScope: { current: "company" } } } },
        { id: "analyst", kind: "actor", label: "Analyst", state: "current", facets: { organization: { kind: "position", unitNodeIdByScope: { current: "finance" } } } }
      ], edges: [], pains: [], contradictions: []
    }, "organization", "current");
    expect(organization.edges).toEqual([
      expect.objectContaining({ from: "analyst", to: "finance", semanticType: "membership", derivedFromUnitNodeId: true }),
      expect.objectContaining({ from: "finance", to: "company", semanticType: "membership", derivedFromUnitNodeId: true })
    ]);
    expect(organization.edges.some((edge) => String(edge.semanticType).includes("report"))).toBe(false);
  });

  it("projects only exact canonical facets and derives lanes from real lane nodes", () => {
    const process = projectBusinessGraph({
      topic: { label: "Approval" },
      nodes: [
        { id: "finance", kind: "team", label: "Finance", state: "current", facets: { organization: { kind: "unit" } } },
        { id: "order-pool", kind: "process", label: "Order company", state: "current", facets: { process: { kind: "pool" } } },
        { id: "finance-lane", kind: "team", label: "Finance", state: "current", facets: { process: { kind: "lane", placement: { current: { poolNodeId: "order-pool" } } } } },
        { id: "approve", kind: "process", label: "Approve order", state: "current", facets: { process: { kind: "activity", placement: { current: { ownerNodeId: "finance", laneNodeId: "finance-lane", poolNodeId: "order-pool" } } } } }
      ],
      edges: [], pains: [], contradictions: []
    }, "process", "current");
    expect(process.nodes).toEqual([expect.objectContaining({ id: "approve", semanticType: "activity", laneId: "finance-lane" })]);
    expect(process.groups).toEqual([expect.objectContaining({ id: "finance-lane", label: "Order company · Finance" })]);
  });

  it("turns canonical architecture boundaries into groups, not duplicate nodes", () => {
    const architecture = projectBusinessGraph({
      topic: { label: "Platform" },
      nodes: [
        { id: "cloud", kind: "system", label: "Cloud", state: "current", facets: { architecture: { kind: "boundary", boundaryKind: "cloud" } } },
        { id: "api", kind: "system", label: "API", state: "current", facets: { architecture: { kind: "api", parentBoundaryNodeIdByScope: { current: "cloud" } } } }
      ], edges: [], pains: [], contradictions: []
    }, "architecture", "current");
    expect(architecture.nodes.map((node) => node.id)).toEqual(["api"]);
    expect(architecture.groups).toEqual([expect.objectContaining({ id: "cloud", semanticType: "boundary" })]);
  });

  it("flattens exact edge facet semantics for deterministic compilers", () => {
    const process = projectBusinessGraph({
      topic: { label: "Approval" },
      nodes: [
        { id: "a", kind: "process", label: "Review", state: "current", facets: { process: { kind: "activity" } } },
        { id: "b", kind: "decision", label: "Approved?", state: "current", facets: { process: { kind: "exclusive_gateway" } } }
      ],
      edges: [{ id: "flow", from: "a", to: "b", kind: "feeds", state: "current", facets: { process: { kind: "sequence", condition: "Complete" } } }],
      pains: [], contradictions: []
    }, "process", "current");
    expect(process.edges).toEqual([expect.objectContaining({ semanticType: "sequence", condition: "Complete" })]);
  });

  it("filters pain targets to the visible projection", () => {
    expect(projectBusinessGraph(graph, "process", "current").pains[0]?.targetNodeIds).toEqual(["capture"]);
  });

  it("filters independent scope while keeping both-scope facts visible", () => {
    const scoped = {
      topic: { label: "Change" },
      nodes: [
        { id: "current", kind: "system", label: "Legacy", state: "current", scope: "current", facets: { architecture: { kind: "software_system" } } },
        { id: "desired", kind: "system", label: "Target", state: "current", scope: "desired", facets: { architecture: { kind: "software_system" } } },
        { id: "both", kind: "system", label: "Shared", state: "current", scope: "both", facets: { architecture: { kind: "software_system" } } }
      ], edges: [], pains: [], contradictions: []
    };
    expect(projectBusinessGraph(scoped, "architecture", "current").nodes.map((node) => node.id)).toEqual(["both", "current"]);
    expect(projectBusinessGraph(scoped, "architecture", "desired").nodes.map((node) => node.id)).toEqual(["both", "desired"]);
  });

  it("explains an empty target as an uncaptured future state", () => {
    const target = projectBusinessGraph(graph, "process", "desired");
    expect(target.nodes).toEqual([]);
    expect(projectionSummary(target)).toBe("No target process has been captured yet.");
  });

  it("inherits current scoped placement for both-scope nodes when target has no override", () => {
    const target = projectBusinessGraph({
      topic: { label: "Target" },
      nodes: [
        { id: "lane", kind: "team", label: "Shared lane", state: "current", scope: "both", facets: { process: { kind: "lane" } } },
        { id: "task", kind: "process", label: "Shared task", state: "current", scope: "both", facets: { process: { kind: "activity", placement: { current: { laneNodeId: "lane" } } } } }
      ], edges: [], pains: [], contradictions: []
    }, "process", "desired");
    expect(target.nodes).toEqual([expect.objectContaining({ id: "task", laneId: "lane" })]);
  });

  it("produces stable semantic hashes and inspector details", () => {
    const projection = projectBusinessGraph(graph, "process", "current");
    const copy = JSON.parse(JSON.stringify(projection));
    expect(semanticProjectionHash(copy)).toBe(semanticProjectionHash(projection));
    expect(semanticProjectionHash({ ...projection, scope: "desired" })).not.toBe(semanticProjectionHash(projection));
    expect(projectionSummary(projection)).toContain("1 step");
    expect(projectionEntityDetail(projection, "capture")).toMatchObject({
      node: { label: "Capture order" },
      pains: [{ description: "Manual entry" }]
    });
  });
});
