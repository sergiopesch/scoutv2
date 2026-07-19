# Generative diagram research for Scout V2

**Status:** research decision paper; no implementation

**Date:** 2026-07-19

**Branch:** `sergiopesch/research-generative-diagrams`

> **Second-stage research:** The post-implementation layout, multi-view UI,
> specialist-ownership and performance investigation is documented in
> [live-multi-view-diagram-blueprint.md](./live-multi-view-diagram-blueprint.md).
> It refines some first-stage conclusions, particularly the limits of
> `architecture-beta` and the distinction between specialist ownership and
> runtime subagents.

## Executive decision

Scout should become a **semantic diagram compiler**, not an AI drawing tool.

The recommended near-term architecture is:

```text
final attributed speech
        ↓
one persistent Codex meeting thread
        ↓
complete, evidence-grounded, view-aware BusinessGraph
        ↓
deterministic semantic + revision validation
        ↓
atomic accepted graph replacement
        ↓
diagram-kind-specific deterministic Mermaid projection
        ↓
off-screen render → atomic SVG replacement over SSE
```

This keeps the strongest parts of the MVP intact and addresses the real quality
problems. A renderer cannot recover a missing decision, incorrect owner,
inverted dependency, or hallucinated reporting line. Conversely, accurate
extraction will still look crude when process, organisation and architecture
semantics are forced through one generic `flowchart TB` template.

The best immediate path is therefore:

1. Retain `BusinessGraph` as canonical truth and retain complete graph
   replacement.
2. Add explicit diagram intent and the smallest diagram-neutral semantics needed
   for containers, hierarchy, lanes, ordering, conditions and boundaries.
3. Strengthen identity resolution, correction handling, evidence rules and
   deterministic semantic validation.
4. Compile the accepted graph with separate process, organisation, architecture
   and relationship projection profiles.
5. Use the Mermaid 11.16 capabilities already installed before introducing a
   new production renderer.
6. Judge every alternative against a replayable utterance-by-utterance
   evaluation corpus, including semantic accuracy and layout stability—not just
   attractive final screenshots.

The strongest open-source future renderer is **React Flow + ELK.js**. The
quality-ceiling commercial benchmark is **yFiles for HTML**, chiefly because of
its explicit incremental-layout support. Neither should replace Mermaid in the
MVP before the semantic and evaluation layers are fixed.

## Non-negotiable Scout constraints

This recommendation deliberately preserves the MVP contract:

- Recall supplies finalized attributed utterances.
- There is one persistent Codex app-server thread per meeting.
- A turn receives the current accepted graph and only the newly finalized
  utterances.
- A turn returns a complete `BusinessGraph` via `turn/start.outputSchema`.
- The server validates and atomically replaces the graph, incrementing the
  revision.
- The browser fully rerenders Mermaid and keeps the previous SVG until the new
  SVG succeeds.
- Server-to-browser delivery remains SSE.

It does **not** propose graph patches, a database, runtime subagents,
partial-transcript analysis, a native app, or a third-party diagram SaaS in the
confidential meeting path.

## What Scout does today

### Current pipeline

```text
Recall final transcript event
  → analysis coordinator batches new finals (8 s initial / 2 s rerun defaults)
  → Codex turn receives current graph, participants and new utterances
  → strict structured output is parsed and Zod-validated
  → customer-evidence and graph-reference checks
  → session store appends graph.accepted and increments revision
  → browser receives snapshot over SSE
  → every graph is compiled to Mermaid `flowchart TB`
  → Mermaid produces a staged SVG
  → revision renderer commits only after successful rendering
```

### Strong foundations worth keeping

- **Final-only speech:** avoids churn caused by ASR partial revisions.
- **Persistent meeting context:** supports continuity without resending the
  transcript.
