# Scout V2 end-to-end product review

Date: 2026-07-19
Mode: live rehearsal plus deterministic completed-meeting fixture
Evidence: `/Users/speschiera/.codex/visualizations/2026/07/19/019f7bcd-2b2d-78c0-9865-171ca80c50ac/scout-e2e-audit`

## User journey reviewed

1. Create a rehearsal session and copy both private links.
2. Open the operator workspace, receive finalized attributed utterances, choose the operator, pause and continue processing, and start analysis.
3. Inspect the completed meeting state and enter post-call review.
4. Switch Process, Organisation, and Architecture diagrams; switch current and target state; zoom; toggle follow-live; open the editor; edit, add, connect, reverse, remove, delete, undo, redo, annotate, and approve.
5. Open the suggested-question checklist, mark a question asked, and close it.
6. Open the approved Codex handoff and inspect the delivery package boundary.
7. Exercise the reset confirmation, cancellation, and destructive confirmation paths.

## Fix list

| Priority | Finding | Evidence | Foundation affected | Planned fix | Status |
| --- | --- | --- | --- | --- | --- |
| P0 | A real analysis turn produced process facets on edges whose endpoints were architecture-only nodes. Server validation correctly rejected the complete graph, leaving revision 0 and blocking the live journey. | `04-analysis-error.png`; server error names `edge-uses-001`, `002`, `004`, `005`, and `006`. | Codex semantic contract | Make cross-facet endpoint invariants explicit in the analyst instructions and cover the exact failure mode in tests. Re-run a real analysis turn. | **Fixed + live validated** (`16-long-topic-fixed.png`; r1, 21 nodes, 12 edges) |
| P0 | The operator exposes the full internal Codex validation message in two status rows and the primary action note. The user sees implementation IDs and schema language instead of a recoverable action. | `04-analysis-error.png` | Error copy primitive | Add a safe, stable user-facing analysis error message while retaining detailed diagnostics in server logs. | **Fixed + tested** |
| P0 | The first real Codex handoff retry revealed that `thread/fork` returns a distinct session ID for each child. The launcher treated that valid metadata as an unrelated tree and aborted after creating the lead. | Browser launch; server log `forked outside the lead session tree` | Codex thread-link validation | Validate the actual parent relationship through `forkedFromId`; do not require a shared child session ID. Keep unrelated-parent fail-closed coverage. | **Fixed + live validated** (`21-codex-launch-success.png`) |
| P1 | “Ask next” remains a large persistent block on the operator even though the whiteboard now uses the requested subtle `?` checklist. The same capability has two interaction models. | `03-live-operator-empty.png`, `05-completed-meeting.png`, `07-question-dock.png` | Suggested-question primitive | Reuse the question queue and bottom-sheet checklist on the operator; remove the persistent question card. | **Fixed + browser validated** (`16-long-topic-fixed.png`) |
| P1 | Codex handoff work is still a fixed demo script: presentation, capability map, generic agentic MVP, and roadmap. It is not derived from the accepted process, organisation, architecture, pains, contradictions, or review notes. | `12-codex-handoff.png` | Handoff task planner | Generate specialist work from the domains actually present in the reviewed graph, plus an evidence-led delivery/validation task. Make task count and lead copy dynamic. | **Fixed + live validated** (`21-codex-launch-success.png`) |
| P1 | The handoff repeats the same work twice as “outcomes” and “linked work,” producing a long, text-heavy page before the only consequential action. | `12-codex-handoff.png` | Handoff information architecture | Collapse the page to one specialist-task plan, progressive source details, and one clear launch action. | **Fixed + responsive validated** (`14-repaired-codex-handoff.png`, `19-mobile-handoff.png`) |
| P1 | The final action does not use the requested product voice (“let Codex do its thing”) and reads like a demo command. | `12-codex-handoff.png` | Primary CTA copy | Use “Let Codex do its thing” with a concise explanation of the real task/thread side effect. | **Fixed + live validated** |
| P1 | Empty target views say no architecture/process has “been heard yet,” which sounds like missing discovery rather than an intentionally uncaptured target state. | Browser step: Architecture → Target | Diagram empty-state primitive | Make empty copy scope-aware: “No target … captured yet.” | **Fixed + tested** |
| P1 | The installed Codex app-server has no native project-create or project/thread-pin operation. | `codex-launch.json` launch receipt | External Codex capability boundary | Create a durable local project workspace and linked session tree, and record the unsupported pin request truthfully rather than presenting a fake success. | **Platform limitation; honest fallback live validated** |
| P2 | Long operator topics can break at arbitrary characters in the narrow left rail (for example, “transformation” breaks into `transformat` / `ion`). | `05-completed-meeting.png` | Responsive type scale | Prefer normal word wrapping and a fluid, smaller display size in the rail. | **Fixed + responsive validated** (`16-long-topic-fixed.png`, `18-mobile-operator-viewport.png`) |
| P2 | Textareas are omitted from the global focus-visible selector even though review notes and item notes are core keyboard inputs. | Source inspection during accessibility pass | Focus primitive | Include `textarea:focus-visible` and preserve the same high-contrast focus ring. | **Fixed + tested** |
| P2 | The review inspector is comprehensive but long. The active edit controls, evidence, map notes, and outline compete in one scroll column. | `10-editor-open.png`, `11-review-approved.png` | Inspector hierarchy | Keep editing and evidence first; make map notes and the accessible outline progressively disclosed without removing capability. | **Fixed + browser validated** |

## Confirmed strengths

- Session creation, link copy, pause/continue, operator identity, reset safeguards, SSE updates, and approval gating behaved correctly.
- Process, Organisation, and Architecture use distinct visual semantics rather than one generic graph treatment.
- Graph editing is complete-snapshot, undoable, evidence-aware, and able to add, reconnect, reverse, remove, and delete elements.
- The suggested-question checklist is subtle, keyboard-addressable, persistent per session, and records asked state.
- Codex handoff is revision-bound and does not become available before human approval.

## Final validation notes

- A second live analysis of mixed workflow, ownership, system, data-flow, current-state, and target-state evidence completed in 90 seconds and atomically published revision 1 with 21 nodes and 12 valid connections.
- The final Codex action created and started one named lead plus four map-derived linked tasks. The receipt records the exact thread IDs, dependencies, working directory, and the unsupported native-pinning boundary.
- The approved package download returned revision-bound JSON with an attachment filename and all expected evidence/manifest fields.
- Keyboard behavior, responsive reflow, state announcements, and visible focus received targeted checks. Screenshot and DOM inspection do not establish full WCAG conformance; a dedicated screen-reader pass remains advisable.
