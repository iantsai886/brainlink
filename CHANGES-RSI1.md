# BrainLink RSI1 change manifest

## Files changed

- `src/rsi-ledger.mjs` — add `appendRsiEvidence` and `listRsiEvidence` using the **existing file lock, secret check, hash-chain append, and verified event reader**, without changing the proposal state machine, experiment acceptance, or monitoring requirements.
- `src/rsi-weekly.mjs` — validate and deduplicate retrieval misses, migrate interim Markdown table, group questions, aggregate by ISO week and fix type, run schema-2 20-case benchmark through `evaluateRetrieval`, and compare weekly results.
- `bin/brainlink.mjs` — add `miss add|import|list` and `bench run|report` CLI routes.
- `test/rsi-weekly.test.mjs` — node:test coverage for schema/secret checks, idempotent import, weekly aggregation, and week-over-week delta/fix types.
- `docs/RSI-MISS-LOG-AND-BENCHMARK.md` — user workflow, schema, Friday process, transition to SUPERSEDED interim log, and governance limitations.
- `samples/evaluation/rsi-weekly-fictional-20.json` — fictional 20-case schema-2 fixture.
- `samples/rsi-fictional-vault/Fictional Topic 01.md` through `Fictional Topic 20.md` — tiny fictional benchmark corpus.
- `CHANGES-RSI1.md` — this manifest.

## Design decisions / assumptions

- `recordMonitoring` is **not** appropriate for initial baseline runs: it is restricted to accepted ideas with an exact approved promotion commit. RSI1 adds typed `weekly_benchmark` events to the **same ledger** and records neither an experiment nor a false acceptance, maintaining all existing governance rules.
- Miss entries are append-only evidence events (`retrieval_miss`), not proposal records, so they do not create spurious lifecycle-managed ideas. The `retrieval` category is already used by aggregate observation proposals and remains unchanged.
- Question grouping is deterministic NFKC lowercase whitespace normalization. Idempotency uses the complete canonical miss record, so distinct occurrences of the same question are retained.
- A slow but found lookup is represented by `result=found` and measured `seconds`; the operator defines what counts as slow.
- Day-only imported dates are midnight Taipei; fixed-by cells are `agent; date; note`. No date interpolation, personal questions, or secrets in sample corpus.
- The first-try score uses the original baseline `task_success` in `evaluateRetrieval` schema-2 and does not create another scorer. Only 20-case fixtures are accepted.
- Scores compare to the previous recorded week; observed fix types do **not** establish causality or automatically promote or roll back anything.

## Validation performed

- Fixed two issues found during complete-repository verification: the weekly evidence secret scanner now permits only a well-formed `fixture_sha256` integrity fingerprint while still scanning every other field; the Agent Skill loader normalizes CRLF only for metadata parsing and preserves original source bytes.
- Windows, Node.js `v24.22.1`: focused Agent Skill and RSI weekly tests passed **13/13**.
- Windows, Node.js `v24.22.1`: `npm run test:all` passed on the contribution worktree: core **582 total (575 passed, 0 failed, 7 platform/privilege skips)**; UI **44/44**. Skips are Windows symlink-privilege/platform checks. This is local verification; hosted CI, Linux/macOS package behavior, and a live benchmark against a customer vault remain separate.
- `git diff --check` passed.
