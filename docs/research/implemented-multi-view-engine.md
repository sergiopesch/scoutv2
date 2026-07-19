# Scout V2 multi-view diagram engine — implementation handoff

## Outcome

Scout now turns one evidence-backed `BusinessGraph` into three independently
retained live views:

- Process: pools, lanes, activities, events, gateways, messages and sequences.
- Organisation: units, people/positions, vacancies, primary reports, secondary
  reports and deterministic unit placement.
- Architecture: boundaries, systems, components, stores, queues and labelled
  connections.

The model never emits coordinates or three competing presentation graphs. It
updates one complete canonical graph. Deterministic projectors, compilers and a
geometry acceptance gate own presentation.

## End-to-end path

```text
finalized attributed utterances
        |
        v
persistent Codex meeting thread
  - prior accepted graph
  - only new finalized utterances, in chronological order
  - customer-only evidence ledger
        |
        v
complete model-output BusinessGraph
  - strict model schema
  - reference + evidence + semantic validation
  - stable identity guard
        |
        v
atomic graph replacement + revision / roleRevision
        |
        v
SSE whiteboard snapshot through an explicit public allowlist
        |
        v
three deterministic projections
        |
        v
active-first serial Mermaid candidate rendering
        |
        v
attached off-screen SVG measurement + geometry gate
        |
        +---- accepted -> atomic per-view commit
        |
        +---- rejected -> next candidate / retained prior artifact + retry
```

## Canonical semantic contract

Facet presence is the sole authority for new view membership. A node or edge
may carry multiple facets when one real identity has several evidenced roles.
Legacy generic nodes remain projectable when facets are absent.

Temporal applicability and epistemic certainty are independent:

- `scope`: `current | desired | both`
- `certainty`: `asserted | hypothesis | unknown | conflicted`

The required legacy `state` remains a compatibility summary. New model output
must include scope and certainty, and semantic validation rejects inconsistent
combinations.

Scoped moves do not duplicate identity:

- Process ownership/lane/pool: `placement.current|desired`
- Organisation unit and vacancy: `unitNodeIdByScope` and
  `positionStatusByScope`
- Architecture containment: `parentBoundaryNodeIdByScope`

For an entity with `scope: both`, a current scoped value is the desired fallback
unless an explicit desired override is present.

## Foundation invariants

- Only the exact empty server bootstrap may omit topic evidence.
- Model output always requires topic evidence.
- Model-emitted nodes, edges and pains always require scope and certainty.
- IDs are globally unique across graph entities.
- Evidence, aliases and pain targets are unique and bounded.
- Every accepted reference exists and applies in the same scope.
- Process lanes and pools are typed referenced graph nodes, not strings.
- Lane and direct-pool references cannot conflict.
- Sequence flow cannot cross pools; message flow must cross known pools.
- Starts have no incoming process edge; ends have no outgoing process edge.
- Documents/data stores use association edges rather than control flow.
- Primary reporting is a per-scope forest with at most one manager.
- Reporting connects matching person/person or position/position types, never
  units.
- Unit hierarchy and architecture containment are acyclic per scope.
- Architecture containment has one authority: the contained node's scoped
  parent field. It is never duplicated as a model edge.
- Current/desired pains can target only nodes present in the same scope.
- Browser snapshots are explicit deep copies. Evidence, aliases, utterances,
  participants, meeting URLs, Recall state and Codex state never reach the
  whiteboard.

## Rendering strategy

One coordinator serializes Mermaid because Mermaid rendering uses shared global
state. The active view always receives priority. Inactive dirty views enter the
queue only from idle work. Currency includes `roleRevision`, graph revision,
view, scope, generation and semantic hash, so an operator correction that
resets revision to zero cannot resurrect an old artifact.

Candidate chains:

| View | Candidate order |
| --- | --- |
| Process | native swimlane, wider swimlane, ELK flowchart, wide dagre |
| Organisation | wide dagre hierarchy, wide ELK hierarchy |
| Architecture | native architecture for small unlabelled overviews, grouped ELK, grouped dagre, flat boundary-preserving fallback |

The final architecture fallback converts boundaries into explicit nodes and
derives containment links. It preserves boundary meaning when a nested cluster
layout cannot route connections without crossing a group title.

## Geometry acceptance

Every candidate is attached to a non-zero off-screen stage. Scout waits for
fonts and an animation frame, samples the rendered SVG, and rejects hard
readability defects:

- non-finite geometry;
- node overlap;
- non-incident edge-through-node intersections;
- edge-through-lane/group-title intersections;
- clipped or colliding primary labels;
- primary organisation reporting crossings;
- missing measured nodes.

Edge-edge crossings outside the primary reporting tree remain a scored soft
metric. A failed candidate never clears the last accepted artifact.

## Browser and accessibility behavior

- WAI-ARIA tablist with arrow, Home and End navigation.
- Independent current/target scope, zoom, follow-live and retained view state.
- Searchable outline equivalent for every rendered diagram.
- Keyboard-selectable diagram and outline entities.
- Inspector with kind, scope, certainty, incoming/outgoing counts and friction.
- Per-view update badges, busy state, atomic error retention and explicit retry.
- Full labels remain in accessible content even when short labels are rendered.

## Verification evidence

The implemented browser fixture exercised a two-lane order process, two
organisation trees with a vacancy, nested architecture boundaries and four
labelled connections through the real installed Mermaid runtime.

Observed committed profiles:

| View | Profile | Entities | Edge crossings | Hard geometry defects |
| --- | --- | ---: | ---: | ---: |
| Process | `process-swimlane-v1` | 6 | 0 | 0 |
| Organisation | `organization-dagre-v1` | 6 | 0 | 0 |
| Architecture | `architecture-flat-boundaries-v1` | 5 + 2 boundaries | 1 | 0 |

The browser run also verified scope switching, outline selection, inspector
updates, keyboard tab navigation, retained revisions and zero console warnings
or errors.

The final automated gate passed 278 tests across 26 files, TypeScript
validation, production compilation and `git diff --check`. This includes exact
regressions for same-hash in-flight revisions, compiler edge omission,
post-SVG semantic edge coverage, focus restoration and edge-label contrast.

At the 32-node contract ceiling, semantic validation measured approximately
0.02 ms p95 locally. A maximally populated nullable structured-output example
was about 32.5 KB (roughly 8,100 tokens). This confirms validation is negligible
and complete-graph model generation is the dominant latency to monitor.

## Operational boundary

This implementation stays inside the Scout MVP contract: no graph patches,
runtime subagents, database, partial transcript analysis, json-render layer or
native application. The conceptual Process, Organisation and Architecture
"teams" are deterministic projection/compiler modules behind one canonical
meeting analyzer and one persistent Codex thread.

## Next measurement, not a correctness blocker

Production hardware still needs a repeatable speech-finalization-to-visible
benchmark. Record transcript finalization, Codex completion, projection,
candidate render, geometry validation and commit separately. Complete-graph
generation time—not the local projection or validator—is expected to dominate.

The semantic projection cache currently uses a compact 32-bit FNV hash. The
meeting turn budget makes a collision very unlikely, but a future higher-volume
version should confirm the canonical projection string or move to a wider hash.
Pains and contradictions also participate in the artifact hash today; splitting
diagram geometry from inspector-only metadata would avoid some harmless
rerenders. Mermaid DOM adapters intentionally fail closed on missing measured
nodes or edges and must be revalidated whenever Mermaid is upgraded.
