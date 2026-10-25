# Contributor review: independent retrieval efficiency evaluation

Date: 2026-10-25 (Asia/Taipei)

## Submitted contribution

- Repository: `iantsai886/brainlink`
- Contributor branch: `eval/independent-retrieval-efficiency`
- Evaluator commit: `ec6bbfd`
- Receipt commit: `99242e5`
- Coordinator report commit: `7568c57`
- Integration branch: `integration/brainlink-retrieval-evaluation`

The contribution adds a schema-2, read-only retrieval evaluator, explicit fixture-vault CLI options, and a fictional 30-case held-out corpus across Personal, Organisation, and Client scenarios. It reports quality, abstention, source completeness, context estimates, latency, and privacy canaries. It makes no production ranking change.

## Result and product decision

The contributor's result is negative for its proposed `compact-coverage-v1` candidate: estimated context falls from 497 to 219 tokens, but task success drops from 17/30 to 15/30 and required-source recall from 1.000 to 0.800. Privacy violations remain zero. The evaluator marks this `quality_regression`.

**Decision: keep the fixture and evaluator; do not adopt this compaction policy.** The reduction is only a local token estimate and cannot justify lower retrieval quality. Revise on development data and use a different frozen set for any new evaluation.

## Review fixes

- Fixed source-recall indexing so each answerable case is measured against its observation at the same original case index. The supplied fixture places all answerable cases first, so this bug did not change the reported metrics; a regression test now interleaves answerable and unanswerable cases and asserts order-invariant recall.
- Added explicit expected baseline and candidate source-recall assertions.
- Set `.gitattributes` to keep the fixture and receipts at LF across platforms. The contributor's exact-byte fixture SHA-256 is `500e0faffedcdf194c535dc3c0b2f44afe2111814f0d6c034420616392cb5490`; Windows `autocrlf` had otherwise changed the checked-out bytes and produced a different hash.
- Stored the Windows integration receipt separately from the contributor's macOS receipt so each result retains its own environment and source commit.

## Evidence

The contributor report states that its macOS Node.js 26.3.1 run passed seven focused evaluator tests and 28 UI tests, while the full core suite had four failures reproduced on the unchanged base. It also reports no live network, customer data, or production ranking changes. The report's machine-specific baseline failures and CI receipts were not independently queried during this review.

Independent Windows validation used Node.js 24.18.0. The focused evaluator suite passed 7/7. `npm run test:all` passed 318 core tests (312 passed, six skipped) and 28 UI tests (28 passed). The skipped core tests depend on Linux/macOS or Windows symlink privileges. The exact fixture hash and negative quality result reproduced locally. The Windows receipt records the integration source commit and environment; it contains aggregate metrics and opaque case IDs, not queries or note contents.

## Limits

- The 30 cases are fictional and do not validate real user tasks, provider token billing, or cross-client behavior.
- Task success is a deterministic source/context proxy; no language model generated answers.
- The benchmark's candidate is evaluation-only and never alters production search or ranking.
- A new held-out corpus and human review are required before adopting any revised retrieval policy.

