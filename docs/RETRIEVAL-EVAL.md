# Retrieval improvement evaluation (bounded RSI foundation)

Status: implemented and locally tested; no autonomous promotion or live ranking changes.

Run `brainlink eval --fixture ABSOLUTE_PATH_TO_JSON` against an already configured vault. The command reads a labelled fixture and reports a SHA-256 fixture fingerprint, case count, hit@k, mean reciprocal rank, privacy-canary violations, estimated output tokens and local latency for the current keyword baseline versus per-case query rephrasings. The report contains only opaque case IDs and aggregate/rank data, not queries, note paths, bodies or snippets. It never edits a vault or config.

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

Fewer than 20 labelled cases yields `needs_more_cases`, regardless of the score. A privacy violation yields `blocked_privacy`; a measured quality gain with enough cases yields only `eligible_for_review`, never automatic deployment. Estimates are **not** provider billing or proof of real token savings, and local latency depends on the machine. Baseline and candidate both run with semantic search off; this evaluator does not yet compare semantic models, filing accuracy, task success or real cross-AI handoffs. Production RSI still needs frozen baselines, independent held-out sets, human-approved promotion, rollback and post-change monitoring.

## Frozen fictional development benchmark

`samples/evaluation/retrieval-rsi-v1.json` runs against the isolated `samples/evaluation/vault` copy. It has 21 labelled queries and a private canary that overlaps public business terms. Run it with `node bin/brainlink.mjs eval --fixture "$PWD/samples/evaluation/retrieval-rsi-v1.json"` after configuring that sample vault as `Acme Eval`, or run the matching automated test with `npm test`. The test asserts the private note never enters ranked results or the aggregate report. On the authoring machine, the initial top-1 run measured baseline hit@1 13/21 and MRR 0.619 versus candidate hit@1 16/21 and MRR 0.762, with zero private-note violations and equal mean estimated output size (134 tokens). This is evidence only for this small fictional corpus, not an independent held-out result, proof of token savings, or production RSI validation. The benchmark may evolve; use its recorded fixture hash from the evaluator output to identify each exact dataset version.

## Session filing evaluation (read-only RSI evidence)

Run `node bin/brainlink.mjs eval-filing --fixture ABSOLUTE_PATH_TO_JSON` after configuring the fixture's vault. This evaluates where BrainLink would suggest filing a completed session, against labelled destinations and a baseline that always selects the configured intake folder. Folder labels must exist and be selectable in the enabled vault. A `null` expected destination labels a deliberate abstention. Optional `forbidden_folders` label privacy-sensitive destinations that must never be proposed for that case.

The report contains a fixture fingerprint, opaque case IDs, aggregate accuracy, precision, coverage, false suggestions, abstentions, privacy violations, and local mean latency. It does not include session summaries, note titles, note paths, or snippets. Evaluation does not write notes or change saved project routes. Fewer than 20 cases cannot qualify for review; any forbidden destination blocks review; a gain can only become `eligible_for_review`, not a live change. The frozen `samples/evaluation/filing-rsi-v1.json` corpus is fictional development data. It demonstrates a repeatable measurement path, not production accuracy, a cross-client handoff, or measured token savings. A separate, independently authored corpus and human review remain necessary before changing session-filing behavior.
