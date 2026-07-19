import { describe, expect, it } from "vitest";
import { projectBusinessGraph } from "../../public/js/diagram-projections.js";
import { compileProjectionCandidates, renderIdForEntity } from "../../public/js/multi-view-mermaid.js";

describe("multi-view Mermaid compilers", () => {
  it("uses stable generated IDs that do not expose model IDs as syntax", () => {
    expect(renderIdForEntity("unsafe; click x")).toMatch(/^entity_[a-z0-9]+$/);
    expect(renderIdForEntity("stable")).toBe(renderIdForEntity("stable"));
  });

  it("compiles canonical process facets to swimlanes with bounded fallbacks", () => {
    const projection = projectBusinessGraph({
      topic: { label: "Order approval" },
      nodes: [
        { id: "finance", kind: "team", label: "Finance", state: "current", facets: { organization: { kind: "unit" } } },
        { id: "finance-lane", kind: "team", label: "Finance", state: "current", facets: { process: { kind: "lane" } } },
        { id: "review", kind: "process", label: "Review order", state: "current", facets: { process: { kind: "activity", placement: { current: { ownerNodeId: "finance", laneNodeId: "finance-lane" } } } } },
        { id: "approve", kind: "decision", label: "Over £10k?", state: "current", facets: { process: { kind: "exclusive_gateway", placement: { current: { ownerNodeId: "finance", laneNodeId: "finance-lane" } } } } }
      ],
      edges: [{ id: "flow", from: "review", to: "approve", kind: "feeds", state: "current", facets: { process: { kind: "sequence", condition: "complete" } } }],
      pains: [], contradictions: []
    }, "process", "current");
    const candidates = compileProjectionCandidates(projection);
    expect(candidates.map(({ id }) => id)).toEqual([
      "process-swimlane-v1", "process-swimlane-wide-v1", "process-elk-v1", "process-dagre-wide-v1"
    ]);
    expect(candidates[0]?.source).toContain("swimlane-beta LR");
    expect(candidates[0]?.source).toContain("subgraph lane_");
    expect(candidates[0]?.source.includes("Responsibility unresolved")).toBe(false);
    expect(candidates[0]?.source).toContain("complete");
    expect(candidates[2]?.source).toContain("Finance · Review order");
  });

  it("keeps canonical reporting hierarchy top-down and matrix links secondary", () => {
    const projection = projectBusinessGraph({
      topic: { label: "Finance" },
      nodes: [
        { id: "cfo", kind: "actor", label: "CFO", state: "current", facets: { organization: { kind: "position" } } },
        { id: "manager", kind: "actor", label: "Finance manager", state: "current", facets: { organization: { kind: "position" } } }
      ],
      edges: [
        { id: "primary", from: "manager", to: "cfo", kind: "owns", state: "current", facets: { organization: { kind: "primary_report" } } },
        { id: "matrix", from: "cfo", to: "manager", kind: "owns", state: "current", facets: { organization: { kind: "secondary_report" } } }
      ], pains: [], contradictions: []
    }, "organization", "current");
    const source = compileProjectionCandidates(projection)[0]?.source ?? "";
    expect(source).toContain("flowchart TB");
    expect(source).toContain(`${renderIdForEntity("cfo")} --> ${renderIdForEntity("manager")}`);
    expect(source).toContain("-.->");
  });

  it("renders deterministic unit membership from unit to member without implying a report", () => {
    const projection = projectBusinessGraph({
      topic: { label: "Company" },
      nodes: [
        { id: "finance", kind: "team", label: "Finance", state: "current", facets: { organization: { kind: "unit" } } },
        { id: "analyst", kind: "actor", label: "Analyst", state: "current", facets: { organization: { kind: "position", unitNodeIdByScope: { current: "finance" } } } }
      ], edges: [], pains: [], contradictions: []
    }, "organization", "current");
    const source = compileProjectionCandidates(projection)[0]?.source ?? "";
    expect(source).toContain(`${renderIdForEntity("finance")} --- ${renderIdForEntity("analyst")}`);
    expect(source).toContain('[["UNIT · Finance"]]');
    expect(source).not.toContain("reports");
  });

  it("uses native architecture only for small unlabelled overviews", () => {
    const projection = projectBusinessGraph({
      topic: { label: "Platform" },
      nodes: [
        { id: "cloud", kind: "system", label: "Cloud", state: "current", facets: { architecture: { kind: "boundary", boundaryKind: "cloud" } } },
        { id: "api", kind: "system", label: "Orders API", state: "current", facets: { architecture: { kind: "api", parentBoundaryNodeIdByScope: { current: "cloud" } } } },
        { id: "db", kind: "system", label: "Orders DB", state: "current", facets: { architecture: { kind: "database", parentBoundaryNodeIdByScope: { current: "cloud" } } } }
      ],
      edges: [{ id: "read", from: "api", to: "db", kind: "feeds", state: "current", facets: { architecture: { kind: "connection" } } }],
      pains: [], contradictions: []
    }, "architecture", "current");
    const candidates = compileProjectionCandidates(projection);
    expect(candidates[0]?.id).toBe("architecture-native-v1");
    expect(candidates[0]?.source).toContain("architecture-beta");
    expect(candidates[0]?.source).toContain("(database)[DATABASE · Orders DB]");
    expect(candidates.map(({ id }) => id)).toContain("architecture-elk-v1");
  });

  it("routes labelled architecture directly through compound ELK", () => {
    const projection = projectBusinessGraph({
      topic: { label: "Platform" },
      nodes: [
        { id: "api", kind: "system", label: "API", state: "current", facets: { architecture: { kind: "api" } } },
        { id: "db", kind: "system", label: "DB", state: "current", facets: { architecture: { kind: "database" } } }
      ],
      edges: [{ id: "read", from: "api", to: "db", kind: "feeds", state: "current", facets: { architecture: { kind: "connection", protocol: "SQL" } } }],
      pains: [], contradictions: []
    }, "architecture", "current");
    const candidate = compileProjectionCandidates(projection)[0];
    expect(candidate?.id).toBe("architecture-elk-v1");
    expect(candidate?.source).not.toContain("subgraph");
    expect(candidate?.source).toContain('"themeVariables":{"textColor":"#101115","edgeLabelBackground":"#FAFAF7"}');
    expect(candidate?.source).toContain("SQL");
  });

  it("uses distinct BPMN-inspired gateway, event, task and connector semantics", () => {
    const projection = projectBusinessGraph({
      topic: { label: "Intake" },
      nodes: [
        { id: "start", kind: "process", label: "Request arrives", state: "current", facets: { process: { kind: "start" } } },
        { id: "task", kind: "process", label: "Review", state: "current", facets: { process: { kind: "activity", taskType: "user" } } },
        { id: "gate", kind: "decision", label: "Complete?", state: "current", facets: { process: { kind: "parallel_gateway" } } },
        { id: "end", kind: "process", label: "Closed", state: "current", facets: { process: { kind: "end" } } }
      ],
      edges: [
        { id: "message", from: "start", to: "task", state: "current", facets: { process: { kind: "message" } } },
        { id: "association", from: "task", to: "gate", state: "current", facets: { process: { kind: "association" } } },
        { id: "sequence", from: "gate", to: "end", state: "current", facets: { process: { kind: "sequence" } } }
      ],
      pains: [], contradictions: []
    }, "process", "current");
    const source = compileProjectionCandidates(projection).at(-1)?.source ?? "";
    expect(source).toContain('(("Request arrives"))');
    expect(source).toContain('USER · Review');
    expect(source).toContain('+ · Complete?');
    expect(source).toContain('((("Closed")))');
    expect(source).toContain("-.->");
    expect(source).toContain("-.-");
  });

  it("avoids native architecture when connection interaction carries semantics", () => {
    const projection = projectBusinessGraph({
      topic: { label: "Events" },
      nodes: [
        { id: "api", kind: "system", label: "API", state: "current", facets: { architecture: { kind: "api" } } },
        { id: "bus", kind: "system", label: "Event bus", state: "current", facets: { architecture: { kind: "event_bus" } } }
      ],
      edges: [{ id: "publish", from: "api", to: "bus", state: "current", facets: { architecture: { kind: "connection", interaction: "asynchronous" } } }],
      pains: [], contradictions: []
    }, "architecture", "current");
    expect(compileProjectionCandidates(projection)[0]?.id).toBe("architecture-elk-v1");
    expect(compileProjectionCandidates(projection)[0]?.source).toContain("asynchronous");
  });

  it("reports semantic edge coverage so no architecture candidate can silently omit an accepted edge", () => {
    const projection = projectBusinessGraph({
      topic: { label: "Platform" },
      nodes: [
        { id: "cloud", kind: "system", label: "Cloud", state: "current", facets: { architecture: { kind: "boundary", boundaryKind: "cloud" } } },
        { id: "api", kind: "system", label: "API", state: "current", facets: { architecture: { kind: "api", parentBoundaryNodeIdByScope: { current: "cloud" } } } }
      ],
      edges: [
        { id: "boundary-link", from: "cloud", to: "api", kind: "feeds", state: "current", facets: { architecture: { kind: "connection" } } }
      ],
      pains: [], contradictions: []
    }, "architecture", "current");

    const candidates = compileProjectionCandidates(projection);
    expect(candidates.length).toBeGreaterThan(1);
    for (const candidate of candidates) {
      expect(candidate.expectedSemanticEdgeIds).toEqual(["boundary-link"]);
      expect([
        ...candidate.renderedSemanticEdgeIds,
        ...candidate.omittedSemanticEdgeIds
      ]).toEqual(["boundary-link"]);
    }
    expect(candidates[0]?.omittedSemanticEdgeIds).toEqual(["boundary-link"]);
    expect(candidates.at(-1)?.renderedSemanticEdgeIds).toEqual(["boundary-link"]);
    expect(candidates.at(-1)?.omittedSemanticEdgeIds).toEqual([]);
    expect(candidates.at(-1)?.source).toContain(
      `${renderIdForEntity("cloud")} --> ${renderIdForEntity("api")}`
    );
  });

  it("retains nested architecture boundaries in every flowchart fallback", () => {
    const projection = projectBusinessGraph({
      topic: { label: "Platform" },
      nodes: [
        { id: "cloud", kind: "system", label: "Cloud", state: "current", facets: { architecture: { kind: "boundary", boundaryKind: "cloud" } } },
        { id: "network", kind: "system", label: "Private network", state: "current", facets: { architecture: { kind: "boundary", parentBoundaryNodeIdByScope: { current: "cloud" } } } },
        { id: "api", kind: "system", label: "API", state: "current", facets: { architecture: { kind: "api", parentBoundaryNodeIdByScope: { current: "network" } } } },
        { id: "db", kind: "system", label: "DB", state: "current", facets: { architecture: { kind: "database", parentBoundaryNodeIdByScope: { current: "network" } } } }
      ],
      edges: [{ id: "read", from: "api", to: "db", kind: "feeds", label: "Orders", state: "current", facets: { architecture: { kind: "connection", protocol: "SQL" } } }],
      pains: [], contradictions: []
    }, "architecture", "current");
    const candidates = compileProjectionCandidates(projection);
    for (const candidate of candidates.slice(0, -1)) {
      expect(candidate.source).toContain(`subgraph ${renderIdForEntity("cloud", "boundary")}`);
      expect(candidate.source).toContain(`subgraph ${renderIdForEntity("network", "boundary")}`);
      expect(candidate.source).toContain(renderIdForEntity("api"));
    }
    const flat = candidates.at(-1);
    expect(flat?.id).toBe("architecture-flat-boundaries-v1");
    expect(flat?.source).not.toContain("subgraph");
    expect(flat?.source).toContain(`${renderIdForEntity("cloud")}[["Cloud"]]`);
    expect(flat?.source).toContain(`${renderIdForEntity("network")}[["Private network"]]`);
    expect(flat?.source).toContain(
      `${renderIdForEntity("cloud")} --> ${renderIdForEntity("network")}`
    );
    expect(flat?.source).toContain(
      `${renderIdForEntity("network")} --> ${renderIdForEntity("api")}`
    );
  });

  it("always ends labelled nested architecture with a flat boundary-preserving fallback", () => {
    const projection = projectBusinessGraph({
      topic: { label: "Commerce platform" },
      nodes: [
        { id: "cloud", kind: "system", label: "Cloud", state: "current", scope: "current", certainty: "asserted", facets: { architecture: { kind: "boundary", boundaryKind: "cloud" } } },
        { id: "domain", kind: "system", label: "Order domain", state: "current", scope: "current", certainty: "asserted", facets: { architecture: { kind: "boundary", parentBoundaryNodeIdByScope: { current: "cloud" } } } },
        ...["api", "worker", "queue", "db"].map((id) => ({
          id,
          kind: "system",
          label: id.toUpperCase(),
          state: "current",
          scope: "current",
          certainty: "asserted",
          facets: { architecture: { kind: id === "db" ? "database" : id, parentBoundaryNodeIdByScope: { current: "domain" } } }
        }))
      ],
      edges: [
        ["api", "queue"], ["queue", "worker"], ["worker", "db"], ["api", "db"]
      ].map(([from, to], index) => ({
        id: `connection-${index}`,
        from,
        to,
        kind: "feeds",
        label: `Flow ${index + 1}`,
        state: "current",
        scope: "current",
        certainty: "asserted",
        facets: { architecture: { kind: "connection", protocol: "HTTPS" } }
      })),
      pains: [], contradictions: []
    }, "architecture", "current");
    const candidates = compileProjectionCandidates(projection);
    expect(candidates.map(({ id }) => id)).toEqual([
      "architecture-elk-v1",
      "architecture-dagre-v1",
      "architecture-flat-boundaries-v1"
    ]);
    const flat = candidates.at(-1)?.source ?? "";
    expect(flat).not.toContain("subgraph");
    expect(flat).toContain("Flow 1");
    expect(flat).toContain(`${renderIdForEntity("domain")} --> ${renderIdForEntity("api")}`);
  });

  it("produces honest view-specific empty states", () => {
    const projection = projectBusinessGraph({ topic: { label: "Discovery" } }, "organization", "current");
    expect(compileProjectionCandidates(projection)[0]?.source).toContain("No explicit reporting structure has been heard yet.");
  });
});
