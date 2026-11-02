# RSI miss log and Friday benchmark

BrainLink stores RSI miss and benchmark evidence as hashed, append-only events in the **existing** `BRAINLINK_HOME/rsi/ledger.jsonl`. The ordinary proposal lifecycle, accepted-change monitoring gate, and rollback rules are unchanged. No second store and no automated promotion/rollback.

## Log a miss

A miss is an unsuccessful, stale, **or slow** Brain lookup. `found` is valid when lookup was slow; record the elapsed seconds. All date values use a full ISO-8601 timestamp with `+08:00`. The schema is:

```json
{"date":"2026-10-30T12:00:00+08:00","agent":"Fictional Agent","question":"Where is the fictional roadmap?","result":"not_found","seconds":3,"fix_needed":"add_index_entry"}
```

`result`: `found`, `not_found`, `stale`. `fix_needed`: `file_missing_fact`, `replace_stale_note`, `add_link`, `add_index_entry`, `other`. Optional `fixed_by`: `{ "agent": "Fixer", "date": "2026-11-06T13:00:00+08:00", "note": "Fictional index updated" }`. Never include credentials, email addresses, private personal information, or non-generic questions. A miss log is not a storage destination for vault note text. Normalize punctuation and wording carefully; reports group by lowercase NFKC questions with repeated whitespace collapsed, not semantic similarity.

```
brainlink miss add --agent "Fictional Agent" --question "Where is the fictional roadmap?" --result not_found --seconds 3 --fix-needed add_index_entry --date 2026-10-30T12:00:00+08:00
brainlink miss list --week 2026-W44
brainlink miss import --file "Brain Miss Log.md"
```

The importer expects exactly the seven interim Markdown table headers, accepts day-only dates as midnight in Taipei, and reads `fixed by` as `agent; YYYY-MM-DD; note`. It validates every row, rejects sensitive fields, and uses a stable content key to avoid re-importing the same event. After verifying the imported row count and backup, mark the interim Markdown document **SUPERSEDED**, keeping it for provenance without further appends.

## Weekly fixed 20-case benchmark

```
brainlink bench run --fixture samples/evaluation/rsi-weekly-fictional-20.json --vault-root samples/rsi-fictional-vault --vault-name "RSI Fictional" --week 2026-W44
brainlink bench report --weeks 8
```

Swap in the approved real 20-case schema-2 fixture once delivered. Keep its questions and expected paths fixed across weeks; investigate fixture changes separately. **First-try correct** = `evaluateRetrieval` schema-2 *baseline* `task_success.count / 20 * 100`. The baseline is the original (noncompact) response to the first literal query; no rewrite or retry. Success requires correct expected sources and required snippet context (or correct abstention for an unanswerable question); the evaluator reports privacy separately. This measures retrieval task-success proxy, not independent verification of generated answers. Scoring is *not reimplemented*.

Every weekly run is recorded as `weekly_benchmark` evidence in the **same** RSI hash chain. The receipt records start/end time, fixture hash, evaluator and BrainLink versions, source commit, whether the tree was clean before and after, whether the commit stayed stable, and Node/platform/architecture. It is idempotent for the same week, fixture, evaluator, and source revision; a new commit in the same week creates a separate receipt. A missing or changing source revision remains visible as unbound/unstable evidence and is not proof tied to a reproducible commit. The source revision fields contain public Git identifiers, not note content.

This event intentionally does not call `recordMonitoring`: existing `recordMonitoring` requires an *accepted* idea and the exact clean-commit promotion SHA. First-week baselines have no such approved change; weakening that requirement would compromise existing governance. Accepted-change monitoring can still be recorded separately through its original API.

## Friday review

Review the week's score and `delta_pp` against the preceding recorded week, then look at `applied_fix_types` from miss records whose `fixed_by.date` falls in that ISO week. Correlation is not causal proof: review individual misses and unchanged control cases before recommending a standing rule. A human approves standing rules, investigates regressions, and uses the existing reviewed rollback process for accepted changes; a benchmark score by itself never triggers rollback. Re-importing identical rows and rerunning identical week+fixture+evaluator does not duplicate evidence. Each distinct version of a week can exist in the append-only ledger, but the report selects the last recorded version for that week.
