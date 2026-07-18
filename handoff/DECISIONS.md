# Live Architect — locked decisions

## Product shape

- The primary user is a builder, consultant, forward-deployed engineer, or
  solutions architect interviewing a CEO, CTO, or other stakeholder.
- The stakeholder can speak naturally and ramble about business problems.
- The product's primary output is a living model of the business: actors,
  systems, workflows, handoffs, pain points, unknowns, and proposed future
  state.
- The transcript is evidence for the model, not the headline product.
- The meeting participant sees the model develop live on a shared whiteboard.

## MVP architecture

- Recall.ai supplies the cross-platform meeting bot, live transcript, and
  participant attribution for Zoom, Google Meet, and Microsoft Teams.
- The bot appears as a visible participant named **Live Architect**.
- The application exposes:
  - `/operator/:sessionId` for builder controls and evidence.
  - `/whiteboard/:sessionId` for the meeting-safe canvas.
- Recall Output Media shares the whiteboard into the meeting.
- Codex app-server performs topic separation, business-model inference,
  follow-up-question generation, and complete graph-snapshot generation.
- The application owns canonical graph state; Codex returns a complete,
  evidence-linked `BusinessGraph` snapshot for each analysis cycle.
- The web MVP uses TypeScript, a local Node server, and Mermaid.
- One Codex thread is used per meeting.
- Transcript input is chunked, but graph output is a complete replacement.
- The server assigns revisions after validation; Codex does not control them.

## UX and reasoning constraints

- Current state, desired state, hypothesis, contradiction, and unknown must be
  visibly distinct.
- Diagram updates should occur after complete thoughts, not every partial
  token.
- Every meaningful graph element should link back to transcript evidence.
- Speaker names should come from meeting identity where available; the model
  may reason about viewpoints but must not silently invent identity.
- The operator remains able to inspect, reject, or correct inferred elements.

## Hackathon constraint

The demo must be buildable and demonstrable in under three hours. Optimize for
one convincing golden path: a messy stakeholder explanation visibly becomes a
correctable workflow diagram during the call.

## Deferred decisions

- Production authentication, retention, compliance, and billing.
- General-purpose graph editing.
- A native macOS capture application.
- A proprietary diarization pipeline.
- Multi-meeting organizational memory.
- Robust conflict resolution across simultaneous Codex turns.
