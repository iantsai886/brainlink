# BrainLink Product Architecture

Status: product architecture baseline
Date: 2026-10-23 Asia/Taipei
Baseline: main at v1.2.6 merge; verify version/tag alignment before release

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
- Twin Profiles: Personal Twin and Organisation Twin configuration with separate policies.
- Agent Connections: provider identity, capabilities, allowed vaults, tools, read/write scope, consent, and revocation.
- Session Capture: supported end-of-session capture with explicit fallback export.
- Memory Pipeline: extraction, classification, destination proposal, provenance, links, approval, and versioning.
- Context Packets: compact citations-first packets with freshness, confidence, exclusions, and full-source fallback.
- Graph and Navigation: clickable source-backed relationships with list/search/edit alternatives; 3D is optional.
- Skills: portable Agent Skills in Git with registry metadata, tests, compatible clients, and rollback.
- Backup and Restore: scheduled user-selected destination, integrity check, retention, restore preview, clean-folder drill, and rollback.
- Improve / RSI: experiment proposals, frozen baseline, fresh cases, costs, failures, reviewer, promotion, and rollback.
- Activity and Audit: privacy-safe event trail, exportable diagnostics, and clear data-flow display.
- Desktop Shell: one-click launch, background service status, single instance, recovery, update, uninstall-with-data-preserved.

## Acceptance gates

No capability is called complete until it is separately labelled design, implemented, locally tested, cross-client tested, and ready for use. Release requires clean install, upgrade, rollback, backup/restore drill, permission-leak tests, accessibility review, large-vault performance checks, and user task testing.

## First complete validation fixture

Use a fictional person, fictional company, fictional customer, and planted private note. Run the same task through Claude Code and Codex. Verify end-session filing, correct destination, source links, compact context, input/output tokens, latency, task success, no private-note leakage in results/excerpts/handoffs/logs, backup integrity, restore, correction, and rollback.

## Engineering rule

GitHub is the code and engineering source of truth. Product knowledge and decisions may be summarised in Second Brain, but implementation status, issues, commits, tests, release notes, and rollback evidence belong here.
