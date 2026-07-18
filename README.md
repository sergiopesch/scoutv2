# Scout v2

Scout joins a live Zoom, Google Meet, or Teams call, receives speaker-attributed
final transcript events from Recall.ai, and turns the conversation into a live
business workflow map using Codex app-server.

The hackathon MVP deliberately uses a full `BusinessGraph` snapshot per analysis
turn. The browser replaces the previous graph and rerenders Mermaid rather than
trying to merge incremental graph patches.

## Surfaces

- `/operator/:sessionId` — attributed transcript, participants, integration
  health, revision state, suggested follow-up, and manual analysis control.
- `/whiteboard/:sessionId` — presentation-safe workflow map for screen sharing.
- `/events/:sessionId` — server-sent session snapshots consumed by both views.

## Requirements

- Node.js 22+
- A locally authenticated `codex` CLI with `codex app-server` support
- A Recall.ai API key and workspace verification secret
- A stable public HTTPS URL forwarding to this server

Recall must send dashboard bot-status webhooks to:

```text
https://YOUR_PUBLIC_HOST/webhooks/recall/status
```

The per-session real-time webhook URL is generated automatically when a bot is
created.

## Configuration

```bash
npm ci
cp .env.example .env
```

Fill in:

```text
PUBLIC_API_BASE_URL=https://YOUR_PUBLIC_HOST
RECALL_REGION=us-west-2
RECALL_API_KEY=...
RECALL_WORKSPACE_VERIFICATION_SECRET=...
RECALL_SVIX_WEBHOOK_SECRET=...
```

`RECALL_SVIX_WEBHOOK_SECRET` is the signing secret for the dashboard bot-status
webhook. Keep all secrets outside git; for the hackathon, store them in
1Password Agent Env.

Load the environment and start the service:

```bash
set -a
source .env
set +a
npm run dev
```

Automatic analysis uses leading-edge batching: the first finalized utterance
starts a non-resetting `ANALYSIS_DELAY_MS` timer (1,500 ms by default).
Additional finals join that pending batch without postponing it. If more finals
arrive while Codex is analyzing, the next pass starts after the shorter,
non-resetting `ANALYSIS_RERUN_DELAY_MS` interval (500 ms by default). The
operator's **Analyze now** action bypasses an idle timer immediately.

## Start a live session

Create a session with the real meeting URL:

```bash
curl -X POST http://127.0.0.1:3000/api/sessions \
  -H 'content-type: application/json' \
  --data '{"meetingUrl":"https://meet.google.com/xxx-yyyy-zzz"}'
```

The response contains the `operatorUrl` and `whiteboardUrl`. Admit the Scout bot
when it appears in the call, then share the whiteboard URL in a browser window.

## No-Recall rehearsal

The development ingest route makes the full Codex and UI loop demoable before
Recall credentials are ready:

```text
SCOUT_ALLOW_DEV_INGEST=true
```

Create a session as above, then send a finalized utterance:

```bash
curl -X POST \
  http://127.0.0.1:3000/api/dev/sessions/SESSION_ID/utterances \
  -H 'content-type: application/json' \
  --data '{
    "id":"demo-1",
    "sequence":1,
    "participantId":"ceo-1",
    "participantName":"Maya, CEO",
    "text":"Sales exports leads from HubSpot to a spreadsheet, then Finance manually copies them into NetSuite.",
    "startedAt":1721308800000,
    "endedAt":1721308815000,
    "finalized":true
  }'
```

Analysis runs after the bounded leading-edge delay, or immediately with:

```bash
curl -X POST http://127.0.0.1:3000/api/sessions/SESSION_ID/analyze
```

## Verification

```bash
npm test
npm run typecheck
npm run build
```

The test suite covers snapshot coordination, runtime routing, Recall
normalization and signature checks, Codex JSON-RPC/structured output handling,
session storage, and deterministic Mermaid generation.
