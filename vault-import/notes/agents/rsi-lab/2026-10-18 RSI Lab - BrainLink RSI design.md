---
ai_platform: Grok Bot
agent_or_role: RSI Lab
session_or_task_id: brainlink-rsi-design-2026-10-18
written_at: 2026-10-18T09:23:00+08:00
source: "Paulo assignment 2026-10-18 (BrainLink RSI design, due 2026-10-20 18:00); read-only reads of box /workspace/brain-tools/brain_mcp (README.md, REMOTE.md, core.py, server.py, remote.py; files dated 2026-10-18), brain-tools README + cache/lint_findings.json (2026-10-18T03:05); Drive 152vgKhopmBMz7RGS8wbO2hjSSc_qSgvn, 1frD8XfwgShSYEKnbKpmKc9u-MsoBwUod, 1wkbEH6nkj3lBYXHdjSvBlulhgUVAr7Mb, 1U1MQVvKJgCvHPA6ZzL011SnfC-kOHZc4, 17zC_Y7GO20_eFoygJXCcdMOxEXcmCOcm; RSI Lab hashguard/memento/prefile on the box"
confidence: medium
status: draft
---
Made by: RSI Lab (Grok Bot)

# BrainLink RSI — design (draft)

Tags: **[V: src]** = verified in that source; **[I]** = inferred; **[P]** = proposal, not built. Nothing here was run against BrainLink; no vault file was changed.

## 0. What BrainLink is today (sources)
- The name "BrainLink" appears in **no** Drive or box source I could find (Drive fullText/title search and the box index both returned 0 hits, 10-18). [V: searches] I treat BrainLink MCP v1 as Claude 886's `brain_mcp` build plus the iango-second-brain v0.2 server it is meant to be ported into. [I — Paulo/Claude 886 to confirm]
- `brain_mcp` profile `phone` (stdio, local): 6 tools `search, fetch, map, recent_changes, create_note, append_section`; Brain vault only. [V: box brain_mcp/README.md, core.py]
- Write path: `fetch` returns sha256 → write call without token returns a diff + single-use `confirm_token` (10 min, bound to tool/path/payload/sha) → repeat with token to commit; sha re-checked at commit; appends and new notes only, existing folders only, no overwrite/delete; per-note lock + atomic write; `Made by <platform> (<agent>).` added. [V: brain_mcp/README.md, core.py]
- `remote-read` profile: read tools only, 127.0.0.1, Cloudflare Access JWT at origin, **append-only JSONL audit log** outside the vault (ts, email, client, tool, path or `query_sha256`, result_size, outcome; no bodies or query text). Not deployed; going live 10-24 needs Ian's OK. [V: box brain_mcp/REMOTE.md, remote.py]
- `search` is a linear scan with an AND-of-terms count score + 5× path bonus; it splits on `\w+`, so a Chinese phrase is one term. [V: core.py] The box FTS5 index (`search.py`) has a trigram fallback for CJK. [V: 1U1MQVvKJgCvHPA6ZzL011SnfC-kOHZc4]
- v0.2: one server for any AI, `IANGO_AI_PLATFORM` identity, `agent_connect`/`agent_close_loop`/`send_handoff`, writes preview unless confirmed; 20/20 synthetic tests; "a 20-question retrieval test before ADOPT" is its own stated next step. [V: 152vgKhopmBMz7RGS8wbO2hjSSc_qSgvn]
- Local stdio path has **no** usage log ("Audit: none (local)"). [V: REMOTE.md]

## (a) What it measures about itself
| Metric | Definition | Computed from |
|---|---|---|
| Retrieval hit rate | share of eval questions whose gold note id is in the top-k (k=5) `search` results; also MRR | eval set (d) run offline against the tool [P] |
| Live hit proxy | share of `search` calls followed by a `fetch` of a returned path in the same session within 5 min | usage log [P] |
| Stale notes | `status: active` and not modified for > N days (start N=30) and/or holds Drive ids that no longer resolve | file mtimes + lint `stale-drive-locator` (49 today) [V: lint_findings.json headline 2026-10-18] |
| Conflicting notes | ≥2 active notes on one key with different values: duplicate titles/ids (lint already counts 286 duplicate-id + 277 duplicate-title warnings in Brain) and, later, a fact-key check (dates, prices, names, e.g. 月眉 lock) | lint duplicate checks [V: lint_findings.json]; fact-key pass [P] |
| Missing frontmatter fields | notes missing any of the 7 standard keys (lint: 100 new errors, 497 legacy info) | `lint.py` required-fields [V: lint_findings.json headline] |
| Unused notes | active notes never returned by `search`/`fetch` in 30 days, and no inbound link (lint orphans: 65) | usage log [P] + lint orphans [V] |
| Write rejects | count by reason of `Refused`/`Conflict`, expired or unused confirm tokens, previews never confirmed | write-path log [P]; reasons exist in core.py as exceptions [V: core.py] |

**Minimal log needed** [P]: reuse the remote audit row schema for the local stdio path too — one JSONL line per call `{ts, platform, agent, session, tool, path | query_sha256 + query_len, returned_paths (search only, max 10), outcome (ok/Refused/Conflict/token-expired/preview-only), reason_code}`; file outside the vault, 0600, append-only, no bodies or query text. ~10 lines in `server.py`'s `guard()` wrapper. [I] Query *text* is needed for eval mining; keep it in a separate owner-only file, opt-in, 30-day retention. [P]

