import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { projectSupplyChain, supplyChainProjectionHash } from "../../public/js/supply-chain-projection.js";
import { compileSupplyChainProjection } from "../../public/js/supply-chain-mermaid.js";
import { DIAGRAM_VIEW_KINDS } from "../../public/js/view-render-coordinator.js";

const graph = {
  topic: { label: "Order fulfilment" },
  nodes: [
    { id: "buyer", kind: "actor", label: "Buyer", state: "current" },
    { id: "order", kind: "artifact", label: "Order", state: "current" },
    { id: "warehouse", kind: "team", label: "Warehouse", state: "current" },
    { id: "erp", kind: "system", label: "ERP", state: "current" },
    { id: "ship", kind: "process", label: "Ship order", state: "current" },
    { id: "future", kind: "system", label: "Future system", state: "desired" }
  ],
  edges: [
    { id: "produces", from: "buyer", to: "order", kind: "produces", state: "current" },
    { id: "handoff", from: "order", to: "warehouse", kind: "hands_off_to", label: "pick request", state: "current" },
    { id: "feed", from: "warehouse", to: "erp", kind: "feeds", state: "current" },
    { id: "process-only", from: "erp", to: "ship", kind: "uses", state: "current" },
    { id: "target", from: "erp", to: "future", kind: "feeds", state: "desired" }
  ]
};

describe("supply-chain beta projection", () => {
  it("keeps the beta flag-off, lazy, and outside the existing coordinator", async () => {
    const [html, controller] = await Promise.all([
      readFile(new URL("../../public/whiteboard.html", import.meta.url), "utf8"),
      readFile(new URL("../../public/js/whiteboard.js", import.meta.url), "utf8")
    ]);
    expect(html).toContain('data-supply-chain-tab tabindex="-1" hidden');
    expect(controller).toContain('get("supplyChain") === "1"');
    expect(controller).toContain('import("./supply-chain-projection.js")');
    expect(controller).toContain('import("./supply-chain-mermaid.js")');
    expect(controller).not.toContain('from "./supply-chain-projection.js"');
    expect(controller).toContain("// Deliberately retain the last valid SVG");
    expect(controller).toContain('[...DIAGRAM_VIEW_KINDS, "supply-chain"]');
    expect(controller).toContain(
      'elements.supplyChainTab.addEventListener("keydown", tabKeyboardNavigation)'
    );
    expect(controller).toContain("serialMermaidRender");
    expect(controller).toContain("!supplyChainActive && viewKind === activeView");
    expect(controller).toContain("elements.reviewAdd.disabled = true");
    expect(controller).toContain("elements.followLive.disabled = true");
    expect(controller).toContain("view.editable && !supplyChainActive");
  });

  it("does not alter the production view coordinator's three-view contract", () => {
    expect(DIAGRAM_VIEW_KINDS).toEqual(["process", "organization", "architecture"]);
    expect(DIAGRAM_VIEW_KINDS).not.toContain("supply-chain");
  });

  it("derives a deterministic view only from explicit production, feed and handoff evidence", () => {
    const projection = projectSupplyChain(graph);
    expect(projection.nodes.map(({ id }) => id)).toEqual(["buyer", "erp", "order", "warehouse"]);
    expect(projection.edges.map(({ id }) => id)).toEqual(["feed", "handoff", "produces"]);
    expect(supplyChainProjectionHash(structuredClone(projection))).toBe(supplyChainProjectionHash(projection));
  });

  it("does not invent supply-chain semantics from nodes or unrelated edges", () => {
    const projection = projectSupplyChain({
      topic: { label: "Sparse" },
      nodes: [{ id: "supplier", kind: "team", label: "Supplier", state: "current" }],
      edges: []
    });
    expect(projection.nodes).toEqual([]);
    expect(projection.edges).toEqual([]);
    expect(projection.emptyMessage).toMatch(/No explicit supply-chain/i);
    expect(projectSupplyChain(graph).nodes.map(({ id }) => id)).not.toContain("ship");
  });

  it("filters current and target scopes without leaking an incompatible endpoint", () => {
    expect(projectSupplyChain(graph, "current").edges.map(({ id }) => id)).not.toContain("target");
    expect(projectSupplyChain(graph, "desired").edges.map(({ id }) => id)).toEqual([]);
  });

  it("compiles a safe standalone flowchart and keeps evidence labels", () => {
    const source = compileSupplyChainProjection(projectSupplyChain(graph));
    expect(source).toContain("flowchart LR");
    expect(source).toContain("pick request");
    expect(source).toContain("produces");
    expect(source).not.toContain("inventory");
    expect(source).not.toContain("lead time");
  });

  it("quotes stakeholder labels that contain Mermaid shape delimiters", () => {
    const labelledGraph = structuredClone(graph);
    labelledGraph.nodes[0]!.label = "Buyer (EU)";
    labelledGraph.nodes[1]!.label = "Order [legacy]";
    const source = compileSupplyChainProjection(
      projectSupplyChain(labelledGraph)
    );
    expect(source).toContain('(["Buyer (EU)"])');
    expect(source).toContain('[/"Order [legacy]"/]');
  });

  it("invalidates the beta render when accessible topic metadata changes", () => {
    const projection = projectSupplyChain(graph);
    const changed = {
      ...projection,
      title: `${projection.title} updated`
    };
    expect(supplyChainProjectionHash(changed)).not.toBe(
      supplyChainProjectionHash(projection)
    );
  });
});