- **Structured output:** `turn/start.outputSchema` constrains the result to the
  graph shape. OpenAI notes that Structured Outputs enforces schema adherence,
  while semantic mistakes can still occur; that distinction is central here.
  See [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
- **Canonical graph rather than model-authored Mermaid:** keeps meeting meaning
  independent from one visual syntax.
- **Customer-only evidence:** operator suggestions cannot silently become facts.
- **Atomic graph and SVG replacement:** viewers see a stale valid diagram rather
  than a broken intermediate state.
- **Small attack surface:** the analysis thread disables tools, network, apps,
  plugins and runtime multi-agent behavior.

### Why the result is crude

The dominant defects are upstream of—or inside—the projection, not SSE or
atomicity.

#### 1. One generic grammar is used for every diagram

`public/js/mermaid-graph.js` emits `flowchart TB` for every graph. Actors, teams,
systems, processes, decisions and artifacts get different shapes, but they all
share one topology and one layout profile. This cannot faithfully express:

- process lanes, phases, gateways, loopbacks and conditions;
- organisation hierarchy, dotted-line reporting and vacancies;
- architecture boundaries, nested containers, ports and protocols;
- non-hierarchical stakeholder or dependency maps.

Pains become extra topology nodes and contradictions float disconnected. Both
can distort layout even though they are annotations rather than business-flow
steps.

#### 2. The canonical schema lacks rendering-relevant semantics

The current graph has node `kind`, `state`, label, confidence and evidence; edge
`kind`, state, label, confidence and evidence. It has no explicit:

- diagram intent;
- parent/container or hierarchy relationship;
- lane/owner distinct from a generic `owns` edge;
- process ordering, gateway type or branch condition;
- system boundary, interface, protocol or directionality constraints;
- primary path, importance, label-shortening or annotation placement hints.

The 10-node and 20-edge limits are also presentation limits masquerading as
knowledge-model limits. They make a clean 1280×720 board possible, but force the
model to omit facts when a meeting becomes richer.

#### 3. The prompt asks for correctness without defining update semantics

The instruction to preserve supported facts and stable IDs is good, but the
model is not given a precise policy for:

- reaffirming versus refining a concept;
- renaming without changing identity;
- merging aliases;
- explicit correction or supersession;
- ambiguity and contradictions;
- what may be removed and what must remain;
- choosing process versus org versus architecture presentation.

New customer utterances and operator context are serialized into separate
arrays. That enforces role separation but loses conversational adjacency. “Yes,
exactly” is harder to interpret safely when separated from the operator question
it confirms. A chronological array with an explicit role and a separate
customer-only evidence policy would preserve both safety and dialogue meaning.

#### 4. Validation is syntactic and referential, not semantic or revision-aware

Current checks catch schema violations, duplicate entity IDs, dangling edges,
missing pain targets and invalid evidence IDs. They do not catch:

- duplicate concepts with new IDs;
- self-loops or duplicate semantic edges;
- a `reports_to`-like relationship in the wrong direction;
- unsupported removal of an unchanged fact;
- ID churn after a label refinement;
- a current-state fact surviving an explicit correction;
- inferred organisational hierarchy presented as asserted truth;
- process dead ends, unreachable steps or malformed gateways.

There is also a subtle evidence-liveness problem: the analyzer accepts older
evidence IDs only when they remain cited somewhere in the current graph. If an
older supported fact is omitted, its evidence ID drops out of the valid set and
cannot later be reintroduced, even though the persistent Codex thread saw it.
The safe remedy is a thread-local registry of previously supplied finalized
customer utterance **IDs**. It need not resend transcript text or add a database.

#### 5. Layout is deterministic only in a narrow sense

Objects are sorted by model-provided ID, then assigned generated identifiers
such as `node_0`. A newly inserted lexically earlier ID renumbers later rendered
elements. There are no stable prior positions, containers, layout seed,
diagram-specific orientation or viewport-continuity rules. Curved edges and
single-line long labels amplify crossings and shrink the full SVG.

The whiteboard CSS fits every SVG into the viewport. As the graph grows,
everything becomes smaller. There is no preserved zoom/pan or “show new item”
behavior.

#### 6. Model effort and cadence are unmeasured quality levers

Scout defaults to `gpt-5.6-sol` at low reasoning effort. Low effort is sensible
for latency, but should not be assumed optimal for correction-heavy semantic
modeling. Benchmark low versus medium on the same replay corpus. Do not choose by
anecdote.

The fixed 8-second initial delay and 2-second rerun delay are transport cadence,
not semantic cadence. Later research should compare turns at finalized sentence,
pause and topic-boundary moments while continuing to exclude partial speech.

## 2026 capability already present in Scout

Scout already installs Mermaid 11.16.0, but uses only its generic flowchart
grammar and default Dagre-style behavior. The installed version includes useful
capabilities that require no new production dependency:

- selectable [layout engines](https://mermaid.js.org/config/layouts.html),
  including ELK and other registered layouts;
- native [swimlane diagrams](https://mermaid.js.org/syntax/swimlanes.html), new
  in 11.16, with lanes, tasks, decisions and cross-lane handoffs;
- [architecture diagrams](https://mermaid.js.org/syntax/architecture.html), with
  groups, services, junctions and newer row/column alignment controls;
- deterministic configuration hooks and a browser parser/render API.

Swimlane and architecture syntaxes are beta. Scout should use a feature flag and
a flowchart+ELK fallback rather than make a beta grammar the only path. Mermaid's
TreeView is directory-oriented rather than a true organisation-chart grammar;
org charts still need a deterministic hierarchy projection.

This is the highest-leverage discovery: the near-term demo can become much more
expressive without first migrating the rendering shell.

## Recommended semantic model direction

This is a research shape, not an implementation specification. The aim is the
smallest model that separates business truth from presentation.

### Canonical meaning

- `diagramIntent`: `process | organization | architecture | relationship |
  mixed | unknown`, including why the intent is supported.
- Stable entities with aliases and a canonical immutable ID.
- Parent/container membership for teams, systems and architectural boundaries.
- Explicit hierarchy edges such as `reports_to` only when evidence supports
  them.
- Process semantics: step, event, gateway, owner/lane, order, branch condition
  and optional artifact input/output.
- Architecture semantics: boundary, component/service, interface/data flow,
  protocol when stated, current/desired state.
- Claim provenance: support, contradiction and whether the statement is
  explicit, inferred or unresolved.

### Projection meaning

- A chosen primary view for the current meeting moment.
- Visible versus summarized elements for the 1280×720 board.
- Annotation references for pains and contradictions so annotations do not
  alter primary topology.
- Optional label short form and importance—not model-authored positions.

Do not store renderer syntax or coordinates as canonical truth. Layout remains a
deterministic projection concern.

### Identity and update policy

For each new mention:

1. Match exact stable ID when available.
2. Match normalized label or known alias with a compatible semantic kind.
3. Compare a bounded candidate set using type and local graph neighborhood.
4. If still ambiguous, preserve both possibilities as unresolved or ask a
   question; do not silently create or merge.
5. Treat the utterance as one of `reaffirm`, `refine`, `supersede`,
   `contradict` or `no-op` internally.
6. Return the complete graph, never a patch.

Stable IDs must never be derived from mutable labels.

## Diagram-specific Mermaid projections

| Intent | Primary live projection | Layout/profile | Fallback |
|---|---|---|---|
| Business process | Mermaid `swimlane-beta` when its supported subset is sufficient | lanes by actor/team/system; explicit decisions and conditions; left-to-right flow | flowchart with subgraphs + ELK |
| Architecture | Mermaid `architecture-beta` | explicit groups/boundaries, orthogonal relationships, deterministic seed/options | flowchart with nested subgraphs + ELK |
| Organisation | deterministic hierarchy compiler to Mermaid flowchart/subgraphs | rooted top-down tree; solid/dotted reporting styles; stable sibling order | ELK or Dagre tree profile |
| Relationship/dependency | Mermaid flowchart | ELK for structured graphs; CoSE-family layout only for truly non-hierarchical maps | Dagre for small directed maps |
| Mixed discovery | one selected primary view plus annotations | show the view that answers the current discussion; avoid putting every semantic kind into one canvas | generic ELK flowchart |

Projection rules should be deterministic and testable:

- stable rendered IDs mapped from stable graph IDs;
- stable input and sibling order;
- fixed fonts, wrapping, spacing, orientation and random seed;
- edge styles derived from state, not edge kind conflation;
- pains and contradictions rendered as badges/callouts linked by metadata;
- retained zoom and pan after the first fit;
- new content highlighted without resetting the whole viewport;
- old SVG retained until parse and render both succeed.

## Worked speech simulation

Consider these finalized customer statements arriving over three turns:

1. “Sales enters an order in the CRM and emails Finance.”
2. “Finance only approves orders above ten thousand pounds; Operations then
   rekeys approved orders into the ERP.”
3. “The rekeying causes mistakes. We want the CRM to send approved orders to
   the ERP automatically through a webhook.”

### What the current projection tends to do

It can create Sales, CRM, Finance, Operations, ERP and perhaps an approval
decision, then connect them in one top-to-bottom graph. It cannot encode Finance
and Operations as lanes, the threshold as a branch condition, email as a current
handoff, webhook as a desired interface, or CRM/ERP as system boundaries. A pain
node adds another edge and perturbs layout.

### What a view-aware graph enables

**Process view**

```text
Sales lane       Enter order in CRM ──email──▶
Finance lane                              [value > £10k?] ─▶ Approve
Operations lane                                                ─▶ Fulfil
System context    CRM                         current rekeying       ERP
```

The rekeying problem is an annotation on the handoff. The desired webhook is a
visually distinct desired-state route.

**Architecture view**

```text
[CRM boundary] ── current: email/manual rekey ──▶ [ERP boundary]
       └──────── desired: approved-order webhook ────────┘
```

**Organisation view**

No org chart is emitted, because the speech names collaborating teams but says
nothing about reporting hierarchy. This abstention is a mark of accuracy.

The same evidence-grounded truth can therefore support distinct projections
without asking the model to invent Mermaid syntax or coordinates.

## Evaluation programme

The evaluation must replay finalized utterances one at a time and compare every
accepted revision with a gold revision. A polished final diagram alone hides the
live product's most important failures.

### Corpus

Create 30–50 synthetic or explicitly consented scenarios, with gold graph states
every one to three customer utterances:

- branched business process with merge, loop, ownership and swimlanes;
- organisation with 15–25 people, vacancies and dotted-line reporting;
- nested architecture with boundaries, components and cross-boundary flows;
- non-hierarchical stakeholder/dependency map;
- ambiguous names, pronouns and aliases;
- operator suggestion followed by customer acceptance or rejection;
- correction, retraction, rename and contradiction;
- repeated information that should cause no graph change;
- irrelevant small talk and malicious transcript instructions;
- ASR-like punctuation, number and homophone errors.

### Semantic metrics

- node and edge precision/recall/F1, including type and direction;
- alias-aware entity resolution and duplicate-concept rate;
- state accuracy: current, desired, hypothesis, unknown;
- owner/lane, decision and condition accuracy;
- evidence precision/recall and unsupported-claim rate;
- correction/contradiction resolution and omission rate;
- graph edit similarity using node and path alignment. DiagramEval's graph-based
  approach is a useful basis: [DiagramEval, EMNLP 2025](https://aclanthology.org/2025.emnlp-main.640/).

### Revision metrics

- stable-ID survival for unchanged concepts;
- unchanged-claim preservation;
- unsupported deletion rate;
- no-op graph churn;
- stale facts remaining after explicit correction;
- retained-node displacement and rank/order inversion;
- number of unrelated nodes moved per new fact.

### Visual and runtime metrics

- parse/render success;
- overlap, clipping, crossings, unnecessary bends and boundary crossings;
- time to accepted graph and time to visible SVG at P50/P95;
- main-thread blocking;
- viewport movement;
- whether a reviewer can identify the newly spoken concept within two seconds;
- task comprehension: “who owns this?”, “what happens next?”, “where is the
  current pain?”, “which systems cross this boundary?”

### Initial acceptance gates

These are deliberately demanding demo targets and should be calibrated with the
first corpus:

- 100% schema and deterministic invariant validity;
- at least 98% valid evidence references;
- no more than 2% unsupported displayed claims;
- at least 95% stable-ID survival for unchanged concepts;
- no more than 5% unrelated graph churn;
- at least 98% structurally sound process revisions;
- below 0.5% renderer failure;
- zero clipped primary labels or node overlaps in demo-scale fixtures.

### Ablations to run before implementation choice

Use the exact same transcript replays and graph schema for:

1. Current low-effort prompt and current renderer.
2. Strong update policy, low effort, current renderer.
3. Strong update policy, medium effort, current renderer.
4. View-aware schema/prompt with Mermaid per-kind profiles.
5. The same accepted gold graphs rendered by React Flow + ELK, Cytoscape + ELK
   and a yFiles evaluation build.

This separates model quality, semantic model quality and renderer quality.

## Delivery sequence after this research branch

No implementation is performed here. If the team approves the direction, the
lowest-risk sequence is:

### Phase 0 — measurement first

- Freeze the replay corpus and gold revisions.
- Record current semantic, revision, visual and latency baselines.
- Add screenshot/visual-regression coverage and actual Mermaid parse/render
  coverage rather than only source-string tests.

### Phase 1 — semantic correctness

- Specify diagram intent, hierarchy/container, lane/owner, decision/condition
  and provenance semantics.
- Define identity, correction, deletion and no-op rules in the prompt.
- Preserve chronological conversational adjacency while retaining
  customer-only evidence checks.
- Add deterministic semantic and revision gates.
- Benchmark low versus medium reasoning effort.

### Phase 2 — no-new-dependency rendering profiles

- Compile process, organisation, architecture and relationship views
  separately.
- Evaluate Mermaid 11.16 swimlane and architecture beta syntaxes behind
  fallbacks.
- Add ELK layout profiles, stable rendered IDs, deterministic configuration,
  annotations and viewport continuity.

### Phase 3 — renderer bake-off only if metrics require it

- Prototype React Flow + ELK.js in a worker as the open-source retained-canvas
  candidate.
- Use a yFiles trial as the live-layout quality benchmark.
- Evaluate bpmn-js only for formal BPMN output and Structurizr/D2 only for
  architecture artifact/export modes.
- Migrate the production renderer only when a candidate wins agreed metrics by
  enough to justify the operational and licensing cost.

## Approaches to avoid

- Direct LLM-to-Mermaid/DOT/D2 as canonical state.
- A second unconstrained generative call that “beautifies” the graph.
- Coordinates or renderer syntax in the canonical business model.
- Random force layouts for formal process, org or architecture views.
- Automatically fitting the whole viewport after every revision.
- Conflating low ASR quality, semantic extraction errors and layout errors.
- Sending confidential live meeting content to diagram-generation SaaS.
- Adding BPMN, C4 and generic graph concepts to one overloaded canvas.
- Replacing Mermaid before a replay corpus proves the renderer is the limiting
  factor.

## Final recommendation

For the next Scout demo, the winning combination is:

> **final attributed speech → stronger evidence-grounded complete BusinessGraph
> → deterministic process/org/architecture compiler → Mermaid 11.16 specialized
> grammar with ELK-backed fallbacks → atomic live SVG updates.**

That path is compatible with the current architecture, needs no new production
dependency for the first meaningful improvement, keeps confidential speech
inside Scout, and leaves a clean migration path to React Flow + ELK or yFiles if
incremental visual continuity becomes the measured bottleneck.

The accompanying ecosystem catalogue records the alternative libraries,
licenses, roles and primary sources: [generative-diagram-ecosystem.md](./generative-diagram-ecosystem.md).
