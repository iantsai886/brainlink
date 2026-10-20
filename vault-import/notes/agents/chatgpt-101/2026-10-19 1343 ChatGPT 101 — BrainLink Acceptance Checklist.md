---
title: BrainLink Acceptance Checklist (Mac demo first)
date: 2026-10-19
author: ChatGPT 101
project: BrainLink
step: 4
status: draft
ai_platform: Grok Bot
agent_or_role: ChatGPT 101
source: "Paulo plan 1Mk0DOGnCb5ZN8CMm503BEIShbVBsVQ__ and addendum 1NyuWcYP4CEpxBzOnOgHYW8Jrok5s9sgh; Claude 886 joint plan 1MWnISJ2aBGK5h8xPVIXruaMT7PxEEYiG; PRODUCT-SPEC 1xhj5UJIjPUyUyMgwTyiutdX3niOf_Hzn; BrainLink 1.1 eval 1Hgqz0wjAI2zLfRTK8lBqN2VfF2ff51ZY; answers from Paulo and Claude 886 2026-10-19 13:43; web check of macOS 15 Gatekeeper 2026-10-19"
---
# BrainLink Acceptance Checklist (Mac demo first)

Made by ChatGPT 101.

v5 supersedes v4 (1xO5tLUVB3CXkoLXUtG_3qK9Ts6AjpsmY). Every line is pass/fail. Claude 886 runs the Mac steps on Ian's Mac; ChatGPT 101 records results in the Run Log and failures in the Bug List. Joint test: Wed 10-21 AM clean-user install on Ian's Mac (Tue 10-20 stretch). Each section runs as soon as its part lands.
Owners (joint plan): store, import/export, MCP server, session tools, `brainlink connect`, packaging = Claude 886; sync = Claude 101; UI = ChatGPT 886; plan and test runs = ChatGPT 101.
MCP tools: brain_search, brain_read, brain_write, session_list, session_read, session_log.
Token rule: tokens_est = CJK chars x1 + other chars / 4, summed over all calls for one answer. Pass = median over the question set 1,050 or fewer AND every answer 3,000 or fewer. Also report p95.
Privacy rule: use only planted marker notes and sessions. Never open, search or copy the real Ian Personal or Ian Livva vaults; only check that private scopes stay invisible.

## 1. Mac demo (lands when: the .pkg is built)

| # | Instruction for Claude 886 | P/F |
|---|---|---|
| D1 | Install the .pkg on the clean user (section 2), using section 3 if Gatekeeper blocks it; the install completes | |
| D2 | Check /Applications/BrainLink.app and /usr/local/bin/brainlink exist; `brainlink version` prints the build version | |
| D3 | Open BrainLink; Setup opens at 127.0.0.1:47800 with a token; create vault, pack and agent in under 3 min | |
| D4 | `brainlink connect` Claude Desktop (or Setup Connect): entry plus timestamped backup in claude_desktop_config.json; reopen it and see the six tools | |
| D5 | `brainlink connect` Claude Code: entry in ~/.claude.json; in a new session `/mcp` shows brainlink with the six tools | |
| D6 | From Claude Desktop, session_list shows a Claude Code session (imported from ~/.claude/projects/*/*.jsonl) and session_read returns it | |
| D7 | EN "What is the AI Platform Vault Access Rule?" via brain_search: that note is rank 1; brain_read opens it | |
| D8 | ZH "月眉 地名" via brain_search: 2026-10-02 — Place-name lock — 月眉 not 越美 is in the top 5 | |
| D9 | Over the D7/D8 question set: median 1,050 or fewer, no answer over 3,000, summary first; record median and p95 | |
| D10 | Plant a marker note in a private scope; it never appears in brain_search, brain_read, session_list or session_read results | |
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

## 5. Sync settings (status: Claude 101 sync v0 in Brain/Grok/Claude 101, 9/9 on the mock; re-run when the real store is wired in)

| # | Check | P/F |
|---|---|---|
| Y1 | Sync is off by default (Local only); a Drive, iCloud or Dropbox folder can be chosen | |
| Y2 | A snapshot is taken before each sync; a conflict keeps both copies | |
| Y3 | Sync carries the session index; private scopes and private sessions are never written to the sync folder (check the folder) | |

## 6. New UI (lands when: ChatGPT 886's UI is integrated in brainlink-src)

| # | Check | P/F |
|---|---|---|
| U1 | Setup opens only on 127.0.0.1 with its token; a wrong token or Host is refused | |
| U2 | The Connect screen auto-detects AI apps and connects each in one click; the Sessions view lists session_list results | |
| U3 | The UI touches notes only through the store API (no direct file writes in the UI code) | |

## 7. MCP addendum (lands when: Claude 886's session tools and `brainlink connect` land)

| # | Check | P/F |
|---|---|---|
| C1 | `brainlink connect --all` (same path as Setup) connects Claude Desktop, Claude Code, Cursor, Codex, Gemini CLI and Windsurf; one run-log row each | |
| C2 | ChatGPT: N/A pending Ian's decision (needs a remote HTTPS connector, which conflicts with localhost-only). Pass now = connect prints an honest not-supported note | |
| C3 | Importers are read-only: Claude Code from ~/.claude/projects/*/*.jsonl, Codex from ~/.codex/sessions/**/*.jsonl plus history if present; source files unchanged (mtime/hash) | |
| C4 | Cursor: sessions come from workspaceStorage state.vscdb, or via session_log if that needs native modules; record which | |
| C5 | From any one app, session_list and session_read return the other apps' sessions, and brain_search reaches the brain, summaries first, within the token rule | |
| C6 | Private sessions and private scopes never appear in another app's results (marker notes and sessions only) | |
| C7 | Plant fake secrets in a session (sk-FAKE key, bearer token, fake private-key block, secret=..., fake email); session_read shows each one masked | |
| C8 | Plant a fake `password=Fake-Pass-123` key=value line in a session; session_read shows it masked | |
| C9 | Windows on ianpc (Claude 886 or Paulo, after the Mac checks): BrainLink-Setup-<version>.exe installs per-user, then C1 for Claude Desktop and Cursor | |

## Open questions

None open (answers from Paulo and Claude 886 applied 2026-10-19 13:43).
