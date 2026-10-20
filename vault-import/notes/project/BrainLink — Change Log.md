---
type: log
status: active
ai_platform: "Claude"
agent_or_role: "Claude Code (BrainLink build)"
session_or_task_id: "brainlink-source-to-brain-2026-10-19"
written_at: 2026-10-19T13:20:00+08:00
source: "BrainLink build sessions 2026-10-17 to 2026-10-19"
confidence: "verified"
tags: [brainlink, changelog]
---
# BrainLink — Change Log

Made by Claude (Claude Code (BrainLink build)).

Append-only. Every AI that changes anything in [[BrainLink]] `source/` or `eval/` adds one entry at the bottom: date and time (Asia/Taipei), AI and role, files, what and why, and `npm test` / `eval` results (real numbers, or "not run" and why). Never edit or delete earlier entries.

## 2026-10-17 — v1.0.0 — Claude Code (BrainLink build)

- Generic, configurable rewrite of `iango-second-brain` v0.2: config-driven vaults and agents, rule packs, Setup UI, AI-app connectors with backups, offline Ed25519 licence keys, macOS `.pkg`.
- Tests: 33/33.

## 2026-10-18 — v1.1.0 — Claude Code (BrainLink build)

- Smart features: auto-linking and Related sections, Home map, optional Ollama semantic search, memories, open loops and brief, templates, daily note, link health, shared commands, one-click setup, 14-day built-in trial, coloured graph.
- Search tuned on this Brain with Technical Reviewer's gold sets (read-only).
- Windows NSIS installer built on macOS.
- Tests: 47/47. Eval: TR 27/28, MRR 0.818; held-out 6/7, MRR 0.607; 0 false not_in_brain.

## 2026-10-19 13:20 — Claude Code (BrainLink build)

- Linux packages: `.deb` (amd64, arm64) and a per-user tar.gz. Tested in Debian 12, Ubuntu 24.04 and Fedora 41 containers.
- Added `.brainlinkignore` support (folders to skip in search), `tools/brain-sync.sh`, and `brainlink disconnect-all`.
- Source copied into Brain as the master copy (`source/`), with `eval/run-eval.mjs`. The eval excludes this project folder.
- Tests: 48/48. Eval run from the Brain copy: TR 27/28, MRR 0.818; held-out 6/7, MRR 0.607; 0 false not_in_brain.
