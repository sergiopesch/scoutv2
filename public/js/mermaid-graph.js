const NODE_KINDS = new Set([
  "actor",
  "team",
  "system",
  "process",
  "artifact",
  "decision",
  "goal",
  "unknown"
]);

const NODE_SHAPES = {
  actor: (id, label) => `${id}(["${label}"])`,
  team: (id, label) => `${id}(["${label}"])`,
  system: (id, label) => `${id}[["${label}"]]`,
  process: (id, label) => `${id}["${label}"]`,
  artifact: (id, label) => `${id}[/"${label}"/]`,
  decision: (id, label) => `${id}{"${label}"}`,
  goal: (id, label) => `${id}(["${label}"])`,
  unknown: (id, label) => `${id}["${label}"]`
};

const sortById = (left, right) =>
  String(left?.id ?? "").localeCompare(String(right?.id ?? ""));

export function escapeMermaidLabel(value, fallback = "Untitled") {
  const clean = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  const entities = {
    "&": "&amp;",
    '"': "&quot;",
    "<": "&lt;",
    ">": "&gt;",
    "|": "&#124;",
    "#": "&#35;",
    ";": "&#59;"
  };
  return (clean || fallback).replace(
    /[&"<>|#;]/g,
    (character) => entities[character]
  );
}

function stateClass(state) {
  return ["current", "desired", "hypothesis", "unknown"].includes(state)
    ? state
    : "unknown";
}

function kindClass(kind) {
  return NODE_KINDS.has(kind) ? `kind-${kind}` : "kind-unknown";
}

function nodeTitle(node) {
  const prefix =
    node.kind && node.kind !== "unknown" ? `${node.kind.toUpperCase()} · ` : "";
  return escapeMermaidLabel(`${prefix}${node.label ?? ""}`);
}

export function businessGraphToMermaid(graph = {}) {
  const nodes = Array.isArray(graph.nodes) ? [...graph.nodes].sort(sortById) : [];
  const edges = Array.isArray(graph.edges) ? [...graph.edges].sort(sortById) : [];
  const pains = Array.isArray(graph.pains) ? [...graph.pains].sort(sortById) : [];
  const nodeIds = new Map();
  const lines = [
    "flowchart TB",
    "%% Scout generates all Mermaid identifiers; model-provided IDs are never executable."
  ];

  nodes.forEach((node, index) => {
    const safeId = `node_${index}`;
    if (!nodeIds.has(String(node.id))) {
      nodeIds.set(String(node.id), safeId);
    }
    const kind = NODE_KINDS.has(node.kind) ? node.kind : "unknown";
    const shape = NODE_SHAPES[kind];
    lines.push(`  ${shape(safeId, nodeTitle({ ...node, kind }))}`);
    lines.push(`  class ${safeId} ${stateClass(node.state)}`);
    lines.push(`  class ${safeId} ${kindClass(kind)}`);
  });

  edges.forEach((edge) => {
    const from = nodeIds.get(String(edge.from));
    const to = nodeIds.get(String(edge.to));
    if (!from || !to) return;
    const label = escapeMermaidLabel(edge.label || edge.kind || "connects");
    const connector = edge.state === "hypothesis" ? "-.->" : "-->";
    lines.push(`  ${from} ${connector}|${label}| ${to}`);
  });

  pains.forEach((pain, index) => {
    const painId = `pain_${index}`;
    const severity = ["low", "medium", "high"].includes(pain.severity)
      ? pain.severity
      : "medium";
    lines.push(
      `  ${painId}{{"PAIN · ${escapeMermaidLabel(pain.description, "Unresolved friction")}"}}`
    );
    lines.push(`  class ${painId} pain`);
    lines.push(`  class ${painId} pain-${severity}`);
    const targets = Array.isArray(pain.targetNodeIds)
      ? [...new Set(pain.targetNodeIds.map(String))].sort()
      : [];
    targets.forEach((targetId) => {
      const target = nodeIds.get(targetId);
      if (target) lines.push(`  ${painId} -.->|affects| ${target}`);
    });
  });

  if (nodes.length === 0 && pains.length === 0) {
    lines.push('  empty["Listening for people, systems and decisions…"]');
    lines.push("  class empty unknown");
  }

  lines.push(
    "  classDef current fill:#172c29,stroke:#53d6ae,color:#f2fbf8,stroke-width:2px",
    "  classDef desired fill:#182841,stroke:#6da8ff,color:#f2f7ff,stroke-width:2px",
    "  classDef hypothesis fill:#30261a,stroke:#f1b65c,color:#fff7e9,stroke-width:2px,stroke-dasharray:6 4",
    "  classDef unknown fill:#23262d,stroke:#7d8798,color:#d8dee9,stroke-width:2px,stroke-dasharray:3 5",
    "  classDef kind-actor rx:20,ry:20",
    "  classDef kind-team rx:20,ry:20",
    "  classDef kind-system stroke-width:3px",
    "  classDef kind-process rx:4,ry:4",
    "  classDef kind-artifact stroke-dasharray:2 2",
    "  classDef kind-decision stroke-width:3px",
    "  classDef kind-goal fill:#183029",
    "  classDef kind-unknown stroke-dasharray:3 5",
    "  classDef pain fill:#391c25,stroke:#ff6f91,color:#fff2f5,stroke-width:2px",
    "  classDef pain-low stroke:#d994a5",
    "  classDef pain-medium stroke:#ff8aa5",
    "  classDef pain-high stroke:#ff4f78,stroke-width:4px"
  );

  return lines.join("\n");
}
