# BrainLink implementation status

Status snapshot: 2026-10-24 (Asia/Taipei)
GitHub repository: `iantsai886/brainlink`
Branch: `fix/private-session-excerpts`
Code baseline: `464e1d5` plus the Agent Skill change set in this branch update
Validation environment: Windows, Node.js 24; `npm test`: 232 tests, 226 passed, 0 failed, 6 skipped.
Client discovery: Codex CLI `0.164.0-alpha.11.1` found the repository skill in `codex debug prompt-input`; Claude Code CLI is not installed here.

This is an evidence ledger, not a release-readiness claim. “Implemented and locally tested” does not imply packaged, cross-client validated, or ready for customers.

## Memory and continuity

| Area | Current implementation | Evidence and remaining gap |
|---|---|---|
| Working memory | Imported Claude Code and Codex sessions, private session logging, bounded `session_read`, handoff mailbox and explicit close operation. | `docs/SESSION-INDEX.md`, `docs/STRUCTURED-HANDOFF.md`, `docs/SESSION-FILING.md`. Local tests cover scopes and privacy. No universal end-of-session detector or real Claude Code ↔ Codex continuation receipt yet. |
| Semantic memory | Markdown/Obsidian notes, multi-vault lexical search, optional local semantic search, links/graph, provenance-aware proposed notes, permission filtering before indexing and retrieval. | `src/core.mjs`, `docs/RETRIEVAL-EVAL.md`; privacy canary tests pass. Verified fact promotion and independent held-out quality evaluation remain incomplete. |
| Procedural memory | Configurable agent roles, rule packs, prompts, shared commands, and a versioned Agent Skills-format cross-AI handoff workflow. | `.agents/skills/brainlink-cross-ai-handoff/SKILL.md` and `.claude/skills/brainlink-cross-ai-handoff/SKILL.md` are byte-identical copies of `skills/brainlink-cross-ai-handoff/SKILL.md`. `test/skills.test.mjs` checks manifest fields, registry metadata, safety instructions, and parity. Codex CLI repository discovery is verified; Claude Code CLI is unavailable, and live two-client handoff remains unverified. |
| Episodic memory | Private imported sessions; `session_close` creates a private session and proposed note; the local UI can preview and file summaries. Exact project-to-vault destinations can be remembered after user confirmation. | `docs/SESSION-FILING.md`; fictional vault tests cover privacy and routing. Session capture still depends on a supported importer or an AI/client call; summaries are reported, not verified knowledge. |
| Context efficiency | Summary-first session reads, token estimates, bounded retrieval evaluator and compact tool interfaces. | `docs/SESSION-INDEX.md`, `docs/RETRIEVAL-EVAL.md`. Estimates do not prove provider-billed token savings or equal task quality. |
| RSI | Read-only evaluator compares a baseline with query variants; it blocks promotion with too few cases or privacy violations and never changes live ranking automatically. | `docs/RETRIEVAL-EVAL.md`. A production RSI loop still needs frozen independent datasets, human review, rollback and post-promotion monitoring. |

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

1. Run the same fictional task end-to-end with Claude Code and Codex CLI, retaining a handoff receipt and private-note leak results.
2. Add a portable Git-based Agent Skill format and validate the same skill against both clients.
3. Extend session capture and destination routing with correction/reversal and source-linked relationships; keep user approval before durable writes.
4. Expand frozen retrieval and filing evaluations to at least 20 representative cases per decision set; measure task success, privacy, latency and token estimates together.
5. Build and install the Windows package on Windows, verify sign-in launch and uninstall cleanup, then run a restore drill on a separate empty location.
6. Complete accessibility, large-vault performance and user task checks before calling the product ready to sell.

## Current limits

- This snapshot does not assign an overall completion percentage: the product is a set of capabilities with different evidence gates, and a percentage would imply precision not supported by the receipts.
- The current test receipt is local to the stated Windows/Node environment; six platform/privilege-dependent tests were skipped.
- No production deployment, customer acceptance, real cross-client handoff, or commercial readiness is claimed.
