# RSI miss log and weekly benchmark

BrainLink stores RSI miss and benchmark evidence as hashed, append-only events in the **existing** `BRAINLINK_HOME/rsi/ledger.jsonl`. The ordinary proposal lifecycle, accepted-change monitoring gate, and rollback rules are unchanged. No second store and no automated promotion/rollback.

## Log a miss

A miss is an unsuccessful, stale, **or slow** Brain lookup. `found` is valid when lookup was slow; record the elapsed seconds. All date values use a full ISO-8601 timestamp with `+08:00`. The schema is:

```json
{"date":"2026-10-30T12:00:00+08:00","agent":"Fictional Agent","question":"Where is the fictional roadmap?","result":"not_found","seconds":3,"fix_needed":"add_index_entry"}
```

`profile` is required to keep Personal, Organisation and Client records separate. `result`: `found`, `not_found`, `stale`. `fix_needed`: `file_missing_fact`, `replace_stale_note`, `add_link`, `add_index_entry`, `other`. Optional `fixed_by`: `{ "agent": "Fixer", "date": "2026-11-06T13:00:00+08:00", "note": "Fictional index updated" }`. The original question is used only to compute a SHA-256 fingerprint and is **not saved**; the ledger stores the fingerprint, profile label, result and timing. Do not put real names or sensitive details in profile/agent/fix notes. Hashes of short or predictable questions can still be guessed, so use fictional/generic question wording for any real-world logging. Never include credentials, email addresses, private personal information, or vault note text. Listing requires an exact profile label and never returns another profile's miss records. Grouping is by exact normalized question fingerprint, not semantic similarity.

```
brainlink miss add --profile "Fictional Organisation" --agent "Fictional Agent" --question "Where is the fictional roadmap?" --result not_found --seconds 3 --fix-needed add_index_entry --date 2026-10-30T12:00:00+08:00
brainlink miss list --profile "Fictional Organisation" --week 2026-W44
brainlink miss import --file "Brain Miss Log.md"
```

## Automatic, content-free retrieval observations

For a registered, profile-scoped AI only, successful `vault_search` and `context_packet` calls automatically append a `retrieval_observation` event to the same ledger. It stores the opaque Twin profile ID, tool name, returned status (`hits`, `weak`, or `not_in_brain`), timestamp, and a 250 ms duration bucket (capped at 120 seconds). It never stores the question, a question hash, vault name, note path, excerpt, or answer. Unassigned and legacy connections are not recorded. This is an operational signal, not proof that the answer was correct or that a `not_in_brain` result was a system failure.

Review aggregate counts for one profile with `brainlink miss observations --profile PROFILE_ID [--week YYYY-Www]`. The report exposes totals by week, tool, and status plus the rounded mean duration bucket. It does not identify individual requests. Records are append-only and are covered by the RSI ledger's existing backup/restore path.

The importer expects exactly eight Markdown table headers, including `profile`, accepts day-only dates as midnight in Taipei, and reads `fixed by` as `agent; YYYY-MM-DD; note`. It validates every row, rejects sensitive fields, and uses a stable content key to avoid re-importing the same event. After verifying the imported row count and backup, mark the interim Markdown document **SUPERSEDED**, keeping it for provenance without further appends.

## Weekly fixed 20-case benchmark

```
brainlink bench run --fixture samples/evaluation/rsi-weekly-fictional-20.json --vault-root samples/rsi-fictional-vault --vault-name "RSI Fictional" --week 2026-W44
brainlink bench report --weeks 8
```

Swap in the approved real 20-case schema-2 fixture once delivered. Keep its questions and expected paths fixed across weeks; investigate fixture changes separately. **First-try correct** = `evaluateRetrieval` schema-2 *baseline* `task_success.count / 20 * 100`. The baseline is the original (noncompact) response to the first literal query; no rewrite or retry. Success requires correct expected sources and required snippet context (or correct abstention for an unanswerable question); the evaluator reports privacy separately. This measures retrieval task-success proxy, not independent verification of generated answers. Scoring is *not reimplemented*.

Setup's **Run benchmark** button and its optional local schedule run only BrainLink's bundled fictional vault and fixed 20-case fixture; the UI never takes a user-selected vault or sends data to a model. Both endpoints require local Setup authentication. The receipt records the app version, Git revision and cleanliness both before and after evaluation, timestamps, and whether the same clean revision remained in place for the whole run. A changed or dirty source is still useful for local diagnosis, but is not called stable evidence. Every weekly run is recorded as `weekly_benchmark` evidence in the **same** RSI hash chain, idempotent by week, fixture, evaluator and source interval. It stores aggregate metrics and no failed case IDs, question text, or note paths. This event intentionally does not call `recordMonitoring`: existing `recordMonitoring` requires an *accepted* idea and the exact clean-commit promotion SHA. First-week baselines have no such approved change; weakening that requirement would compromise existing governance. Accepted-change monitoring can still be recorded separately through its original API.

## Friday review

Review the week's score and `delta_pp` against the preceding recorded week. A score change is not causal proof: compare the fixture, code revision and environment before recommending a standing rule. A human approves standing rules, investigates regressions, and uses the existing reviewed rollback process for accepted changes; a benchmark score by itself never triggers rollback. Re-importing identical rows and rerunning the same week, fixture, evaluator and source interval does not duplicate evidence. Each distinct run of a week can exist in the append-only ledger, but the report selects the last recorded version for that week. Automatic capture of content-free retrieval status and timing is implemented for profile-scoped AI calls; automatic answer-quality evaluation remains unimplemented.
