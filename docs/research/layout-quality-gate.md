# Layout quality gate and deterministic fallback specification

**Status:** research specification; no runtime implementation

**Purpose:** define what “renders without overlapping lines or elements” means
for Scout's Process, Organisation and Architecture views.

## Core principle

A successful Mermaid/ELK/render call is not the same as a readable diagram.
Scout should accept a visual artifact only after checking its actual geometry.

Use hard constraints first and soft optimization second.

```text
Hard rejection
  node-node overlap
  nonincident edge-node intersection
  edge through lane/group title
  clipped primary text
  stale revision
  non-finite/off-canvas geometry

Soft score
  edge-edge crossings
  label collisions that can be hidden
  unnecessary bends
  total edge length
  boundary crossings
  retained-node displacement
  canvas area/aspect ratio
```

## Why a zero-crossing promise is impossible

Arbitrary graphs can be non-planar, so some edge-edge crossings cannot be
removed without changing the graph. Layout algorithms also trade crossing count
against stable ordering, compactness and edge length.

Scout's promise should be:

- never accept nodes on top of nodes;
- never accept a relationship line through an unrelated node or heading;
- never accept clipped primary labels;
- minimize crossings and make unavoidable ones explicit with line hops;
- reduce or split a view when crossing density destroys comprehension.

## Input contract

The quality gate receives:

```text
GeometryCandidate
  viewKind
  graphRevision
  projectionHash
  layoutProfileId
  viewportClass
  nodes[]: id, kind, bounds, incidentEdgeIds
  groups[]: id, bounds, titleBounds
  labels[]: id, ownerId, importance, bounds
  edges[]: id, sourceId, targetId, pathSegments, labelIds
  priorAcceptedGeometry?
```

All IDs are stable semantic/render IDs, not array positions.

## Measurement prerequisites

Before layout or geometry acceptance:

1. Await the final locally bundled font.
2. Normalize whitespace and deterministic wrapping.
3. Give every node a known width and height.
4. Include icons, state badges and card borders in the node bounds.
5. Include lane headers and group titles as obstacles.
6. Never measure inside a `display:none` tab with zero dimensions.
7. Do not fetch icons, images or fonts after layout.

Hidden tabs should be laid out against a stable logical viewport class, not their
temporarily hidden DOM dimensions.

## Geometric tests

### Node-node overlap

Expand each node rectangle by the minimum visual clearance and test rectangle
intersection. Any positive intersection is a hard failure.

Groups may contain nodes; containment is not overlap. Two sibling groups may not
overlap.

### Edge-node intersection

Flatten curves to line segments within a fixed tolerance. For each segment,
test intersection with expanded node rectangles except the legitimate endpoint
region of its source or target.

Any segment crossing a nonincident node is a hard failure.

### Header and title obstacles

Test edge segments against lane-header and group-title bounds. Connections may
cross a group boundary at a valid boundary point but may not cross its title.

### Label collision

Test:

- label against nodes;
- label against group/lane titles;
- label against other labels;
- important label against unrelated edges.

A primary task/name/condition label collision is a hard failure. An optional
relationship label may trigger label removal and inspector-only presentation in
a fallback profile.

### Edge-edge crossings

Count segment intersections excluding:

- shared valid endpoints;
- explicit junction/bus nodes;
- intentional shared orthogonal tracks;
- line-hop geometry at a declared crossing.

Classify crossings by relationship importance. A primary process or reporting
edge crossing is much more serious than two optional secondary overlays.

### Boundary correctness

For architecture edges, count boundary intersections. A connection between two
elements should cross only the boundaries separating their containment paths.
Repeatedly leaving and re-entering a boundary is a hard failure.

### Text clipping

Compare every primary text box with its owning card/title bounds. Ellipsis is
acceptable only when intentionally declared and the full text is available in
the accessible name/inspector.

### Revision validity

Before commit, verify:

```text
candidate.graphRevision == view.latestRequestedRevision
candidate.projectionHash == view.latestProjectionHash
```

Otherwise discard silently as stale.

## Lexicographic candidate score

Do not let a compact canvas compensate numerically for an edge passing through a
node. Compare candidates lexicographically:

```text
(
  hardFailureCount,
  nonincidentEdgeNodeIntersections,
  primaryLabelCollisions,
  primaryEdgeCrossings,
  totalEdgeCrossings,
  boundaryViolations,
  retainedNodeDisplacement,
  unnecessaryBends,
  totalEdgeLength,
  canvasAreaPenalty
)
```

The first differing component decides the winner. Deterministic tie-break:
`layoutProfileId` lexical order.

## Bounded candidate search

For small demo views, the renderer may evaluate a bounded set of deterministic
profiles within a strict time budget.

### Process candidates

1. Native swimlane LR, frozen lane order.
2. Native swimlane LR with increased spacing/short labels.
3. Flowchart LR + ELK without visual lane containers.

