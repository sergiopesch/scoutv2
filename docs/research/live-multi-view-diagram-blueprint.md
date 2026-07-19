# Scout live multi-view diagram blueprint

**Status:** second-stage research; assumes the first semantic-diagram proposal has
already been implemented

**Date:** 2026-07-19

**Branch:** `sergiopesch/research-generative-diagrams`

## Executive outcome

Assuming Scout already has a stronger semantic graph and separate diagram
intent, four problems still prevent consistently excellent live diagrams:

1. **The view is too dense.** Some graphs cannot be drawn without crossings;
   the only solution is semantic reduction and progressive disclosure.
2. **The layout engine lacks enough constraints.** Containers, lanes, primary
   hierarchy, ports, label bounds and stable prior order must be known before
   layout.
3. **The renderer is treated as the quality authority.** Scout needs an
   independent geometry gate that rejects node, edge and label collisions.
4. **Every revision is treated as a complete visual reset.** Per-view viewport,
   selection, collapse state, artifact cache and prior ordering must be retained.

The recommended architecture is one canonical accepted graph, three complete
deterministic view projections, and three independently retained tab states:

```text
                         ┌───────────────────────────────┐
final customer speech ──▶│ one canonical meeting analyst│
                         │ complete BusinessGraph        │
                         └──────────────┬────────────────┘
                                        │ accepted revision
                ┌───────────────────────┼───────────────────────┐
                ▼                       ▼                       ▼
       ProcessProjection        OrganisationProjection   ArchitectureProjection
                │                       │                       │
       process validator          org validator            arch validator
                │                       │                       │
       swimlane compiler          hierarchy compiler       dual arch compiler
                │                       │                       │
       geometry gate              geometry gate            geometry gate
                │                       │                       │
                └────────── per-tab staged artifact cache ─────┘
                                        │
                                active view commits first
```

This architecture gives specialist ownership without allowing separate live
agents to invent incompatible facts.

## A necessary constraint decision: “teams” versus runtime agents

The requested business-process, organisation and architecture teams are a good
ownership model. They are not a good reason to fan out three model calls after
every utterance.

Scout's current MVP contract explicitly requires one persistent Codex thread per
meeting and prohibits runtime subagents. The live analyzer also disables both
multi-agent feature flags. Introducing persistent specialist threads would
therefore be a contract change, not a refinement of the existing design.

### MVP-compatible specialist ownership

Each domain team owns a deterministic capability package:

| Team | Owns |
|---|---|
| Process | process ontology, BPMN-lite rules, `ProcessProjection`, compiler, swimlane profile, process linter, fixtures and metrics |
| Organisation | position/reporting ontology, `OrganisationProjection`, hierarchy compiler, matrix-link overlay, fixtures and metrics |
| Architecture | architecture ontology, `ArchitectureProjection`, compiler profiles, port rules, icon registry/licence manifest, fixtures and metrics |
| Integration | canonical graph, shared identity/evidence, atomic revisions, projection scheduling, geometry gate contract, SSE and merge decisions |

These are real specialist boundaries. They make independent iteration and
evaluation possible without extra inference latency or contradictory runtime
state.

### If the MVP contract is deliberately changed later

OpenAI's current Agents SDK guidance distinguishes two patterns:

- **Handoffs:** a specialist takes ownership of the conversation.
- **Agents as tools:** a manager keeps ownership and calls specialists as
  bounded capabilities.

