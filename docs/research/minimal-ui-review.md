# Scout V2 minimal UI review

Date: 2026-07-19
Mode: live browser review plus deterministic completed-meeting fixture
Evidence: `/Users/speschiera/.codex/visualizations/2026/07/19/019f7bcd-2b2d-78c0-9865-171ca80c50ac/scout-minimal-audit`

## Outcome

Scout now uses one restrained visual language derived from the logo: off-white paper, charcoal ink, quiet grey rules, and a subtle monochrome grain. The second terracotta/red accent system, decorative circles, tab pictograms, arrow glyphs, green confirmation badge, exaggerated shadows, and redundant status markers have been removed.

The most visible defect was not decorative: the black ovals beside Organisation and Architecture were hidden “Updated” labels whose component CSS overrode the browser's native `[hidden]` behavior. The hidden-state contract is now explicit, while the accessible updated announcement remains available to assistive technology.

## Journey health

| Step | Screen or capability | Health | Validation |
| --- | --- | --- | --- |
| 1 | Start Scout | Healthy | Product-first workspace language, one clear input and action, reduced supporting copy, responsive mobile state. |
| 2 | Operator workspace | Healthy | Participant choice, finalized transcript, processing state, and post-call navigation remain available; completed-state controls collapse automatically. |
| 3 | Process map | Healthy | BPMN-informed task, event, and sequence semantics render and remain editable. |
| 4 | Organisation map | Healthy | Reporting hierarchy renders without tab icons or hidden-state pills and remains editable. |
| 5 | Architecture map | Healthy | System, API, data-store, event-bus, external-system, protocol, and boundary semantics remain editable. |
| 6 | Suggested questions | Healthy | A minimal `?` trigger opens the gentle checklist; asked state remains tickable and persistent. |
| 7 | Evidence and editing | Healthy | Element fields, connections, reverse/remove actions, evidence, disposition, notes, add/delete, undo/redo, and approval remain available through progressive disclosure. |
| 8 | Codex handoff | Healthy | Approval gate, revision-bound package, specialist task plan, source review, download, and “Let Codex do its thing” launch remain functional. |

## Fixes completed

| Finding | Foundation | Resolution |
| --- | --- | --- |
| Tab icons and black ovals made the three map modes look noisy and broken. | Tab primitive and hidden-state contract | Removed decorative glyphs and visual update pills; added an explicit `[hidden]` override and kept an assistive update announcement. |
| Terracotta/red was competing with the Scout mark across tabs, selections, errors, buttons, shadows, and handoff accents. | Colour tokens and state primitives | Consolidated the interface onto the exact logo neutrals and removed the second colour system from HTML, CSS, and diagram renderers. |
| Decorative circles and heavy shadows dominated start, canvas, and handoff surfaces. | Surface and texture system | Removed decorative pseudo-elements and shadows; retained only a very subtle monochrome paper grain. |
| Completed operator and review states still showed dead or disabled controls. | Progressive disclosure | Hide completed processing cards, resolved identity prompts, post-call analysis controls, disabled undo/redo/save controls, and Follow Live where they no longer apply. |
| Rehearsal copy made the entry point read like a demo. | Product voice | Reframed it as a Scout workspace while preserving the safety truth that no meeting participant is created. |
| Handoff repeated too much explanatory content. | Information hierarchy | Shortened the launch sequence, clamped specialist summaries, simplified source control, and preserved the detailed execution content behind disclosure. |
| Decorative arrows, checks, and symbols appeared inside actions and status rows. | Action and status primitives | Removed non-essential symbols from start, operator, review, and handoff surfaces; retained the user-requested `?` affordance and functional zoom notation. |

## Accessibility and interaction notes

- Tabs expose correct selected state and support visible keyboard focus.
- The suggested-question control has an explicit accessible name with remaining count.
- Hidden visual update text remains in the accessibility tree only when applicable.
- The semantic editors expose labelled inputs, connection controls, source evidence, review decisions, and notes.
- Reduced-motion behavior remains available.
- Browser screenshots and DOM inspection are not a substitute for a dedicated screen-reader and assistive-technology conformance review.

## Verification

- 32 test files passed; 316 tests passed.
- TypeScript typecheck passed.
- Production build passed.
- `git diff --check` passed.
- Legacy terracotta/red and secondary palette values are absent from `public/`.
