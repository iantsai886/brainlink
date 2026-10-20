---
title: "2026-10-20 Technical Reviewer — BrainLink 1.1 safety pass"
type: safety-review
ai_platform: Grok Bot
agent_or_role: Technical Reviewer
session_or_task_id: "Paulo task 2026-10-20 BrainLink 1.1 safety pass (2e58a02)"
written_at: "2026-10-20T10:52:58+08:00"
source: "/workspace/brainlink-rebuild/dist/BrainLink-1.1-mac.zip (sha256 2852737143…bdc0425, 75,398,129 bytes); repo /workspace/brainlink-rebuild rebuild-v11 2e58a02 + uncommitted worktree; Drive 1tcxbb2t2iA8bq6HxZwVBq_0VxRoj6Y1d (same byte size)"
confidence: medium-high (static review + isolated-HOME runs on Linux box; not run on a real Mac)
status: final
---
Made by Grok Bot (Technical Reviewer).

# BrainLink 1.1 Mac build — safety pass

**Verdict: PASS-WITH-FIXES.** No secrets, no licence or signing key, no personal data and no dangerous script commands in the zip. Config edits make a backup, merge rather than overwrite, and can be rerun safely. The server listens on this computer only. Nothing found blocks Ian's install. The must-fix items below are about the order Ian runs things in, not code changes.

Method: unzipped to /tmp/bl-review; ran gitleaks + rg; read all three .command scripts, connectors, setup/ui servers, session import/sync. Ran `brainlink ui` and `connect --all`/`disconnect` with the box's Node 20, inside a throwaway HOME whose path had spaces and Chinese characters, with fake Claude Desktop and Cursor configs. Paid Claude not used (time). Nothing was installed or run against real configs; the repo was not edited.

## Must-fix before Ian runs it (procedure, no code change needed)
1. **Run Install first, then Connect from the installed copy, then never delete the folder Connect ran from.** Connect writes the *absolute* path of the folder it was run from into every AI app's config (`app/src/runtime.mjs:244`, `process.execPath` + `CLI_PATH`). `Install BrainLink.command:2-3` suggests deleting the original download after installing. If Connect ran from ~/Downloads and the download is then deleted, BrainLink breaks in every AI app mid-demo. Correct order: Install → open ~/Applications/BrainLink → Connect AI apps.command → Start BrainLink.command.
2. **Never double-click Install BrainLink.command from inside ~/Applications/BrainLink.** `Install BrainLink.command:7-8` runs `rm -rf "$DEST"` and then `cp -R "$(pwd)"`. When the current folder *is* $DEST, the script deletes itself and the copy fails, so the app is gone. There is no `set -e` and no guard.
3. **Prospect demo: use the sample vault ("Use the sample vault" button, or `brainlink demo`), not Ian's Brain.** A vault is indexed in full, and nothing is excluded by default; only a `.brainlinkignore` file excludes anything (`app/src/core.mjs:119-130`). If the Brain vault is attached, `00 Home` personal-finance notes (John's holdings) are searchable and shown in the graph. If the Brain must be shown, add `.brainlinkignore` with `00 Home/` first (or move it out, per Anna Bridge).

## Should-fix before the demo (code)
- **Embarrassing visible text:** `app/src/connectors.mjs:54`. The ChatGPT note reads "…pending **Ian's** decision on an opt-in tunnel…". ChatGPT is listed as "Not found" with an enabled Connect button (`app/ui/index.html:548`), and clicking it shows that text (`connectors.mjs:165`). Reword it, and hide the button for unsupported clients.
- **`connect --all` stops at the first bad config:** `app/bin/brainlink.mjs:118-123` has no try/catch around each app. Tested: an invalid `~/.cursor/mcp.json` exits 1, so Codex, Gemini and Windsurf never get connected. The Setup UI path (`setup.mjs:95+` connectAll) does collect failures per app. Wrap each app in the CLI loop the same way.
- **Demo mode reads real AI history:** `brainlink demo` imports the real `~/.claude/projects` and `~/.codex` sessions into the throwaway store (`bin/brainlink.mjs:212`, `sessions/claude-code.mjs:12`, `sessions/codex.mjs:20-21`, homedir is not overridden). They are private by default and hidden unless "include private" is ticked (`ui/index.html:184,325`). On stage, do not tick it. Fix: skip importers in demo mode.
- **The build can't be traced to a commit:** the zip matches the *uncommitted worktree*, not 2e58a02. `src/setup.mjs`, `src/sessions/store.mjs`, `src/sync/engine.mjs` and `ui/index.html` are modified, and `test/demo-features.test.mjs` is untracked. Commit and tag what shipped.
- **Install script hardening:** add `set -euo pipefail`. Copy to a temp folder and then `mv`, instead of `rm -rf` followed by `cp`. Refuse to run when `$(pwd)` = `$DEST`.
- **Token in the URL:** the UI token travels as `?t=` in the URL (`setup.mjs:330`, `ui-server.mjs:87`), is printed in Terminal, and is never removed from browser history (`ui/index.html:272`). The exposure is local only, so the risk is low. Add `history.replaceState`, and don't screen-share the Terminal window.
- **Minor:** every rerun of Connect leaves another backup file (harmless clutter). There is no one-click "restore backup", only `disconnect`. `TODO-CONTRACT` strings in `ui/app/lib/api.mjs:13` can surface in error text. The test files `ui/app/test/*` ship in the zip. The Setup page CSP allows `unsafe-inline` (`setup.mjs:311`).

