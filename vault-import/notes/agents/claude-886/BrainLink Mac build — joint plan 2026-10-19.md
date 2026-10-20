---
type: plan
status: proposed
owner: Claude 886
ai_platform: Grok Bot
agent_or_role: Claude 886
session_or_task_id: brainlink-mac-build-2026-10-19
written_at: 2026-10-19T13:45:00+08:00
source: Paulo relay of Ian's revised target 2026-10-19
confidence: medium
tags: [brainlink, plan, mac-build]
aliases: [BrainLink joint plan]
---
Made by Grok Bot (Claude 886). Changelog: 2026-10-19 v1 created.

1. Target: a Mac .pkg ready on Wed 10-21, with Tue 10-20 as a stretch. Scope is our own store, sync, the UI redesign and one-shot MCP connect with cross-session reads.
2. The contract is Node only: /workspace/brainlink-store/interface.d.ts (store, sessions, change events, snapshots, dated supersede, undo) with an in-memory reference impl and contract tests. Claude 886 owns it, and changes go through a version bump only, with no forks.
3. Integration repo: /workspace/brainlink-src (v1.1 as received, in git). Each owner commits only in their own module folder.
4. Claude 886: the contract, the store, Obsidian import/export, MCP server, session tools and importers, `brainlink connect`, and packaging.
5. Claude 101: sync in src/sync/ against the contract (local-only by default, Drive/iCloud/Dropbox folders, keep both on conflict, snapshot before sync, carries the session index).
6. ChatGPT 886: UI redesign against the contract's reference impl. It reads and writes through the store API only, never the files.
7. ChatGPT 101: the test plan, a fresh-Mac install checklist and the unsigned-installer notes, then it runs the joint test.
8. Mon 10-19: contract published, session tools and connect done.
9. Tue 10-20: store and import/export, with sync and UI built on the contract; evening integration in brainlink-src.
10. Wed 10-21 AM: pkgbuild and a clean-user install test on Ian's Mac; Wed PM: fixes and handover.
11. To avoid rework: one contract, search tuned only in the Mac core, no box brain_mcp track, one build per milestone and diagnose before rerunning.
12. Blockers: the full v1.1 tree (bin/, test/, packaging/) and Ian's Mac connected under Computers with a spare clean user account.
13. Handoffs: post the contract commit, then each module's commit plus test count, batched in one message per milestone to Claude 886.
14. Related: BrainLink build plan 10dqy8BVJPvRhYBqL-JI9t6YiI4Jh0nHT.
