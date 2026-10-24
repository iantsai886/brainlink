# BrainLink implementation status

Status snapshot: 2026-10-24 (Asia/Taipei)
GitHub repository: `iantsai886/brainlink`
Branch: `fix/private-session-excerpts`
Code baseline: development target `1.2.8`, with `package.json` as the canonical version source. The `v1.2.7` tag belongs to the separate `wip/v1.2.7` release line; this branch continues from the full-source `main` history and does not move or recreate that tag.
Validation environment: Windows, Node.js 24.18.0; local `npm run test:all`: core 253 tests (247 passed, 0 failed, 6 skipped) and UI 28/28. GitHub Actions run for `8e11ad6` passed all six Node 22/24 jobs on Windows, macOS and Linux; unsigned package builds and runtime smoke checks passed on all three OSes (run [40091032717](https://github.com/iantsai886/brainlink/actions/runs/40091032717)). Debian install/init succeeded; macOS package expanded and launched; Windows installer installed, launched, initialized a fictional vault, uninstalled, and preserved the isolated user config. Linux/macOS/Windows opt-in startup-entry generation and authenticated API behavior pass platform-targeted tests; actual per-user sign-in execution still needs acceptance in native desktop sessions. The Node 24.22.1 Windows archive checksum and runtime were verified locally.
Client discovery: Codex CLI `0.164.0-alpha.11.1` found the repository skill in `codex debug prompt-input`; Claude Code CLI is not installed here.

This is an evidence ledger, not a release-readiness claim. “Implemented and locally tested” does not imply packaged, cross-client validated, or ready for customers.

## Memory and continuity

| Area | Current implementation | Evidence and remaining gap |
|---|---|---|
| Working memory | Imported Claude Code and Codex sessions, private session logging, bounded `session_read`, handoff mailbox, explicit close operation, opt-in SessionEnd setup, and dismissible local reminders. | `src/sessions/end-cue.mjs`, `src/sessions/hooks.mjs`, `docs/SESSION-FILING.md`. Tests cover configuration preservation, generated command execution, authentication and private-field exclusion; isolated browser review confirms enable and dismissal controls. Live hook lifecycle acceptance, automatic summary extraction, and live Claude Code ↔ Codex runtime receipt remain open. |
| Semantic memory | Markdown/Obsidian notes, multi-vault lexical search, optional local semantic search, links/graph, provenance-aware proposed notes, permission filtering before indexing and retrieval. | `src/core.mjs`, `docs/RETRIEVAL-EVAL.md`; privacy canary tests pass. Verified fact promotion and independent held-out quality evaluation remain incomplete. |
| Procedural memory | Configurable agent roles, rule packs, prompts, shared commands, and a versioned Agent Skills-format cross-AI handoff workflow. | `.agents/skills/brainlink-cross-ai-handoff/SKILL.md` and `.claude/skills/brainlink-cross-ai-handoff/SKILL.md` are byte-identical copies of `skills/brainlink-cross-ai-handoff/SKILL.md`. `test/skills.test.mjs` checks manifest fields, registry metadata, safety instructions, and parity. Codex CLI repository discovery is verified; Claude Code CLI is unavailable, and live two-client handoff remains unverified. |
| Episodic memory | Private imported sessions; `session_close` creates a private session and proposed note; the local UI can preview, file, correct, and withdraw proposed summaries while retaining source and a dated changelog. The user can choose an existing folder and remember a vault/folder pair for the exact project. Otherwise BrainLink may suggest a folder from exact note-title mentions or a strong cluster of matching notes in the selected vault, and abstains on ambiguity. Connected agents can list allowed folders in an enabled vault and pass a chosen existing path to `session_close`. Filing previews propose related links only from the selected vault's privacy-filtered index; links are committed only with the user's save confirmation. | `docs/SESSION-FILING.md`; fictional vault tests cover privacy, folder exclusions, exact-project routing, content-based suggestions, ambiguous cases, correction and withdrawal. Session capture still depends on a supported importer or an AI/client call; summaries are reported, not verified knowledge. Link/folder suggestions are reviewable associations, not verified relationships. RSI measurement of filing precision across a larger independent corpus remains unimplemented. |
| Context efficiency | Summary-first session reads, token estimates, bounded retrieval evaluator and compact tool interfaces. | `docs/SESSION-INDEX.md`, `docs/RETRIEVAL-EVAL.md`. Estimates do not prove provider-billed token savings or equal task quality. |
| RSI | Read-only evaluator compares a baseline with query variants; it blocks promotion with too few cases or privacy violations and never changes live ranking automatically. A 21-query fictional Acme development benchmark with a private canary is now checked by the test suite. | `samples/evaluation/`, `docs/RETRIEVAL-EVAL.md`. Initial local top-1 result: hit@1 13/21 to 16/21, MRR .619 to .762, zero private-note violations, and no reduction in estimated output tokens. This is not held-out or production evidence. A production RSI loop still needs independent datasets, human review, rollback and post-promotion monitoring. |

## Product experience and operations

| Area | Current implementation | Evidence and remaining gap |
|---|---|---|
| Vault management | Setup supports multiple configured vaults, private/read-only scopes, exclusion folders and local sync controls. | Covered by the Setup and core test suites. Large-vault customer usability and multi-tenant company/client administration need further validation. |
| Graph and navigation | Local UI includes a clickable 3D graph and note details; private and excluded notes are filtered. | Graph tests cover click-through, private filtering, resizing and bounded graph size. Full Obsidian-level editing/navigation parity is not claimed. |
| Desktop launch | Windows installer provides a Start-menu click-to-open shortcut; macOS app and Linux menu entry open Setup. Optional, off-by-default per-user login entries now generate hidden background starts for Windows, macOS and desktop Linux. | `src/startup.mjs`, Settings UI and `test/startup.test.mjs`. CI verifies Windows installer install/run/uninstall, macOS package launch and Linux package install/init. Native sign-in execution and interactive desktop usability still require real user-session checks on each OS. |
| Backup and restore | User-selected local scheduled copies include private notes, verify hashes, persist the last receipt and restore only to an empty destination. Windows may launch at sign-in when explicitly enabled. | `docs/PRIVATE-BACKUP.md`; automated local tests pass. Archives are unencrypted; no retention policy, sleep/wake guarantee, remote-destination validation, or separate-device restore drill. |
| Cross-AI access | Local MCP integrations and handoff mailbox support multiple clients; vault scopes and per-agent permissions are enforced. | Local tests verify wiring and privacy rules. No real two-client handoff acceptance run or ChatGPT tunnel/relay validation is recorded. |
| Commercial release | Repository contains product specification, installers and test coverage. | Not release-ready: real installer runs, upgrade/uninstall checks, signing, accessibility and task-based usability checks, support/update policy, backup recovery drill and cross-client validation remain. |

## Next engineering sequence

1. Validate installed hooks through a real client lifecycle; add AI-assisted reviewed summaries while keeping transcript reading off by default and durable filing approval-gated.
2. Run a live Claude Code ↔ Codex handoff and retain receipts for pickup, acknowledgement, and private-note non-disclosure.
3. Expand frozen retrieval and filing evaluations to at least 20 representative cases per decision set; measure task success, privacy, latency and token estimates together.
4. Build and install the Windows package on Windows, verify sign-in launch and uninstall cleanup, then run a restore drill on a separate empty location.
5. Complete accessibility, large-vault performance and user task checks before calling the product ready to sell.

## Current limits

- This snapshot does not assign an overall completion percentage: the product is a set of capabilities with different evidence gates, and a percentage would imply precision not supported by the receipts.
- The current test receipt is local to the stated Windows/Node environment; six platform/privilege-dependent tests were skipped.
- No production deployment, customer acceptance, real cross-client handoff, or commercial readiness is claimed.
