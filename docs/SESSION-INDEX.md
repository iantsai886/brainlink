# Session index entry shape

What `src/sessions/*` stores locally, and the lean shape sync (`src/sync/engine.mjs`, Claude 101's
module) and the `session_list` MCP tool carry around instead of a full session + its messages.

## 1. Full session record (local store, `src/sessions/store.mjs`)

One JSON Lines store under `<appHome>/sessions/sessions.jsonl`, wrapping `brainlink-store`'s
`createMemoryStore` (contract v0.2) for its session methods only — one fixed private vault named
`Sessions`. Each record is the contract's `Session` type (`brainlink-store/interface.d.ts`):

```
{ id, client, source_id, vault: "Sessions", project, profile_id?, title, summary,
  started_at, updated_at, message_count, note_refs, private, etag }
```

`id = s_<sha256(client:source_id)[:16]>`, so re-running an importer on the same file is idempotent.
`profile_id` is an optional Personal/Organisation/Client Twin owner. It is `null` for older records and
unassigned imported sessions. The store filters it before session query matching and refuses an
ID read when the caller's `profile_id` does not match. Profile closeouts persist their owner; a
scoped AI cannot assign an existing imported session to itself. `private` defaults to `false` in
the store contract itself (so existing callers/fixtures that never set it are unaffected);
**every importer in this repo passes `private: true` explicitly**, per the
milestone rule that imported sessions default to private. `session_log`-created sessions also pass
`private: true` by default (same reasoning: no history client should default to shared).

For profile-scoped AI agents, `session_log` is hidden unless the profile grants the separate
`log_session` action and enables episodic memory. The server forces those entries to remain
private and stamps the Twin's `profile_id`; a supplied `session_id` can be appended only if that
same profile owns it. The action is profile-wide, so Setup requires it on every vault granted to
that AI. This saves short notes to BrainLink's local session store; it does not write a note into
an Obsidian vault or import full client transcripts.

## 2. SessionRecord — the lean projection

Declared in `brainlink-store/interface.d.ts` (`SessionRecord`) and built by
`toSessionRecord(session)` (`brainlink-store/memory-store.mjs`):

```
{ id, client, project, started_at, turns, summary, private }
```

One line: **`SessionRecord = {id, client, project, started_at, turns, summary, private}`, where
`turns = message_count`.** This is what `session_list` returns (never the full message log) and
what a future scheduled export would hand to sync.

## 3. What `src/sync/engine.mjs` actually accepts today

`syncOnce({ store, cfg, sessions, ... })`'s `sessions` param is filtered as:

```js
sessions.filter((e) => !e.private && (!e.scope || e.scope === 'brain')).map(redactDeep)
```

So the entry shape sync can carry is `SessionRecord` plus one extra field, `scope`, set to the
session's vault name (`SYNC_VAULT = 'brain'` in `src/sync/settings.mjs` is the only vault sync ever
reads notes from — see that file for the current, authoritative value): `{...SessionRecord, scope}`.
Every string field is deep-redacted again before it reaches disk (`src/sync/redact.mjs`), on top of
the redaction already applied at import time — defense in depth, not a reason to skip either pass.

**Current behaviour:** this repo's local session store keeps every session in the `Sessions` vault,
not `brain`, but `src/sync-cli.mjs` (the only caller of `syncOnce` with real session entries) stamps
`scope` itself rather than passing the raw vault name through unconditionally: non-private sessions
get `scope: 'brain'`, so they are sync-eligible, while private sessions keep `scope: 'Sessions'`,
which `syncOnce`'s filter excludes regardless of `private`. The MCP server design (`docs/mcp.md` §3,
"Vault mapping") describes routing a session to whichever content vault contains its project's
working directory — a finer-grained scope than the current all-or-nothing `brain` stamp — not yet
implemented; flagged as an open issue in the milestone report, not silently assumed.

## 4. Why this shape and not something richer

- `turns` rather than `message_count` in the lean record: shorter name for a budget-constrained tool
  response; same number, just renamed at the projection boundary so the full `Session` type (used by
  the store, sync, and anything doing CAS-style work) keeps the more precise `message_count`.
- `project` (not `cwd`): matches what's useful across clients — Claude Code and Codex both expose a
  working directory, but calling it `project` leaves room for clients that only have a project name.
- No `note_refs`/`etag`/`updated_at` in `SessionRecord`: those matter for the store's own consistency
  (CAS, cross-links) but cost tokens in a list response without being summary-useful.
