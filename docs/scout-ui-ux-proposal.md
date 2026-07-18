# Scout UI/UX proposal — Signal in the Field

## Intent

Bring the product into alignment with the supplied Scout mark: a warm-white
tile, a near-black circular field and one precise ivory route.  The result
should feel like a calm, editorial tool for making sense of a live
conversation—not a neon monitoring dashboard.

The MVP interaction contract remains exactly as it is today: finalized,
attributed transcript in; complete graph snapshot out; full Mermaid rerender;
SSE updates; no new product capability is required for this visual pass.

## What is working

- The product already has a clear three-surface journey: session start,
  operator control room and shareable whiteboard.
- The transcript gives the operator the most important live evidence in the
  center of the layout.
- The whiteboard deliberately preserves the last good graph during a failed
  render. That trust-preserving behaviour should remain visible in the new UI.
- The current graph semantics already have non-colour distinctions in part:
  shapes identify entity type and hypotheses use dashed connectors.

## Findings

1. **The visual language and logo disagree.** The stylesheet leads with green,
   blue, amber, pink and red state tokens, while the supplied logo has only
   warm whites and graphite blacks. The accent palette appears in controls,
   status states, backgrounds, the legend and Mermaid graph classes, making
   the experience read as a different product.
2. **Colour currently carries too much meaning.** A person watching a shared
   screen has to remember five colours in the legend. State should be readable
   with fill, border weight, dash, shape and direct labels first; colour can be
   absent entirely.
3. **The start page prioritises atmosphere over the primary action.** Its large
   heading and three-step explainer push the meeting URL—the only required
   action—into a secondary card. The information is useful but should become a
   concise, progressive disclosure after the field.
4. **The operator's three columns have equal visual competition.** Meeting
   metadata, the live transcript, and analysis control all begin at the top
   with similar treatment. During a meeting, the transcript needs a clear
   dominant reading plane; peripheral context should recede.
5. **The shareable whiteboard is visually dense.** A gridded green background,
   persistent legend, status box, footer question and colourful graph compete
   with the map. It is a presentation surface, so the map should be the first
   and almost only thing noticed.
6. **The wordmark is represented by an `S` circle, not the mark.** Reusing the
   supplied icon (with an accessible text label) will create the strongest
   continuity across every surface.

## Design direction

**Signal in the Field**: a warm-white workspace framed by charcoal, with one
dark circular field used as the visual anchor. The Scout route is not a
decoration; it becomes the product metaphor: one trustworthy path extracted
from a noisy conversation.

The visual balance is intentionally restrained:

- **Whiteboard:** warm white, presentation-safe and spacious.
- **Operator:** graphite for long-form concentration, with warm-white content
  sheets where attention is needed.
- **Start:** warm white with a single dark brand field, making the join action
  feel confident and deliberate.
- **Motion:** a quiet route-draw on initial load and a one-time, low-amplitude
  pulse for incoming evidence. Never animate the whole graph while someone is
  presenting.

## Proposed token system

Use semantic tokens throughout CSS and Mermaid. The values below are sampled
from the supplied mark, with only neutral extensions for legibility.

| Role | Token | Value | Use |
| --- | --- | --- | --- |
| Paper | `--paper` | `#FAFAF7` | Whiteboard and start canvas |
| Paper, low | `--paper-soft` | `#F7F7F3` | Cards and inactive fields |
| Rule | `--rule` | `#ECECE7` | Dividers and quiet boundaries |
| Ink | `--ink` | `#101115` | Primary text and strong graph elements |
| Field | `--field` | `#17181C` | Operator canvas and logo field |
| Panel | `--panel` | `#1D1F25` | Raised dark surfaces |
| Quiet ink | `--ink-muted` | `#62656C` | Secondary copy |
| Inverse | `--inverse` | `#FAFAF7` | Text on field |

Do not create a brand accent colour. Critical states must be communicated by
explicit text, icon and a neutral treatment:

| Meaning | Visual encoding |
| --- | --- |
| Listening / live | filled black dot + `LIVE` label |
| Processing | rotating two-stroke ring + `ANALYSING` label |
| Attention needed | outlined square + `ACTION NEEDED` label |
| Current graph item | black fill, white text, solid border |
| Desired graph item | white fill, 2px black border |
| Hypothesis | white fill, dashed 2px border + `?` prefix |
| Unknown | paper-grey fill, dotted border |
| Pain | black fill, 4px left rule + `FRICTION` label |

This is accessible in greyscale, on a projector and for people with colour
vision differences.

## Surface proposals

### 1. Start a Scout session

The initial page becomes an invitation rather than a marketing split-screen:

1. Small lockup at top left using the actual Scout icon and `SCOUT` wordmark.
2. A central, narrow join panel with the title **“Add Scout to a meeting.”**
3. The URL field is focused on load and is followed immediately by the primary
   action: **“Create session”**.
4. Beneath the button, one sentence sets expectation: “Scout joins as Live
   Architect; your host may need to admit it.”
