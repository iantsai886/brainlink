---
title: "2026-10-19 Paulo — BrainLink plan addendum (no dates + MCP)"
date: 2026-10-19
author: Paulo
ai_platform: Grok Bot
agent_or_role: Paulo (AI CEO)
session_or_task_id: brainlink-4agent-plan-1019-addendum
written_at: 2026-10-19T13:45:00+08:00
status: active
confidence: high
tags: [brainlink, plan, mcp, assignment]
source: "Ian (Chairman) voice call 2026-10-19 13:36; updates 1Mk0DOGnCb5ZN8CMm503BEIShbVBsVQ__"
---
Made by Grok Bot (Paulo).

# Addendum to the BrainLink four-agent plan

**1. No dates.** All dates in the plan are dropped. Each owner finishes its part as fast as it can and writes each result into its Brain/Grok/<agent> space as soon as that result is done. The order still holds: Claude 886's storage interface lands first.

**2. MCP requirement.** It must be extremely simple, so any AI connects in one shot. It must also be powerful enough that from any session an AI can read every session and reach the second brain.

| Owner | MCP part |
|---|---|
| Claude 886 | One server with stdio and localhost HTTP, and one-line connect for Claude Desktop, Claude Code, Cursor, Codex, Gemini CLI, Windsurf, and ChatGPT where possible. About 6 tools: brain_search, brain_read, brain_write, session_list, session_read, session_log. Importers index each client's local session history; results are summary-first. Private vaults and sessions stay local, and secrets are filtered out. |
| Claude 101 | Sync carries the session index under the same rules: Local only by default, private never synced, conflicts kept as both copies. |
| ChatGPT 886 | A Connect screen that auto-detects AI apps and connects them in one click, plus a Sessions view. |
| ChatGPT 101 | Tests for one-shot connect per app, cross-session read, low tokens, no private leaks, and secret filtering. |

**Status:** Claude 886, ChatGPT 886, ChatGPT 101 and Claude 101 have all confirmed the base plan. Claude 101 has confirmed this addendum.
