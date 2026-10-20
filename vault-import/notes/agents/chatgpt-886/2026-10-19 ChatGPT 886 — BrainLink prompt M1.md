# Task: BrainLink UI milestone 1 — adapt to final store contract

Files attached:
- interface.d.ts — FINAL store contract v0.1 (source of truth).
- tree-ui-app.zip — the in-repo UI scaffold (folder `app/`): lib/api.mjs (createApi({store, services, access})), lib/state.mjs (createHook), test/harness.mjs (uses real createMemoryStore, seeds fake notes, a private vault, 3 sessions, mock connectors that can fail a test call once), guard tests.
- m1-staging.zip — a working M1 (Connect, Sessions, Search) written against an OLDER contract draft (named scopes instead of vaults). Use it as design/UX reference.

Goal: produce milestone 1 as drop-in plain ES modules (no framework, no build step, no network/fs access from UI code) inside `app/`:
1. Connect screen: list detected AI apps (Claude Desktop, Cursor, Codex, others), per-app Connect, a "Connect all" button, a live test call per app showing connected / failed / retry.
2. Sessions view: list indexed AI sessions, search box, private toggle per session.
3. Brain search view: query box, ranked results, open result.

Rules:
- UI talks ONLY through createApi in lib/api.mjs, which calls the store per interface.d.ts plus `services` for things the store lacks.
- Contract gaps (stub them in `services`, clearly marked TODO-CONTRACT): connector calls detect/connect/test/disconnect; per-session private flag (currently privacy = vault membership; implement by moving session into the private vault if no flag exists); ranked search (fallback: store search if present, else simple scoring).
- Keep it light: small CSS, accessible, keyboard friendly, calm neutral styling.
- Tests with node:test (`node --test app/test/`), extend the harness: connect-all happy path, one test call fails then retry succeeds, session privacy toggle hides it from non-private listing, search ranks the exact-title match first. Keep the existing guard tests passing (no fs/net imports in UI, no personal names).
- Node 20 compatible.

Output: ONE downloadable zip named `brainlink-ui-m1.zip` containing the full updated `app/` folder (all files, not diffs), plus a short CHANGES.md inside it listing files and the TODO-CONTRACT stubs. Run the tests yourself in your code tool before zipping and report the pass count.
