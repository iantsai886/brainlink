# BrainLink RSI1 change manifest

## Files changed

- `src/rsi-ledger.mjs` — add `appendRsiEvidence` and `listRsiEvidence` using the **existing file lock, secret check, hash-chain append, and verified event reader**, without changing the proposal state machine, experiment acceptance, or monitoring requirements.
- `src/rsi-weekly.mjs` — validate and deduplicate retrieval misses, migrate interim Markdown table, store only normalized question fingerprints, require a profile when reading misses, aggregate by ISO week and fix type, run schema-2 20-case benchmark through `evaluateRetrieval`, and compare weekly results.
- `src/core.mjs` — narrowly allow correctly shaped `question_sha256` fingerprints through the existing secret scanner; malformed hashes and hashes in ordinary prose remain flagged.
- `bin/brainlink.mjs` — add `miss add|import|list` and `bench run|report` CLI routes.
- `test/rsi-weekly.test.mjs` — node:test coverage for schema/secret checks, idempotent import, weekly aggregation, and week-over-week delta/fix types.
- `docs/RSI-MISS-LOG-AND-BENCHMARK.md` — user workflow, schema, Friday process, transition to SUPERSEDED interim log, and governance limitations.
- `samples/evaluation/rsi-weekly-fictional-20.json` — fictional 20-case schema-2 fixture.
- `samples/rsi-fictional-vault/Fictional Topic 01.md` through `Fictional Topic 20.md` — tiny fictional benchmark corpus.
- `CHANGES-RSI1.md` — this manifest.

## Design decisions / assumptions

- `recordMonitoring` is **not** appropriate for initial baseline runs: it is restricted to accepted ideas with an exact approved promotion commit. RSI1 adds typed `weekly_benchmark` events to the **same ledger** and records neither an experiment nor a false acceptance, maintaining all existing governance rules.
- Miss entries are append-only evidence events (`retrieval_miss`), not proposal records, so they do not create spurious lifecycle-managed ideas. The `retrieval` category is already used by aggregate observation proposals and remains unchanged.
- Question grouping is deterministic NFKC lowercase whitespace normalization followed by SHA-256. The original question is scanned for secrets, used to compute the fingerprint, and not saved. A hash of a short or predictable question may still be guessed, so only fictional/generic wording is recommended. Profile is a label-based separation filter, not an authentication boundary; it does not replace separate app homes/ledgers for strong isolation.
- A slow but found lookup is represented by `result=found` and measured `seconds`; the operator defines what counts as slow.
- Day-only imported dates are midnight Taipei; fixed-by cells are `agent; date; note`. No date interpolation, personal questions, or secrets in sample corpus.
- The first-try score uses the original baseline `task_success` in `evaluateRetrieval` schema-2 and does not create another scorer. Only 20-case fixtures are accepted. Evidence stores aggregate failure count, not case IDs.
- Scores compare to the previous recorded week; observed fix types do **not** establish causality or automatically promote or roll back anything.

## Validation performed

- Node.js `v24.22.1` on Windows: focused RSI tests passed 4/4; syntax checks passed for the modified runtime files.
- Full `npm run test:all`: core suite ran 588 tests (578 passed, 2 failed, 8 skipped). The two failures were transient Windows `EPERM` errors in unrelated RSI-discovery settings-file replacement and cross-process session lock tests. The UI suite did not run because the core command exited nonzero. Rerun the two affected tests and the full suite in CI before merge; no passing full-suite claim is made.
