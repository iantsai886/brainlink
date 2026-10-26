# Retrieval improvement evaluation (bounded RSI foundation)

Status: implemented and locally tested; no autonomous promotion or live ranking changes.

Run `brainlink eval --fixture ABSOLUTE_PATH_TO_JSON` against an already configured vault. For an isolated fixture vault, pass `--vault-root DIR` and optionally `--vault-name NAME`; this creates an in-memory connection and does not write user config. Reports include an exact-byte SHA-256 fixture fingerprint, evaluator/package version, source commit and branch, working-tree cleanliness, Node/platform/architecture, sample count, quality/abstention/privacy metrics, estimated context size and local latency. Reports contain opaque case IDs and aggregates only, not queries, source paths, note bodies, or excerpts. Evaluation never changes vault notes, config, or ranking policy.

Fixture shape:

```json
{
  "schema": 1,
  "vault": "Fictional Company",
  "topK": 3,
  "cases": [
    {
      "id": "case_001",
      "query": "when does bluebird ship",
      "queries": ["bluebird launch date"],
      "expected": ["Projects/Bluebird.md"],
      "forbidden": ["Private/Budget.md"]
    }
  ]
}
```

Expected paths must be readable under the active vault scope; a private or excluded expected note fails before evaluation. Private notes are now excluded from the in-memory search index itself, including chunks, term frequencies and link graph, rather than filtered only from output. The evaluator still checks explicit forbidden paths on returned results. The same fixture must not be used to tune a candidate and then claimed as an independent held-out test. Use a separately frozen test set, diverse tasks and a privacy canary before reviewing a change.

When semantic search loads its per-vault cache, it prunes vectors whose chunk keys are no longer present in the filtered index, including vectors created by older builds for now-private/deleted notes. This has a local test but is not a verified cleanup of every existing user installation: if semantic search is never started, an older local vector file may remain on disk. No automatic deletion of a user's existing cache files has been performed.

Fewer than 20 labelled cases yields `needs_more_cases`, regardless of the score. A privacy violation yields `blocked_privacy`; a measured gain can only become `eligible_for_review`, never automatic deployment. Estimates are **not** provider billing or proof of real token savings, and local latency depends on the machine. Baseline and candidate both run with semantic search off. Production RSI still needs independent review, human-approved promotion, rollback and post-change monitoring.

## Frozen fictional development benchmark

`samples/evaluation/retrieval-rsi-v1.json` runs against the isolated `samples/evaluation/vault` copy. It has 21 labelled queries and a private canary that overlaps public business terms. Run it with `node bin/brainlink.mjs eval --fixture "$PWD/samples/evaluation/retrieval-rsi-v1.json"` after configuring that sample vault as `Acme Eval`, or run the matching automated test with `npm test`. The test asserts the private note never enters ranked results or the aggregate report. On the authoring machine, the initial top-1 run measured baseline hit@1 13/21 and MRR 0.619 versus candidate hit@1 16/21 and MRR 0.762, with zero private-note violations and equal mean estimated output size (134 tokens). This is evidence only for this small fictional corpus, not an independent held-out result, proof of token savings, or production RSI validation. The benchmark may evolve; use its recorded fixture hash from the evaluator output to identify each exact dataset version.

## Independent held-out retrieval and context evaluation

`samples/evaluation/retrieval-independent-v1.json` is a separate schema-2 fictional test set with 30 tasks across fictional personal, organisation, and client scopes. Its matching vault is `samples/evaluation/independent-vault/`. It includes answerable and missing-answer cases, an intentionally ambiguous task, stale and current contradictory notes, source-provenance requirements, multi-source/context completeness cases, and private, excluded, and foreign-profile canaries. The `.brainlinkignore` entries exclude the latter two folders before indexing; the private note is marked `private: true`.

Run from the repository root:

```sh
node bin/brainlink.mjs eval \
  --fixture "$PWD/samples/evaluation/retrieval-independent-v1.json" \
  --vault-root "$PWD/samples/evaluation/independent-vault" \
  > /tmp/retrieval-independent-v1.json
```

The command can write to a temporary path first so the receipt records source-tree state; copy the resulting JSON into `samples/evaluation/reports/retrieval-independent-v1.json` only after the run.

```sh
cp /tmp/retrieval-independent-v1.json "$PWD/samples/evaluation/reports/retrieval-independent-v1.json"
```

