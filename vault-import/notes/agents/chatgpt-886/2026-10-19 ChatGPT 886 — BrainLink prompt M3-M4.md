# Task: BrainLink UI milestones 3 + 4 — Settings/Sync and light Graph (final UI)

Attached: tree-ui-app-m2.zip (current committed `app/`, M1+M2 done, 16 tests pass), interface.d.ts, memory-store.mjs + errors.mjs (REAL reference store: use in app/test/support/ for your runs only; do NOT ship), sync-settings.mjs (backend reference for sync options; Node-side, UI must NOT import it).

M3 — Settings screen:
- Sync choice: radio list of providers exactly matching sync-settings.mjs PROVIDERS/PROVIDER_LABELS (Local only, Google Drive folder, iCloud folder, Dropbox folder). Folder picker field showing suggested folders, device name, Validate + Save. Clear note: private vaults and sessions never sync. No team sync in v1.
- Access: via `services.settings` {get(), suggestFolders(), validate(s) -> {ok, message}, save(s) -> {ok, message}}; mock in harness. Feature-detect, show disabled state if missing.
- Also: Connected apps summary (link to Connect), privacy defaults (imported sessions private), about/version, theme light/dark (CSS vars, localStorage via injected `access.prefs` only).

M4 — Graph screen (light):
- 2D force-directed graph on <canvas>, no libraries, nodes = notes (from store list), edges = [[wikilinks]] (reuse lib/notes.mjs parsing). Pan/zoom, hover label, click opens note in Notes screen, filter by vault, hide private by default. Cap simulation (e.g. 300 iterations, ≤2000 nodes, degrade to static layout beyond).
- Pure layout function in lib/graph.mjs testable without DOM.

Finish: nav has Setup, Connect, Notes, Search, Sessions, Graph, Settings; consistent styling; keyboard accessible.

Rules: plain ES modules, no framework/build, no fs/net in UI, Node 22. Keep all existing tests passing; add tests: settings validate/save paths + missing-service disabled state, graph edge extraction, layout determinism with seed, private filtering.

Output: ONE downloadable zip `brainlink-ui-m34.zip` with full `app/` folder (no support store files, no top-level stray files) + app/CHANGES.md. Run tests before zipping and report pass count.
