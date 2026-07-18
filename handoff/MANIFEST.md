# Handoff manifest

## Provenance

- Source Codex thread: `019f751e-db8d-7d82-8df4-83c524690db6`
- Source date: 18 July 2026
- Target repository: `sergiopesch/scoutv2`
- Export format: Markdown plus sanitized JSON

## Included artifacts

| Path | Description |
| --- | --- |
| `START_HERE.md` | Recipient instructions and Codex bootstrap prompt |
| `DECISIONS.md` | Condensed authoritative product and architecture decisions |
| `artifacts/live-architect-base-prd.md` | Full working PRD created during the thread |
| `artifacts/architecture.mmd` | Mermaid source for the core system architecture |
| `transcript/thread-transcript.md` | Human-readable conversation history |
| `transcript/thread-messages.json` | Machine-readable conversation history |

## Transcript sanitation

The transcript contains only visible user and assistant messages. It excludes:

- system and developer instructions;
- hidden reasoning;
- tool-call payloads and raw tool output;
- environment variables and credentials;
- internal event metadata.

This makes the export suitable as project context while avoiding an unsafe raw
Codex session dump.

## Artifact inventory note

At export time, the source workspace contained one authored product artifact:
the base PRD. Its embedded Mermaid diagrams are preserved, and the primary
architecture diagram is also included as a standalone `.mmd` file. No image,
audio, video, or binary artifacts were present in the source workspace.
