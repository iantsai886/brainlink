---
title: BrainLink Mac Demo Acceptance Checklist
date: 2026-10-19
author: ChatGPT 101
project: BrainLink
step: 4
status: draft
---
# BrainLink Mac Demo Acceptance Checklist

Made by Grok Bot (ChatGPT 101). Run once per build with Claude 886 on Ian's Mac; mark each P or F, then log in the run log.

| # | Check (pass/fail) | P/F |
|---|---|---|
| M1 | Fresh Mac (no ~/Library/Application Support/BrainLink): open BrainLink-<version>.pkg; if blocked as unsigned, right-click > Open, or System Settings > Privacy & Security > Open Anyway; installer completes | |
| M2 | /Applications/BrainLink.app and /usr/local/bin/brainlink exist; `brainlink version` prints the build version | |
| M3 | Opening BrainLink starts Setup at http://127.0.0.1:47800/ with a token; vault picked, pack + agent created in under 3 min | |
| M4 | `brainlink status` lists the vaults, plan (trial) and agent, with no MISSING vault | |
| M5 | Setup > Connect Claude Desktop: entry written to claude_desktop_config.json, timestamped backup made; after reopen, BrainLink tools listed | |
| M6 | Setup > Connect Claude Code: entry in ~/.claude.json; new session `/mcp` shows brainlink connected | |
| M7 | `brainlink clients` shows both apps connected | |
| M8 | In Claude Desktop, "<agent> close loop" appends one dated section to the agent's log | |
| M9 | In Claude Code, "Connect to <agent>" returns that capture under recent captures (cross-app session read; see open question) | |
| M10 | English: "What is the AI Platform Vault Access Rule?" returns AI Platform Vault Access Rule as result 1 | |
| M11 | Chinese: "月眉 地名" returns 2026-10-02 — Place-name lock — 月眉 not 越美 in the top 5 | |
| M12 | Tokens per answer for M10 and M11 (CJK x1 + other chars / 4, RSI Lab rule) are each 1,050 or fewer | |
| M13 | Private vault (private: true) never appears in `search`/`fetch` results; a connection scoped with BRAINLINK_VAULTS sees only its vaults | |
| M14 | Writing a planted fake key (e.g. sk-FAKE + 40 base64 chars) is refused "looks like it contains secrets" | |
| M15 | No network except localhost during M5 to M14 (lsof/nettop shows only 127.0.0.1); activity.log holds no note text | |

Open question: BrainLink v1 has no session-import tool; M9 uses close-loop captures as the cross-app session path until Claude 886 confirms otherwise.
