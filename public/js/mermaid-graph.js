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

function linkPresentation(state) {
  switch (state) {
    case "current":
      return {
        connector: "-->",
        style: "stroke:#101115,stroke-width:2px"
      };
    case "desired":
      return {
        connector: "==>",
        style: "stroke:#101115,stroke-width:4px"
      };
    case "hypothesis":
      return {
        connector: "-.->",
        style: "stroke:#62656C,stroke-width:2px,stroke-dasharray:7 4"
      };
    default:
      return {
        connector: "-.->",
        style: "stroke:#62656C,stroke-width:2px,stroke-dasharray:2 5"
      };
  }
}

export function businessGraphToMermaid(graph = {}) {
  const nodes = Array.isArray(graph.nodes) ? [...graph.nodes].sort(sortById) : [];
  const edges = Array.isArray(graph.edges) ? [...graph.edges].sort(sortById) : [];
  const pains = Array.isArray(graph.pains) ? [...graph.pains].sort(sortById) : [];
  const contradictions = Array.isArray(graph.contradictions)
    ? [...graph.contradictions].sort(sortById)
    : [];
  const nodeIds = new Map();
  const linkStyles = [];
  let linkIndex = 0;
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
    const presentation = linkPresentation(edge.state);
    lines.push(`  ${from} ${presentation.connector}|${label}| ${to}`);
    linkStyles.push(`  linkStyle ${linkIndex} ${presentation.style}`);
    linkIndex += 1;
  });

  pains.forEach((pain, index) => {
    const painId = `pain_${index}`;
    const severity = ["low", "medium", "high"].includes(pain.severity)
      ? pain.severity
      : "medium";
    const state = stateClass(pain.state);
    lines.push(
      `  ${painId}{{"PAIN · ${escapeMermaidLabel(pain.description, "Unresolved friction")}"}}`
    );
    lines.push(`  class ${painId} pain`);
    lines.push(`  class ${painId} pain-${state}`);
    lines.push(`  class ${painId} pain-${severity}`);
    const targets = Array.isArray(pain.targetNodeIds)
      ? [...new Set(pain.targetNodeIds.map(String))].sort()
      : [];
    targets.forEach((targetId) => {
      const target = nodeIds.get(targetId);
      if (target) {
        const presentation = linkPresentation(state);
        lines.push(`  ${painId} ${presentation.connector}|affects| ${target}`);
        linkStyles.push(`  linkStyle ${linkIndex} ${presentation.style}`);
        linkIndex += 1;
      }
    });
  });

  contradictions.forEach((contradiction, index) => {
    const contradictionId = `contradiction_${index}`;
    lines.push(
      `  ${contradictionId}{{"CONTRADICTION · ${escapeMermaidLabel(contradiction.description, "Conflicting evidence")}"}}`
    );
    lines.push(`  class ${contradictionId} contradiction`);
  });

  if (nodes.length === 0 && pains.length === 0 && contradictions.length === 0) {
    lines.push('  empty["Listening for people, systems and decisions…"]');
    lines.push("  class empty unknown");
  }

  lines.push(
    "  classDef current fill:#101115,stroke:#101115,color:#FAFAF7,stroke-width:2px",
    "  classDef desired fill:#FAFAF7,stroke:#101115,color:#101115,stroke-width:2.5px",
    "  classDef hypothesis fill:#F7F7F3,stroke:#101115,color:#101115,stroke-width:2px,stroke-dasharray:7 4",
    "  classDef unknown fill:#ECECE7,stroke:#62656C,color:#292C34,stroke-width:2px,stroke-dasharray:2 4",
    "  classDef kind-actor rx:20,ry:20",
    "  classDef kind-team rx:20,ry:20",
    "  classDef kind-system stroke-width:3px",
    "  classDef kind-process rx:4,ry:4",
    "  classDef kind-artifact stroke-dasharray:2 2",
    "  classDef kind-decision stroke-width:3px",
    "  classDef kind-goal stroke-width:3px",
    "  classDef kind-unknown stroke-dasharray:3 5",
    "  classDef pain fill:#101115,stroke:#101115,color:#FAFAF7,stroke-width:2px",
    "  classDef pain-current fill:#101115,stroke:#101115,color:#FAFAF7",
    "  classDef pain-desired fill:#FAFAF7,stroke:#101115,color:#101115",
    "  classDef pain-hypothesis fill:#F7F7F3,stroke:#101115,color:#101115,stroke-dasharray:7 4",
    "  classDef pain-unknown fill:#ECECE7,stroke:#62656C,color:#292C34,stroke-dasharray:2 4",
    "  classDef pain-low stroke-width:2px",
    "  classDef pain-medium stroke-width:3px",
    "  classDef pain-high stroke-width:4px",
    "  classDef contradiction fill:#FAFAF7,stroke:#101115,color:#101115,stroke-width:3px,stroke-dasharray:3 3"
  );

  lines.push(...linkStyles);

  return lines.join("\n");
}
