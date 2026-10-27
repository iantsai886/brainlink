# BrainLink Recursive Improvement System

Status: product requirement and governed operating design; local proposal ledger and opt-in, pausable research discovery from fixed arXiv, Crossref and GitHub public metadata endpoints (runs only while Setup is open) implemented; continuous research service, experiment execution and promotion are not implemented.
Date: 2026-10-25 Asia/Taipei.

## Product commitment

RSI is a core BrainLink capability. BrainLink should keep looking for useful ideas, analyzing new evidence, researching relevant advances, and testing improvements to memory quality, agent continuity, privacy, usability, reliability, and efficiency. Its goal is to become an exceptionally capable second brain for AI agents, not to maximize novelty, graph size, autonomy, or a single benchmark score.

“Keep improving” means a persistent, traceable learning loop. It does not mean every new idea is adopted, a model is retrained, or production behavior changes without review. A source discovery is an input; a proposal is not an experiment; an experiment is not a verified gain; and a verified gain is not automatically approved for release.

This aligns with Iango’s canonical RSI direction: permutation generates alternatives, evaluation distinguishes gains from noise, retention makes validated gains reusable, and RSI improves the discovery and evaluation process itself. The Iango record explicitly labels the operating design as proposed and the runtime as unverified.

## The loop

1. **Observe:** collect privacy-safe product signals such as failed retrievals, corrections, unresolved handoffs, stale links, restore failures, user friction, and evaluation regressions. Never ingest a user's private corpus or session merely because it could be useful. Use explicitly authorized scope and synthetic fixtures by default.
2. **Discover:** review new research, standards, open-source projects, user feedback, support issues, and internal failure patterns. Keep source, publication date, access date, claim, applicability, uncertainty, license, and conflict-of-interest notes. Research should be scheduled or triggered when a real runtime exists; this document alone does not create a background researcher.
3. **Triage:** deduplicate against the idea ledger; map the idea to a user problem and memory type; estimate user value, confidence, implementation cost, privacy/security risk, maintenance burden, and reversibility. Reject hype, unsupported vendor claims, and ideas without a testable user outcome.
4. **Hypothesize:** write one falsifiable claim, one baseline, a bounded candidate change, success and guardrail metrics, representative fresh cases, resource cap, and stop conditions. If no useful measurement or safe test exists, retain it as a research question, not a claimed improvement.
5. **Evaluate:** compare baseline and candidate on the same task definition and environment, with fixed scoring and an independent held-out set where feasible. Report per-case outcomes, failures, human rescue, latency, resource/token cost, and privacy/security findings. Unknown is not zero. Never use a tiny query sample as broad quality proof.
6. **Review:** summarize evidence, limitations, risk, and rollback. A reviewer separate from the candidate author checks methodology and boundary findings for material changes. More agents are not automatically better; each reviewer needs a defined check.
7. **Promote reversibly:** accepted code and Skills enter Git through a reviewable change with CI, version, release notes, and rollback. Knowledge changes remain attributable and correctable in the selected vault. No silent change to permissions, data scope, credentials, production, billing, or customer commitments.
8. **Monitor and learn:** watch post-change regressions and drift, compare results to the frozen baseline, and roll back when guardrails fail. Record the decision and why. Feed false starts and reviewer corrections into better future discovery, prioritization, and evaluation methods.

## What “best for AI agents” means

Use a balanced scorecard rather than a single opaque rank:

| Dimension | Example evidence |
|---|---|
| Agent task success | Correct continuation, answer quality, source fidelity, successful tool use |
| Memory quality | Correct classification, placement, link accuracy, freshness, correction rate |
| Context efficiency | Actual provider tokens when available; otherwise clearly labelled estimates; task success held constant |
| Privacy and security | Unauthorized content in search, ranking, excerpts, summaries, handoffs, logs, backups, and restore |
| Continuity | Another authorized client resumes from a compact, source-linked handoff |
| User experience | Time to first successful connection, task completion, correction effort, accessibility, recovery clarity |
| Reliability and operations | Install/upgrade, backup/restore, latency, failure recovery, support and maintenance cost |

Hard privacy, permission, data-integrity, and recovery guardrails cannot be traded for a higher average score. Token savings count only when measured against a comparable task with quality and privacy maintained. Estimated tokens are not provider billing evidence.

## Idea and experiment record

Every candidate should have a durable, versioned record containing:

