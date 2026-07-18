import { describe, expect, it } from "vitest";
import {
  businessGraphToMermaid,
  escapeMermaidLabel
} from "../../public/js/mermaid-graph.js";

const graph = {
  topic: { id: "topic", label: "Order fulfilment" },
  nodes: [
    {
      id: "unsafe; click node",
      kind: "system",
      label: 'CRM <script>alert("x")</script>',
      state: "current"
    },
    {
      id: "ops",
      kind: "team",
      label: "Ops",
      state: "desired"
    }
  ],
  edges: [
    {
      id: "edge-z",
      from: "unsafe; click node",
      to: "ops",
      label: "hands | off",
      state: "hypothesis"
    }
  ],
  pains: [
    {
      id: "pain-a",
      description: "Manual; fragile",
      targetNodeIds: ["ops"],
      severity: "high"
    }
  ]
};

describe("businessGraphToMermaid", () => {
  it("is deterministic and sorts model objects by ID", () => {
    const first = businessGraphToMermaid(graph);
    const reordered = businessGraphToMermaid({
      ...graph,
      nodes: [...graph.nodes].reverse()
    });
    expect(first).toBe(reordered);
    expect(first).toMatch(/^flowchart TB/);
  });

  it("uses generated identifiers and escapes labels", () => {
    const output = businessGraphToMermaid(graph);
    expect(output).toContain("node_0");
    expect(output).toContain("node_1");
    expect(output).not.toContain("unsafe; click node");
    expect(output).not.toContain("<script>");
    expect(output).toContain("&lt;script&gt;");
    expect(output).toContain("hands &#124; off");
    expect(output).toContain("Manual&#59; fragile");
    expect(output).toContain("class node_0 desired\n");
    expect(output).toContain("class node_0 kind-team\n");
    expect(output).toContain("class pain_0 pain\n");
    expect(output).toContain("class pain_0 pain-high\n");
  });

  it("omits edges whose endpoints do not exist", () => {
    const output = businessGraphToMermaid({
      ...graph,
      edges: [{ id: "bad", from: "missing", to: "ops", label: "bad" }]
    });
    expect(output).not.toContain("|bad|");
  });
});

describe("escapeMermaidLabel", () => {
  it("strips controls, limits length, and supplies a fallback", () => {
    expect(escapeMermaidLabel("\u0000  ")).toBe("Untitled");
    expect(escapeMermaidLabel("x".repeat(200))).toHaveLength(120);
  });
});
