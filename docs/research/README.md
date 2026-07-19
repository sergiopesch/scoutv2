# Live diagram engineering notes

These documents capture the evidence, decisions, implementation contract, and
quality standards behind Scout's live Process, Organisation, and Architecture
views. The production source of truth remains the validated `BusinessGraph` and
the executable tests; these notes explain why the implementation is shaped this
way and where its extension seams are.

## Start here

1. [Implemented multi-view engine](implemented-multi-view-engine.md) — the
   shipped pipeline, concurrency rules, projection model, browser behavior,
   verification, and known residual risks.
2. [Live multi-view blueprint](live-multi-view-diagram-blueprint.md) — the full
   target architecture for transcript classification, specialized diagram
   semantics, rendering, interaction, latency, and agent ownership boundaries.
3. [Layout quality gate](layout-quality-gate.md) — measurable acceptance rules,
   fallback policy, regression corpus, and performance budgets.
4. [Generative diagram investigation](generative-diagrams-investigation.md) —
   Scout's original-state audit, evaluated architecture, and delivery roadmap.
5. [Renderer ecosystem](generative-diagram-ecosystem.md) — comparison of Mermaid,
   React Flow, ELK.js, BPMN tooling, commercial SDKs, and generative services.
6. [Post-call editing and Codex handoff](post-call-codex-handoff.md) — explicit
   review approval, full-snapshot edits, revision-locked package publication,
   security boundaries, and the truthful Codex launch contract.

## Current decision

Scout keeps one complete, evidence-grounded `BusinessGraph` as canonical truth.
The browser deterministically compiles that graph into independent views and
uses Mermaid 11.16 with multiple layout candidates. A geometry and semantic
quality gate chooses the first readable result and atomically replaces the last
valid SVG.

This preserves the existing meeting-thread and complete-snapshot contract while
leaving the visual layer replaceable. React Flow with ELK.js remains the leading
open retained-canvas candidate only when replay benchmarks prove Mermaid is the
limiting factor; it is not required by the current production path.

## Change discipline

When extending the diagram engine:

- Add meaning to the canonical schema before adding presentation behavior.
- Keep model prompts free of coordinates and renderer-specific syntax.
- Preserve stable entity IDs and current/desired scope semantics.
- Add semantic and geometry regressions before enabling a new layout profile.
- Treat missing nodes or semantic edges as hard failures.
- Keep the previous accepted SVG until a complete replacement passes.
- Revalidate Mermaid DOM measurement adapters whenever Mermaid is upgraded.

The repository release gate is `npm run check`; CI additionally starts the built
server and smoke-tests its health and public operator surface.