```yaml
schema_version: "1"
idea_id: "BL-RSI-YYYY-NNN"
status: "discovered|triaged|researching|proposed|testing|review|accepted|rejected|deferred|rolled_back"
title: "Short user-problem statement"
user_problem: "Who is blocked and what task fails?"
memory_types: [working, semantic, procedural, episodic]
sources:
  - url: ""
    published_at: "unknown"
    accessed_at: ""
    claim: ""
    confidence: ""
    limitations: ""
hypothesis: "If change X, measure Y should improve for these users because Z."
baseline_version: ""
candidate_version: ""
test_set_version: ""
metrics: []
guardrails: []
privacy_scope: "synthetic or explicitly authorized scope"
cost_cap: ""
results: "unknown until measured"
reviewer: ""
decision_and_reason: ""
rollback: ""
next_review_date: ""
```

Do not put customer content, secrets, credentials, or personal records in public research logs or GitHub issues. Use opaque case IDs and synthetic fixtures; keep restricted evidence in its authorized vault.

## Recursive improvement test

A feature-level gain is **first-order improvement**. Call an outcome **recursive improvement** only when the change improves the method that discovers, prioritizes, evaluates, or retains candidates, and that changed method demonstrably produces better downstream candidates on fresh cases under comparable resource limits. Preserve lineage from parent method to child method, protocol versions, cases, reviewers, and downstream results. If this evidence is absent, label the change first-order or unverified.

## Autonomy levels

- **A0 — Observe:** collect explicitly allowed aggregate signals and public-source references.
- **A1 — Recommend:** create and prioritize proposals; no code or knowledge mutation.
- **A2 — Experiment:** run bounded evaluations in a sandbox with synthetic or authorized data; produce receipts only.
- **A3 — Prepare:** create a reviewable Git change or vault proposal with tests and rollback instructions.
- **A4 — Promote:** human-approved merge/release under existing authority and release gates.
- **Never autonomous by default:** widen permissions, access personal/client data, publish externally, alter credentials, spend money, change production policy, delete/overwrite durable knowledge, or bypass review.

Autonomy is configured by operation and data scope, not by a single “RSI on” switch. A user may enable discovery reminders separately from code execution or promotion.

## Current implementation boundary

### Commit-bound experiment evidence

Every new RSI experiment receipt records the Git commit before and after the run and whether each tree was clean. If Git is missing, the tree is dirty, or the commit changes during the run, the receipt is marked `source_unbound` and cannot support acceptance. An accepted idea must cite an eligible experiment run ID, the exact fixture SHA-256, the tested candidate version, and the identical full promotion commit SHA. Existing schema-1 ledger receipts remain readable but cannot be used as commit-bound acceptance evidence. The Setup form can copy these identifiers from an eligible run. This proves the local receipt's source binding; it does not verify that the commit exists on GitHub, passed hosted CI, or was independently reviewed.

Current update: discovery settings include an off-by-default option to recheck up to three 30-day-old public citations from BrainLink discovery records after each manual or scheduled discovery run. It uses only still-selected sources and exact stored public identifiers, appends freshness fingerprints/statuses, and leaves proposal content unchanged. This is citation maintenance, not independent verification of claims or evidence of recursive improvement.

The authenticated **Download review record** export includes a SHA-256 integrity checksum over its JSON payload. The checksum detects accidental changes but does not authenticate the author.

BrainLink includes read-only retrieval and session-filing evaluators. The RSI ledger can run two fixed evaluation suites against bundled fictional notes after a proposal enters `testing` and names the matching candidate version. It records aggregate-only, hash-linked receipts; it does not run proposal-supplied code, inspect user vaults, change live behavior, or advance a proposal. These fictional development sets are not independent or production validation. A local proposal ledger can suggest likely duplicates from title/problem text; this advisory check does not merge or block proposals. Opt-in research discovery (see [RSI research discovery](RSI-DISCOVERY.md)) can query user-selected built-in arXiv, Crossref and GitHub public repository metadata sources for user-chosen topics while Setup is open, and append relevant entries as `discovered` proposals with source provenance and a relevance explanation. A user can manually check a discovered proposal's stored paper ID, DOI or GitHub repository identity; the check stores a metadata fingerprint/status receipt without rewriting the proposal. There is no always-on research service, safe runner for arbitrary proposal code, automatic promotion, or proof of recursive gain. Do not describe those as implemented.

