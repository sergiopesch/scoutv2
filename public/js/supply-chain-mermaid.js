import { escapeMermaidLabel } from "./mermaid-graph.js";
import { renderIdForEntity } from "./multi-view-mermaid.js";

const sortById = (left, right) => String(left?.id ?? "").localeCompare(String(right?.id ?? ""));

function presentationClass(item) {
  if (item?.certainty === "hypothesis") return "hypothesis";
  if (["unknown", "conflicted"].includes(item?.certainty)) return "unknown";
  if (item?.scope === "desired" || item?.state === "desired") return "desired";
  return "current";
}

function nodeSource(node) {
  const id = renderIdForEntity(node.id, "supply");
  const label = escapeMermaidLabel(node.label, "Untitled");
  if (node.kind === "artifact") return `${id}[/"${label}"/]`;
  if (node.kind === "actor") return `${id}(["${label}"])`;
  return `${id}["${label}"]`;
}

/** A standalone compiler: it has no effect unless the beta tab is activated. */
export function compileSupplyChainProjection(projection) {
  const lines = [
    '%%{init: {"layout":"dagre","themeVariables":{"textColor":"#101115","edgeLabelBackground":"#FAFAF7"},"flowchart":{"curve":"linear","nodeSpacing":62,"rankSpacing":92,"padding":14}}}%%',
    "flowchart LR",
    `accTitle: ${escapeMermaidLabel(projection.title, "Supply chain")}`,
    `accDescr: ${escapeMermaidLabel(projection.description, "Explicit supply-chain connections")}`
  ];
  if (projection.nodes.length === 0) {
    lines.push(`  empty["${escapeMermaidLabel(projection.emptyMessage)}"]`);
    lines.push("  class empty unknown");
  } else {
    for (const node of projection.nodes.slice().sort(sortById)) {
      lines.push(`  ${nodeSource(node)}`);
      lines.push(`  class ${renderIdForEntity(node.id, "supply")} ${presentationClass(node)}`);
    }
    for (const edge of projection.edges.slice().sort(sortById)) {
      const label = edge.label || edge.kind.replaceAll("_", " ");
      lines.push(`  ${renderIdForEntity(edge.from, "supply")} -->|${escapeMermaidLabel(label)}| ${renderIdForEntity(edge.to, "supply")}`);
    }
  }
  lines.push(
    "  classDef current fill:#101115,stroke:#101115,color:#FAFAF7,stroke-width:2px",
    "  classDef desired fill:#FAFAF7,stroke:#101115,color:#101115,stroke-width:2.5px",
    "  classDef hypothesis fill:#F7F7F3,stroke:#101115,color:#101115,stroke-width:2px,stroke-dasharray:7 4",
    "  classDef unknown fill:#ECECE7,stroke:#62656C,color:#292C34,stroke-width:2px,stroke-dasharray:2 4"
  );
  return lines.join("\n");
}
