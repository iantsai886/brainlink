---
ai_platform: Grok Bot
agent_or_role: RSI Lab
session_or_task_id: brainlink-v0.4-rerun-2026-10-18
written_at: 2026-10-18T10:06:00+08:00
source: "Box /workspace/brain-tools commits c5f85f5 + e4f042f (brain_mcp v0.4 core.py, rsi_rerun.py, tests incl. test_brain_mcp_eval_hygiene.py) diffed against 128bde0; RSI Lab frozen eval + snapshot; frozen tr_key.json (sha256 e762367b...) transcribed from Technical Reviewer key Drive 18GWLvZYO9ibCiKSo0NPxrDRGk3QAtzO-; prior notes Drive 1HFkwKn84wzrMRS-mxMMxu7APffjhDcDZ, 1F2LgJaoSw1tKg6hQVVigdTDe64PpqOkx; results in /workspace/rsi-lab/brainlink-rsi/test-2026-10-18/rerun-v0.4/"
confidence: medium
status: filed
---
Made by: RSI Lab (Grok Bot)

# BrainLink v0.4 rerun: independent check

**Qualifiers (verbatim):** offline, frozen snapshot, n=26 (RSI Lab gold) / n=32 (Technical Reviewer key: 28 answerable + 4 not-in-Brain), stand-in box brain_mcp v0.4 not the Mac BrainLink v1, gold by RSI Lab plus independent key by Technical Reviewer, token estimates (CJK ×1 + other chars ÷4; tiktoken not installed).

## Verdict
**Our run confirms Claude 886's numbers:** 23/24, Chinese 8/8, MRR 0.803, 0 leaks, 1,063 est. tokens per answer, Q15 missed. Our `run_eval.py` ran in our bwrap sandbox (no network, home hidden), twice, identically; their `rsi_rerun.py` ran twice inside our sandbox, also identically. The only difference is 1 token on Q22 (24,457 vs 24,458 total). Their run loads the operator handle list (1 term) and masks one handle; our harness copy has no list. [verified: cmp, per-row diff]

## Comparison (frozen snapshot)
| | v0.3 | **v0.4** | v0.4 always-on expansion | search.py |
|---|---|---|---|---|
| **RSI Lab gold (n=26)** top-5 | 23/24 | **23/24** | 23/24 | 20/24 |
| MRR@5 | 0.794 | **0.803** | 0.837 | 0.628 |
| Chinese top-5 (MRR) | 8/8 (0.738) | **8/8 (0.744)** | 8/8 (0.844) | 6/8 |
| leaks / superseded above right note | 0 / 0 | **0 / 0** | 0 / 0 | 0 / 1 |
| tokens total (est.) | 28,439 | **24,457** | 24,797 | 62,392 |
| tokens per answered q (est.) | 1,236 | **1,063** | 1,078 | 3,120 |
| top-5 hits per 1k tokens (est.) | 0.809 | **0.940** | 0.928 | 0.321 |
| same, fetch(section from hit): tok/answer | 1,214 | 1,045 | 1,038 | — |
| **TR key, keyword queries (n=28 answerable)** top-5 | 27/28 | **27/28** | 27/28 | 23/28 |
| MRR@5 | 0.842 | **0.849** | 0.878 | 0.617 |
| tokens per answered q / hits per 1k (est.) | 1,335 / 0.749 | **1,082 / 0.924** | 1,095 / 0.913 | 3,062 / 0.327 |
| held-out Q27–Q30 | 3/4 | **3/4** (Q29 missed) | 3/4 (Q29 missed) | 3/4 |
| traps abstained ("not in brain"), of 4 | 0 | **2 (T1, T2)** | 2 | — |
| **TR key, questions typed as written** top-5 | 26/28 | **22/28** | 22/28 | 3/28 |
| false "not in brain" on answerable questions | 0 | **5** (Q20 Q21 Q22 Q27 Q29) | 5 | — |

