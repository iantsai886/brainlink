---
ai_platform: Grok Bot
agent_or_role: RSI Lab
session_or_task_id: brainlink-rsi-offline-test-2026-10-18
written_at: 2026-10-18T09:35:00+08:00
source: "Paulo go-ahead 2026-10-18 (via parent); design note Drive 1dy5XTKZwrgrjmlNlN8SFXoWHpp0tTPHZ; Claude 886 competitor study Drive 1vnxtuRSoBRYOUuk_6DDCs2MmavPCd4z2; box /workspace/brain-tools (brain_mcp/core.py, search.py, index/brain.sqlite, cache/files, cache/lint_findings.json 2026-10-18T03:05); results in /workspace/rsi-lab/brainlink-rsi/test-2026-10-18/"
confidence: medium
status: filed
---
Made by: RSI Lab (Grok Bot)

# BrainLink RSI — first offline test (2026-10-18)

**Qualifiers (verbatim, apply to every number):** offline, local snapshot, n=26, stand-in code, gold by RSI Lab. Tokens are an **estimate** (tiktoken not installed: CJK chars ×1 + other chars ÷4). $0, no model calls, no installs, no vault or Drive edits except this note.

## Setup
- **Engine A = STAND-IN for BrainLink v1**: a copy of the box `brain_mcp` `core.py` (`BrainVault.search` + `fetch`). BrainLink v1 itself is Claude 886's productised iango-second-brain build on Ian's Mac (unreachable), so it was **not** tested. [verified: Paulo via parent; brain_mcp/README]
- **Engine B**: a copy of box `brain-tools/search.py` (FTS5 + trigram fallback) on a copy of `index/brain.sqlite`.
- **Snapshot**: of 1,414 cached files, the 1,194 that the current Drive listing marks as Brain were copied to real paths (0444/0555, Drive mtimes); 220 not in the listing were skipped; 2 path collisions renamed. [verified: snapshot_manifest.json]
- **Run**: inside `bwrap --unshare-net` (network check: `offline (OSError)`), home dir hidden, everything read-only but `out/`. Each query: top 5 + fetch of the top hit (A: `fetch`; B: the note at the hit's cache path, as its `read:` line tells an agent).
- **Eval**: BrainLink-Eval v0, 26 items, LongMemEval-style categories from the competitor study: single-fact 16, multi-note 2, temporal-latest 3, knowledge-update/superseded 3, abstention/private-trap 2; 8 Chinese/mixed. **Gold written by RSI Lab, not independent** (the design wanted an independent author). Frozen: `eval.json` sha256 `7eca87e5cc14e967a751295a516b69ab3e2579b085ca3e13642b1119cff01bef`. hit@5 and MRR@5 over the 24 answerable items; leaks over all 26.
- **Repeat**: run1 and run2 byte-identical (`per_question.json`, `summary.json`, `vault_baseline.json`). [verified: cmp]

## Results
| | A: brain_mcp (stand-in) | B: search.py |
|---|---|---|
| top-5 hit, overall | **11/24 = 0.458** | **20/24 = 0.833** |
| MRR@5, overall | 0.375 | 0.628 |
| top-5 hit, Chinese/mixed (n=8) | 4/8 = 0.50 | 6/8 = 0.75 |
| private leaks (n=26) | 0 | 0 |
| superseded note ranked above gold | 1 (Q16) | 1 (Q18) |
| tokens, total est. (search + top-hit fetch) | 635,789 | 62,392 |
| of which search results only | 9,915 | 15,105 |
| tokens per answered question (est.) | 57,799 | 3,120 |
| top-5 hits per 1,000 tokens (est.) | 0.017 | 0.321 |
| Chinese: tokens/answered, hits/1k (est.) | 38,250; 0.026 | 2,393; 0.418 |
| **Verdict** (≥0.70 overall, ≥0.50 zh, 0 leaks; thresholds are guesses) | **FAIL** (overall) | **PASS** |

By category, A / B: single-fact 9/16 / 15/16; multi-note 0/2 / 2/2; temporal-latest 1/3 / 1/3; knowledge-update 1/3 / 2/3.
**Leak caveat:** 0 leaks holds by construction (the snapshot and the FTS index have no private-vault files), so it doesn't test the access guards. The two traps did return Brain notes (not abstention). [verified: per_question.json]

## Vault metric baseline (lint report 2026-10-18T03:05 + snapshot)
Brain lint by check: required-fields 386, frontmatter-missing 121, duplicate-id 372, duplicate-title 277, stale-drive-locator 53, orphan 22. Lint headline: stale Drive locators 49, new missing-field errors 100, orphans 65. Snapshot: 1,163 `.md` notes, 123 with no frontmatter, 693 with all 7 standard keys, 454 `status: active`, of which 191 unchanged >30 days (stale by the design's rule). Unused notes and write rejects: **not measurable**, since the local path has no log. [verified: out/run1/vault_baseline.json]

## First fix (named, NOT applied): stop generated mega-notes from winning ranking in `core.search`
- **Evidence:** A missed 13 of 24. In **10** of them the #1 hit was a generated note: a Claude 886 Brain lint report (9: Q01 Q02 Q04 Q07 Q13 Q14 Q15 Q17 Q19) or `Grok/00 INDEX.md` (Q08). These notes are 86k–323k chars. `core.search` scores by **raw term count**, with no length normalisation. [verified: per_question.json, diag_engineA_misses.json, core.py]
- In the unchanged ranking at depth 50, removing generated notes (lint reports, 00 INDEX, 00 MAP, manifest summary, RUN_STATUS) puts the gold in the top 5 for 9 of those 10. **Counterfactual** (a filter on the unchanged output, not the fix): hit@5 0.458 → **0.833**, MRR 0.375 → 0.612, Chinese 0.50 → 0.75. [verified: counterfactual_skip_generated.json]
- **Proposed fix:** length-normalised (BM25-style, saturating) scoring, plus down-weighting or excluding generated report notes by path or frontmatter `generated_by`.
- **CJK segmentation is the second fix, not the first.** Only 2 misses are Chinese-specific: Q20 `月眉 越美 地名` and Q21 `威瑪舒培 驗收 付款` returned **0 results**. The cause is the strict all-terms AND (no single note holds every term), not tokenisation, because spaced CJK terms already match as substrings. Engine B's trigram/bigram-style fallback found Q21 at rank 4; both engines missed Q20. Proposed: a character-bigram OR fallback when AND returns 0. [verified: per_question.json; inferred: cause]
- Remaining A misses: Q10 and Q15 (strict AND on words like "why/instead", "current/version"). Q16 shows the SUPERSEDED note at #1 above the gold, which supports the study's "temporal supersede" item 1. [verified]

## Token rule (new, from Ian via Paulo)
**Any RSI fix must not raise the token cost:** est. tokens per answered question, and top-5 hits per 1,000 tokens, on this eval. Both are re-measured before and after, and the fix is rejected if either gets worse.
- Fix 1 check, **counterfactual**: tokens per answered question 57,799 → 8,602; hits per 1k tokens 0.017 → 0.116. **Passes the rule**, but it is still about 2.8× Engine B's 3,120, because `fetch` returns whole notes (up to 200k chars). Next token item (design only): a sectioned or capped `fetch` (head + matched section), checked under the same rule.
- Fix 2 (bigram OR fallback): **unverified**. It turns 2 zero-result answers (~1 token each) into a ~500-token result list plus a fetch, so it raises total tokens. It passes only if the hits it adds keep tokens per answered question flat or lower. It must be measured.

## Usefulness-reweighting hook (design note only, nothing built)
A slot in the ranking for a per-note usefulness weight from the future usage log (fetched-after-search, cited-in-write), following the competitor study's items 6 and 8 (fused ranking, feedback weights). Its guards come from the design (cap, decay, exploration, per-session dedupe, generated notes excluded). It is evaluated on this eval's held-out half under the token rule.

## What worked / failed / worked around / still risky
- **Worked:** an offline, deterministic run (identical twice), a frozen eval, a read-only snapshot, and a clear failure cause backed by depth-50 evidence.
- **Failed:** A (stand-in) FAIL at 0.458 overall. tiktoken is absent, so the token counts are estimates.
- **Worked around:** BrainLink v1 code is unreachable, so the stand-in was used. Generated mega-notes were kept in the snapshot because they are in the real vault. Engine B's "fetch" = reading the snapshot copy.
- **Still risky:** gold by RSI Lab (not independent); n=26 is small; the 220 cached files outside the listing were excluded; the leak test is trivial by construction; the token estimate can be off by tens of percent for mixed text; real BrainLink v1 may rank differently.

Files: `eval.json`, `run_eval.py`, `build_snapshot.py`, `diag_*.py`, `vault_baseline.py`, `out/run1|run2/`, `SHA256SUMS`, `prefile-check.log`.
