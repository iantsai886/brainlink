---
type: project
status: active
ai_platform: "Claude"
agent_or_role: "Claude Code (BrainLink build)"
session_or_task_id: "brainlink-source-to-brain-2026-10-19"
written_at: 2026-10-19T13:20:00+08:00
source: "BrainLink build sessions 2026-10-17 to 2026-10-19 with Ian; source copied from the Mac checkout"
confidence: "verified"
tags: [brainlink, product, mcp, source-code, second-brain]
aliases: ["BrainLink MCP", "BrainLink project"]
---
# BrainLink

Made by Claude (Claude Code (BrainLink build)).

BrainLink MCP is Iango's sellable product. It turns any Obsidian or Markdown folder into one second brain that every AI (Claude, ChatGPT Codex, Cursor, Gemini, Grok, Windsurf) can search and write to safely. It is the generic, customer version of Ian's own `iango-second-brain` server. **Any AI may read, verify, update or modify it** by following the rules below.

## Where everything is

| What | Where |
|---|---|
| Full source code, tests, docs, packaging | `source/` in this folder (master copy) |
| Product spec, approved by Ian | `source/docs/PRODUCT-SPEC.md` |
| Developer and user guide | `source/README.md` |
| Packaging notes | `source/packaging/windows/README.md`, `source/packaging/linux/README.md` |
| Search-quality evaluation on this Brain | `eval/run-eval.mjs` |
| Change log (append only) | [[BrainLink — Change Log]] |
| Installers (binary, not stored here) | Mac checkout `build/brainlink/dist/` |
| Licence signing key | Ian's Mac only (`~/.brainlink-issuer`). **Never copy it anywhere.** |

## Current state (2026-10-19, v1.1.0)

- **Tests:** `npm test` passes 48/48 (Node 22, no dependencies).
- **macOS:** `.pkg` with bundled Node, ad-hoc signed. Developer ID signing and notarisation wait on Ian's certificates.
- **Windows:** NSIS `.exe` and portable zip, built on the Mac. Windows logic is unit-tested; **not yet run on a real Windows PC**.
- **Linux:** `.deb` (amd64, arm64) and a per-user tar.gz. Tested in Debian 12, Ubuntu 24.04 and Fedora 41 containers.
- **Search on this Brain:** 27/28 top-5 on Technical Reviewer's gold set (MRR 0.818), 6/7 on held-out v2, 0 false "not in brain". See [[2026-10-19-1307-from-claude-to-grok-brainlink-1-1-scored-on-brain-with-technical-reviewer-gold-s]].

## Rules for every AI working on BrainLink

1. **Read first:** this note, then `source/README.md` and `source/docs/PRODUCT-SPEC.md`. Check [[BrainLink — Change Log]] for work in progress, so two AIs don't edit the same file at once.
2. **Edit the files in `source/` directly.** Keep each change small and focused, and match the existing style. The code is plain Node 22 ESM with no npm dependencies, and it must stay that way.
3. **Verify before you finish:**
   - `cd source && npm test` must pass.
   - If you touched search, linking or the verdict, also run `node eval/run-eval.mjs --show`. Top-5 and MRR must not fall, and false `not_in_brain` must stay 0.
   - Report real numbers. If you couldn't run something, say so.
4. **Keep it generic.** Nothing that names Ian, Iango vaults, agents, people or private paths may go into `source/src`, `source/bin`, `source/ui` or `source/samples`; a test enforces this. Never copy Brain notes into the product. The sample vault is fictional.
5. **No secrets, ever.** No API keys, tokens or the licence private key in any file.
6. **No AGPL code.** Obsidian Copilot and Khoj were studied for patterns only. Don't copy code from them or from any GPL project.
7. **Log every change:** append an entry to [[BrainLink — Change Log]] with date, AI and role, files, what and why, and test and eval results. Never rewrite other entries.
8. **Builds, signing and releases happen on Ian's Mac.** Ask Claude Code there with `send_handoff` to Claude. It pulls `source/` before building, so your edits are included.

## How the Mac checkout stays in step

`source/tools/brain-sync.sh` copies between this folder and the Mac checkout. It never overwrites a newer file on either side, never deletes, and only previews unless `--apply` is given.

- Before building on the Mac: `tools/brain-sync.sh pull "<this folder>" --apply`
- After changes made on the Mac: `tools/brain-sync.sh push "<this folder>" --apply`
- `tools/brain-sync.sh status "<this folder>"` shows what differs in each direction.

`source/.brainlinkignore` keeps the fictional sample vault (`samples/`) out of Brain search. Ian's own `iango-second-brain` server already skips `Projects/*/source`.

## Open items

- Ian: Apple Developer ID Application and Installer certificates plus the `brainlink-notary` notarytool profile, then signed and notarised `.pkg`.
- Run the Windows installer on a real Windows 10/11 PC, then Authenticode-sign it.
- Lemon Squeezy or Paddle webhook calling `source/tools/license-issue.mjs` (the private key stays on the Mac).
- Legal review of `source/LICENSE.txt` (EULA draft) and a privacy policy.
- Search: multilingual embeddings (bge-m3 via Ollama) for cross-language questions; Claude 886's token-first design (section fetch, `max_tokens`, `tokens_est`) — see [[2026-10-18 Claude 886 — BrainLink build plan: token-first, local search, model layer (design)]].
- A fresh blind gold set from Technical Reviewer — see [[2026-10-18 Technical Reviewer — BrainLink independent gold set]].

## Related

- [[2026-10-18 Paulo — BrainLink market research + RSI design]]
- [[2026-10-18 Claude 886 — BrainLink competitor feature study (REA)]]
- [[2026-10-18 RSI Lab - BrainLink v0.4 rerun]]
- [[2026-10-18 Technical Reviewer — BrainLink held-out set v2]]
