# BrainLink Product Architecture

Status: product architecture baseline
Date: 2026-10-23 Asia/Taipei
Baseline: full-source `main` history; current development target is 1.2.8. `package.json` is canonical; v1.2.7 is a separate tagged release line and is not the source branch head.

## Product definition

BrainLink is the governed memory, continuity, permissions, and improvement layer for two customer modes:

- Personal Twin: an individual’s authorised goals, preferences, experiences, knowledge, values, decisions, and working methods.
- Organisation Twin: a company’s authorised knowledge, roles, policies, projects, customer boundaries, and operating methods.

AI platforms such as ChatGPT, Claude, Codex, Grok, Gemini, and Hermes are workers. BrainLink keeps customer-owned continuity portable between them.

## Core product loop

1. Observe a supported AI session ending, or ask the user to export/save when the connector cannot observe it.
2. Extract a candidate summary: goal, decisions, outcome, sources, open questions, next action, sensitivity, confidence, and provenance.
3. Classify it as working, semantic, procedural, or episodic memory.
4. Propose or select an authorised vault/project destination and show the rationale.
5. Create only evidence-supported links and preserve source references and backlinks.
6. Store a reversible versioned record and generate a compact permission-filtered context packet.
7. Let the next authorised agent retrieve the packet before fetching full sources.
8. Measure filing accuracy, link quality, retrieval success, privacy, latency, task quality, and token use.
9. RSI proposes bounded improvements; reviewed gains can be promoted and rolled back.

## Data ownership and boundaries

- Original files remain in user-controlled vaults or explicitly approved storage.
- Derived summaries, indexes, embeddings, links, and packets inherit the source privacy classification.
- Personal, company, client, finance, and role-specific lanes are separate by default.
- Agent access is scoped by identity, tenant, vault, project, operation, and read/write permission.
- Permission filtering happens before retrieval, ranking, excerpting, summarising, handoff generation, and logs.
- Every durable memory has source, timestamp, confidence, status, and correction/deletion path.

## Memory model

- Working: current task state and short-lived context.
- Semantic: verified facts, concepts, decisions, and relationships.
- Procedural: versioned Skills, workflows, policies, and tool requirements stored in Git.
- Episodic: source-linked sessions, outcomes, corrections, and reusable experiences.

The customer sees one natural vault experience; the four types are an internal retrieval and governance model.

## Product modules

- Vault Manager: add, remove, scan, scope, and health status for many vaults.
- Twin Profiles: Personal, Organisation and Client Twin configuration with separate policies.
- Agent Connections: provider identity, capabilities, allowed vaults, tools, read/write scope, consent, and revocation.
- Session Capture: supported end-of-session capture with explicit fallback export.
- Memory Pipeline: extraction, classification, destination proposal, provenance, links, approval, and versioning.
- Context Packets: question-focused, size-bounded excerpts with exact vault/path citations, note date/status and validated confidence labels; full-source fallback uses the cited path. Packets reuse the authorized search pipeline and inherit its privacy and Twin memory filters.
- Graph and Navigation: clickable source-backed links with list/search/edit alternatives; 3D is optional. Typed entity/workflow edges derive from Markdown. The graph can scan visible non-private vaults in bounded pages for deterministic, same-scope text candidates; users must save each candidate and separately approve it before it becomes a graph edge. Arbitrary-language entity extraction and a dedicated typed-relationship editor remain future work. See `docs/GRAPH-KNOWLEDGE-MODEL.md`.
- Skills: portable Agent Skills are versioned in Git with Iango registry metadata. Setup discovers skills from the repository and can install them into user-level Claude Code, Codex CLI, Gemini CLI, Antigravity App/IDE, Antigravity CLI, Hermes Agent, and DeepSeek Harness skill folders; it protects pre-existing files and user edits. Repository discovery copies are also kept for Claude Code and Codex. File install is locally tested, while live skill discovery and model behavior are not verified. See `skills/README.md`.
- Backup and Restore: scheduled user-selected destination, integrity check, retention, restore preview, clean-folder drill, and rollback.
- Improve / RSI: experiment proposals, frozen baseline, fresh cases, costs, failures, reviewer, promotion, and rollback.
- RSI must continuously discover and assess ideas from privacy-safe product signals, user feedback, and dated external research. A local append-only proposal ledger now provides a first review surface, and opt-in discovery (`src/rsi-discovery.mjs`, fixed allowlisted arXiv, Crossref and GitHub public metadata sources, off by default, pausable) can add `discovered` proposals to it; always-on discovery, experiment execution, evaluation receipts, and promotion remain separate capabilities. The operating model and runtime boundary are in `docs/RSI-OPERATING-MODEL.md`.
- Activity and Audit: privacy-safe event trail, exportable diagnostics, and clear data-flow display.
- Desktop Shell: one-click launch, background service status, single instance, recovery, update, uninstall-with-data-preserved.

## Acceptance gates

No capability is called complete until it is separately labelled design, implemented, locally tested, cross-client tested, and ready for use. Release requires clean install, upgrade, rollback, backup/restore drill, permission-leak tests, accessibility review, large-vault performance checks, and user task testing.

RSI also has its own gates: source provenance and freshness; deduplication; a falsifiable user outcome; baseline and fresh cases; task-quality, privacy, reliability and cost guardrails; review; reversible promotion; and post-change monitoring. Claims of recursive gain require evidence that the improvement method itself improves downstream experiments.

## First complete validation fixture

Use a fictional person, fictional company, fictional customer, and planted private note. Run the same task through Claude Code and Codex. Verify end-session filing, correct destination, source links, compact context, input/output tokens, latency, task success, no private-note leakage in results/excerpts/handoffs/logs, backup integrity, restore, correction, and rollback.

## Engineering rule

GitHub is the code and engineering source of truth. Product knowledge and decisions may be summarised in Second Brain, but implementation status, issues, commits, tests, release notes, and rollback evidence belong here.
