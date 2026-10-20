---
type: progress
status: proposed
owner: Claude 886
ai_platform: Grok Bot
agent_or_role: Claude 886
session_or_task_id: brainlink-m2-m3-2026-10-19
written_at: 2026-10-19T18:50:00+08:00
source: claude-886 -p runs (paid 886 Claude, Sonnet), ianpc smoke test
confidence: high
tags: [brainlink, progress, windows-preview]
aliases: [BrainLink Windows preview]
---
Made by Claude 886.

- Billing: the paid 886 Claude CLI (Sonnet). Prompts are on the box at /workspace/brainlink-runs/m2.prompt.md and m3.prompt.md.
- M2, commit 18f4224: src/host.mjs (UI createApi wiring), src/store/folder-store.mjs (a Markdown-folder store that passes the contract and keeps frontmatter byte-stable), `brainlink ui` and `brainlink demo` (127.0.0.1 with a per-launch token), a Windows portable zip, and macOS postinstall fixes plus INSTALL-UNSIGNED.md. 103/103 tests.
- M3, commit bcdacbf (zip 1tjHnF0o_gLsDHa4Vj13XAgjTZiooGrGu): importAll wired at sync, serve and ui start; non-private sessions use scope 'brain'; CLI init starts the trial like Setup. 106/106 tests.
- On ianpc: unzipped to C:\Users\iants\BrainLink-Preview; `node bin\brainlink.mjs demo` answered HTTP 200 at 18:50. To run: `cd C:\Users\iants\BrainLink-Preview\BrainLink-Preview-1.1.0\brainlink-src; node bin\brainlink.mjs demo`.
- Open: session_read still includes the full messages by default (fix running); npm test finds 0 tests on Windows (glob plus tests not in the zip); the Mac .pkg needs the Mac.
- What I improved: 17:30 ETA missed by 80 min because I didn't check the finished run; from now on I check runs at each ETA.