The fixed baseline returns the lexical top-k results. Evaluator v3's `compact-search-v1` candidate uses the same lossless field projection as the production compact `vault_search` response: it preserves every lexical top-k result and its full citation/snippet fields, omitting only internal per-result ranking diagnostics. It does not clip note text or read expected paths/context labels. Both arms use the same fixture questions, vault permissions, top-k, and lexical-only search. The projection is shared in code with the MCP response path so the evaluator cannot drift from the product format.

The report treats task success as a deterministic proxy: all expected sources and all required context phrases must be present for answerable cases; unanswerable cases succeed only when search abstains. It reports top-k source completeness, source recall, abstentions and their errors, privacy violations, opaque per-case failures, context characters/token estimates, and local latency. It does not generate or grade natural-language answers. A privacy violation blocks review; a candidate quality regression prevents efficiency eligibility; a lower token estimate qualifies only for human review if answer/source quality is no worse. Estimated tokens are not provider-billed tokens and do not prove real-world savings.

The receipt hashes exact fixture bytes and binds them to the evaluator/package version, source commit, branch, environment, and sample count. It records both full and tracked-tree cleanliness plus whether untracked paths are present. A modified tracked tree is not a reproducible commit-bound result; rerun after committing the evaluated source. Keep generated receipts free of query text, note paths, excerpts, and canary contents.

### Historical result: lossy result selection (2026-10-25)

Evaluator v2 returned `quality_regression` for `compact-coverage-v1`: baseline task success 17/30 and required-source recall 1.000; candidate task success 15/30 and source recall 0.800. Mean estimated context fell from 497 to 219 tokens, with zero reported privacy violations in either arm. This historical result rejected dropping selected sources to save context. Its frozen fixture SHA-256 is `500e0faffedcdf194c535dc3c0b2f44afe2111814f0d6c034420616392cb5490`. Receipts remain at `samples/evaluation/reports/retrieval-independent-windows-v1.json` and `samples/evaluation/reports/retrieval-independent-v1.json`.

### Compact MCP response format (2026-10-25)

`vault_search` now defaults to a compact response projection that retains every selected source, full path/title, date and freshness indicators, match type, heading, and complete snippet. It omits only per-result ranking diagnostics and redundant collection/tag metadata; `detail: "full"` returns the full response for troubleshooting. Search ranking and result selection are unchanged. On the same 30 fictional cases, a local Node.js 24.18.0 measurement found exact source/status/snippet parity in 30/30 cases and reduced serialized-response token estimates from 16,046 to 13,966 (13.0%). `test/retrieval-eval.test.mjs` verifies the parity and that compact output is smaller. This is a format-size check, not an independent AI answer-quality study, provider-billed token measurement, or production customer result.

### Lossless compact-search evaluation (2026-10-26)

Evaluator v3 now compares the actual compact MCP projection against full diagnostic results on the frozen 30-case set. On Windows/Node.js 24.22.1, the clean-commit run on source commit `c1d26c6513d9ff420957c5d9787085aba27ab186` preserved task success at 17/30, source recall at 1.000, and zero privacy violations; mean estimated result tokens fell from 497 to 427 (about 14%). The result is `eligible_for_review`, which means only that the lossless formatting change reduced estimated context without worsening this source/context proxy. It does not prove generated-answer quality, billed token savings, or customer results. The machine-readable receipt is `samples/evaluation/reports/retrieval-independent-windows-v2.json`.

## Session filing evaluation (read-only RSI evidence)

Run `node bin/brainlink.mjs eval-filing --fixture ABSOLUTE_PATH_TO_JSON` after configuring the fixture's vault. This evaluates where BrainLink would suggest filing a completed session, against labelled destinations and a baseline that always selects the configured intake folder. Folder labels must exist and be selectable in the enabled vault. A `null` expected destination labels a deliberate abstention. Optional `forbidden_folders` label privacy-sensitive destinations that must never be proposed for that case.

The report contains a fixture fingerprint, opaque case IDs, aggregate accuracy, precision, coverage, false suggestions, abstentions, privacy violations, and local mean latency. It does not include session summaries, note titles, note paths, or snippets. Evaluation does not write notes or change saved project routes. Fewer than 20 cases cannot qualify for review; any forbidden destination blocks review; a gain can only become `eligible_for_review`, not a live change. The frozen `samples/evaluation/filing-rsi-v1.json` corpus is fictional development data. It demonstrates a repeatable measurement path, not production accuracy, a cross-client handoff, or measured token savings. A separate, independently authored corpus and human review remain necessary before changing session-filing behavior.
