# Task: BrainLink UI milestone 2 — align stubs to contract v0.2 + note viewer/editor

Attached: tree-ui-app-m1.zip (current committed `app/`, M1 done), interface.d.ts (v0.1), memory-store.mjs + errors.mjs (REAL reference store; put them in app/test/support/ replacing the fixture for your test runs only, and do NOT ship them in the output zip).

Part A — align M1 stubs to these exact v0.2 shapes (decided by store owner):
1. Separate `connectors` service (not store): detect(): [{client, installed, connected}]; connect(client), test(client), disconnect(client) each -> {ok, message}.
2. Sessions: SessionRecord.private: boolean; imported sessions default private=true, never synced, never in search. UI sets via store.setSessionPrivate(id, bool). Feature-detect: if store.setSessionPrivate missing, fall back to current vault-move adapter.
3. Ranked search: store.search(query, {limit=5, scope?, includeSessions=false}) -> [{id, title, snippet, score, sha12}]. UI never re-ranks; only displays. Fallback to existing simple scoring only if store.search missing.

Part B — Notes viewer/editor screen (replaces Obsidian for daily use):
- Vault + folder tree, open note, rendered Markdown view (headings, lists, links, code, [[wikilinks]]), YAML frontmatter shown as a small read-only table with an edit toggle.
- Edit mode: plain textarea Markdown editor, Save via store write per interface.d.ts, optimistic-concurrency using sha12 if contract supports it (show conflict message otherwise), unsaved-change guard, Cmd/Ctrl+S.
- Backlinks panel (notes linking to current note), new note, rename (if contract supports), no delete in v1.
- Wire into existing app.mjs routes/nav; keep styling consistent.

Rules: plain ES modules, no framework/build, no fs/net in UI, Node 22. Keep all existing tests passing; add tests: v0.2 shape usage with feature-detect fallbacks, save + conflict path, wikilink + backlink resolution, unsaved guard.

Output: ONE downloadable zip `brainlink-ui-m2.zip` with full `app/` folder (no support store files) + CHANGES.md. Run tests before zipping and report pass count.
