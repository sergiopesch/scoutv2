# Scout v2 implementation rules

## MVP contract

- Recall provides finalized attributed utterances.
- One persistent Codex app-server thread exists per meeting.
- Each Codex analysis turn receives the current accepted graph plus only the
  new finalized utterances.
- Each turn returns a complete `BusinessGraph` through `turn/start.outputSchema`.
- The server validates and atomically replaces the graph, then increments the
  revision.
- The browser performs a complete Mermaid rerender and retains the previous SVG
  until the new SVG succeeds.
- Use SSE from server to browser.

Do not add graph patches, json-render, a database, authentication, a native
application, partial-transcript analysis, or runtime subagents.

## Ownership

The integration agent owns:

- `package.json`, lockfiles, and TypeScript configuration
- `src/shared/**`
- `src/server/index.ts`
- `src/server/session-store.ts`
- integration tests and merge decisions

Delegated lanes may change only their assigned paths:

- Codex: `src/server/codex/**`, `test/codex/**`
- Recall: `src/server/recall/**`, `test/recall/**`,
  `test/fixtures/recall/**`
- Whiteboard: `public/**`, `test/ui/**`

Do not edit another lane or shared files. Report required shared changes to the
integration agent.

## Verification

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Fixture data must remain clearly isolated from the live runtime path. Never
commit credentials, webhook secrets, meeting URLs, or participant recordings.
