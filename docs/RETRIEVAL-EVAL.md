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

The fixed baseline returns the lexical top-k results. The candidate applies the label-blind `compact-coverage-v1` rule: keep the highest-ranked result, then keep later results only when lexical coverage is at least 0.35 and the serialized context remains within 350 locally estimated tokens. It does not clip note text or read expected paths/context labels. Both arms use the same fixture questions, vault permissions, top-k, and lexical-only search. The rule is part of the evaluator version and must not be tuned on this frozen test set.

The report treats task success as a deterministic proxy: all expected sources and all required context phrases must be present for answerable cases; unanswerable cases succeed only when search abstains. It reports top-k source completeness, source recall, abstentions and their errors, privacy violations, opaque per-case failures, context characters/token estimates, and local latency. It does not generate or grade natural-language answers. A privacy violation blocks review; a candidate quality regression prevents efficiency eligibility; a lower token estimate qualifies only for human review if answer/source quality is no worse. Estimated tokens are not provider-billed tokens and do not prove real-world savings.

The receipt hashes exact fixture bytes and binds them to the evaluator/package version, source commit, branch, environment, and sample count. It records both full and tracked-tree cleanliness plus whether untracked paths are present. A modified tracked tree is not a reproducible commit-bound result; rerun after committing the evaluated source. Keep generated receipts free of query text, note paths, excerpts, and canary contents.

### Recorded independent result (2026-10-25)

The frozen fixture currently returns `quality_regression` for `compact-coverage-v1`: baseline task success 17/30 and required-source recall 1.000; candidate task success 15/30 and source recall 0.800. Mean estimated context falls from 497 to 219 tokens, with zero reported privacy violations in either arm. The evaluation does **not** support adopting this compaction rule; it demonstrates why context savings must not be accepted when retrieval quality drops. The fixture has SHA-256 `500e0faffedcdf194c535dc3c0b2f44afe2111814f0d6c034420616392cb5490`. The Windows integration receipt is stored at `samples/evaluation/reports/retrieval-independent-windows-v1.json`; the contributor's macOS receipt remains at `samples/evaluation/reports/retrieval-independent-v1.json`.

## Session filing evaluation (read-only RSI evidence)

Run `node bin/brainlink.mjs eval-filing --fixture ABSOLUTE_PATH_TO_JSON` after configuring the fixture's vault. This evaluates where BrainLink would suggest filing a completed session, against labelled destinations and a baseline that always selects the configured intake folder. Folder labels must exist and be selectable in the enabled vault. A `null` expected destination labels a deliberate abstention. Optional `forbidden_folders` label privacy-sensitive destinations that must never be proposed for that case.

The report contains a fixture fingerprint, opaque case IDs, aggregate accuracy, precision, coverage, false suggestions, abstentions, privacy violations, and local mean latency. It does not include session summaries, note titles, note paths, or snippets. Evaluation does not write notes or change saved project routes. Fewer than 20 cases cannot qualify for review; any forbidden destination blocks review; a gain can only become `eligible_for_review`, not a live change. The frozen `samples/evaluation/filing-rsi-v1.json` corpus is fictional development data. It demonstrates a repeatable measurement path, not production accuracy, a cross-client handoff, or measured token savings. A separate, independently authored corpus and human review remain necessary before changing session-filing behavior.
