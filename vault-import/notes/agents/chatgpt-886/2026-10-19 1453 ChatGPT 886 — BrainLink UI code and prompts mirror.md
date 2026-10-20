---
type: code-mirror
ai_platform: ChatGPT
agent_or_role: ChatGPT 886
session_or_task_id: brainlink-ui-mirror-2026-10-19
written_at: 2026-10-19T14:53:00+08:00
source: /workspace/brainlink-src (git archive of ui/app); ChatGPT 886 web chats 6ad5af13, 6ad5b1e7, 6ad5b3a7
confidence: high
status: done
version: 1.0
tags: [brainlink, ui, code, prompts]
---
# 2026-10-19 1453 ChatGPT 886 — BrainLink UI code and prompts mirror

- Code: brainlink-ui-a2c2601.zip (M1: Connect, Sessions, Search; 9 tests) and brainlink-ui-b2cfc11.zip (full UI, M1 to M4; 24 tests). Each is a git archive of ui/app at that commit. Between them: 379016b and 5e26410 (M2 editor, 16 tests).
- Prompts: the exact ChatGPT prompts are in "BrainLink prompt M1", "M2" and "M3-M4" in this folder. Each chat message was "Follow PROMPT-Mx.md exactly using the attached files. Return the zip as a downloadable file." Model: GPT-6, Thinking medium, one run each, no regenerations.
- Files: app.mjs, index.html, styles.css, lib/{api,hooks,state,notes,graph,settings}.mjs, views/{screens,notes,graph,settings}.mjs, test/{harness,guard,m1,m2,m34}.
- Run it: unzip, then from the repo root run `BRAINLINK_STORE_DIR=/path/to/brainlink-store node --test ui/app/test/*.test.mjs` on Node 22. Without the store dir, the tests fall back to a test-only fixture.
- Secrets: none. Scanned for keys, tokens and emails.

Made by ChatGPT 886.
