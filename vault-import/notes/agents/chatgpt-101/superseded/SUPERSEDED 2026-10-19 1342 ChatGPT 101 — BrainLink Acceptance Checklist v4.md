---
title: BrainLink Acceptance Checklist (Mac demo first)
date: 2026-10-19
author: ChatGPT 101
project: BrainLink
step: 4
status: draft
ai_platform: Grok Bot
agent_or_role: ChatGPT 101
source: "Paulo plan 1Mk0DOGnCb5ZN8CMm503BEIShbVBsVQ__ and addendum 1NyuWcYP4CEpxBzOnOgHYW8Jrok5s9sgh; Claude 886 joint plan 1MWnISJ2aBGK5h8xPVIXruaMT7PxEEYiG; PRODUCT-SPEC 1xhj5UJIjPUyUyMgwTyiutdX3niOf_Hzn; BrainLink 1.1 eval 1Hgqz0wjAI2zLfRTK8lBqN2VfF2ff51ZY; web check of macOS 15 Gatekeeper 2026-10-19"
---
# BrainLink Acceptance Checklist (Mac demo first)

Made by ChatGPT 101.

v4 supersedes v3 (1aq4wNYdNPKaez21lW9efLB9nwSfQdotP). Every line is pass/fail. Claude 886 runs the Mac steps on Ian's Mac; ChatGPT 101 records results in the Run Log and failures in the Bug List. Joint test: Wed 10-21 AM clean-user install on Ian's Mac (Tue 10-20 stretch). Each section runs as soon as its part lands.
Owners (joint plan): store, import/export, MCP server, session tools, `brainlink connect`, packaging = Claude 886; sync = Claude 101; UI = ChatGPT 886; plan and test runs = ChatGPT 101.
MCP tools (Paulo addendum): brain_search, brain_read, brain_write, session_list, session_read, session_log.
Token rule (RSI Lab): tokens_est = CJK chars x1 + other chars / 4, summed over all calls for one answer. Pass = 1,050 or fewer (v1.1 measured ~950).

## 1. Mac demo (lands when: the .pkg is built)

| # | Instruction for Claude 886 | P/F |
|---|---|---|
| D1 | Install the .pkg on the clean user (section 2), using section 3 if Gatekeeper blocks it; the install completes | |
| D2 | Check /Applications/BrainLink.app and /usr/local/bin/brainlink exist; `brainlink version` prints the build version | |
| D3 | Open BrainLink; Setup opens at 127.0.0.1:47800 with a token; create vault, pack and agent in under 3 min | |
| D4 | Connect Claude Desktop in one shot: entry plus timestamped backup in claude_desktop_config.json; reopen it and see the six tools | |
| D5 | Connect Claude Code in one shot: entry in ~/.claude.json; in a new session `/mcp` shows brainlink with the six tools | |
| D6 | Log a Claude Desktop session with session_log; from Claude Code, session_list shows it and session_read returns it | |
| D7 | EN "What is the AI Platform Vault Access Rule?" via brain_search: that note is rank 1; brain_read opens it | |
| D8 | ZH "月眉 地名" via brain_search: 2026-10-02 — Place-name lock — 月眉 not 越美 is in the top 5 | |
| D9 | D7 and D8 each use 1,050 tokens or fewer, summary first | |
| D10 | Plant a marker note in a personal or livva scope; it never appears in brain_search, brain_read, session_list or session_read results | |
| D11 | During D4 to D10, only 127.0.0.1 traffic is seen (lsof -i); activity.log holds no note text | |

## 2. Fresh-Mac install, clean macOS user (lands when: .pkg built and a spare clean user exists on Ian's Mac)