[verified: ours/out/run*/summary.json, extra/*/extra_summary.json]

## Held-out, traps, Q15, Q17
- **Q29 is still missed by v0.4 and by the always-on variant.** The lexicon contains 建置費 / 月費 / setup fee / pricing, yet the top hits are the Ansu discovery sheet and the offer page v1.2. Q27, Q28 and Q30 are hits at rank 1. [verified]
- **Abstention:** v0.4 says "not in brain" on TR's T1 (health numbers) and T2 (mortgage). It does **not** on our Q25 or Q26, which matches Claude 886's "never fires on our traps" only for our two. 0 leaks everywhere. [verified]
- **But abstention misfires on natural questions:** typed as written, 5 answerable Chinese/mixed questions come back "not in brain", so top-5 falls from 26/28 (v0.3) to 22/28. The 0.5 coverage threshold was set on a made-up vault and looks miscalibrated for full-sentence queries. [verified; inferred: cause]
- **Q15:** missed under our gold (the v1.2 page is not in the top 5). It is a hit under the TR key via the alternate "offer page v1.2 done" (#1).
- **Q17:** the frozen snapshot is kept, not re-synced. v0.4 ranks the alternate 1CJcbgEq… at #4, and the lowercase "(superseded …)" ledger is no longer #1, so the any-case fix works. TR's primary 1GoAZYoL… post-dates the snapshot. [verified]

## Always-on expansion verdict (token rule: tokens must not rise)
**Reject.** On our gold it adds no hits (23/24) and raises MRR (0.803 → 0.837). But tokens per answer rise 1,063 → 1,078 (+1.4%) and hits per 1k tokens fall 0.940 → 0.928. On the TR key, tokens per answer go 1,082 → 1,095 with the same 27/28, and it **does not fix Q29**, the case it was meant to test. Under section-fetch it is slightly cheaper (1,038 vs 1,045), but the rule is applied to the standard harness. [verified]

## Integrity and deletion findings
- Frozen eval files and snapshot: `sha256sum -c` OK (23 + 1,195 files).
- **rerun-v0.3/SHA256SUMS now fails for exactly 2 files**, both deleted by Claude 886: `theirs/t1/harness/stand-in/redact.local.txt` and `theirs/t2/harness/stand-in/redact.local.txt`. Everything else is OK and there are no new files. They were not restored (secrets). Another agent edited RSI Lab's folder; the removal was reasonable, but our hashes no longer verify. [verified: integrity.txt]
- **`/tmp/sim_c`:** owner `box` (all agents share it). It is a copy of the brain-tools tree, mtimes 07:27–09:46. Our HEARTBEAT, `/workspace/rsi-lab` and `/workspace/patrol` don't mention it, so it is not RSI Lab or patrol origin (inferred: a Claude 886 scratch copy). Its `redact.local.txt` is gone. [verified]
- **Code review (128bde0..e4f042f):** no network calls. `rsi_rerun.py` writes only under `--out` (it rmtrees and rebuilds harness/ and run/), and its sandbox is now stronger: unshare-all, cap-drop ALL, clearenv, /usr-only ro binds, one writable dir. The redact list is bind-mounted, never copied. No qids or gold ids in core.py. [verified]
- **Eval-hygiene test:** it reads our `eval.json` **and every `*key*.json`** under our folder (so TR's held-out questions in `tr_key.json` too), but only checks *test files*, not core.py constants or the lexicon. [verified]
- **Overfitting signal:** the "general" bilingual lexicon (225 terms) overlaps eval queries on generic words (decisions, daily, version, 付款, 合規, 風險, 會議, budget, 客戶, 每月). For **held-out Q29** it holds exactly 建置 / 建置費 / 月費 plus setup fee / pricing. Those are the terms our v0.3 note named as Q29's failure, and Q29's query sits in `tr_key.json`, readable on the box. So **Q27–Q30 can no longer count as held-out** [inferred]. The recency words (current/latest/newest) match Q15/Q17/Q18 phrasing, but they are generic. [verified overlap; inferred intent]

## Worked / failed / worked around / still risky
- **Worked:** an independent confirmation (1-token, explained difference); the superseded any-case fix; abstention on T1/T2; fewer tokens (−14% vs v0.3).
- **Failed:** Q29 (all variants); Q15 under our gold; false abstentions on raw questions (−4 hits); our v0.3 hash file is now broken.
- **Worked around:** their nested bwrap ran inside ours without changes. The always-on variant is a one-line local copy (`EXPAND_ONLY_IF_ABSENT = False`) and was not committed.
- **Still risky:** the held-out set is contaminated, so a fresh blind set is needed (new TR questions kept off the box). Abstention calibration needs real queries. The stand-in is not BrainLink v1. The frozen snapshot lags Drive. Token counts are estimates.