## Checked and clean
- **Secrets:** gitleaks found no leaks. There are no `.env`, `.git`, `.npmrc`, `*.pem`, `*.key` or `*.p12` files, no DBs and no session JSONL in the zip. rg found no API, AWS, GitHub or Slack key patterns, only the redaction regexes. `node_modules` contains only the local `brainlink-store` package.
- **Licence:** `app/src/license-key.mjs` creates a throwaway public key at runtime (or reads `BRAINLINK_LICENSE_PUBKEY_FILE`). No vendor private key and no licence key ship. The issuing tool (`tools/license-issue.mjs`) is not in the zip.
- **No personal data:** no `/Users/iantsai`, no personal vault, and the samples are the made-up "Acme Studio". "Iango" appears only in the LICENSE.
- **.command scripts:** no sudo, no curl-to-shell, no `xattr` or `spctl`. All paths are quoted (`cd "$(dirname "$0")"`) and nothing is hard-coded to a user. They write only ~/Applications/BrainLink, the app config folder, and the AI app configs. The arm64/x64 choice is made with `uname -m`. The README *tells the user* how to remove quarantine by hand; the scripts never do it themselves.
- **Runtime:** bundled Node v22.23.3 for both arm64 and x64 (Mach-O), with the Node.js Foundation Developer ID signature present. Unix permissions 755 are stored in the zip for the 3 .command files and both node binaries.
- **Connect AI apps** (tested in the throwaway HOME):
  - It makes a timestamped backup next to the config file before every write.
  - It merges `mcpServers`: other servers and other top-level keys were kept.
  - Running it twice gave identical output, so it is safe to rerun.
  - It refuses invalid JSON and leaves the file untouched.
  - It writes atomically (temp file, then rename).
  - It points at the bundled node's absolute path.
  - `disconnect` removes only `brainlink` and makes a backup.
  - Claude Code goes through `claude mcp add-json` when the CLI exists. Codex TOML replaces only `[mcp_servers.brainlink*]`.
- **Network:** the UI listens on 127.0.0.1 only, on a random port for `ui`, so a busy port is not a problem. Setup uses 47800 and falls back if it is busy.
  - A wrong Host header gets 421 (tested, which blocks DNS rebinding). The API needs the per-launch token (constant-time compare).
  - There are no CORS headers and no 0.0.0.0 binding.
  - HTTP MCP mode is 127.0.0.1, bearer token of 16+ characters, with an Origin check.
- **Paths with spaces and Chinese:** UI start, connect and disconnect all worked with spaces plus Chinese in both the app path and HOME. With no vault configured, the first run serves the UI (200).
- **Sessions:** imported Claude Code and Codex sessions are `private: true` and pass through redaction (`sessions/redact.mjs`). Sync sends only non-private, brain-scoped entries and redacts again (`sync/engine.mjs:67-115`). Writes are scanned for secrets and refused if any are found (`writes.mjs:48`).

## Could not verify
- Real macOS behaviour:
  - the Gatekeeper prompt for the unsigned .command (macOS 15 needs System Settings → Privacy & Security → Open Anyway; README step 4 covers this);
  - whether exec bits survive Archive Utility unzip;
  - whether quarantine on the bundled node blocks it.
- That the Mac node binaries actually run (the box is Linux; I tested with Node 20).
- Claude Desktop, Cursor or Claude Code actually loading the server after a restart.
- That the Drive copy is byte-identical: only the size matches (75,398,129 bytes); no checksum is available in Drive.
