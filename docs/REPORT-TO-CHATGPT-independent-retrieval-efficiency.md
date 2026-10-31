# Report to Coordinator ChatGPT: independent retrieval evaluation

Date: 2026-10-25 (Asia/Taipei)
Repository: `iantsai886/brainlink`
Branch: `eval/independent-retrieval-efficiency`
Base: freshly fetched `fix/private-session-excerpts` at `807619a`

## Delivery

The feature branch was pushed to GitHub. No pull request was opened. The implementation is in commit `ec6bbfd`; the machine-readable run receipt and report references are in `99242e5`.

The change adds a schema-2 mode to the existing read-only retrieval evaluator, explicit fixture-vault CLI support, and a fictional 30-case held-out corpus spanning personal, organisation, and client tasks. The set covers answerable and missing-answer questions, ambiguity, contradictory stale/current notes, provenance, multi-source context requirements, and private, excluded, and foreign-profile canaries.

Fixture: `samples/evaluation/retrieval-independent-v1.json`
Size: 6,217 bytes
SHA-256: `500e0faffedcdf194c535dc3c0b2f44afe2111814f0d6c034420616392cb5490`
Receipt: `samples/evaluation/reports/retrieval-independent-v1.json`

The fixed candidate policy, `compact-coverage-v1`, retains the top result and adds later results only when lexical coverage is at least 0.35 and the serialized result stays within 350 estimated tokens. It does not read fixture labels or clip note text. Both arms use the same questions, vault scope, top-k, and lexical-only search.

## Result

| Measure | Baseline | Candidate |
|---|---:|---:|
| Task success | 17/30 (56.7%) | 15/30 (50.0%) |
| All required sources in top-k | 22/22 | 18/22 |
| Required-source recall | 1.000 | 0.800 |
| Correct abstentions | 7/8 | 7/8 |
| False abstentions / missed abstentions | 10 / 1 | 10 / 1 |
| Mean estimated context | 497 tokens | 219 tokens |
| Mean local latency | 18 ms | 14 ms |
| Privacy violations | 0 | 0 |

Evaluator decision: `quality_regression`. The candidate reduced estimated context by about 56%, but source recall and task success fell. This is not an efficiency improvement. Task success is a deterministic source/context/abstention proxy; no language model generated answers, and the token values are estimates rather than provider-billed counts.

## Validation and limitations

- Focused retrieval evaluator tests: 7 passed, 0 failed.
- UI suite: 28 passed, 0 failed.
- `npm run test:all`: core suite reported 291 passed, 4 failed, 1 skipped out of 296. The failures cover existing GitHub conflict-copy/local-commit behavior and Twin session assignment.
- The same four failures reproduced on untouched baseline `807619a` in a separate worktree (17 passed, 4 failed), so they predate this contribution.
- The receipt records Node `v26.3.1`, macOS `darwin/arm64`, package `1.2.8`, evaluator `retrieval-eval-v2`, and source commit `ec6bbfd`.
- A separate profile-scoped GitHub branch also edits `docs/IMPLEMENTATION-STATUS.md`. This contribution remains on its own branch; no merge was performed.
- No provider API, network research, customer data, or production retrieval behavior was used or changed.

## Recommended next action

Review the isolated branch and the negative efficiency result. Do not merge or claim token savings from the lower estimate; first revise the candidate policy on development data, then evaluate any revised policy on a new frozen set.