For Scout, only the manager pattern is appropriate. The accepted graph must have
one authority. See [OpenAI orchestration and handoffs](https://developers.openai.com/api/docs/guides/agents/orchestration).

A post-MVP runtime experiment could be:

```text
Meeting manager
  ├─ process specialist tool      only when process facts changed
  ├─ organisation specialist tool only when org facts changed
  └─ architecture specialist tool only when architecture facts changed
```

Each specialist would receive the accepted canonical graph, the previous
complete view projection and only relevant finalized evidence. It could return a
complete candidate `ViewProjection`, but could not create canonical facts,
change entity identity or cite non-customer evidence. A deterministic merger and
validator would remain authoritative.

Even then, the first visible graph should not wait for all specialists. Parallel
model calls consume more tokens and create tail-latency and reconciliation
costs. OpenAI's Codex manual likewise notes that subagent workflows are useful
for genuinely independent work but cost additional model/tool work. Runtime
specialists should be measured against a single-call baseline and retained only
if they produce a material accuracy gain.

## The correct canonical/view separation

The earlier proposal used a single `diagramIntent`. That is insufficient for a
meeting that discusses an order process, the responsible departments and the
systems involved in the same sentence.

The canonical graph should support **many-to-many view membership**:

- Sales can appear as an organisation unit, a process lane and an architecture
  external actor.
- CRM can appear as a process system lane and an architecture system.
- “Finance approves orders” can produce a process task owned by the Finance
  position/unit without inventing an organisational reporting line.
- “The integration service reads the order database” belongs to architecture;
  it should not become a business-process step unless the customer describes it
  as part of the business workflow.

The canonical graph remains evidence-grounded business truth. Projections decide
what is visible in each view.

### Recommended semantic families

```text
Shared
  EntityIdentity, Alias, Evidence, State, ConfidenceBand, Contradiction

Process
  Pool, Lane, Event, Activity, Gateway, Artifact, SequenceFlow, MessageFlow

Organisation
  Person, Position, Vacancy, OrgUnit, PrimaryReport, SecondaryReport, Membership

Architecture
  Actor, System, Service, Component, API, Store, Queue, Boundary, Connection
```

The model produces semantic types and relationships, never renderer syntax,
coordinates, port sides, icon names or line paths.

## Post-implementation failure taxonomy

“Lines overlap” is at least eight separate failure classes.

| Failure | Typical cause | Correct control |
|---|---|---|
| Node–node overlap | wrong/late dimensions; force-layout collision | fixed measured bounds; node separation; geometry rejection |
| Edge through node | router lacks obstacles or correct ports | orthogonal obstacle routing; fixed-side ports; geometry rejection |
| Edge through group/lane title | title bounds absent from routing model | treat headers as obstacles |
| Label–node or label–edge collision | labels added after routing; labels too long | integrated label placement; hard label budgets; inspector for detail |
| Edge–edge crossing | poor ordering, dense or non-planar topology | constrained ordering, port order, line hops, view reduction |
| Boundary crossing | separate compound layouts or missing hierarchy handling | one compound layout; boundary proxies; cross-hierarchy routing |
| Visual jitter | full relayout, unstable IDs/order, refit viewport | prior order/positions, deterministic seeds, retained viewport |
| Stale commit | old asynchronous render completes last | per-view revision token; latest-only commit |

Zero edge-edge crossings cannot be guaranteed for arbitrary graphs. Zero
node-node overlap, zero nonincident edge-node intersections and zero clipped
labels **can** be hard acceptance conditions.

## The visual quality pipeline

Every view should pass through the same stages even though its semantics and
layout profile differ.

### 1. Projection

Select only the canonical entities and claims relevant to the view and current
scope. Produce a complete projection for the accepted graph revision.

### 2. Semantic normalization

- Resolve stable IDs and aliases.
- Remove duplicate display relationships.
- Classify primary versus secondary relationships.
- Convert implied branching into explicit gateways only when supported.
- Mark unresolved ownership, direction or hierarchy instead of inventing it.
- Separate current and desired scopes.

### 3. Readability reduction

- Select one primary story or focal element.
- Collapse deeper detail behind subprocess, organisation-unit or boundary
  proxies.
- Aggregate genuinely parallel equivalent connections.
- Move evidence, long descriptions and contradictions into the inspector.
- Refuse to shrink below the minimum readable zoom merely to show everything.

### 4. Deterministic measurement

- Load the bundled font before measuring.
- Use fixed card widths and deterministic two-line wrapping.
- Include badges, icons, lane headers and group titles in measured bounds.
- Bundle icon assets locally so geometry never changes after a network request.

### 5. Constrained layout

Choose a view-specific algorithm, orientation, ports, rank constraints, stable
order and spacing. Preserve prior order/coordinates as a preference rather than
an absolute rule when that preference creates a collision.

### 6. Edge routing and label placement

Route after node placement. Architecture and process use orthogonal routes;
secondary organisation links use reserved side ports/tracks. Labels are placed
with bounds and collision candidates, not simply at path midpoints.

### 7. Independent geometry gate

Inspect the actual output geometry. The renderer's success status is not enough.
Reject collisions and score remaining soft defects.

### 8. Atomic per-view commit

Commit only if the artifact matches the latest requested projection revision.
On failure, keep that tab's previous valid artifact and follow a deterministic
fallback chain.

The companion specification defines this gate precisely:
[layout-quality-gate.md](./layout-quality-gate.md).

## Business-process view contract

The process view should be **BPMN-inspired (`bpmn-lite`)**, not described as
BPMN-compliant unless Scout generates valid BPMN XML plus Diagram Interchange.
The normative standard remains [OMG BPMN 2.0.2](https://www.omg.org/spec/BPMN/).

### Semantic projection

```text
ProcessProjection
  revision, viewId, scope(current|desired), completeness
  pools[]
  lanes[]: ownerKind, stable order
  elements[]:
    start, end, task, subprocess,
    gateway-exclusive, gateway-parallel, gateway-inclusive,
    gateway-event, intermediate-event, document, data-store
  flows[]: sequence, message, association, condition, default
  unresolved[]
```

Rules:

- Pools represent participants/external parties; lanes partition responsibility
  within a participant.
- Sequence flow remains inside a pool; message flow crosses pools.
- Every task belongs to exactly one lane, including an explicit unresolved lane.
- Tasks use “verb + object” labels.
- Exclusive gateways are phrased as questions; outgoing conditions are labeled.
- Parallel, inclusive and event-based gateways are used only when explicitly
  supported by evidence.
- The compiler never invents a join.
- Data artifacts do not carry sequence flow.
- Fragmentary processes may lack start/end events, but the view must say it is a
  fragment.

### Primary Mermaid engine

Mermaid 11.16 `swimlane-beta` has a dedicated lane-aware layout; it is not ELK.
Its implementation includes Sugiyama-style ranks, orthogonal obstacle routing,
label collision handling, shared-track nudging, line hops and internal layout
validation. See the official [swimlane syntax](https://mermaid.js.org/syntax/swimlanes.html)
and source for the [layout core](https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/rendering-util/layout-algorithms/swimlanes/layoutCore.ts),
[orthogonal router](https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/rendering-util/layout-algorithms/swimlanes/orthogonalRouter/router.ts)
and [validator](https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/rendering-util/layout-algorithms/swimlanes/direction/validation.ts).

Recommended frozen profile to benchmark:

```text
direction: LR
nodeSpacing: 48
rankSpacing: 96
lineHops: arc
ignoreCrossLaneEdges: true
optimizeRanksByCrossings: true
automaticLaneOrdering: false
```

Mermaid exposes these crossing controls in its
[configuration](https://mermaid.js.org/config/schema-docs/config.html). Keep lane
auto-ordering off: departments changing vertical position after one new handoff
does more damage than a marginal crossing reduction. Freeze lane order when the
view first becomes credible; insert new lanes deterministically near their main
handoff partner.

The native validator currently warns rather than making Scout's acceptance
decision, so the independent geometry gate remains required.

### Process fallback chain

1. Native `swimlane-beta` with the frozen profile.
2. The same grammar with optional labels shortened and increased spacing.
3. Mermaid `flowchart LR` + ELK with owner badges instead of pseudo-lanes.
4. Previous valid SVG plus a small “layout update pending” status.

### Process density controls

Initial demo budget to calibrate:

- at most six visible lanes;
- at most 16 visible activities/gateways;
- at most 24 flows;
- at most three visible outcomes from a gateway;
- task labels no more than two lines;
- edge labels reserved for conditions, messages and meaningful handoffs.

When the full process exceeds the readable viewport, create phase/subprocess
views. Keep the complete truth in the canonical graph.

### Why not bpmn-js in the hot path

[bpmn-js](https://bpmn.io/toolkit/bpmn-js/) is the strongest open formal BPMN
viewer/modeler, but it requires valid BPMN and BPMN-DI. Its companion
[bpmn-auto-layout](https://github.com/bpmn-io/bpmn-auto-layout) documents material
limitations: only the first collaboration participant is laid out; message
flows, groups, annotations and associations are not laid out; subprocesses are
collapsed. It is not a live multi-pool speech-to-layout solution. It also has a
visible attribution requirement; see [bpmn.io licensing](https://bpmn.io/license/).

Use it later for formal BPMN export/editing, not as Scout's first live renderer.

## Organisation view contract

An organisation chart is not a generic network. Its layout authority is a
**primary reporting forest**. Dotted/matrix relationships are a separate visual
layer.

### Position-centric semantic projection

```text
OrganisationProjection
  revision, scope(current|desired)
  people[]
  positions[]: title, incumbent(s), filled|vacant|unknown, orgUnit
  units[]: parentUnit
  primaryReports[]
  secondaryReports[]: functional|project|administrative|matrix|unknown
  memberships[]
```

Rules:

- Positions, people and vacancies are distinct.
- A position has zero or one primary manager for a given scope.
- The primary reporting graph is acyclic.
- Multiple roots are valid; Scout must not invent a CEO.
- A synthetic visual root is allowed but is never stored as business truth.
- Team membership, collaboration or “works with” is not a reporting line.
- Secondary reporting requires explicit evidence and a relationship type.
- Current and desired structures are independently selectable.
- Dotted styling cannot mean both matrix reporting and uncertainty; tentative
  relationships require an additional badge/state treatment.

### Layout policy

- Primary reporting controls a top-to-bottom rooted-tree/forest layout.
- Incoming primary edges use top ports; outgoing primary edges use bottom ports.
- Preserve prior sibling order; insert a new report near its manager.
- Large management spans use compact multi-row or bus placement.
- Primary reporting must have zero crossings.
- Secondary links use side ports and do not influence primary ranks.
- Default to secondary links for the selected position only.
- A “show matrix relationships” control may expose all secondary links when the
  quality gate allows it.
- Org-unit bands/headers are preferable to nested groups unless a unit contains a
  complete reporting subtree. Grouped tree layouts can become invalid when group
  membership cuts across the tree.

### Rendering path

- Immediate MVP: deterministic Mermaid hierarchy, ELK when secondary
  relationships are visible, prior SVG retained.
- Strict-tree fast path after renderer migration: D3 hierarchy for small fixed
  cards. [D3 tree](https://d3js.org/d3-hierarchy/tree) produces a compact tidy
  tree and supports sibling separation.
- Preferred open retained canvas: React Flow + ELK worker.
- Quality benchmark: the [yFiles organisation-chart demo](https://www.yfiles.com/demos/showcase/orgchart)
  combines compact subtrees, filtering, collapse/expand, search and zoom-based
  levels of detail.

### Organisation progressive disclosure

- Small: full position cards and primary reports.
- Medium: compact cards; secondary relationships selected-node only.
- Large: root plus two or three levels, unit-aware collapse and search.
- Low zoom: position title/unit.
- Medium zoom: incumbent, title and state.
- High zoom/selection: full detail in an inspector.

## Architecture view contract

Architecture needs more than a generic `system` node. It requires abstraction
levels, nested boundaries, ports and typed interactions.

### Semantic projection

```text
ArchitectureProjection
  revision, level(landscape|context|container|component|deployment|data-flow)
  focalElementId?
  elements[]:
    person, external-system, software-system, service, application,
    api, gateway, worker, database, data-store, queue, event-bus,
    file-store, integration, device, network, unknown
  boundaries[]:
    organisation, domain, cloud, account, region, environment,
    network, vpc, subnet, cluster, namespace, security-zone
  connections[]:
    direction, sync|async|event|stream|batch|file-transfer|replication|manual,
    protocol?, dataDescription?, state
```

The compiler—not the model—chooses abstraction level, ports, junctions, icon,
label abbreviation, layout direction and fallback grammar.

### Dual Mermaid compiler

Use two render paths from the same projection:

1. `architecture-beta` for small icon-oriented landscape/context overviews.
2. `flowchart` + ELK for protocol-labelled data flow, container views and
   fallback.

Mermaid architecture supports nested groups, services, side-specific ports,
cross-group syntax, junctions, deterministic seeds, icons and `align row|column`.
See [architecture diagrams](https://mermaid.js.org/syntax/architecture.html).

It is not sufficient as the sole production architecture engine:

- edge syntax has no general protocol/data label;
- it uses fCoSE and defaults to 2,500 iterations;
- fixed seed gives repeatability, not incremental position preservation;
- Mermaid documents a sibling-overlap limitation that alignment directives
  mitigate but do not make semantically risk-free;
- contradictory align order can make rendering fail;
- group IDs cannot be direct edge endpoints.

Therefore every architecture-beta render must have a collision gate and an ELK
fallback.

### Deterministic architecture routing

For a left-to-right view:

- normal flow exits right and enters left;
- feedback uses a dedicated lower return channel;
- management/control enters through top ports;
- database/store replication or change streams use right/bottom ports;
- cross-boundary connections cross every boundary exactly once;
- boundary proxies/junctions prevent one edge crossing multiple nested levels;
- more than three edges on one port triggers a junction or detail view;
- multiple relations between the same pair are aggregated only when meaning is
  preserved;
- self-loops move to a focused detail view;
- protocol/data labels remain short and full details move to the inspector;
- dense diagrams show current or desired, not both by default.

ELK Layered is well suited to the fallback because it supports directed layers,
orthogonal routing, explicit ports, compound graphs and cross-hierarchy edges.
See [ELK Layered](https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html)
and [hierarchy handling](https://eclipse.dev/elk/reference/options/org-eclipse-elk-hierarchyHandling.html).

### Architecture view reduction

Initial budgets to calibrate:

- Landscape: 10–12 systems/external actors.
- Context: focal system plus direct neighbours.
- Container: 12–16 services/stores/queues/APIs inside one system.
- Data flow: one scenario or datum only.
- Deployment: environment/cloud/network/runtime boundaries; no business-process
  tasks.
- No more than two visible nested boundary levels.

This follows the model/view separation of
[Structurizr DSL](https://docs.structurizr.com/dsl/language) without making
Structurizr Scout's runtime source of truth.

## Icon system and licensing

The model should output a semantic type and, when explicitly supported, vendor
and product. It must never output an arbitrary icon URL.

### Versioned local registry

```text
IconRegistryEntry
  semanticKey
  pack
  iconName
  sourceVersion
  licenseId
  sourceUrl
  attributionRequirement
  brandGuidelinesUrl?
  reviewedAt
```

Resolution order:

1. Locally bundled generic Scout icon by semantic type.
2. Mermaid built-in cloud/database/disk/internet/server when sufficient.
3. Curated vendor icon only when vendor/product is explicit in evidence.
4. Generic fallback and visible text label.

[Tabler Icons](https://github.com/tabler/tabler-icons) is a strong MIT-licensed
generic base. Mermaid can register local Iconify JSON packs; see
[icon registration](https://mermaid.js.org/config/icons). Bundle and pin packs
locally rather than fetching a CDN/API during rendering.

Vendor packs need individual review:

- [AWS architecture icons](https://aws.amazon.com/architecture/icons/) publish
  official packages and usage guidance.
- [Azure architecture icons](https://learn.microsoft.com/en-us/azure/architecture/icons/)
  permit specified diagram/documentation uses and prohibit distortion and some
  representational uses.
- [Google Cloud icons](https://cloud.google.com/icons) provide official product
  assets.
- Simple Icons' repository license does not remove individual trademark and
  brand restrictions; see its [disclaimer](https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md).

Icons never replace labels or accessible names.

## Multi-view user-interface contract

### Stable shell

- Three stable tabs: **Process**, **Organisation**, **Architecture**.
- Each tab shows last committed graph revision and a new-information badge.
- Toolbar: zoom, fit, reset, search and follow-live toggle.
- Current/Desired selector within Process and Organisation/Architecture where
  applicable.
- Right-side inspector shared across views for selected entity, claims,
  relationships and transcript evidence.
- View-specific legend.
- Honest empty states such as “No explicit reporting structure has been heard
  yet.”
- Conditional minimap only when the view is larger than the viewport.

### Independent retained state

```text
ViewRuntimeState
  latestRequestedRevision
  committedRevision
  semanticHash
  clean|dirty|rendering|failed
  cachedArtifact
  viewport(x,y,zoom)
  collapsedIds
  selectedEntityId
  followLive
```

Runtime rules:

1. Project all views semantically after each accepted graph.
2. Skip a view if its semantic hash did not change.
3. Render the active tab first.
4. Mark changed inactive views dirty and retain their cached artifact.
5. Pre-render inactive views during idle time or on first activation.
6. On activation, display the cache immediately, then stage the latest revision.
7. Discard any result whose revision token is stale.
8. Preserve viewport, selection, collapse and keyboard focus per tab.
9. Fit only on the first useful render, explicit reset or material scope change.
10. Never auto-switch after the user has chosen a tab; show a badge instead.
11. Cross-highlight a shared entity across views when possible.

The W3C [tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/)
recommends automatic activation only when panel display has no noticeable
latency. Cached artifacts make fast automatic activation possible; otherwise use
manual activation.

### Selection and evidence

The diagram is a summary, not the evidence display. Selecting a node or edge
opens:

- full label and description;
- state and support band;
- owner/parent/boundary;
- incoming/outgoing relationships;
- cited customer utterances;
- contradiction or unresolved question.

This lets canvas labels stay short while preserving explainability.

### Animation

- Briefly fade/highlight added or changed elements.
- Never animate continuously flowing edges.
- With a retained renderer, animate only changed nodes and routes.
- For a major relayout or Mermaid replacement, crossfade complete artifacts
  rather than tween nodes through one another.
- Respect `prefers-reduced-motion` and never animate inactive tabs.

## Rendering and latency architecture

### End-to-end reality

Recall low-latency English transcript events typically arrive 1–3 seconds after
an utterance is finalized. The current Scout coordinator then waits eight more
seconds before the first analysis turn. See [Recall transcription modes](https://docs.recall.ai/docs/recallai-transcription).

This means “real time” cannot be solved by a faster graph renderer alone.
Measure four independent intervals:

```text
speech end → finalized transcript
final transcript → analysis turn start
turn start → accepted canonical graph
accepted graph → visible active-tab artifact
```

The first research change should be an adaptive finalized-utterance cadence,
not partial-transcript analysis. A short trailing debounce can combine adjacent
finals, while backpressure coalesces finals received during an active turn.

### Mermaid scheduling limitation

Mermaid serializes `render()` calls through a global execution queue. Three tabs
cannot be assumed to render in parallel through one Mermaid instance. See the
[Mermaid render implementation](https://github.com/mermaid-js/mermaid/blob/develop/packages/mermaid/src/mermaid.ts).

Therefore:

- compile all three projections cheaply;
- render only the active changed tab immediately;
- render inactive tabs during idle time;
- keep at most one latest queued render per tab;
- cache artifacts by view, scope, semantic hash, theme and viewport class;
- preload fonts and icon packs once;
- avoid shadows, filters, gradients and continuous animation;
- retain each tab's prior SVG independently.

### Future retained-canvas performance

React Flow is the preferred open UI shell, but performance depends on disciplined
state usage. Its official guidance recommends memoizing components/handlers,
avoiding subscriptions to entire node arrays, collapsing large trees and
simplifying styles. See [React Flow performance](https://reactflow.dev/learn/advanced-use/performance).

ELK.js supports Web Workers specifically to prevent layout from freezing the UI.
See [ELK.js](https://github.com/kieler/elkjs). It computes positions and routes;
the retained renderer owns DOM/SVG presentation and animation.

Only render visible elements when measurements show it helps; virtualization has
its own bookkeeping cost. Preserve fixed node dimensions and independent view
state to avoid remeasurement.

## Accessibility

A visual diagram cannot be the only representation.

Every tab should also expose:

- semantic title and description;
- searchable outline/table;
- concise node and relationship accessible names;
- throttled live summary such as “Process updated: two steps and one handoff
  added.”

For a future read-only React Flow view, nodes can be focusable while every edge
need not become a separate tab stop. Remove editor-specific delete/move
instructions. React Flow provides focus, automatic panning, ARIA roles and
customizable live messages; see [accessibility](https://reactflow.dev/learn/advanced-use/accessibility).

Mermaid supports accessible title and description directives. Lines, nodes and
controls must not rely on colour alone. Diagrams are allowed two-dimensional
scrolling under WCAG's reflow exception, but the rest of the page should still
reflow; see [WCAG 2.2](https://www.w3.org/TR/WCAG22/).

## Performance and quality targets

These are benchmark targets, not claims about current behavior.

### Active view

- Projection/compiler: p95 ≤ 5 ms.
- Mermaid render at demo density: p95 ≤ 200 ms.
- Cached tab activation: ≤ 50 ms.
- No single active-tab main-thread task over 50 ms.
- No stale revision commits.

### Geometry

- Zero node-node overlap.
- Zero edge intersections through nonincident nodes.
- Zero edge intersections through lane/group titles.
- Zero clipped primary labels.
- Zero primary-report crossings.
- Edge-edge crossings minimized; unavoidable crossings use line hops or a
  reduced/focused view.

### Stability

- At least 95% stable-ID survival for unchanged concepts.
- No automatic viewport reset after first render.
- No unrelated branch reorder for a one-fact revision.
- Unchanged-node median movement below 10% of viewport dimensions until a
  retained renderer supports stricter from-sketch layout.
- Keyboard focus survives when the selected semantic entity survives.

### Reliability

- Renderer/fallback failure below 0.5%.
- Every rejected geometry records its failure class and chosen fallback.
- Each view independently retains its previous accepted artifact.

## Worked multi-view simulation

Finalized customer evidence arrives:

1. “Sales enters the order into Salesforce and emails Finance.”
2. “The Finance Manager reports to the CFO and approves orders over ten
   thousand pounds.”
3. “Operations rekeys approved orders into SAP; that causes mistakes.”
4. “We want an integration service to publish approved orders to a queue and SAP
   should consume them.”

### Process tab

- Lanes: Sales, Finance, Operations/System.
- Current: enter order → email → value gateway → approve → rekey into SAP.
- Desired: publish to queue → consume in SAP, selected with the Target toggle.
- The rekeying pain is a badge/inspector annotation, not a layout node.

### Organisation tab

- Finance Manager → CFO is a primary reporting edge.
- Sales, Finance and Operations appear as units/positions only when evidence
  supports their structure.
- No line is inferred between Sales and Finance merely because work is handed
  off.

### Architecture tab

- Salesforce → current email/manual integration → SAP.
- Desired: integration service → queue → SAP.
- Current and desired are filtered rather than fully overlaid in a dense view.
- Vendor icons are used only because Salesforce and SAP were explicit; otherwise
  generic application icons are used.

One shared entity selection connects the stories without merging them into one
unreadable canvas.

## Implementation decision sequence after research approval

No application implementation is performed on this branch.

### 0. Freeze evaluation truth

- Create transcript-to-canonical-graph gold revisions.
- Create gold Process, Organisation and Architecture projections.
- Record current semantic, geometry, stability and latency baselines.

### 1. Specify projections and validators

- Approve the domain contracts and shared identity/evidence model.
- Add deterministic semantic invariants for each view.
- Add many-to-many view membership and current/desired scopes.

### 2. Build the geometry gate before polishing

- Detect actual SVG/route collisions.
- Record deterministic fallback selection.
- Add golden visual fixtures for dense, cyclic and ambiguous cases.

### 3. Ship the multi-view Mermaid path

- Native swimlane process compiler plus ELK fallback.
- Organisation primary forest plus selected secondary overlay.
- Architecture overview/data-flow dual compiler.
- Per-view state, semantic hashes, caches and active-first scheduler.
- Local versioned icon registry.

### 4. Benchmark retained renderers

- React Flow + direct ELK.js worker as the open candidate.
- yFiles evaluation as the incremental-layout quality ceiling.
- Migrate only if measured stability, interaction or geometry gains justify the
  contract and dependency change.

### 5. Consider runtime specialists only after the single-call baseline

- Use manager-style agents-as-tools, never independent authorities.
- Trigger only affected specialists.
- Apply strict deadline/fallback and evidence/reference validation.
- Keep the first visible update independent of specialist completion.
- Retain runtime specialists only if replay evaluations demonstrate material
  semantic gains after accounting for latency and cost.

## Final recommendation

The best implementation for Scout is not “three AI agents drawing three
diagrams.” It is:

> **one evidence-grounded canonical analyst, three specialist-owned deterministic
> semantic projections, three diagram-specific layout compilers, an independent
> geometry gate, and three retained tab states updated active-view first.**

This design is fast because it avoids redundant inference and serial Mermaid
work. It is accurate because all views share one identity/evidence authority. It
is clear because each tab tells one kind of story. It is sustainable because a
future React Flow + ELK or yFiles renderer can replace the visual layer without
rewriting the canonical meeting intelligence.
