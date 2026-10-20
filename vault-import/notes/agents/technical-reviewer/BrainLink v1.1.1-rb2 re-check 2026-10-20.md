---
ai_platform: Grok Bot
agent_or_role: Technical Reviewer
session_or_task_id: "Claude 886 request 2026-10-20 — BrainLink v1.1.1-rb2 re-check vs PASS-WITH-FIXES review 1cT46RAIP4W-__3pDrREpd7mBW_i0zpaO"
written_at: "2026-10-20T20:12:00+08:00"
source: "repo /workspace/brainlink-rebuild tag v1.1.1-rb2 (67354f4, read-only via /tmp worktree, since removed); Drive zip 1uqsHoioab90K6gnro0Yw-Q7xQ5vlbWX5 (sha256 a8c8b546…fcb8, 75,402,406 bytes)"
confidence: high for code, build and Linux behaviour; not run on a real Mac
status: final
title: "BrainLink v1.1.1-rb2 re-check 2026-10-20"
type: safety-review
---
Made by Grok Bot (Technical Reviewer).

# BrainLink v1.1.1-rb2: re-check against the 1.1 safety pass

**Verdict: PASS-WITH-FIXES.** Every original install-order must-fix is now fixed in code, and the zip can be traced to the tag: rebuilding from the tag gave a byte-identical zip. It is safe for the sample-vault demo and for a fresh-Mac install. It is **not yet safe to attach Ian's real Brain vault**: the new default exclusions can be bypassed (see N1–N4).

## Build traceability
| Check | Result | Evidence |
|---|---|---|
| Tag → commit | PASS | `v1.1.1-rb2^{commit}` = 67354f4d28… (lightweight tag) on rebuild-v11 |
| mac-zip merged | PASS | e2cc3a3 "Merge branch 'mac-zip'"; `merge-base --is-ancestor mac-zip v1.1.1-rb2` is true (mac-zip = 457de9c) |
| Working tree | Clean at 20:05 (only untracked node_modules). By 20:10 it was dirty because Claude 886's RB5 job (v1.2.0-rc1: trial and licence removal) was editing it live. That does not affect the tag. | `git status --short` |
| Zip sha256 | **MATCH**: a8c8b546d971ddb4ba70148910b9743fde302bdd6dd1e242cdb6fcc3bcd6fcb8 | the Drive download, dist/BrainLink-1.1-mac.zip and its .sha256 are all identical (`cmp`) |
| Zip built from the tag | **PASS, reproducible**: build-zip.sh run on a clean `git worktree` of the tag, outside the repo, gave the **byte-identical** zip | `cmp` OK. The app files diff against `git archive` shows only src/license-key.mjs, which build-zip.sh:46-58 replaces with a placeholder on purpose. |

## Original must-fixes
| # | Status | Evidence |
|---|---|---|
| a. Connect writes the installed path | FIXED | Start and Connect source `.install.sh` (build-zip.sh:96,137), which copies to ~/Applications/BrainLink and `cd`s there before running node. runtime.mjs:11,22 still uses `process.execPath` + `CLI_PATH`, but those now resolve to DEST. Tested: connect run from a fake ~/Downloads wrote `…/home/Applications/BrainLink/app/bin/brainlink.mjs` into Cursor's mcp.json and kept the other server. |
| b. Install can't delete itself | FIXED | Install BrainLink.command:6 has `set -euo pipefail`; :9-13 refuses to run when HERE equals DEST ("already installed"); :16-19 copies to a mktemp folder, then rm and mv. The zip self-test proves both: install from Downloads, and refusal from inside DEST without changing any file. |
| c. Default exclusions | PARTIAL, see N1–N4 | core.mjs:131 `DEFAULT_EXCLUDED_FOLDERS` includes `00 Home/`. ensureDefaultIgnore (core.mjs:149) is called from setup.mjs:157 (quickStart) and setup.mjs:213. Temp-vault test: before, `00 Home/holdings.md` was indexed and searchable. After ensureDefaultIgnore it was gone from index and search; a second call was a no-op. |

## Should-fixes
| Item | Status | Evidence |
|---|---|---|
| ChatGPT wording | FIXED in the app | connectors.mjs:55 now reads "Not available yet…". No "Ian's decision" in src/, ui/ or bin/. Leftovers: the shipped README.md:62 still says "(pending Ian)". The ChatGPT card shows a disabled Connect with "install it, then reload", which is misleading for ChatGPT (index.html:559). |
| connect --all aggregation | FIXED | bin/brainlink.mjs:126-144 uses a per-app try/catch and prints a summary. Tested: invalid Gemini JSON failed, while Cursor and Windsurf still connected. Nit: exit code is 0 even when an app failed. |
| Token masking | FIXED with a caveat | bin/brainlink.mjs:33 maskUrl is applied at :89,:92,:216,:235, and the browser still gets the full URL. Tested: unset prints `?t=M1zz…`; `=1` prints the full token. **Caveat:** `BRAINLINK_SHOW_TOKEN=0` also unmasks, because any non-empty value counts. Not done: `history.replaceState` (none in ui/index.html), so the token stays in browser history. |
| TODO-CONTRACT | FIXED in code | Removed from ui/app/lib/api.mjs. Still in ui/app/CHANGES.md:14 (also shipped in the zip) and docs/HANDOFF-UI.md:15. These are docs only and never reach error text. |
| Demo mode imports real sessions | NOT FIXED | bin/brainlink.mjs:233 `importAll({ env: demoEnv })`. The importers default to `homedir()` (sessions/claude-code.mjs:12, codex.mjs:20-21). Sessions are still private by default and hidden unless "Show private sessions" (index.html:185) is ticked. Don't tick it on stage. |
| Build from uncommitted tree | FIXED | see Build traceability above |
| Install hardening | FIXED | see b |