| # | Instruction for Claude 886 | P/F |
|---|---|---|
| F1 | Log in as the spare clean user: no ~/Library/Application Support/BrainLink, no brainlink entry in ~/.claude.json, no Node on PATH | |
| F2 | Copy the .pkg in by download or AirDrop so it carries quarantine as a customer copy would (`xattr` shows com.apple.quarantine) | |
| F3 | Install, run D2 to D5, and time install to first answer (target under 3 min) | |
| F4 | Uninstall: `brainlink disconnect all`, delete BrainLink.app; vault notes are untouched and app config backups remain | |

## 3. Unsigned installer on macOS 15 Sequoia and later (web-checked 2026-10-19)

| # | Instruction for Claude 886 | P/F |
|---|---|---|
| G1 | Double-click the .pkg once and dismiss the block dialog (Done). Right-click > Open no longer bypasses Gatekeeper on macOS 15+ | |
| G2 | Open System Settings > Privacy & Security, scroll to Security, click Open Anyway beside the BrainLink line, confirm, enter the password or Touch ID | |
| G3 | Fallback if no Open Anyway button: `xattr -d com.apple.quarantine /path/to/BrainLink-<version>.pkg`, then reopen. Trusted builds only | |
| G4 | Record the macOS version and which path worked; on macOS 14 or earlier, right-click > Open still works | |

## 4. Own store without Obsidian (lands when: Claude 886's store passes the contract tests)

| # | Check | P/F |
|---|---|---|
| S1 | With no Obsidian installed, brain_write, brain_read and brain_search work through the store | |
| S2 | A stale-etag write is refused; supersede and revert make new versions and nothing is hard-deleted | |
| S3 | Obsidian export then import round-trips notes, frontmatter and links unchanged | |

## 5. Sync settings (lands when: Claude 101's src/sync/ passes the contract tests)

| # | Check | P/F |
|---|---|---|
| Y1 | Sync is off by default (Local only); a Drive, iCloud or Dropbox folder can be chosen | |
| Y2 | A snapshot is taken before each sync; a conflict keeps both copies | |
| Y3 | Sync carries the session index; personal and livva scopes and private sessions are never written to the sync folder (check the folder) | |

## 6. New UI (lands when: ChatGPT 886's UI is integrated in brainlink-src)

| # | Check | P/F |
|---|---|---|
| U1 | Setup opens only on 127.0.0.1 with its token; a wrong token or Host is refused | |
| U2 | The Connect screen auto-detects AI apps and connects each in one click; the Sessions view lists session_list results | |
| U3 | The UI touches notes only through the store API (no direct file writes in the UI code) | |

## 7. MCP addendum (lands when: Claude 886's session tools and `brainlink connect` land)

| # | Check | P/F |
|---|---|---|
| C1 | One-shot connect works for Claude Desktop, Claude Code, Cursor, Codex, Gemini CLI and Windsurf (one run-log row each) | |
| C2 | ChatGPT where possible: `brainlink serve --http` answers with the bearer token; wrong token gets 401, foreign Origin 403 | |
| C3 | From any one app, session_list and session_read return sessions from the others, and brain_search reaches the brain | |
| C4 | brain_search and session_read return summaries first and stay within the token rule | |
| C5 | Private sessions and the personal and livva scopes never appear in another app's results | |
| C6 | Imported sessions with planted fake secrets (sk-FAKE key, bearer token, password=, 16-digit number) come back redacted in session_read | |
| C7 | Windows (needs a real Windows PC): BrainLink-Setup-<version>.exe installs per-user, then C1 for Claude Desktop and Cursor | |

## Open questions (Claude 886 / Paulo)

1. Which local session stores does each importer read? Needed for D6, C3 and C6.
2. Is 1,050 per answer or the p50 over a question set? v0.4 measured ~1,063, v1.1 ~950.
3. Ian Personal and Ian Livva also live in Google Drive. Use the real vaults in the demo, or only marker notes?
4. Does `brainlink connect` replace the Setup Connect buttons, and does it reach the ChatGPT app or only Codex?
5. Is a Windows PC available for C7 before sign-off?
6. Will importer redaction also catch passwords? v1's secret scan is pattern-based and write-only.
