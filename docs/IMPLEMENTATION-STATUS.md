# BrainLink implementation status

Status snapshot: 2026-10-24 (Asia/Taipei)
GitHub repository: `iantsai886/brainlink`
Branch: `fix/private-session-excerpts`
Code baseline: development target `1.2.8`, with `package.json` as the canonical version source. The `v1.2.7` tag belongs to the separate `wip/v1.2.7` release line; this branch continues from the full-source `main` history and does not move or recreate that tag.
Validation environment: Windows, Node.js 24.18.0; latest local `npm run test:all`: core 243 tests (237 passed, 0 failed, 6 skipped) and UI 27 tests (27 passed, 0 failed). GitHub Actions run #5 at `8efc5e3` passed all six Node test jobs and the unsigned Windows installer. Run #6 at `3e0c3d6` passed all six Node jobs and the unsigned Windows and macOS installers; Linux packaging failed because GNU tar does not accept the BSD ownership flags. The script now selects ownership flags per GNU/BSD tar; this fix and the frozen RSI benchmark are awaiting local and remote verification. The Node 24.22.1 Windows archive checksum and runtime were verified locally. Browser review used an isolated fictional vault for the previous session-reminder UI; the latest correction/withdrawal UI has not had browser usability review.
Client discovery: Codex CLI `0.164.0-alpha.11.1` found the repository skill in `codex debug prompt-input`; Claude Code CLI is not installed here.

This is an evidence ledger, not a release-readiness claim. “Implemented and locally tested” does not imply packaged, cross-client validated, or ready for customers.

## Memory and continuity

| Area | Current implementation | Evidence and remaining gap |
|---|---|---|
| Working memory | Imported Claude Code and Codex sessions, private session logging, bounded `session_read`, handoff mailbox, explicit close operation, opt-in SessionEnd setup, and dismissible local reminders. | `src/sessions/end-cue.mjs`, `src/sessions/hooks.mjs`, `docs/SESSION-FILING.md`. Tests cover configuration preservation, generated command execution, authentication and private-field exclusion; isolated browser review confirms enable and dismissal controls. Live hook lifecycle acceptance, automatic summary extraction, and live Claude Code ↔ Codex runtime receipt remain open. |
| Semantic memory | Markdown/Obsidian notes, multi-vault lexical search, optional local semantic search, links/graph, provenance-aware proposed notes, permission filtering before indexing and retrieval. | `src/core.mjs`, `docs/RETRIEVAL-EVAL.md`; privacy canary tests pass. Verified fact promotion and independent held-out quality evaluation remain incomplete. |
| Procedural memory | Configurable agent roles, rule packs, prompts, shared commands, and a versioned Agent Skills-format cross-AI handoff workflow. | `.agents/skills/brainlink-cross-ai-handoff/SKILL.md` and `.claude/skills/brainlink-cross-ai-handoff/SKILL.md` are byte-identical copies of `skills/brainlink-cross-ai-handoff/SKILL.md`. `test/skills.test.mjs` checks manifest fields, registry metadata, safety instructions, and parity. Codex CLI repository discovery is verified; Claude Code CLI is unavailable, and live two-client handoff remains unverified. |
| Episodic memory | Private imported sessions; `session_close` creates a private session and proposed note; the local UI can preview, file, correct, and withdraw proposed summaries while retaining source and a dated changelog. Exact project-to-vault destinations can be remembered after user confirmation. | `docs/SESSION-FILING.md`; fictional vault tests cover privacy, routing, correction and withdrawal. Session capture still depends on a supported importer or an AI/client call; summaries are reported, not verified knowledge. |
| Context efficiency | Summary-first session reads, token estimates, bounded retrieval evaluator and compact tool interfaces. | `docs/SESSION-INDEX.md`, `docs/RETRIEVAL-EVAL.md`. Estimates do not prove provider-billed token savings or equal task quality. |
| RSI | Read-only evaluator compares a baseline with query variants; it blocks promotion with too few cases or privacy violations and never changes live ranking automatically. A 21-query fictional Acme development benchmark with a private canary is now checked by the test suite. | `samples/evaluation/`, `docs/RETRIEVAL-EVAL.md`. Initial local top-1 result: hit@1 13/21 to 16/21, MRR .619 to .762, zero private-note violations, and no reduction in estimated output tokens. This is not held-out or production evidence. A production RSI loop still needs independent datasets, human review, rollback and post-promotion monitoring. |

## Product experience and operations

| Area | Current implementation | Evidence and remaining gap |
|---|---|---|
| Vault management | Setup supports multiple configured vaults, private/read-only scopes, exclusion folders and local sync controls. | Covered by the Setup and core test suites. Large-vault customer usability and multi-tenant company/client administration need further validation. |
| Graph and navigation | Local UI includes a clickable 3D graph and note details; private and excluded notes are filtered. | Graph tests cover click-through, private filtering, resizing and bounded graph size. Full Obsidian-level editing/navigation parity is not claimed. |
| Desktop launch | Windows installer provides a Start-menu click-to-open shortcut. An optional, off-by-default Windows sign-in launcher starts Setup hidden, without opening a browser. | `src/startup.mjs`, `packaging/windows/BrainLink.nsi`, `test/startup.test.mjs`. Installer compile and real Windows install/uninstall have not been verified in this environment; macOS/Linux login launch is absent. |
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