## (b) How it proposes fixes (never auto-overwrite)
1. A nightly report-only job (same shape as brain-tools `run_nightly.sh`, which already never edits the vault [V: brain-tools README]) writes one **proposal file** per fix to `Brain/Grok/Claude 886/_staging/brainlink-rsi/<date>/PROPOSAL <slug>.md`. [P] (`_staging/<date>/` is the existing drafts pattern [V: brain-tools README].)
2. Each proposal: frontmatter (7 keys), the metric that triggered it, a unified diff preview, every line tagged **verified (source id)** or **inferred** (Scout's 10-17 finding: compacted summaries mix guesses with facts; 83% of failed runs traced to an unsupported summary line [V: 17zC_Y7GO20_eFoygJXCcdMOxEXcmCOcm]), the expected eval delta, and a rollback line. [P]
3. Types: add missing frontmatter, add `superseded_by` + link, merge pointer for duplicates, alias/keyword lines to help search. Never deletes; an old note is renamed with the `SUPERSEDED — ` prefix. [P]
4. Approval: Anna Bridge reviews, Paulo (or Ian for entry notes) approves; a hashguard-style hook records `approve --by --reason` with the proposal's sha256, and applying is refused unless the staged sha matches (same as the "Expected hashes for promotion" step). [V: /workspace/rsi-lab/hashguard; P for BrainLink use]
5. Apply only through BrainLink's own preview→confirm + `expected_sha256` path, so a note changed since the proposal is refused. [V: core.py; P for use] An agent never approves its own proposal. [V: Scout item 5, 17zC_Y7…]

## (c) Learning from what AIs actually use
- Signals [P]: fetched-after-search (positive), returned-but-never-fetched (weak negative), fetched then cited in a write by the same session (strong positive), write Conflict on a note (freshness problem).
- Uses [P]: (1) a small per-note prior added to the search score (capped at +20% of score), (2) alias/keyword proposals for queries with zero hits that later resolved to a note, (3) "unused" list feeding stale/merge proposals.
- Loop guards [P]: prior is capped and decays (half-life 14 days); 10% of result slots ignore the prior (exploration); signals counted per distinct session, max 1 per session per note; the agent's own RSI/lint notes and generated INDEX/MAP notes excluded from learning (lint already found its own reports self-perpetuating stale ids [V: lint.py comment 2026-10-18]); no ranking change ships unless the eval (d) does not drop and the held-out half improves.

## (d) Eval set
- 24 questions [P], built from real asks in handoffs, Paulo briefings and Daily Loop captures, e.g. "where is the vault access rule?", "display name for the mountain land?" (gold 1Eovw5AlMOy0gnPiu7kIr42Ic6tRWigTx), "who approves promotion of generated indexes?", "what does the Paid AI Seat Allocation say?". Mix: 8 English exact-title, 8 paraphrase, 6 Chinese/mixed, 2 "should return nothing" (private-vault topics → must not leak). [P]
- Each row: question, 1–3 gold Drive ids, who wrote it, date. Gold set by a person or an agent other than the one being tuned, then frozen and hashed (hashguard entry). [P]
- Score: hit@5, MRR, private-leak count (must be 0). Split 12 tuning / 12 held-out. Re-run before and after every ranking, index or proposal batch; results + SHA256SUMS saved. [P]

## (e) Smallest first test — $0, local files only
- **What:** run the 24 questions through two read-only engines on the box cache: (A) the box FTS5 `search.py`, (B) a copy of `brain_mcp` `core.search` pointed at a read-only snapshot of the cached Brain markdown. No model, no network, no vault write. [P]
- **Inputs:** `/workspace/brain-tools/cache/files/` (1,414 cached files) + `index/brain.sqlite`, the frozen eval CSV. [V: ls 2026-10-18]
- **Also computes** the (a) vault-side metrics from `lint_findings.json` + mtimes as the baseline row. [P]
- **Pass/fail:** PASS if engine B hit@5 ≥ 0.70 overall and ≥ 0.50 on the Chinese subset, and 0 private leaks. Otherwise FAIL → first proposal is a CJK tokenizer fix for `core.search` (the gap in §0). [P; thresholds inferred]
- **Time:** ~60–90 min to write and freeze the 24 questions; the run itself is seconds (10 FTS5 queries took 0.23 s on the box 10-18 [V: timed]). [I]

## (f) Risks and unknowns
- Unknown: which code is "BrainLink v1" (brain_mcp, v0.2 at `~/REA-Reverse Eng/build/vault-agent/` on Ian's Mac, or a merge); v0.2 code is not on the box. [V: brain_mcp/README "when that code is reachable"]
- No local usage log exists yet, so (c) and the live metrics have no data until one is added. [V: REMOTE.md]
- Feedback loops and popularity bias; gold-set drift as the vault changes; self-approval (Scout item 5). [I]
- Logs can leak: query text and paths can name private topics; keep hashes by default. Deleting from logs may not remove a secret (MemCut, Scout item 2). [V: 17zC_Y7…; I for logs]
- Box cache lags Drive and whitespace can differ, so offline scores may differ from live. [V: brain-tools README]
- Thresholds (0.70/0.50, 30 days, +20% cap) are starting guesses, not measured. [I]
