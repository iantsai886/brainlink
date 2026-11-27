# BrainLink RSI Gate — Pilot Pass & 63-Draft Read-Only Analysis (2026-11-27)

**Actor:** Antigravity (Anna) | **Judge:** `deterministic-rubric-v1` (strictly `!= Hermes (DeepSeek)`)

## Summary
- **Pilot 19 (2026-11-21..26):** **2 `active`** (`cited-incident-dating-check`, `credential-free-discovery-fallback`), **12 `held`** (untested but operationally relevant, each with an explicit unblock condition), **5 `killed`** (untested and out of current scope; files preserved on disk).
- **Rollback verification:** `cited-incident-dating-check` was promoted → rolled back to `draft` (retaining both `.rsi-history/` snapshots) → re-promoted to `active`.
- **Remaining 63 drafts (read-only, unchanged):** **0** passed `test_card_exercised`. Recommended: **46 hold**, **17 kill** (awaiting Chairman approval; zero files modified).

## Deliverable 5A — 19 Pilot Skills (2026-11-21..26)

| Skill | Verdict | Reason | Evidence Path | What the Judge Actually Ran |
|---|---|---|---|---|
| `agent-deploy-annotation-hook` | **killed** | Never executed; generic web-property deploy annotation outside current BrainLink/RSI focus. | `agent-deploy-annotation-hook-2026-11-27-17-22-35.json` | Deterministic rubric (8 checks: frontmatter, secret scan, actionable steps, guardrails, test-card evidence); 7/8 passed. |
| `alliance-partner-screen` | **killed** | Never executed; narrow Taiwan 116年度 跨域 subsidy screen with no active client lane. | `alliance-partner-screen-2026-11-27-17-22-35.json` | Deterministic rubric (8 checks: frontmatter, secret scan, actionable steps, guardrails, test-card evidence); 7/8 passed. |
| `approval-gated-icp-outbound-drafts` | **held** | Failed test_card_exercised (not yet run) [condition: Run steps 1-5 on 10 real trial sign-ups to drafts-only folder when outbound resumes] | `approval-gated-icp-outbound-drafts-2026-11-27-17-22-35.json` | Deterministic rubric (8 checks: frontmatter, secret scan, actionable steps, guardrails, test-card evidence); 7/8 passed. |
| `cited-incident-dating-check` | **active** | Passed 8/8 deterministic checks; hand-run verified on 2026-11-26 Radar item 4 + live npm version check. | `cited-incident-dating-check-2026-11-27-17-22-35.json` | Deterministic rubric (8 checks: frontmatter, secret scan, actionable steps, guardrails, test-card evidence); 8/8 passed. |
| `credential-free-discovery-fallback` | **active** | Passed 8/8 deterministic checks; hand-run verified on 2026-11-24 expired YouTube OAuth morning (HTTP 200 Atom fallback). | `credential-free-discovery-fallback-2026-11-27-17-22-35.json` | Deterministic rubric (8 checks: frontmatter, secret scan, actionable steps, guardrails, test-card evidence); 8/8 passed. |
| `four-part-nightly-agent-log` | **held** | Failed test_card_exercised (not yet run) [condition: Run across 5 real agent sessions and verify <200 words + 4 headings + artifact path] | `four-part-nightly-agent-log-2026-11-27-17-22-35.json` | Deterministic rubric (8 checks: frontmatter, secret scan, actionable steps, guardrails, test-card evidence); 7/8 passed. |
| `held-out-rule-gate` | **held** | Failed test_card_exercised (not yet run) [condition: Run once on 3 draft skills with a 10-case held-out set and log output] | `held-out-rule-gate-2026-11-27-17-22-35.json` | Deterministic rubric (8 checks: frontmatter, secret scan, actionable steps, guardrails, test-card evidence); 7/8 passed. |
| `installer-instruction-diff` | **held** | Failed test_card_exercised (not yet run) [condition: Run steps 1-6 on one throwaway scratch install and confirm diff output] | `installer-instruction-diff-2026-11-27-17-22-35.json` | Deterministic rubric (8 checks: frontmatter, secret scan, actionable steps, guardrails, test-card evidence); 7/8 passed. |
| `locale-funnel-segmentation-check` | **killed** | Never executed; generic GA4 demo funnel check outside current priorities. | `locale-funnel-segmentation-check-2026-11-27-17-22-35.json` | Deterministic rubric (8 checks: frontmatter, secret scan, actionable steps, guardrails, test-card evidence); 7/8 passed. |
| `mcp-bridge-exposure-audit` | **held** | Failed test_card_exercised (not yet run) [condition: Run steps 1-7 against ianpc Hermes MCP client config and log receipt] | `mcp-bridge-exposure-audit-2026-11-27-17-22-35.json` | Deterministic rubric (8 checks: frontmatter, secret scan, actionable steps, guardrails, test-card evidence); 7/8 passed. |
| `mcp-tool-subset-spec` | **held** | Failed test_card_exercised (not yet run) [condition: Build and verify allow-lists for 2 real seats sharing one MCP server] | `mcp-tool-subset-spec-2026-11-27-17-22-35.json` | Deterministic rubric (8 checks: frontmatter, secret scan, actionable steps, guardrails, test-card evidence); 7/8 passed. |
| `memory-recall-vs-rank-benchmark` | **held** | Failed test_card_exercised (not yet run) [condition: Run against BrainLink vault_search on 20 real vault questions and record recall@5/recall@50] | `memory-recall-vs-rank-benchmark-2026-11-27-17-22-35.json` | Deterministic rubric (8 checks: frontmatter, secret scan, actionable steps, guardrails, test-card evidence); 7/8 passed. |
| `model-retirement-sweep` | **held** | Failed test_card_exercised (not yet run) [condition: Execute once on the next real model retirement notice and record receipt] | `model-retirement-sweep-2026-11-27-17-22-35.json` | Deterministic rubric (8 checks: frontmatter, secret scan, actionable steps, guardrails, test-card evidence); 7/8 passed. |
| `per-model-memory-size-test` | **held** | Failed test_card_exercised (not yet run) [condition: Run once on one real seat measuring floor/full/subset scores] | `per-model-memory-size-test-2026-11-27-17-22-35.json` | Deterministic rubric (8 checks: frontmatter, secret scan, actionable steps, guardrails, test-card evidence); 7/8 passed. |
| `pre-cloud-placeholder-swap` | **held** | Failed test_card_exercised (not yet run) [condition: Run steps 1-6 on a synthetic bilingual zh-TW + pt-BR sample with 6 entities] | `pre-cloud-placeholder-swap-2026-11-27-17-22-35.json` | Deterministic rubric (8 checks: frontmatter, secret scan, actionable steps, guardrails, test-card evidence); 7/8 passed. |
| `quota-error-triage` | **held** | Failed test_card_exercised (not yet run) [condition: Replay 3 recorded error bodies (429, 503, invalid_grant) from vault logs] | `quota-error-triage-2026-11-27-17-22-35.json` | Deterministic rubric (8 checks: frontmatter, secret scan, actionable steps, guardrails, test-card evidence); 7/8 passed. |
| `serving-substrate-delivery-eval` | **killed** | Never executed (marked "Not yet run"); 5-seat VPS saturation sweep not currently active. | `serving-substrate-delivery-eval-2026-11-27-17-22-35.json` | Deterministic rubric (8 checks: frontmatter, secret scan, actionable steps, guardrails, test-card evidence); 7/8 passed. |
| `tender-gate-read` | **killed** | Never executed; public-tender intake rubric outside current BrainLink/RSI focus. | `tender-gate-read-2026-11-27-17-22-35.json` | Deterministic rubric (8 checks: frontmatter, secret scan, actionable steps, guardrails, test-card evidence); 7/8 passed. |
| `write-then-read-back-gate` | **held** | Failed test_card_exercised (not yet run) [condition: Run steps 1-4 on 5 writes in one Distill run and verify frontmatter keys] | `write-then-read-back-gate-2026-11-27-17-22-35.json` | Deterministic rubric (8 checks: frontmatter, secret scan, actionable steps, guardrails, test-card evidence); 7/8 passed. |

