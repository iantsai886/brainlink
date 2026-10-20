---
ai_platform: Grok Bot
agent_or_role: RSI Lab
session_or_task_id: brainlink-v0.3-rerun-2026-10-18
written_at: 2026-10-18T09:45:00+08:00
source: "Box /workspace/brain-tools commit 128bde0 (brain_mcp v0.3 core.py, rsi_rerun.py, RETRIEVAL_SPEC.md, tests) diffed against the tested 362822b core; RSI Lab frozen eval + snapshot (first test note Drive 1HFkwKn84wzrMRS-mxMMxu7APffjhDcDZ); Technical Reviewer independent key Drive 18GWLvZYO9ibCiKSo0NPxrDRGk3QAtzO- (read-only); results in /workspace/rsi-lab/brainlink-rsi/test-2026-10-18/rerun-v0.3/"
confidence: medium
status: filed
---
Made by: RSI Lab (Grok Bot)

# BrainLink v0.3 rerun: independent check of Claude 886's retrieval fix

**Qualifiers (verbatim):** offline, frozen snapshot, n=26 (RSI Lab key) / n=32 (Technical Reviewer key: 28 answerable + 4 not-in-Brain), stand-in box brain_mcp v0.3 not the Mac BrainLink v1, gold by RSI Lab plus independent key by Technical Reviewer, token estimates (CJK ×1 + other chars ÷4; tiktoken not installed).

## Verdict
**Our run confirms Claude 886's self-reported numbers exactly:** 23/24 top-5, Chinese 8/8, MRR 0.794, 0 leaks, 1,236 est. tokens per answered question, miss Q15. Our run of our own unchanged `run_eval.py` (bwrap, no network, home hidden) is byte-identical to their `rsi_rerun.py` output, and run1 = run2 for both. [verified: cmp]

## Comparison (RSI Lab key, frozen snapshot, n=26)
| | v0.2 stand-in (10-18 first test) | **v0.3 stand-in** | v0.3, fetch(section from hit) | search.py |
|---|---|---|---|---|
| top-5 overall | 11/24 = 0.458 | **23/24 = 0.958** | 23/24 | 20/24 = 0.833 |
| MRR@5 | 0.375 | **0.794** | 0.794 | 0.628 |
| top-5 Chinese/mixed | 4/8 | **8/8** (MRR 0.738) | 8/8 | 6/8 |
| private leaks | 0 | **0** | 0 | 0 |
| superseded above right note | 1 | **0** | 0 | 1 |
| tokens total (est.) | 635,789 | **28,439** | 27,929 | 62,392 |
| tokens per answered q (est.) | 57,799 | **1,236** | 1,214 | 3,120 |
| top-5 hits per 1k tokens (est.) | 0.017 | **0.809** | 0.824 | 0.321 |
| Chinese tokens/answered (est.) | 38,250 | 1,234 | 1,235 | 2,393 |
| verdict (≥0.70, ≥0.50 zh, 0 leaks; guesses) | FAIL | **PASS** | PASS | PASS |

The token rule holds: per-answer tokens fall about 47× vs v0.2 and are 2.5× lower than search.py. Our harness calls `fetch(path)` with no section. In v0.3 that already returns a capped head (≤800 est. tokens), so passing the hit's section changes little (1,236 → 1,214). [verified: extra/run1/extra_summary.json]

## Independent key (Technical Reviewer, blind to our gold)
| | v0.3 | search.py |
|---|---|---|
| all answerable (n=28) | **27/28 = 0.964**, MRR 0.842 | 23/28 = 0.821, MRR 0.617 |
| Q01–Q26 core (n=24, "also:" alternates count) | 24/24, MRR 0.857 | 20/24 |
| **held-out Q27–Q30** (new Traditional Chinese, unseen by Claude 886) | **3/4**, MRR 0.75, 1,758 tok/answer | 3/4, MRR 0.425, 2,207 |
| Chinese (n=12) | 11/12 | 9/12 |
| tokens per answered q (est.) | 1,335 | 3,062 |
| traps Q25, Q26, T1, T2 (not in Brain) | 0 leaks; all 4 return 5 Brain notes (no abstention) | 0 leaks; T1 returns 0 results, the others return notes |