### Organisation candidates

1. Top-down primary forest, previous sibling order.
2. Top-down compact multi-row placement for high-degree managers.
3. Primary forest with secondary overlay suppressed except selection.

### Architecture candidates

1. Architecture overview with deterministic alignment directives.
2. Flowchart + compound ELK, left-to-right orthogonal.
3. Focused context/data-flow view with deeper boundaries collapsed.

Never use random retries. Every candidate is reproducible and recorded.

## Deterministic fallback policy

Apply in this order:

1. Increase spacing within the same semantic view.
2. Shorten optional visual labels; retain full text in the inspector.
3. Suppress secondary/annotation edges.
4. Add junctions or aggregate semantically equivalent parallel connections.
5. Collapse deeper subtrees/subprocesses/boundaries.
6. Switch to the view-specific fallback renderer.
7. Keep the previous accepted artifact and show a non-blocking layout status.

Never silently drop a primary canonical fact. If a fact is not visible because
of reduction, expose it in the inspector/outline and mark the collapsed proxy.

## View-specific hard invariants

### Process

- One lane per visible task.
- Sequence flow stays within a pool.
- Decision outcomes remain distinguishable.
- No line crosses a lane header.
- No edge crosses a task/gateway it does not connect.
- Feedback edges use a recognizable return route.
- Unavoidable crossings receive line hops.

### Organisation

- Primary reporting graph is a forest.
- Primary reporting edges have zero crossings.
- One incoming primary-manager edge per position.
- Secondary links do not alter primary rank/order.
- Vacancy is visible text, not only styling.
- Synthetic roots are not presented as real positions.

### Architecture

- Every visible child is inside its declared boundary.
- Cross-boundary edges cross each separating boundary once.
- Protocol/data direction remains visible or available in the inspector.
- Port direction does not invert semantic direction.
- More than three edges on one side triggers a junction/detail policy.
- Brand icon never appears without a visible/accessible label.

## Stability measurement

For every stable node present in consecutive accepted artifacts:

```text
normalized displacement =
  distance(previous center, current center) /
  viewport diagonal
```

Also record:

- layer/rank change;
- sibling-order inversion;
- group/lane change;
- viewport transform change;
- whether movement was causally connected to a changed semantic claim.

The first Mermaid implementation cannot pin coordinates, so stability goals are
based on stable ordering, deterministic profiles and viewport retention. A
future direct ELK/yFiles renderer should use prior coordinates/from-sketch layout
and enforce stricter movement budgets.

ELK documents separate cycle-breaking, layering, crossing-minimization, node
placement and routing phases, including interactive strategies based on previous
positions. See the [ELK layered overview](https://eclipse.dev/elk/blog/posts/2025/25-08-21-layered.html).

## Performance instrumentation

Record independently:

```text
projectionMs
compileMs
layoutMs
renderMs
geometryGateMs
commitMs
totalAcceptedGraphToVisibleMs
visibleNodeCount
visibleEdgeCount
candidateCount
fallbackLevel
staleResultDiscarded
```

For ELK.js, enable its execution-time measurement in benchmark builds and run
layout in a worker. The [ELK.js documentation](https://github.com/kieler/elkjs)
supports both workers and execution-time logging.

## Visual-regression fixture matrix

Each view needs revision sequences, not only final snapshots.

| Fixture | Revisions should expose |
|---|---|
| Linear process | stable ranks and no unnecessary bends |
| Diamond + merge | branch labels and gateway correctness |
| Process loop | feedback routing and line hops |
| Six-lane handoffs | lane order and crossing density |
| High-span manager | compact subtree/bus placement |
| Matrix organisation | primary tree stability with selected secondary links |
| Multiple org roots | no invented CEO; synthetic-root presentation |
| Architecture fan-in | port pressure and junction insertion |
| Nested boundaries | cross-hierarchy routing |
| Current/desired architecture | scope filtering and stable shared identities |
| Long labels | deterministic wrapping and inspector overflow |
| Font/icon delay simulation | no geometry drift after commit |
| Bursty revisions | stale-render rejection and active-tab priority |

For every revision, store semantic expectation, geometry metrics, screenshot and
change summary.

## Acceptance report

Every candidate should produce a compact diagnostic record:

```text
view=architecture
graphRevision=17
projectionHash=...
profile=arch-flowchart-elk-v1
accepted=true
nodes=14
edges=19
edgeNodeIntersections=0
primaryLabelCollisions=0
edgeCrossings=2
medianStableDisplacement=0.031
layoutMs=42
renderMs=77
gateMs=4
fallbackLevel=1
```

This makes visual quality observable rather than anecdotal.

## Final gate decision

Scout should never ask “did Mermaid return SVG?” as the final question. It
should ask:

> Is this complete view revision semantically valid, geometrically readable,
> causally stable and still current?

Only then should the tab atomically replace its previous artifact.
