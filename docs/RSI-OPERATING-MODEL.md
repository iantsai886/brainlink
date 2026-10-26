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

BrainLink includes read-only retrieval and session-filing evaluators. The RSI ledger can run two fixed evaluation suites against bundled fictional notes after a proposal enters `testing` and names the matching candidate version. It records aggregate-only, hash-linked receipts; it does not run proposal-supplied code, inspect user vaults, change live behavior, or advance a proposal. These fictional development sets are not independent or production validation. A local proposal ledger can suggest likely duplicates from title/problem text; this advisory check does not merge or block proposals. Opt-in research discovery (see [RSI research discovery](RSI-DISCOVERY.md)) can query user-selected built-in arXiv, Crossref and GitHub public repository metadata sources for user-chosen topics while Setup is open, and append relevant entries as `discovered` proposals with source provenance and a relevance explanation. A user can manually check a discovered proposal's stored paper ID, DOI or GitHub repository identity; the check stores a metadata fingerprint/status receipt without rewriting the proposal. There is no always-on research service, safe runner for arbitrary proposal code, automatic promotion, or proof of recursive gain. Do not describe those as implemented.

The source-backed proposal ledger and fixed-suite experiment runner are implemented in Setup. Both are local to the BrainLink app data directory and use an append-only hash-linked journal with revision checks. Experiment runs are allowed only for ideas in `testing`, require the named candidate version to match the built-in suite, and save aggregate metrics and privacy counts only. The UI shows the result but never accepts or promotes it. Acceptance still requires evidence, a reviewer, and rollback details. The ledger is included in verified backup and restore. The separate, off-by-default discovery stage may add `discovered` proposals; it cannot move them further.

Next delivery stages: compare proposals on fresh, independent fictional test sets; add post-promotion monitoring and a reviewed regression rollback path; then validate a live Claude Code ↔ Codex task handoff. Discovery runs on a schedule while the desktop process is available; it is not an always-on service or a complete recursive improvement loop.

## Acceptance gates

1. A user can see why an idea was proposed, its evidence, date, confidence, scope, and status. (The local ledger now implements the proposal, source URL/claim, memory tags, and review lifecycle foundation.)
2. The same idea is deduplicated or linked instead of repeatedly rediscovered. (Discovery skips proposals with the same canonical source URL or a near-identical title; manual saves get advisory similarity matches.)
3. A proposal can be rejected, deferred, tested in isolation, accepted, and rolled back with an audit trail.
4. The evaluation distinguishes first-order from recursive improvement and labels missing measurements as unknown.
5. Synthetic privacy canaries prove restricted notes are excluded before search results, excerpts, generated packets, logs, exports, and backups.
6. Token/time claims compare equivalent work and preserve task-quality and privacy guardrails.
7. No agent can promote a change or widen scope without the appropriate approval.
8. Discovery can be paused, its sources checked, and its stored findings exported or removed through an explicit user-controlled workflow. (Pause/resume, local run and manual freshness receipts, and ledger backup are implemented; a check compares metadata fingerprints only and never rewrites a proposal. Findings are removed from consideration by rejection because the ledger is append-only.)

## References

- Iango Brain: `20 Iango/Iango Main Core — Recursive Self-Improvement and Permutation.md` (canonical direction; detailed operating design is proposed).
- Iango Brain: `20 Iango/Iango RSI — Agent Operating Contract.md` (agent execution and evidence contract).
- BrainLink: `docs/RETRIEVAL-EVAL.md`, `docs/IMPLEMENTATION-STATUS.md`, and `docs/PRODUCT-ARCHITECTURE.md` (current implementation receipts and limits).
