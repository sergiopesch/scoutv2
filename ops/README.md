# Scout operations runbook

Scout's MVP state is intentionally process-local. Run exactly one application
replica and do not restart or roll it while a meeting is active. A restart ends
all sessions and the shutdown path asks active Recall bots to leave.

## Provisioning

1. Install the exact Node version in `.node-version` and npm version in
   `package.json`.
2. Install and authenticate the supported Codex CLI as the same OS user that
   runs Scout. Provision `/home/scout` and `/home/scout/.codex` with mode `0700`
   and remove group/other access from any existing Codex session files. Codex
   persists the meeting thread so it can be reused across analysis turns and
   resumed after a child-process restart; those files contain transcript
   context and must remain readable only by the service account.
3. Copy the repository to `/opt/scout`, run `npm ci && npm run check`, and keep
   the working directory at the repository root. Create
   `/opt/scout/.scout-handoffs` as the `scout` user with mode `0700`; the
   systemd sandbox explicitly grants this directory write access so approved
   Codex handoffs do not require a writable application tree.
4. Store runtime configuration at `/etc/scout/scout.env` with mode `0600`.
5. Install `scout.service.example` as a systemd service after adapting paths and
   the service account. Keep its `UMask=0077` and `.codex` write-path controls.
6. Put a stable HTTPS proxy in front of the local listener. The Caddy example
   publishes only Recall webhooks and the presentation-safe whiteboard surface;
   session creation and the operator console remain local.

The proxy must disable buffering for SSE and keep its read timeout above the
15-second heartbeat interval. Do not configure autoscaling or more than one
replica. Keep `/review/*`, `/handoff/*`, operator APIs, and session creation off
the public proxy; `/assets/*` is public only so the presentation-safe surface
can load the Scout mark.

## Release procedure

1. Confirm there are no active meetings in `/metrics`.
2. Install from the lockfile with the pinned Node and npm versions.
3. Run `npm run check`; it executes the 316-test suite, typecheck, production
   build, built-server smoke test, and whitespace validation.
4. Run `npm audit --omit=dev` and resolve any production dependency finding
   before deployment.
5. Replace the application files without replacing `.scout-handoffs/`, then
   restart the single Scout service.
6. Verify `/livez`, `/readyz`, and `/metrics` before enabling new sessions.

Roll back by restoring the previous verified application revision and running
the same health checks. A rollback or restart ends process-local sessions; it
does not delete prepared handoff directories.

## Health and deploy gate

- `GET /livez` proves that the HTTP process is accepting requests.
- `GET /readyz` returns 200 only when live Recall or explicit rehearsal mode is
  configured and Codex/Recall preflight checks succeed.
- `GET /health` is a compatibility alias for `/readyz`.
- `GET /metrics` exposes process-local JSON counters for sessions, analyses,
  retained state, active SSE clients, and the latest dependency readiness.

Before creating a session:

```bash
curl --fail http://127.0.0.1:3000/livez
curl --fail http://127.0.0.1:3000/readyz
```

Deploy only when there are no active meetings. On shutdown, verify the
`session.retired` records and allow `SHUTDOWN_GRACE_MS` for SSE and the Codex
child to drain.

## Logs and alerts

Scout emits JSON lifecycle records containing session, bot, thread, and turn
identifiers but never transcript text or secrets. Alert on:

- `/readyz` returning 503 for more than one minute;
- repeated `session.create_failed` or `recall.integration_error` events;
- Codex child restart/quarantine events;
- shutdown exceeding the configured grace period.

Recall retries webhook deliveries when Scout returns a non-2xx response. Keep
the public status webhook configured as
`${PUBLIC_API_BASE_URL}/webhooks/recall/status` and use the workspace
verification secret for current Recall workspaces. Configure
`RECALL_SVIX_WEBHOOK_SECRET` only for an explicitly legacy dashboard webhook.
