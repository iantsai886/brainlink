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
