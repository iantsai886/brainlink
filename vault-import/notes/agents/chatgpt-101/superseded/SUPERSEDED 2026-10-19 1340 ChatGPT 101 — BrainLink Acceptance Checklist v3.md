---
title: BrainLink Acceptance Checklist (Mac demo first)
date: 2026-10-19
author: ChatGPT 101
project: BrainLink
step: 4
status: draft
---
# BrainLink Acceptance Checklist (Mac demo first)

Made by Grok Bot (ChatGPT 101). v3, aligned with the joint plan by Claude 886 (Drive 1MWnISJ2aBGK5h8xPVIXruaMT7PxEEYiG). Every line is pass/fail.
Run: Claude 886 executes the Mac steps on Ian's Mac; ChatGPT 101 records results in the Run Log and failures in the Bug List. Joint test: Wed 10-21 AM clean-user install on Ian's Mac (Tue 10-20 stretch). Each section runs as soon as its piece lands.
Owners (joint plan): store, import/export, MCP server, session tools, `brainlink connect`, packaging = Claude 886; sync = Claude 101; UI = ChatGPT 886; plan and test runs = ChatGPT 101.
Token rule (RSI Lab): tokens_est = CJK chars x1 + other chars / 4, summed over all calls for one answer. Pass = 1,050 or fewer (v1.1 measured ~950).

## 1. Mac demo (lands when: the .pkg is built)

| # | Instruction for Claude 886 | P/F |
|---|---|---|
| D1 | Install the .pkg on the clean user (section 2), using section 3 if Gatekeeper blocks it; the install completes | |
| D2 | Check /Applications/BrainLink.app and /usr/local/bin/brainlink exist; `brainlink version` prints the build version | |
| D3 | Open BrainLink; Setup opens at 127.0.0.1:47800 with a token; create vault, pack and agent in under 3 min | |
| D4 | Connect Claude Desktop in one shot: entry plus timestamped backup in claude_desktop_config.json; reopen it and see the BrainLink tools | |
| D5 | Connect Claude Code in one shot: entry in ~/.claude.json; in a new session `/mcp` shows brainlink; `brainlink clients` lists both | |
| D6 | End a Claude Desktop session, then from Claude Code list and read that session through the session tools | |
| D7 | Ask EN "What is the AI Platform Vault Access Rule?": that note is rank 1 | |
| D8 | Ask ZH "月眉 地名": 2026-10-02 — Place-name lock — 月眉 not 越美 is in the top 5 | |
| D9 | D7 and D8 each use 1,050 tokens or fewer, summary first | |
| D10 | Plant a marker note in a personal or livva scope; it never shows up in any search, fetch or session result | |
| D11 | During D4 to D10, only 127.0.0.1 traffic is seen (lsof -i); activity.log holds no note text | |

## 2. Fresh-Mac install, clean macOS user (lands when: .pkg built and a spare clean user exists on Ian's Mac)

| # | Instruction for Claude 886 | P/F |
|---|---|---|
| F1 | Log in as the spare clean user: no ~/Library/Application Support/BrainLink, no ~/.claude.json brainlink entry, no Node on PATH | |
| F2 | Copy the .pkg in by download or AirDrop so it carries quarantine as a customer copy would (`xattr` shows com.apple.quarantine) | |
| F3 | Install, run D2 to D5, and time install to first answer (target under 3 min) | |
| F4 | Uninstall test: `brainlink disconnect all`, delete BrainLink.app; the vault notes are untouched and app config backups remain | |

## 3. Unsigned installer on macOS 15 Sequoia and later (verified by web lookup 2026-10-19)

| # | Instruction for Claude 886 | P/F |
|---|---|---|
| G1 | Double-click the .pkg once and dismiss the block dialog (Done). Right-click > Open no longer bypasses Gatekeeper on macOS 15+ | |
| G2 | Open System Settings > Privacy & Security, scroll to Security, click Open Anyway beside the BrainLink line, confirm, enter the password or Touch ID | |
| G3 | Fallback if no Open Anyway button: `xattr -d com.apple.quarantine /path/to/BrainLink-<version>.pkg`, then reopen. Trusted builds only | |
| G4 | Record macOS version and which path worked; on macOS 14 or earlier, right-click > Open still works | |

## 4. Own store without Obsidian (lands when: Claude 886's store passes the contract tests)

| # | Check | P/F |
|---|---|---|
| S1 | With no Obsidian installed, notes are created, read and searched through the store API | |
| S2 | A stale-etag write is refused; supersede and revert make new versions and nothing is hard-deleted | |
| S3 | Obsidian export then import round-trips notes, frontmatter and links unchanged | |

## 5. Sync settings (lands when: Claude 101's src/sync/ passes the contract tests)

| # | Check | P/F |
|---|---|---|
| Y1 | Sync is off by default; a Drive, iCloud or Dropbox folder can be chosen | |
| Y2 | A snapshot is taken before each sync; a conflict keeps both copies | |
| Y3 | Sync carries the session index; personal and livva scopes are never written to the sync folder (check the folder) | |

## 6. New UI (lands when: ChatGPT 886's UI is integrated in brainlink-src)

| # | Check | P/F |
|---|---|---|
| U1 | Setup opens only on 127.0.0.1 with its token; a wrong token or Host is refused | |
| U2 | Vault, agents, Connect, sync settings and the live call log all work with no command line | |
| U3 | The UI touches notes only through the store API (no direct file writes in the UI code) | |

## 7. MCP addendum (lands when: Claude 886's session tools and `brainlink connect` land)

| # | Check | P/F |
|---|---|---|
| C1 | One-shot connect works for Claude Desktop, Claude Code, Cursor, Codex and Gemini CLI (one run-log row each) | |
| C2 | ChatGPT where possible: `brainlink serve --http` answers with the bearer token; a wrong token gets 401, a foreign Origin 403 | |
| C3 | From any one app, the AI lists and reads sessions from the others and searches the brain | |
| C4 | Results are summary first and within the token rule | |
| C5 | Private sessions and the personal and livva scopes never appear in another app's results | |
| C6 | Imported sessions with planted fake secrets (sk-FAKE key, bearer token, password=, 16-digit number) come back redacted | |
| C7 | Windows (needs a real Windows PC): BrainLink-Setup-<version>.exe installs per-user, then C1 for Claude Desktop and Cursor | |

## Open questions (Claude 886 / Paulo)

1. What are the session tool names, and which session stores does each importer read? Needed for D6, C3 and C6.
2. Is the 1,050 target per answer or the p50 over a question set? v0.4 measured ~1,063, v1.1 ~950.
3. Ian's real Ian Personal and Ian Livva vaults also live in Google Drive (Vault Access Rule). Should the demo use them or only marker notes?
4. Does `brainlink connect` replace the Setup Connect buttons, and does it cover the ChatGPT app or only Codex?
5. Is a Windows PC available for C7 before sign-off?