The source-backed proposal ledger and fixed-suite experiment runner are implemented in Setup. Both are local to the BrainLink app data directory and use an append-only hash-linked journal with revision checks. An authenticated **Download review record** action exports the current proposal records, including sources, discovery rationale, experiment receipts, status history, monitoring and rollback evidence, as a dated JSON file; it does not expose the raw journal or change the ledger. Treat the exported file as user-controlled project material and store it only in an approved location. Experiment runs are allowed only for ideas in `testing`, require the named candidate version to match the built-in suite, and save aggregate metrics and privacy counts only. The UI shows the result but never accepts or promotes it. Acceptance requires evidence, a reviewer, rollback details, and a full 40-character promotion commit SHA; BrainLink checks the SHA format but does not verify it against GitHub. After acceptance, a reviewer can append a post-release monitoring receipt tied to that exact commit, with a test window, sample count, metric comparison, guardrail result, reviewer and evidence reference. A rollback can now be recorded only after a person has reverted and checked the code: the append-only receipt links the accepted and restored commit SHAs, restored version, reason, reviewer and optional evidence reference. It is not a Git operation and does not verify that either commit exists or passed checks. A regression is recorded for human review; it does not trigger an automatic rollback. Monitoring receipts are self-reported and do not prove that the data came from production. The ledger is included in verified backup and restore. The separate, off-by-default discovery stage may add `discovered` proposals; it cannot move them further. An off-by-default local observer can run manually or on a user-selected daily, weekly, fortnightly, or monthly schedule while Setup is running. It compares 30-day and prior-30-day tool success/failure counts from the content-free activity log. Its groups cover retrieval, sessions, filing (including source-scan success/failure), handoffs, and recovery (backup and restore success/failure). Setup writes only operation names and outcome bits for scans, backups, and restores; no vault, folder, path, note content, or agent identity is added. The observer marks small samples unknown and returns aggregates only. A flagged category can prefill the existing proposal form with the aggregate counts and a fictional-test hypothesis; the user must review and submit it. The observer does not save proposals on its own or change code. The activity log rotates, so older calls may be absent; the observer cannot judge answer quality. Only the aggregate report and run status are saved locally, never the raw activity log.

The independent retrieval evaluator's decision gates are separated as a pure, reusable function and covered by a small guardrail matrix. The checks confirm that a privacy failure blocks review even when other signals look positive, insufficient sample size requests more evidence, quality regression rejects an efficiency claim, and lower estimated context with preserved quality is only eligible for human review. This is a regression check for the evaluator's decision policy, not evidence that the evaluator itself improves over time and not a demonstration of recursive gain.

The content-free activity log now records a rough token estimate for the serialized result of selected read-only tools (search, note reads, session reads, handoff listings, and the BrainLink guide). It stores only the integer estimate beside the normal operation/outcome metadata; result text and tool arguments are not persisted. The observer reports current and prior 30-day mean estimates by tool category. These estimates cover only BrainLink tool responses, not the agent's full prompt, generated answer, or provider billing. A changed mix of tools can change the average, so it is an observation for review, not causal proof of token savings. Failed calls and write previews do not contribute. The local observer/UI tests use synthetic data; no user-vault telemetry has been analyzed here.

The same local activity log now records only the action label for typed graph review: `approved`, `rejected`, or `reopened`. RSI reports current and previous 30-day counts for these choices without storing note paths, evidence, titles, or relationship text. Counts provide reviewer feedback about suggestion handling but do not explain why a reviewer chose an action and are not a graph-quality score. They can inform a human RSI proposal; they do not change extraction or ranking automatically.

Next delivery stages: compare proposals on fresh, independent fictional test sets; connect monitoring to a trusted source and verify rollback commit existence and checks; then validate a live Claude Code ↔ Codex task handoff. Discovery runs on a schedule while the desktop process is available; it is not an always-on service or a complete recursive improvement loop.

## Acceptance gates

1. A user can see why an idea was proposed, its evidence, date, confidence, scope, and status. (The local ledger now implements the proposal, source URL/claim, memory tags, and review lifecycle foundation.)
2. The same idea is deduplicated or linked instead of repeatedly rediscovered. (Discovery skips proposals with the same canonical source URL or a near-identical title; manual saves get advisory similarity matches.)
3. A proposal can be rejected, deferred, tested in isolation and accepted with an audit trail. A human can record a rollback receipt after reverting and checking the code; BrainLink does not execute that revert.
4. The evaluation distinguishes first-order from recursive improvement and labels missing measurements as unknown.
5. Synthetic privacy canaries prove restricted notes are excluded before search results, excerpts, generated packets, logs, exports, and backups.
6. Token/time claims compare equivalent work and preserve task-quality and privacy guardrails.
7. No agent can promote a change or widen scope without the appropriate approval.
8. Discovery can be paused, its sources checked, and its stored findings exported or removed through an explicit user-controlled workflow. (Pause/resume, local run and manual freshness receipts, and ledger backup are implemented; a check compares metadata fingerprints only and never rewrites a proposal. Findings are removed from consideration by rejection because the ledger is append-only.)

## References

- Iango Brain: `20 Iango/Iango Main Core — Recursive Self-Improvement and Permutation.md` (canonical direction; detailed operating design is proposed).
- Iango Brain: `20 Iango/Iango RSI — Agent Operating Contract.md` (agent execution and evidence contract).
- BrainLink: `docs/RETRIEVAL-EVAL.md`, `docs/IMPLEMENTATION-STATUS.md`, and `docs/PRODUCT-ARCHITECTURE.md` (current implementation receipts and limits).