## Deliverable 5B — Remaining 63 Drafts (Read-Only Recommendation — State Unchanged)

| Skill | Date | Recommended Action | Reason |
|---|---|---|---|
| `advisor-plan-gate` | 2026-11-12 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `agent-engine-connectability-check` | 2026-11-18 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `agent-identity-boundary-audit` | 2026-11-06 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `agent-session-cost-audit` | 2026-11-13 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `agent-state-truth-audit` | 2026-11-10 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `ai-value-receipt-gate` | 2026-11-20 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `ambition-brief-rewrite` | 2026-11-06 | kill (out-of-scope & untested) | Failed test_card_exercised (0 executed runs); low alignment with current BrainLink/RSI priorities. |
| `ci-secret-stealer-hunt` | 2026-11-13 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `citation-sample-design` | 2026-11-20 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `client-offboarding-key-sweep` | 2026-11-19 | kill (out-of-scope & untested) | Failed test_card_exercised (0 executed runs); low alignment with current BrainLink/RSI priorities. |
| `code-rebuilt-demo-brief` | 2026-11-11 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `conversion-brief-gate` | 2026-11-13 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `credential-store-mode-check` | 2026-11-19 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `dependency-fix-reachability-check` | 2026-11-14 | kill (out-of-scope & untested) | Failed test_card_exercised (0 executed runs); low alignment with current BrainLink/RSI priorities. |
| `depth-or-geometry-claim-check` | 2026-11-10 | kill (out-of-scope & untested) | Failed test_card_exercised (0 executed runs); low alignment with current BrainLink/RSI priorities. |
| `evaluator-harness-upgrade` | 2026-11-15 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `evidence-regression-cases` | 2026-11-09 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `expensive-to-cheap-handoff` | 2026-11-17 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `fictional-customer-role-rehearsal` | 2026-11-11 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `handle-to-channel-lead-enrichment` | 2026-11-15 | kill (out-of-scope & untested) | Failed test_card_exercised (0 executed runs); low alignment with current BrainLink/RSI priorities. |
| `impossible-week-flag` | 2026-11-20 | kill (out-of-scope & untested) | Failed test_card_exercised (0 executed runs); low alignment with current BrainLink/RSI priorities. |
| `inbox-job-run` | 2026-11-02 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `install-with-coding-agent` | 2026-11-02 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `iteration-direction-check` | 2026-11-10 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `lane-boundary-audit` | 2026-11-03 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `licence-field-resolution` | 2026-11-20 | kill (out-of-scope & untested) | Failed test_card_exercised (0 executed runs); low alignment with current BrainLink/RSI priorities. |
| `licence-gate-before-client-use` | 2026-11-02 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `licence-layer-audit` | 2026-11-04 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `local-asr-language-check` | 2026-11-04 | kill (out-of-scope & untested) | Failed test_card_exercised (0 executed runs); low alignment with current BrainLink/RSI priorities. |
| `mcp-server-install-gate` | 2026-11-04 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `memory-utility-eviction-pass` | 2026-11-19 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `multi-agent-baseline-check` | 2026-11-18 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `note-instruction-quarantine` | 2026-11-03 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `number-class-reconciliation` | 2026-11-19 | kill (out-of-scope & untested) | Failed test_card_exercised (0 executed runs); low alignment with current BrainLink/RSI priorities. |
| `panel-decision-review` | 2026-11-02 | kill (out-of-scope & untested) | Failed test_card_exercised (0 executed runs); low alignment with current BrainLink/RSI priorities. |
| `partner-side-subsidy-entry` | 2026-11-11 | kill (out-of-scope & untested) | Failed test_card_exercised (0 executed runs); low alignment with current BrainLink/RSI priorities. |
| `paywalled-book-dossier` | 2026-11-20 | kill (out-of-scope & untested) | Failed test_card_exercised (0 executed runs); low alignment with current BrainLink/RSI priorities. |
| `pipeline-gap-audit` | 2026-11-02 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `platform-gap-audit` | 2026-11-13 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `professional-software-engineering` | 2026-11-11 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `prospect-gift-demo` | 2026-11-11 | kill (out-of-scope & untested) | Failed test_card_exercised (0 executed runs); low alignment with current BrainLink/RSI priorities. |
| `python-install-autostart-audit` | 2026-11-05 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `retainer-floor-offer` | 2026-11-05 | kill (out-of-scope & untested) | Failed test_card_exercised (0 executed runs); low alignment with current BrainLink/RSI priorities. |
| `retrieval-first-fix-order` | 2026-11-20 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `retrieval-or-finetune-check` | 2026-11-02 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `rubric-gate-review` | 2026-11-05 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `rule-binding-audit` | 2026-11-10 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `rule-to-monitor-migration` | 2026-11-11 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `scheduled-run-overlap-check` | 2026-11-19 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `skill-editor-batch-review` | 2026-11-12 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `skill-hill-climb-loop` | 2026-11-09 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `skill-pack-permission-audit` | 2026-11-15 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `skill-rationalization-hardening` | 2026-11-15 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `skill-structural-gate-run` | 2026-11-18 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `spawn-authority-cap` | 2026-11-10 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `spoken-name-to-repo-resolver` | 2026-11-18 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `subsidy-capital-gate` | 2026-11-10 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `thin-tool-offer-test` | 2026-11-12 | kill (out-of-scope & untested) | Failed test_card_exercised (0 executed runs); low alignment with current BrainLink/RSI priorities. |
| `training-subsidy-scoping` | 2026-11-14 | kill (out-of-scope & untested) | Failed test_card_exercised (0 executed runs); low alignment with current BrainLink/RSI priorities. |
| `vertical-niche-screen` | 2026-11-12 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `voice-pilot-quote-gate` | 2026-11-09 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
| `weekly-constraint-check` | 2026-11-01 | kill (out-of-scope & untested) | Failed test_card_exercised (0 executed runs); low alignment with current BrainLink/RSI priorities. |
| `withheld-finding-audit` | 2026-11-19 | hold (pending test run) | Failed test_card_exercised (0 executed runs); relevant to BrainLink/AI ops — hold until 1 real run is logged. |