## New issues found
- **N1 (must-fix before Ian's real Brain): the exclusion is bypassed by direct read.** `readNote` (core.mjs:501-507) uses `safeJoin` with no ignore check, and the MCP tools `vault_read_note` (server.mjs:105-108) and `fetch` (server.mjs:191) call it. Tested: `readNote(ctx,'T','00 Home/holdings.md')` returned the note after the ignore file was in place. Any `[[00 Home/…]]` link in a visible note reveals the path. The comment "never read" (core.mjs:128-130) is not true.
- **N2: rules only match at the folder level where they sit.** walk() (core.mjs:180-190) tests each rule against `f.name` only in the folder that holds the .brainlinkignore. So `00 Home/` at the vault root does **not** exclude `Brain/00 Home/` when the vault root sits above Brain. Tested: `Brain/00 Home/nested.md` stayed indexed and searchable.
- **N3: some vaults never get the defaults.** CLI `brainlink init` (bin/brainlink.mjs:95-114) never calls ensureDefaultIgnore, and vaults added before rb2 get no migration. ensureDefaultIgnore is only called at setup.mjs:157 and :213.
- **N4: Setup can overwrite the user's own ignore file.** The "Add vault" form pre-fills the defaults (index.html:577) and always sends `excludedFolders` (:585). setup.mjs:212 then calls `writeExcludedFolders`, which **overwrites** any existing `.brainlinkignore`, including the user's rules and comments. This contradicts the comment "never overwrites" at core.mjs:147.
- **N5 (3f78147): the "verified handshake" is in-process.** clientHealthCheck (setup.mjs:121-136) calls the MCP handler inside the Setup server itself. It proves the vault and BrainLink code work, but **not** that the AI app can launch the written command (node path, CLI path) or load it. So "Connected" still means "config written + BrainLink healthy", not "app verified". Other notes:
  - The "not present → refuse" gate (connectors.mjs connectClient) is correct and fixes the false Connected for apps that were never installed. Good.
  - On health failure, the `/api/connect` rollback calls disconnectClient, which would also remove an entry that was already working if the user re-connects (low).
  - The CLI `connect` path does no health check (inconsistent, low).
- **N6 (low): an install from Downloads replaces DEST.** Each Start or Connect run from a Downloads copy rm -rf's and replaces ~/Applications/BrainLink (.install.sh:7-12), even while a server is running from it. User data lives outside DEST, so the impact is low.
- **N7 (nit): the version still says 1.1.** package.json is still 1.1.0 and the zip is named BrainLink-1.1-mac.zip, so the tag name isn't visible in the artefact.

## Regressions: none found
- gitleaks on the zip: no leaks. On the commits e2cc3a3..tag: no leaks. On the tag tree: 8 hits, all fake fixtures in test/ and docs/PRODUCT-SPEC.md (sk_live_demo, hunter2SECRET), and none of them ship. rg found no real key patterns, no `/Users/iantsai`, and no .pem/.key/.p12/.env files.
- Binding: ui-server.mjs:85 and setup.mjs:366 listen on '127.0.0.1'; server.mjs:301 HTTP mode defaults to 127.0.0.1 and still has the Origin check.
- Tests: `node --test test/` gave **124/124 pass** (Node 20, with BRAINLINK_STORE_DIR set; without it sync.test can't find the store from a /tmp worktree, an environment issue only). `test-zip.sh` on the Drive zip: **SELF-TEST PASSED**.

## Still unverifiable on Linux
- The Gatekeeper prompt and "Open Anyway" for the unsigned .command files, quarantine on the bundled node, and whether exec bits survive Archive Utility.
- That the bundled darwin node 22.23.3 binaries run (tested with the box's Node 20).
- Claude Desktop, Cursor, Claude Code and the others actually loading BrainLink after a restart.
- Whether the .install.sh move behaves correctly on APFS/iCloud-synced ~/Applications.

## Remaining actions (owner: Claude 886)
1. N1: apply the ignore rules in readNote/fetch (and in writes) by refusing paths under excluded folders.
2. N2: support path rules (`Brain/00 Home/`), or match folder names at any depth for root rules.
3. N3: call ensureDefaultIgnore in `init`, and migrate existing vaults (one-time, no overwrite).
4. N4: pre-fill the form from the existing .brainlinkignore, or merge instead of overwriting.
5. Demo mode: skip the importers (or point HOME at the demo root).
6. Make `BRAINLINK_SHOW_TOKEN` need exactly `1`; add `history.replaceState`.
7. Small fixes: README "(pending Ian)", the ChatGPT card copy, a non-zero exit when connect --all has a failure, and bumping the version.
8. Re-review is needed for RB5 / v1.2.0-rc1 (LaunchAgent, .app, trial removal), which is a new attack surface.

Until N1–N4 are fixed: demo only with the sample vault. If Ian's Brain must be attached, move `00 Home` out of the vault first. A .brainlinkignore entry alone is not enough.
