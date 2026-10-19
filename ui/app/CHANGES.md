# BrainLink UI M1 changes

- `app/lib/api.mjs`: v0.1 vault-aware store adapter; host connector service boundary; session privacy move with complete-message safety check; ranked search fallback and access filtering.
- `app/lib/hooks.mjs`: Connect/Connect all, test/retry/disconnect, session search/privacy/read, ranked note search/read state.
- `app/views/screens.mjs`: accessible Connect, Sessions, Brain search screens with safe HTML escaping.
- `app/app.mjs`, `app/index.html`, `app/styles.css`: framework-free routes, event wiring, responsive calm styling, host-integration shell.
- `app/lib/state.mjs`: preserved original shared hook/escaping helper.
- `app/test/m1.test.mjs`: five new behavior/security tests.
- `app/test/harness.mjs`, `app/test/harness.test.mjs`: retained seed/services and original tests; optional fallback fixture when reference store is unavailable.
- `app/test/support/memory-store.mjs`: **test-only** incomplete store fixture to run tests from these uploads; NOT the real `createMemoryStore`.
- `app/test/guard.test.mjs`: existing UI safety/name guards unchanged.
- `app/README.md`, `app/.gitignore`: integration documentation and existing ignore rules.

## TODO-CONTRACT

1. `services.connectors.detect/connect/test/disconnect` must be provided by the host integration; v0.1 has no connector management. Live test calls are delegated, not simulated by production UI.
2. `services.sessions.setPrivate` is optional; absent this, the adapter reads the entire session and `putSession`-upserts it into a private/public vault preserving identity. A native atomic move/session privacy method is needed to avoid races and ensure move semantics across implementations. Moves fail if message history is incomplete; integration must verify this behavior against the reference store.
3. `services.search.query` is optional; absent this, store `list/read` is used for simple title/path/body scoring. Native ranked indexed search is not in v0.1.

## Verification

`node --test app/test/*.test.mjs` (Node 22.16.0): **9 passed, 0 failed** using the bundled test-only fixture, because the real reference `memory-store.mjs` was not included in the provided attachments.
