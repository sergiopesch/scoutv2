const finite = (value) => Number.isFinite(Number(value));

const normalizedRect = (rect) => {
  const x = Number(rect?.x ?? rect?.left ?? 0);
  const y = Number(rect?.y ?? rect?.top ?? 0);
  const width = Number(rect?.width ?? 0);
  const height = Number(rect?.height ?? 0);
  return { id: rect?.id, x, y, width, height };
};

const expandedRect = (rect, clearance = 0) => ({
  ...rect,
  x: rect.x - clearance,
  y: rect.y - clearance,
  width: rect.width + clearance * 2,
  height: rect.height + clearance * 2
});

const pointInRect = (point, rect, tolerance = 0) =>
  point.x >= rect.x - tolerance &&
  point.x <= rect.x + rect.width + tolerance &&
  point.y >= rect.y - tolerance &&
  point.y <= rect.y + rect.height + tolerance;

export function rectanglesOverlap(leftInput, rightInput, clearance = 0) {
  const left = expandedRect(normalizedRect(leftInput), clearance);
  const right = expandedRect(normalizedRect(rightInput), clearance);
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function orientation(a, b, c) {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < 0.0001) return 0;
  return value > 0 ? 1 : 2;
}

function pointOnSegment(a, b, point) {
  return (
    point.x <= Math.max(a.x, b.x) + 0.0001 &&
    point.x >= Math.min(a.x, b.x) - 0.0001 &&
    point.y <= Math.max(a.y, b.y) + 0.0001 &&
    point.y >= Math.min(a.y, b.y) - 0.0001
  );
}

function segmentsCross(a, b, c, d) {
  const first = orientation(a, b, c);
  const second = orientation(a, b, d);
  const third = orientation(c, d, a);
  const fourth = orientation(c, d, b);
  if (first !== second && third !== fourth) return true;
  if (first === 0 && pointOnSegment(a, b, c)) return true;
  if (second === 0 && pointOnSegment(a, b, d)) return true;
  if (third === 0 && pointOnSegment(c, d, a)) return true;
  if (fourth === 0 && pointOnSegment(c, d, b)) return true;
  return false;
}

export function segmentIntersectsRectangle(start, end, rectInput, clearance = 0) {
  const rect = expandedRect(normalizedRect(rectInput), clearance);
  if (pointInRect(start, rect) || pointInRect(end, rect)) return true;
  const topLeft = { x: rect.x, y: rect.y };
  const topRight = { x: rect.x + rect.width, y: rect.y };
  const bottomRight = { x: rect.x + rect.width, y: rect.y + rect.height };
  const bottomLeft = { x: rect.x, y: rect.y + rect.height };
  return (
    segmentsCross(start, end, topLeft, topRight) ||
    segmentsCross(start, end, topRight, bottomRight) ||
    segmentsCross(start, end, bottomRight, bottomLeft) ||
    segmentsCross(start, end, bottomLeft, topLeft)
  );
}

const pairs = (items) => {
  const output = [];
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      output.push([items[left], items[right]]);
    }
  }
  return output;
};

const segmentsOf = (edge) => {
  const points = Array.isArray(edge?.points) ? edge.points : [];
  return points.slice(1).map((point, index) => [points[index], point]);
};

/**
 * Applies hard readability checks and a deterministic soft crossing score.
 * This gate is renderer-independent so the same tests can protect Mermaid now
 * and a retained layout engine later.
 */