5. A collapsed “What happens next” disclosure contains the current three
   steps. This preserves helpful guidance without slowing the decision.
6. On success, replace the form with a calm, numbered hand-off: `1 Open
   operator`, `2 Share whiteboard`, `3 Admit Live Architect`. Keep both links
   and the copy action exactly as they work now.

The field should be 52–56px tall, use an obvious URL/link icon, show a visible
focus ring and preserve the current validation and live-region announcements.

### 2. Operator — the field desk

Use a stable desktop layout with a 72px rail, a flexible transcript plane and
a 320px analysis dock.

```text
┌────────┬──────────────────────────────────────┬──────────────────┐
│ mark   │ Meeting title      LIVE / time        │ Graph status     │
│ topic  ├──────────────────────────────────────┤ r12  ·  3 queued │
│ people │  10:31  Maya, CEO                    │──────────────────│
│ systems│  “Sales exports …”                   │ Ask next         │
│        │                                      │ “Where…”        │
│        │  10:32  James, Finance               │ [Analyse now]   │
│        │  “Then we copy …”                    │  3 items queued │
└────────┴──────────────────────────────────────┴──────────────────┘
```

- The **rail** holds brand, meeting context, integration health and people as
  icon-plus-label items. It should not use a separate card for every item.
- The **transcript** is the reading surface: warm-white text panel on the dark
  field, generous line height, an anchored time/speaker column, and a fine
  horizontal rule between turns. Partial speech remains visibly provisional
  using a light italic treatment and `Speaking` label.
- The **analysis dock** is calm but decisive. Revision and queued utterances
  sit in a single compact status row; the suggested question gets one strong
  editorial quote block; the action stays at the bottom as it does today.
- “Analyse now” remains available, but the label should include state:
  `Analyse 3 new utterances`; disable it only during work and retain the
  current explanatory note.
- On tablets, move the dock beneath the transcript as a summary card. On
  phones, present meeting context and analysis as stacked sections before the
  scrollable transcript. Preserve the current functional order and live
  updates.

### 3. Whiteboard — the shared map

This is the most important brand opportunity and should be redesigned as a
projection-friendly sheet:

- Warm-white canvas; no grid and no ambient coloured gradients.
- Small Scout icon and meeting topic in a narrow top bar. The live state sits
  alongside it as text plus neutral status shape.
- The graph has a large protected margin and is vertically centred. Set its
  maximum rendered height based on the available viewport, as today.
- Put the state key behind a `Map key` button in the lower right; it opens a
  small neutral sheet. The key is useful, but should not permanently compete
  with the map.
- The suggested next question appears only when present, as a single bordered
  strip at the bottom left. It should never overlap the graph.
- Retain the render-error behaviour. Make the notice a black outlined sheet
  with the text “Latest map retained; the next update could not render.” This
  reassures the presenter about exactly what happened.

### 4. Mermaid graph styling

Keep graph content and rendering flow unchanged. Replace the current colour
class definitions with the grayscale semantic system above. Node *shape*
continues to represent kind, while *fill, line treatment and prefix* represent
certainty/state. Edges should use solid black for current/desired, dashed for
hypothesis and dotted for unknown. Pain items should remain visually forceful
through a heavy edge and explicit `FRICTION` label, rather than pink.

## Implementation sequence (low-risk)

1. Add the Scout SVG as a public asset and replace only the decorative `S`
   marks; retain text labels for accessibility.
2. Introduce neutral design tokens and a small set of shared primitives
   (`status`, `button`, `surface`, `rule`, `eyebrow`) in `public/styles.css`.
   Replace one surface at a time, keeping all existing IDs and JS hooks.
3. Restyle the Mermaid `classDef`s and `themeVariables`; add snapshots for the
   source string so semantic graph distinctions remain deterministic.
4. Make the whiteboard presentation-first, then adjust the operator layout and
   finally simplify the start page.
5. Validate desktop, tablet and 375px mobile views; keyboard focus, reduced
   motion, live-region feedback and light/dark contrast need explicit checks.

## Guardrails for delivery

- Do not change session routes, DOM IDs consumed by JavaScript, SSE event
  handling, form validation, or the full-graph render strategy.
- Do not turn the graph into a custom canvas or introduce graph patches.
- Do not rely on colour as the only state signal.
- Keep the previous SVG visible until a newly rendered SVG succeeds.
- Avoid a generic “SaaS dashboard” treatment: no coloured KPI tiles, glowing
  gradients, glass effects or persistent background grids.

## Acceptance criteria

- Every product surface visibly belongs to the supplied Scout icon.
- The palette is warm white, charcoal and neutral greys only.
- A user can identify graph state in greyscale without consulting colour.
- The join URL is the clearest first action on the start page.
- The operator can scan latest speech and analysis queue without hunting.
- The whiteboard is legible from a shared screen and keeps the graph dominant.
- Existing unit tests, typecheck, build and `git diff --check` remain clean.
