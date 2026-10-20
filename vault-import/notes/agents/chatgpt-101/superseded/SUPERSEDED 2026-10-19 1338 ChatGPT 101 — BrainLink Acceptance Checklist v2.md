---
title: BrainLink Acceptance Checklist (Mac demo first)
date: 2026-10-19
author: ChatGPT 101
project: BrainLink
step: 4
status: draft
---
# BrainLink Acceptance Checklist (Mac demo first)

Made by Grok Bot (ChatGPT 101). Every line is pass/fail. Run each section as soon as its piece lands; log each run in the Run Log and failures in the Bug List.
Owner split: pending joint plan from Claude 886.
Token rule (RSI Lab): tokens_est = CJK chars x1 + other chars / 4, per answer (all search + read calls for one question). Pass = 1,050 or fewer (v1.1 measured ~950).

## 1. Mac demo (lands when: Mac .pkg built, target Tue 10-20, latest Wed 10-21; needs Ian's Mac)

| # | Check | P/F |
|---|---|---|
| D1 | Fresh Mac (no ~/Library/Application Support/BrainLink): open BrainLink-<version>.pkg; if blocked as unsigned, right-click > Open, or System Settings > Privacy & Security > Open Anyway; install completes | |
| D2 | /Applications/BrainLink.app and /usr/local/bin/brainlink exist; `brainlink version` prints the build version | |
| D3 | Opening BrainLink starts Setup at 127.0.0.1:47800 with a token; vault, pack and agent created in under 3 min | |
| D4 | Setup > Connect Claude Desktop: entry in claude_desktop_config.json plus timestamped backup; after reopen, BrainLink tools listed | |
| D5 | Setup > Connect Claude Code: entry in ~/.claude.json; new session `/mcp` shows brainlink; `brainlink clients` shows both | |
| D6 | Claude Desktop "<agent> close loop" appends one dated section; Claude Code "Connect to <agent>" shows it in recent captures | |
| D7 | EN "What is the AI Platform Vault Access Rule?" returns that note at rank 1 | |
| D8 | ZH "月眉 地名" returns 2026-10-02 — Place-name lock — 月眉 not 越美 in the top 5 | |
| D9 | D7 and D8 each use 1,050 tokens or fewer | |
| D10 | A private: true vault never appears in `search`/`fetch`; a BRAINLINK_VAULTS-scoped connection sees only its vaults | |
| D11 | Only 127.0.0.1 traffic during D4 to D10 (lsof/nettop); activity.log holds no note text | |

## 2. Own storage without Obsidian (lands when: storage piece delivered; not in v1 spec)

| # | Check | P/F |
|---|---|---|
| S1 | On a Mac with no Obsidian installed, BrainLink creates/uses a plain Markdown folder and search/read work | |
| S2 | A note saved through BrainLink is a new .md file; repeating the save refuses (never overwrite) | |
| S3 | Same folder opened later in Obsidian shows the notes and links unchanged | |

## 3. Sync settings (lands when: sync piece delivered; v1 spec lists team sync out of scope)

| # | Check | P/F |
|---|---|---|
| Y1 | Sync settings are visible in Setup and default to off for any vault marked private | |
| Y2 | A note added on machine A appears on machine B after sync, with nothing overwritten or deleted | |
| Y3 | Same note edited on both sides gives a conflict copy or flag, not silent loss | |
| Y4 | Private vault with sync on is refused or needs typed confirmation, and nothing of it reaches the sync target | |

## 4. New UI (lands when: new UI build delivered)

| # | Check | P/F |
|---|---|---|
| U1 | Setup opens only on 127.0.0.1 with its token; a wrong token or Host header is refused | |
| U2 | Vault, pack, agent, Connect all, licence and live call log all work without the command line | |
| U3 | Graph view shows note, link and unlinked counts matching `brainlink status` | |

## 5. MCP addendum (lands when: Mac build plus each app installed; Windows rows need a real Windows PC)

| # | Check | P/F |
|---|---|---|
| C1 | One-shot connect works for Claude Desktop, Claude Code, Cursor, Codex and Gemini CLI (one row each in the run log) | |
| C2 | ChatGPT: HTTP mode (`brainlink serve --http`, bearer token) answers; wrong token 401, foreign Origin 403; tunnel only if Ian approves | |
| C3 | From app A, the AI lists and reads app B's sessions and searches the brain | |
| C4 | Results come back summary-first (snippets before full notes), within D9's token rule | |
| C5 | Private sessions and private vaults never appear in another app's results | |
| C6 | Planted fake secrets (fake API key, token, password, 16-digit number) are filtered or refused on import and write | |
| C7 | Windows: BrainLink-Setup-<version>.exe installs per-user, then C1 for Claude Desktop and Cursor | |

## Open questions (Claude 886 / Paulo)

1. v1 has no session list/read or import tool (spec tools: vault_search, vault_read_note, agent_connect, list_handoffs, search, fetch...). Which tool does C3/C6 use? D6 uses close-loop captures meanwhile.
2. What are the storage, sync and new UI pieces exactly (no spec found)? Steps 1-3 notes not found in Drive.
3. Source of the 1,050 target: v0.4 measured ~1,063, v1.1 ~950. Per answer or per question set p50?
4. Ian Personal and Ian Livva are themselves synced via Google Drive (Vault Access Rule). Does "local-only" mean BrainLink adds no upload beyond Drive?
5. Secret scan is pattern-based and write-only in v1; is password detection planned?
