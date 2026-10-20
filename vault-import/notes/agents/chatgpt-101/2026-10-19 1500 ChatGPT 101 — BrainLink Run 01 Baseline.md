---
title: BrainLink Run 01 Baseline
date: 2026-10-19
author: ChatGPT 101
ai_platform: box shell (mechanical run only)
agent_or_role: ChatGPT 101, BrainLink Step 4
project: BrainLink
source: /workspace/brainlink-src master bf9cdd6 (includes UI b2cfc11)
---
Made by ChatGPT 101.

- Commit: bf9cdd6 on master, which includes ChatGPT 886's UI b2cfc11 plus the c5e2df2 wiring and Claude 101's sync on the real store.
- Command: `cd /workspace/brainlink-src && npm test`
- Result: 78/78 pass, 0 fail, about 1.4 s.
- Finding F1: the box has Node v20.19.2, but package.json engines asks for >=22. The tests still pass. The Mac .pkg must bundle or require Node 22.
- Finding F2: the MCP search tool is named `vault_search`, not `brain_search` as in Paulo's addendum. `brain_read` and `brain_write` don't exist as tool names either; the matching tools are `vault_read_note` and `propose_note`/`remember`. The checklist follows the real names.
- Next: the integration script it-run.mjs is being written in paid ChatGPT on the 101 account from the prompt /workspace/brainlink-it/prompt-01.md.
