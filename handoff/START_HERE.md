# Scout v2 — Codex handoff

This directory is a portable handoff of the Codex discovery thread that defined the hackathon MVP currently called **Live Architect**.

## Open in Codex

1. Clone `sergiopesch/scoutv2`.
2. Open the checkout in Codex:

   ```bash
   codex app /absolute/path/to/scoutv2
   ```

3. Start a new task with this prompt:

   > Read `handoff/START_HERE.md`, `handoff/DECISIONS.md`,
   > `handoff/artifacts/live-architect-base-prd.md`, and
   > `handoff/transcript/thread-transcript.md`. Treat the PRD and locked
   > decisions as the current product contract. The transcript is supporting
   > context and records how those decisions were reached. First summarize the
   > MVP, identify any contradictions or unresolved implementation choices,
   > inspect the repository, and propose the smallest build plan that can
   > produce a working hackathon demo. Do not change files until the plan has
   > been reviewed.

## Product in one sentence

A Recall.ai meeting participant listens to a stakeholder discovery call while a Codex-backed application continuously turns the discussion into an evidence-grounded business workflow diagram visible to everyone in the meeting.

## Handoff contents

- `DECISIONS.md` — short, authoritative decision log.
- `artifacts/live-architect-base-prd.md` — complete base PRD.
- `artifacts/architecture.mmd` — standalone Mermaid system diagram.
- `transcript/thread-transcript.md` — readable user/assistant thread history.
- `transcript/thread-messages.json` — machine-readable, sanitized message history.
- `MANIFEST.md` — provenance and export details.

## Important limitation

Codex does not currently import this as the original task object. Opening the
repository and using the bootstrap prompt creates a new Codex task with the
same working context and artifacts. The export deliberately excludes system
instructions, hidden reasoning, tool credentials, and raw tool output.