export function evaluateGeometryCandidate(candidate = {}, options = {}) {
  const clearance = Number(options.clearance ?? 2);
  const nodes = Array.isArray(candidate.nodes) ? candidate.nodes.map(normalizedRect) : [];
  const titles = Array.isArray(candidate.titleBounds)
    ? candidate.titleBounds.map(normalizedRect)
    : [];
  const labels = Array.isArray(candidate.labels) ? candidate.labels.map((label) => ({
    ...normalizedRect(label),
    importance: label.importance ?? "optional",
    ownerId: label.ownerId
  })) : [];
  const edges = Array.isArray(candidate.edges) ? candidate.edges : [];
  const hardFailures = [];

  const invalidEdgeGeometry = edges.some((edge) =>
    !Array.isArray(edge?.points) ||
    edge.points.length < 2 ||
    edge.points.some((point) => !finite(point?.x) || !finite(point?.y))
  );
  if (invalidEdgeGeometry) hardFailures.push({ type: "invalid-edge-geometry" });

  for (const [left, right] of pairs(nodes)) {
    if (rectanglesOverlap(left, right, clearance)) {
      hardFailures.push({ type: "node-overlap", leftId: left.id, rightId: right.id });
    }
  }

  let edgeNodeIntersections = 0;
  let titleIntersections = 0;
  for (const edge of edges) {
    for (const [start, end] of segmentsOf(edge)) {
      for (const node of nodes) {
        if (node.id === edge.sourceId || node.id === edge.targetId) continue;
        if (segmentIntersectsRectangle(start, end, node, clearance)) {
          edgeNodeIntersections += 1;
          hardFailures.push({ type: "edge-through-node", edgeId: edge.id, nodeId: node.id });
          break;
        }
      }
      for (const title of titles) {
        if (segmentIntersectsRectangle(start, end, title, clearance)) {
          titleIntersections += 1;
          hardFailures.push({ type: "edge-through-title", edgeId: edge.id, titleId: title.id });
          break;
        }
      }
    }
  }

  let primaryLabelCollisions = 0;
  let clippedPrimaryLabels = 0;
  for (const label of labels.filter((item) => item.importance === "primary")) {
    const collision = nodes.some(
      (node) => node.id !== label.ownerId && rectanglesOverlap(label, node, 1)
    ) || titles.some(
      (title) => title.id !== label.ownerId && rectanglesOverlap(label, title, 1)
    );
    if (collision) {
      primaryLabelCollisions += 1;
      hardFailures.push({ type: "primary-label-collision", labelId: label.id });
    }
    const owner = nodes.find((node) => node.id === label.ownerId);
    if (owner && !(
      label.x >= owner.x - 1 &&
      label.y >= owner.y - 1 &&
      label.x + label.width <= owner.x + owner.width + 1 &&
      label.y + label.height <= owner.y + owner.height + 1
    )) {
      clippedPrimaryLabels += 1;
      hardFailures.push({ type: "clipped-primary-label", labelId: label.id, ownerId: owner.id });
    }
  }

  let edgeCrossings = 0;
  let primaryEdgeCrossings = 0;
  for (const [left, right] of pairs(edges)) {
    if (
      left.sourceId === right.sourceId ||
      left.sourceId === right.targetId ||
      left.targetId === right.sourceId ||
      left.targetId === right.targetId
    ) continue;
    if (segmentsOf(left).some(([a, b]) =>
      segmentsOf(right).some(([c, d]) => segmentsCross(a, b, c, d))
    )) {
      edgeCrossings += 1;
      if (left.importance === "primary" || right.importance === "primary") {
        primaryEdgeCrossings += 1;
      }
    }
  }
  if (options.rejectPrimaryEdgeCrossings && primaryEdgeCrossings > 0) {
    hardFailures.push({ type: "primary-edge-crossing", count: primaryEdgeCrossings });
  }

  const invalidGeometry = nodes.some((node) =>
    !finite(node.x) || !finite(node.y) || !finite(node.width) || !finite(node.height)
  );
  if (invalidGeometry) hardFailures.push({ type: "invalid-geometry" });

  return {
    accepted: hardFailures.length === 0,
    hardFailures,
    metrics: {
      nodes: nodes.length,
      edges: edges.length,
      edgeNodeIntersections,
      titleIntersections,
      primaryLabelCollisions,
      clippedPrimaryLabels,
      edgeCrossings,
      primaryEdgeCrossings
    }
  };
}

const domRect = (element, id) => {
  const bounds = element.getBoundingClientRect();
  return { id, x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height };
};

function edgePoints(path, step = 8) {
  if (typeof path.getTotalLength !== "function" || typeof path.getPointAtLength !== "function") {
    return [];
  }
  const length = path.getTotalLength();
  if (!Number.isFinite(length) || length <= 0) return [];
  const count = Math.max(2, Math.ceil(length / step));
  return Array.from({ length: count + 1 }, (_, index) => {
    const point = path.getPointAtLength((length * index) / count);
    if (typeof path.getScreenCTM === "function") {
      const matrix = path.getScreenCTM();
      if (matrix && typeof DOMPoint === "function") {
        const transformed = new DOMPoint(point.x, point.y).matrixTransform(matrix);
        return { x: transformed.x, y: transformed.y };
      }
    }
    return { x: point.x, y: point.y };
  });
}

/** Extracts a conservative geometry candidate from a rendered Mermaid SVG. */
export function geometryCandidateFromSvg(svg) {
  const nodeSelector = "g.node, g.architecture-service";
  const titleSelector = "g.cluster-label, .swimlane-title, .swimlane-label, .architecture-groups > g";
  const edgeSelector = "path.flowchart-link, g.edgePath path, .architecture-edges path.edge";
  const labelSelector = "g.node .label, g.nodeLabel, g.architecture-service > g .architecture-service-label";
  const nodes = [...svg.querySelectorAll(nodeSelector)].map((node, index) =>
    domRect(node, node.id || node.dataset?.id || `node-${index}`)
  );
  const titleBounds = [
    ...svg.querySelectorAll(titleSelector)
  ].map((title, index) => domRect(title, title.id || `title-${index}`));
  const labels = [...svg.querySelectorAll(labelSelector)].map(
    (label, index) => ({
      ...domRect(label, label.id || `label-${index}`),
      ownerId: label.closest("g.node, g.architecture-service")?.id,
      importance: "primary"
    })
  );
  const edges = [...svg.querySelectorAll(edgeSelector)]
    .map((path, index) => {
      const points = edgePoints(path);
      if (points.length < 2) return undefined;
      const source = nodes.find((node) => pointInRect(points[0], node, 3));
      const target = nodes.find((node) => pointInRect(points.at(-1), node, 3));
      return {
        id: path.id || `edge-${index}`,
        sourceId: source?.id,
        targetId: target?.id,
        points
      };
    })
    .filter(Boolean);
  const variant = svg.querySelector(".architecture-services")
    ? "architecture"
    : svg.querySelector(".swimlane")
      ? "swimlane"
      : "flowchart";
  return {
    nodes,
    titleBounds,
    labels,
    edges,
    diagnostics: {
      variant,
      selectors: { nodeSelector, titleSelector, edgeSelector, labelSelector },
      counts: { nodes: nodes.length, titles: titleBounds.length, labels: labels.length, edges: edges.length }
    }
  };
}