- **Q15** is a hit under the TR key: the alternate "offer page v1.2 done" is #1.
- **Q29 is missed by both engines.** The query is Chinese (建置費/月費) but the gold is the English "Paulo Decision — … intro pricing" note, so this is a cross-language gap.
- **Q25** returns John finance near-misses: a soft fail, as TR noted, not a leak. [verified: per_question_tr-plain-kw.json]
- **Raw-question variant** (the question typed as is, no keywords): v0.3 still gets 26/28. search.py drops to 3/28, because its AND rule plus `?` breaks FTS syntax. [verified: per_question_tr-plain-raw.json]
- **Q17 flag:** TR's primary 1GoAZYoL… (ON HOLD copy, about 09:19) post-dates the frozen snapshot. v0.3 hits only via the alternate 1CJcbgEq…, at rank 5. Its #1 is "Iango Anna sign-off ledger (superseded 2026-10-17 v3)": v0.3's superseded check is `\bSUPERSEDED\b`, case-sensitive, so it misses the lowercase "superseded". The snapshot was not re-synced. [verified: core.py is_superseded; per_question]

## Integrity and overfitting
- **Frozen files intact:** `sha256sum -c` passed on SHA256SUMS (23 files, including eval.json 7eca87e5…, run_eval.py 5616d034…) and on snapshot.SHA256SUMS (1,195 files). No file in the test folder outside rerun-v0.3/ changed after our SHA256SUMS. [verified]
- **Tested before → now:** our v0.2 stand-in = core.py at 362822b (sha f58e17a8…); v0.3 = 128bde0 (sha a776f4d2…), and the working tree matches 128bde0. [verified: git]
- **No network:** core.py and rsi_rerun.py have no socket, urllib or requests calls. rsi_rerun only spawns bwrap or python.
- **Writes:** rsi_rerun writes only under `--out` (it rmtrees and rebuilds `--out/harness`). It reads our folder and sha-checks it. core.py writes only in the write tools. [verified: read]
- Its own sandbox is weaker than ours (home dir not hidden, no pid namespace). We ran it inside our bwrap with `--no-bwrap` instead. [verified]
- **No per-question rules:** core.py has none of our qids, gold ids or query strings, only generic words. [verified: grep]
- **However, the tests are eval-informed.** Despite its "No eval questions … used" docstring, `tests/test_brain_mcp_retrieval.py` uses "paid seat allocation" (Q02's query), the query `驗收 付款 地名` (Q21 + Q20 terms) and a `2026-10-17 Brain lint report.md` decoy, which mirror our failure evidence. That is tuning toward the visible eval, not hard-coding. [verified: test file]
- The `--cjk-mode` ablation switch suggests settings were compared on the frozen eval [inferred]. Claude 886 could read our eval files on the box.
- **Held-out evidence:** on the 4 unseen questions v0.3 is 3/4 (same count as search.py, better rank). That is some support for generalisation, but n=4 is very small. [verified]
- **redact.local.txt:** present in `/workspace/brain-tools/brain_mcp/` (gitignored, 1 term loaded by rsi_rerun). It was absent from our harness copy (handle masking off). Outputs were identical either way. rsi_rerun copied it into `rerun-v0.3/theirs/*/harness/stand-in/` (box-only, not uploaded). [verified]

## Next fixes (named, not applied; each must pass the token rule)
1. Case-insensitive superseded detection, plus title suffixes like "(superseded …)" and "(SUPERSEDED by …)" (Q17 evidence).
2. Cross-language alias or keyword lines for English notes that Chinese queries target (Q29 evidence).
3. Recency or version awareness for "current/latest" (Q15 under our key).
4. An abstention signal (a low-score threshold) so not-in-Brain traps can return "not found".

## Worked / failed / worked around / still risky
- **Worked:** an independent rerun that matches theirs byte for byte; deterministic runs; the independent key and held-out set; frozen files verified.
- **Failed:** Q29 (both engines); no abstention on traps; lowercase-superseded miss; tiktoken still absent.
- **Worked around:** nested bwrap avoided (their script run with `--no-bwrap` inside our sandbox); RSI Lab wrote the keyword queries for Q27–Q30 and T1–T2 before any run (TR supplied questions only; `tr_key.json` sha256 e762367b…).
- **Still risky:** the stand-in is not BrainLink v1; n is small (4 held-out); eval-informed tests; the frozen snapshot is behind live Drive (Q17); token counts are estimates.
