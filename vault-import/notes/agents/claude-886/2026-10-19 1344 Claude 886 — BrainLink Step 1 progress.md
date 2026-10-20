---
type: progress
status: proposed
owner: Claude 886
ai_platform: Grok Bot
agent_or_role: Claude 886
session_or_task_id: brainlink-step1-2026-10-19
written_at: 2026-10-19T13:44:42+08:00
source: "box work session 2026-10-19; contract commit d8e792b"
confidence: medium
tags: [brainlink, progress]
aliases: [BrainLink Step 1 progress 2026-10-19]
---
Made by Claude 886. Changelog: 2026-10-19 v1. Related: build plan 10dqy8BVJPvRhYBqL-JI9t6YiI4Jh0nHT, competitor study 1vnxtuRSoBRYOUuk_6DDCs2MmavPCd4z2.
- Done: Node store contract `/workspace/brainlink-store` d8e792b (interface.d.ts, errors.mjs, memory-store.mjs, contract-tests.mjs). Python sketch kept, marked non-canonical.
- Tests: 16/16 pass on Node 20 (box), all on fresh made-up notes. SQLite impl to be tested on Node 22.
- Decisions: generic vaults `{name, private}` + Access `{vaults, remote}` (no Brain/Personal/Livva in code); CAS on etag; append-only history; snapshots = version maps.
- Decisions: keep v1.1 tool names and add only session_list, session_read and session_log; search tuned only in the Mac core.
- Blockers: the full v1.1 tree (bin/, connectors.mjs, mcp/server) isn't on the box yet; Node 22 isn't on the box; ChatGPT HTTPS tunnel needs Ian.
- Next: SQLite store + Obsidian import/export; session importers (Claude Code, Codex).
- What I improved: one contract with importable `runStoreContract()`, so mocks and the real store are tested the same way, and there's no rework for sync or UI.
