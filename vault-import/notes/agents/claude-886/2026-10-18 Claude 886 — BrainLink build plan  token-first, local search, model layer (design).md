---
title: "2026-10-18 Claude 886 — BrainLink build plan: token-first, local search, model layer (design)"
type: design
status: proposed
owner: Claude 886
ai_platform: Grok Bot
agent_or_role: Claude 886
session_or_task_id: brainlink-buildplan-1018
written_at: 2026-10-18T09:40:00+08:00
source: Paulo merged research (Drive 1cl2jY8H3lEq_mnKf1Nh9l_bBWhzxMMg6); Claude 886 REA study (Drive 1vnxtuRSoBRYOUuk_6DDCs2MmavPCd4z2); public web with URLs inline; box prototype brain_mcp (phone profile)
confidence: medium
tags: [brainlink, design, token-efficiency, local-search, fts5, jieba, bge-m3, reranker, rrf, model-routing, byok, keychain, agent-memory-repo, rsi]
aliases: ["BrainLink build plan 1018", "BrainLink token-first design", "BrainLink local search design", "BrainLink model layer design"]
---
Made by Grok Bot (Claude 886).

# BrainLink build plan: token-first answers, local search, model layer (design)

**Status.** This is a design only. The BrainLink v1 source on the Mac isn't reachable yet. Anything that depends on v1 internals is tagged **[confirm once Mac connected]** and collected in §6.

**Inputs.**
- Paulo's merged research, top-10 items #1–#3 (Drive 1cl2jY8H…). This plan implements those three.
- Claude 886's REA study (Drive 1vnxtuRS…).
- The box prototype `brain_mcp`. Its phone profile has 6 tools: `search`, `fetch`, `map`, `recent_changes`, `create_note`, `append_section`.

**Rules.**
- No AGPL or GPL code copied.
- No purchases.
- Every library named below has its licence checked through the GitHub or Hugging Face APIs on 2026-10-18.
- Estimates are marked **[E]**. Anything not confirmed from a primary source is marked **[U]**.

**Design principle.**
- Don't add tools. All three features extend the *same* six tool names with optional parameters. Search, fetch and map need **no model call**.
- This addresses IBM failure mode F3 (too many tools: 46 failed, 19 passed; Brain note "Intake — IBM Technology — Context Engineering 4 Failure Modes", from https://www.youtube.com/watch?v=BwXremQ-i6I).

---

## 0. Agent Memory Repo: what it is, and the verdict

**What it is.** An open spec for agent memory stored as a **git repo of Markdown**.
- **Entry point.** A required `MEMORY.md`, loaded at the start of every session and kept short. It holds the always-needed entries plus an `## Index` of `[[path]]` links.
- **Entries.** One bullet per line, with optional `[key: value; …]` metadata. The recommended keys are `source` and `added: YYYY-MM-DD`.
- **Links.** `[[path]]` links are resolved from the memory root.
- **Loop.** Clone, search or follow links, update ("no human in the loop"), then push after every edit.
- **Dreaming.** A periodic job adds patterns, merges duplicates, removes outdated entries and checks sources.
- **Composability.** Multiple repos can be loaded side by side.
- Sources: https://cognition.com/agent-memory-repo and https://github.com/AgentMemoryRepo/agentmemoryrepo (SPEC.md).

| Item | Finding |
|---|---|
| Spec URL | https://cognition.com/agent-memory-repo ; https://github.com/AgentMemoryRepo/agentmemoryrepo (README + SPEC.md) |
| Maintainers | Cognition, the company behind Devin. "Originally developed by Cognition and released as an open standard" (README, quoted at https://reveneau.com/ainews/cognition-agent-memory-repo-git-markdown-devin-spec-274-stars). All commits so far are from Cognition staff and Devin bots (GitHub commits API) |
| Launch | Repo created 2026-10-04. Announced with Devin Memory + Dreaming on 2026-10-05 (https://devin.ai/blog/memory-and-dreaming) |
| Licence | **MIT** (GitHub API) |
| Adoption | 801★, 38 forks, last push 2026-10-06 (GitHub API, 2026-10-18). Star growth peaked on 10-05 and 10-06 and is "cooling" (https://gitnova.dev/en/r/AgentMemoryRepo/agentmemoryrepo; https://trendshift.io/repositories/283908). The README names only Devin and Claude-compatible agents as skill targets. **No other vendor has adopted it natively** (reveneau, above). Devin itself uses it in production as the "Memory Drive" (devin.ai blog) |
| Maturity | **Early, version 0.** The spec is about one page. It has **no YAML frontmatter, no schema version, no validity or supersede field, and no conflict semantics beyond git** (independent read: https://ai.thesatyajit.com/articles/agent-memory-repo). The Dreaming implementation is described but not released (same source). Devin's hosted version adds a revision check that rejects stale writes and surfaces conflicts (devin.ai blog) |

**Verdict: LATER, and yes as an adapter, not as our native format.**
- Ship **read and export support after the 10-27 model layer**: target the 10-28 to 11-01 window, effort S.
- Don't change the vault to this format.

Reasons:
1. **Cheap fit.**
   - Our MAP/INDEX is already a short entry point plus an index of links, so generating a `MEMORY.md` from the MAP is roughly a day of work [E].
   - `[[path]]` links match Obsidian wikilinks.
   - `source`/`added` map onto our frontmatter `source`/`written_at`.
2. **Upside.** "BrainLink speaks Agent Memory Repo" lets Devin, and any agent using Cognition's skill, read Ian's Brain with no MCP. It's also a cheap compatibility line for sales (Paulo's merged top-10 #9).
3. **Why not native.**
   - The spec has no frontmatter, no supersede or validity fields and no approval step. Those are BrainLink's core safety features: SUPERSEDED, stable ids, hash-checked promotion, propose-then-approve.
   - Its loop is explicitly "no human in the loop", which conflicts with Technical Reviewer's per-write approval rule.
   - It is 2 weeks old with a single maintainer, so it may still change.
4. **Why not now.** Items (a), (b) and (c) below are Ian's top 3 and do more for token cost and Chinese search. AMR can wait a week with no loss.

**Adapter shape (pattern only, written in our own words):**
- `brainlink export --format amr <vault> <out_dir>`. Writes `MEMORY.md` from the MAP: the top entries, then `## Index` with links. It copies non-private, non-SUPERSEDED notes and appends `[source: …; added: …]` to bullets where frontmatter has them. It **runs through upload_gate-style redaction first** and **never exports private vaults**.
- `brainlink import --format amr <repo>`. Reads AMR bullets as **proposals** into the inbox and never writes them directly.

---

## (a) Token-first answers (due 2026-10-22)

**Goal.** Answer from the smallest unit that works, in this order: **MAP slice → snippets → one section → full note**. Every response carries a token count, and a miss gets a one-line "not in brain" instead of weak hits.

**Why.**
- Paulo's baseline estimate is about 8–12k input tokens per question with a "search then fetch 5 full notes" pattern, and the target is about 1.5–2.5k [E] (Paulo §3).
- LongMemEval shows that weak retrieval and long reads hurt accuracy, and it treats abstention as a core memory ability (https://arxiv.org/abs/2410.10813).
- Zep reports about 1.6k context tokens against 115k for full context, at higher accuracy (https://arxiv.org/abs/2501.13956).

### a.1 Token counting
- Use a local tokenizer estimate. `tiktoken` (MIT, https://github.com/openai/tiktoken) with the `o200k_base` encoding serves as a model-neutral proxy.
- Report it as `tokens_est`, not as billing truth.
- Don't use a chars/4 rule. CJK text is far denser in tokens per character than English [E]. That's why the estimate must use a real tokenizer, and why the mixed zh/en tests in (b) measure it.

### a.2 API shapes (the same 6 tools, extended)

The 6 tools are `map`, `search`, `fetch`, `recent_changes`, `create_note` and `append_section`. Only the first three change here, and only with optional parameters, so the change is backward-compatible. All responses include a `meta` block.

```text
map(topic?: str, max_tokens: int = 800)
  -> { entries: [{title, path, status, updated, one_line}], truncated: bool,
       meta: {tokens_est, cap, source: "MAP"} }
  # topic=None returns the hub; topic="BrainLink" returns that MAP section only.

search(query: str, k: int = 5, max_tokens: int = 600,
       mode: "auto"|"keyword"|"hybrid" = "auto",
       include_superseded: bool = false)
  -> { status: "hits" | "not_in_brain",
       hits: [{path, title, heading, snippet (<=200 chars, max 2 per hit),
               score, status, updated, superseded_by?}],
       suggest?: [map titles],            # only when status = not_in_brain
       meta: {tokens_est, cap, mode_used, latency_ms, index_rev} }

fetch(path: str, section?: str,            # heading text or anchor
      max_tokens: int = 1500,
      expect_hash?: str)                   # reuses hashguard for read-consistency
  -> { path, section_used, content, truncated: bool, next_section?: str,
       hash, status, updated, superseded_by?,
       meta: {tokens_est, cap} }
```

**Answer protocol.** This goes in the server `instructions` string, which is under 120 tokens:
1. Call `map(topic)` if the question names a known area.
2. Otherwise call `search(query)` and read the snippets. If they answer the question, stop.
3. Else call `fetch(path, section=heading_of_best_hit)`.
4. Fetch the full note (`fetch(path)` with no section) only if the section points elsewhere. That fetch is still capped by `max_tokens` and offers `next_section`.

**Caps.**
- The server caps every response at its `max_tokens`. A hard server ceiling of 4,000 tokens per call applies even if the client asks for more.
- A **per-answer budget** of 3,000 tokens by default is tracked per MCP session: the sum of map, search and fetch tokens between two user turns. A client can't see user turns, so the server approximates a turn as calls less than 20 s apart [E]. When the budget is spent, `search` and `fetch` return `budget_exhausted` with the best path so far.

**"Not in brain".**
- If the top fused score is below a threshold and no keyword hit exists, `search` returns `status: "not_in_brain"` and up to 3 MAP titles as `suggest`. The response stays under 60 tokens.
- The threshold is tuned on the eval set (a.4). It starts as RRF top score < 0.02 *and* BM25 hits = 0 [E].

**Supersede.**
- Default results hide SUPERSEDED notes and notes with frontmatter `status: superseded|retired|deprecated|replaced|obsolete`. This reuses brain-tools' existing SUPERSEDED filter.
- If a hidden note was the best match, the response includes `superseded_by` so the AI follows the live note. This addresses F4, conflicting info.

### a.3 Metric: tokens per answer
- Each call is logged locally, outside the vault, as `{ts, tool, tokens_est, cap, status, latency_ms, session_id_hash}`. There are **no query texts or contents** in the log, matching the audit-log rule.
- Nightly rollup: the p50 and p90 of **tokens per answer**, the not_in_brain rate, budget_exhausted count, and the share of answers resolved at the snippet, section or full level.
- The rollup feeds the Brain Health panel and the RSI loop (Paulo §6, RSI Lab's metrics). An RSI config change must **not raise** p50 tokens per answer.

### a.4 Acceptance tests (due 10-22, run in CI and nightly)

| # | Test | Pass condition |
|---|---|---|
| A1 | `search` on 20 known-answer questions | Every response is ≤ its `max_tokens`, and `meta.tokens_est` is present |
| A2 | Snippet sufficiency | ≥ 50% of the 20 questions are answerable from snippets alone (human-labelled once) [E target] |
| A3 | Section fetch | `fetch(path, section=h)` returns only that heading's block, and `next_section` is set when there is more |
| A4 | Cap enforcement | `fetch` of a 6k-token note with `max_tokens=1500` gives `truncated=true` and ≤ 1,500 tokens (±5%) |
| A5 | Not in brain | 10 questions with no answer in the fixture vault give `status=not_in_brain` and ≤ 60 tokens, with ≤ 1 false abstention across the 20 known-answer questions |
| A6 | Supersede | A fixture pair (old marked SUPERSEDED, new live) returns only the new note by default and includes `superseded_by` when the old note was the better lexical match |
| A7 | Budget | 4 rapid calls totalling more than 3,000 tokens make the 4th return `budget_exhausted` |
| A8 | Tokens per answer | Over the 20 questions, p50 is ≤ 2,500 using the answer protocol, against a recorded baseline of "search + 5 full fetches" |
| A9 | No-model guarantee | The tests pass with the network disabled and no model backend configured |
| A10 | Privacy | `upload_gate`-style redaction on all responses gives 0 findings for the Brain fixture |

The fixtures are a synthetic vault of about 60 notes with no private data, plus a frozen, hashed question set. This follows the "one agent + acceptance tests" rule from the agent-teams note.

---

## (b) Local search with no model call (due 2026-10-25)

**Pipeline.**

```text
query ─► normalize (NFKC, lower, zh-Hant→zh-Hans map for matching only)
      ─► [1] keyword: FTS5 (jieba-segmented column, BM25)  ┐
      ─► [2] keyword: FTS5 trigram column (substrings ≥3)  ├─► RRF fuse ─► MAP boost ─► (optional) rerank top-30 ─► snippets
      ─► [3] dense: bge-m3 vectors (local, ONNX int8)       ┘
```

None of the stages calls an LLM. Embedding happens **at index time**: a query embedding is one local forward pass on CPU, which isn't a model API call.

### b.1 Keyword index: SQLite FTS5 vs tantivy

| | SQLite FTS5 | tantivy |
|---|---|---|
| What | Full-text extension built into SQLite, with BM25 ranking and built-in `unicode61`, `ascii`, `porter` and `trigram` tokenizers (https://www.sqlite.org/fts5.html) | A Rust search engine library in the style of Lucene, MIT, 16k★ (https://github.com/quickwit-oss/tantivy; GitHub API) |
| Chinese | Two options. (1) Pre-segment the text with jieba in the app and store space-joined tokens in a `unicode61` column. (2) Use the `trigram` tokenizer for substring match. **The trigram tokenizer can't match substrings shorter than 3 characters** (FTS5 docs), and most Chinese words are 2 characters, e.g. 店長 or 記憶, so trigram alone is not enough | The `tantivy-jieba` tokenizer, MIT (https://github.com/jiegec/tantivy-jieba) |
| Ops | One file, already used for metadata, zero new runtime. Python, Node and Rust all have bindings | Separate index directory. Native from Rust; Python via `tantivy-py` [U: version not checked] |
| Pick | **Default.** A jieba column plus a trigram column, with a fallback `LIKE` scan for 1–2-character queries on a small vault (<5k notes). Same SQLite file as the vector table | Revisit only if vaults over 50k notes make FTS5 slow [E], or if v1 is Rust **[confirm once Mac connected]** |

There is also the `wangfenjin/simple` SQLite FTS5 tokenizer extension, with jieba and pinyin built in. Its licence is a **dual MIT-or-GPL-3.0** choice, so the MIT option is usable (https://raw.githubusercontent.com/wangfenjin/simple/master/LICENSE; https://github.com/wangfenjin/simple). It adds a native extension per OS, so pre-segmenting in the app is simpler for v1.

### b.2 Chinese segmentation compared

Ian writes Traditional Chinese, Taiwan usage, mixed with English.

| Tool | Licence | Status | Traditional Chinese | Notes | Use? |
|---|---|---|---|---|---|
| **jieba** (Python) | MIT (https://github.com/fxsjy/jieba) | 35k★; last push 2024-08 (stale but stable) | The default dictionary is Simplified. A larger `dict.txt.big` dictionary is offered for better Traditional coverage, and `cut_for_search` gives fine-grained tokens for indexes (README) | Dictionary plus HMM for unknown words; custom user dictionary | **Yes, default.** Use `dict.txt.big` and a user dictionary of vault titles and aliases |
| **jieba-rs** | MIT (https://github.com/messense/jieba-rs) | Active (push 2026-10-15) | Same dictionaries | A Rust port, much faster [U: no benchmark checked]; good if v1 is Rust or Node via bindings | Yes, if v1 isn't Python **[confirm once Mac connected]** |
| **OpenCC** | Apache-2.0 (https://github.com/BYVoid/OpenCC) | Active | Traditional ↔ Simplified conversion | Normalizes zh-Hant to zh-Hans *for the index only*, so Simplified-trained dictionaries and queries in either script match. The stored text is unchanged | **Yes**, as a normalizer |
| pkuseg | MIT (https://github.com/lancopku/pkuseg-python) | Last push 2022 | Simplified-domain models | Higher accuracy in papers, but heavier and stale | No |
| HanLP | Apache-2.0 (https://github.com/hankcs/HanLP) | Active | Yes | Neural, heavy dependencies; overkill for indexing | No (maybe later) |
| THULAC | MIT label, but the README says **commercial use requires a licence by email** (https://github.com/thunlp/THULAC-python) | Stale | — | Licence risk for a paid product | **No** |
| **CKIP tagger / ckip-transformers** | **GPL-3.0 ⚠** (https://github.com/ckiplab/ckiptagger; https://github.com/ckiplab/ckip-transformers) | — | Best-known Taiwan Traditional segmenter | GPL is incompatible with a closed paid build | **No (GPL)** |
| SQLite trigram | Public domain (SQLite) | Built in | Script-agnostic | Misses queries under 3 characters | Yes, as the second column only |

### b.3 Local embeddings: bge-m3

**Facts.**
- Multilingual (100+ languages), with dense, sparse and multi-vector (ColBERT) outputs from one model.
- Input up to **8,192 tokens**, 1,024-dimensional dense vectors.
- **MIT** licence. Source for all of these: https://huggingface.co/BAAI/bge-m3 (card, HF API).

**Size.**
- About 568M parameters [U: from the XLM-R-large base; the card lists the base, not the count].
- The fp32 weights are **2.27 GB**. The official repo ships an ONNX export (`onnx/model.onnx_data`, 2.27 GB) (HF API file list).

**Quantized options.**
- fp16 ONNX at **1.13 GB**, and int8 ONNX at **568–570 MB**: `model_int8.onnx` and `model_quantized.onnx` in https://huggingface.co/Xenova/bge-m3/tree/main/onnx.
- A community int8 build exports dense, sparse and ColBERT outputs at once: https://huggingface.co/gpahal/bge-m3-onnx-int8 (MIT).

**Quality of int8.** Zilliz's memsearch benchmark (955 chunks, 2,172 bilingual queries) measured int8 ONNX at about **1% lower recall** than fp32 (zh Recall-at-5 0.776 vs 0.783). It needs only `onnxruntime` (about 200 MB of dependencies, no torch) and runs CPU-only. In that benchmark it **beat OpenAI text-embedding-3-small on Chinese**, while English-centric Ollama embedders collapsed on Chinese (zh Recall-at-5 < 0.40). Source: https://zilliztech.github.io/memsearch/home/embedding-evaluation/

**CPU and RAM.**
- About 1–1.5 GB RAM for int8 inference at normal batch sizes [E, consistent with the search summary of the HF cards]. The fp32 model needs about 3 GB or more [E].
- Indexing speed on a laptop CPU is roughly tens of chunks per second at 512 tokens [E, **measure on the Mac**]. A vault of about 1,500 notes, or about 6k chunks, indexes once in minutes, and after that only changed files are re-embedded (hashguard).

**Chunking.**
- Split by heading, 300–500 tokens per chunk, with the note title and heading prepended to each chunk. The title-prepending is key expansion, which raised recall in LongMemEval §5.3 (https://arxiv.org/abs/2410.10813).
- Store chunk vectors in the same SQLite file (a float32 blob plus brute-force cosine). That is fine below about 50k chunks [E]. `sqlite-vec` is an option later [U: licence not checked today].

**Sparse output.** bge-m3's sparse weights can serve as a learned-BM25 signal at no extra cost (card). Treat it as optional channel [4] after v1.

### b.4 Optional reranker: bge-reranker-v2-m3
- A cross-encoder built on bge-m3, multilingual, "lightweight … fast inference" per BAAI's table. **Apache-2.0**. The safetensors weights are 2.27 GB (https://huggingface.co/BAAI/bge-reranker-v2-m3; HF API).
- Use it only on the top 30 fused candidates. It's off by default on laptops and on by default on the Nvidia box.
- Serving options:
  - In-process via ONNX: quantize it ourselves with `optimum` (the same approach as the int8 bge-m3 builds) [U: no official int8 reranker found today].
  - llama.cpp server with `--reranking` (https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).
  - vLLM `/v1/rerank` (https://docs.vllm.ai/en/latest/models/pooling_models/scoring/). A **vLLM CPU crash with this exact model was reported** in issue https://github.com/vllm-project/vllm/issues/24319, so don't rely on vLLM for CPU reranking.
- Expected cost: about 0.5–2 s for 30 pairs on a CPU [E, measure].

### b.5 Fusion and MAP boost
- **RRF.** score(d) = Σ over channels of 1 / (k + rank_c(d)), with k = 60. This is Reciprocal Rank Fusion (Cormack, Clarke & Büttcher, SIGIR 2009, cited as [20] in https://arxiv.org/abs/2501.13956). Channels: jieba-BM25, trigram-BM25 and dense. Each channel contributes its top 50.
- **MAP boost.** Multiply the fused score by 1.25 if the note is linked from the MAP or INDEX hub, and by 1.10 if it was updated in the last 30 days [E: starting weights].
  - SUPERSEDED notes are dropped before fusion.
  - The weights are **RSI-tunable config**: changes are A/B-tested on the held-out half of the eval, and a change must not lower hit-at-5 or raise tokens per answer (Paulo §6).
- **Rerank.** If enabled, rerank the top 30 and then build snippets.

### b.6 Acceptance tests, mixed zh/en (due 10-25)

The fixtures are about 80 synthetic notes: 40% Traditional Chinese, 30% English and 30% mixed within a sentence. They include 2-character Chinese terms, product names in English inside Chinese sentences, and a few Simplified-script notes. The question set is frozen and hashed.

| # | Test | Pass condition |
|---|---|---|
| B1 | 2-character Chinese term (e.g. 記憶) | The correct note is in the top 3, which proves the jieba column works where trigram can't |
| B2 | Query script mismatch: a Simplified query against a Traditional note, and the reverse | The correct note is in the top 5 (OpenCC normalization) |
| B3 | Mixed query: an English term in a Chinese sentence (e.g. 「BrainLink 的 token 上限」) | The correct note is in the top 3 |
| B4 | Semantic paraphrase with no shared keywords (zh query, en note, and the reverse) | The correct note is in the top 5 through the dense channel |
| B5 | Overall | hit-at-5 ≥ 0.85 and MRR ≥ 0.6 on 60 questions [E targets; record the baseline from the current keyword scan first] |
| B6 | Supersede | A SUPERSEDED note never appears in the top 5 by default |
| B7 | Not in brain | 10 unanswerable zh and en questions give `not_in_brain`, with ≤ 1 false abstention |
| B8 | Latency | On a laptop CPU, with the reranker off: p50 ≤ 150 ms and p95 ≤ 400 ms for search over 2k notes [E]. With the reranker on: p95 ≤ 2.5 s |
| B9 | No network | Everything passes offline, with models pre-downloaded and no API keys present |
| B10 | Incremental index | Editing one note re-embeds only its chunks (verified by hash), and the index revision increments |
| B11 | Private vaults | Private vaults are indexed only in their own separate index file, never merged into the Brain index |

---

## (c) Model layer (design only, due 2026-10-27)

**Scope.** Models serve **background jobs only**: summaries and tags, dedup and merge proposals, the consolidation "dream", the RSI eval judge, and an optional answer tool. **The hot path (search, fetch, map) never calls a model.** Embeddings and rerank run in-process (b.3, b.4) and can optionally be served by the local backend.

### c.1 Three backends, one interface

All backends speak the OpenAI-compatible `/v1/chat/completions` and `/v1/embeddings`. Config is one list of backends: `{id, kind: local|cheap|premium, base_url, model, key_ref, region, trains_on_data, zdr}`.

| Backend | Option | OpenAI-compatible evidence | Notes |
|---|---|---|---|
| Local | **Ollama** (MIT, https://github.com/ollama/ollama) | `http://localhost:11434/v1/chat/completions` (https://raw.githubusercontent.com/ollama/ollama/main/docs/api/openai-compatibility.mdx) | Easiest install on Mac and Windows. **Default local** |
| Local | **llama.cpp server** (MIT, https://github.com/ggml-org/llama.cpp) | OpenAI-compatible chat, responses and embeddings routes, plus a reranking endpoint (server README, above) | Lightest; good for the reranker |
| Local | **LM Studio** | `http://localhost:1234/v1`, with `/v1/chat/completions` and `/v1/embeddings` (https://lmstudio.ai/docs/developer/openai-compat) | GUI for non-developers. Proprietary app [U: licence terms not reviewed] |
| Local | **vLLM** (Apache-2.0, https://github.com/vllm-project/vllm) | `/v1/chat/completions`, `/v1/embeddings`, `/v1/rerank` (https://docs.vllm.ai/en/latest/serving/online_serving/) | Best on the Nvidia box (Linux, GPU). macOS CPU support is **experimental, build from source** (https://docs.vllm.ai/en/latest/getting_started/installation/cpu/) |
| Cheap API | qwen-flash, glm-flash, deepseek-flash, or OpenRouter with ZDR | Prices and privacy in Paulo §4.1 (Drive 1cl2jY8H…), not re-checked here | Shareable vaults only |
| Premium API | Claude, GPT or Gemini with the user's own key | Prices not re-checked | Hard jobs only, with approval |

### c.2 Routing rules (evaluated in order; the first match wins)
1. **Privacy hard rule.** If a vault is tagged `privacy: private` (Personal, Livva, journals), the job goes to **local only**. If local is down, **queue the job; never fall back to an outside API.** The only override is per vault, with typed confirmation, and it's logged. The default is off.
2. **Hot path.** Search, fetch and map use no model.
3. **Task type.**
   - Embeddings, rerank, tags, summaries and dedup candidates go to **local**.
   - Consolidation proposals and the RSI judge go **local first, then cheap API**, for shareable vaults only.
   - Conflict adjudication on key notes and monthly audits go to **premium, with a per-job cost preview and human approval**.
4. **Token cost.** Estimate input and output tokens before each call. If the estimate is over the job's cap (defaults: 20k for a cheap call, 50k for a premium call [E]), split or batch the job, or ask first.
5. **Provider allow-list.** Default outside providers are only those with no-training or ZDR terms (Paulo §4.1). Providers whose terms permit training or keep data in other jurisdictions are off by default.
6. **Pre-call gate.** Before any outside call, run the same secret, PII and account-handle redaction as `upload_gate`. If it finds anything, the call is refused and logged.

### c.3 Fallback
- **Local.** On a timeout or health-check failure, retry once after 2 s, then mark the backend down for 5 minutes.
- **Shareable vault.** Fall back to the next allowed backend of the same or a cheaper class. Never escalate to premium automatically.
- **Private vault.** Queue the job and report "waiting for local model" in the nightly status.
- **Budget exhausted.** Stop cleanly and keep a resume watermark (the Cognee `improve` pattern, https://docs.cognee.ai/core-concepts/main-operations/improve). The next run resumes there.
- **Every fallback is logged** with `{job, from, to, reason}`.

### c.4 User keys (BYOK) stored in the OS keychain only
- **Stores:** macOS Keychain, Windows Credential Manager, and libsecret/Secret Service on Linux.
- **Libraries (pick by v1's language, [confirm once Mac connected]):**
  - Python `keyring`, MIT, which covers macOS Keychain, Windows Credential Locker/Manager, Freedesktop Secret Service and KWallet (https://github.com/jaraco/keyring; PyPI licence MIT).
  - Rust `keyring` crate, Apache-2.0, active (https://github.com/open-source-cooperative/keyring-rs).
  - **Avoid `node-keytar`, which is archived** (https://github.com/atom/node-keytar, archived 2022-12).
- **Rules:**
  - Config holds only `key_ref` (service = `BrainLink`, account = backend id), never the key itself. Keys never go in the vault, Drive, logs, crash reports or env files.
  - The UI shows only the last 4 characters.
  - A "Test" button makes a 1-token call.
  - Removing a backend deletes its keychain item.
  - On a headless Linux system with no Secret Service, refuse to store and tell the user why. **Don't fall back to a file.**

### c.5 Cost meter
- Per call, log `{ts, backend, model, job, tokens_in, tokens_out, cached_in?, usd_est, vault_class: shareable|private, status}`, with no prompt or response text.
- The price table is a versioned local JSON with the date each price was checked. Paulo §4.1 prices are the seed, and the user can edit them.
- Caps: a monthly cap per provider (default US$5) and a nightly token cap. At 80% the meter warns, and at 100% it stops (c.3).
- Reporting: the Brain Health panel shows today, the month so far, tokens per answer (from a.3) and outside spend. The weekly digest has a 5-line summary.

### c.6 Acceptance tests (design-level; implement after 10-27)
- **C1.** A private-vault job with local down is queued, and there are 0 outside calls (verified by a mock server receiving nothing).
- **C2.** A secret in a prompt makes the gate refuse the outside call.
- **C3.** A key is stored and read through the keychain, and a grep of the config dir finds no key bytes.
- **C4.** A cheap backend timing out falls back to the next allowed cheap one and never to premium.
- **C5.** The monthly cap stops calls at 100% and a resume watermark is written.
- **C6.** The cost meter's sum matches mocked usage within 1%.

---

## 5. Schedule

| Date | Deliverable |
|---|---|
| 10-20 | Fixtures (a.4/b.6) and a baseline run on the current keyword search |
| **10-22** | (a) token-first: map/search/fetch params, caps, not_in_brain, metric; A1–A10 green |
| 10-23 to 10-24 | (b) FTS5 jieba + trigram columns and the OpenCC normalizer; B1–B3, B6, B7, B9 |
| **10-25** | (b) bge-m3 int8 dense channel, RRF + MAP boost, optional reranker; B1–B11 green |
| **10-27** | (c) model-layer design frozen: config schema, router rules, keychain choice, cost meter; C1–C6 written as tests |
| 10-28 to 11-01 | Agent Memory Repo export/import adapter (verdict: later) |

Dates assume the v1 code is reachable by about 10-20. If the Mac isn't connected, (a) and (b) are built in the box prototype `brain_mcp` and ported afterwards.

## 6. Open questions that need the v1 code [confirm once Mac connected]
1. **Does v1 already have semantic or meaning-based search?** Paulo's matrix says "keyword scan; CJK weak", but that came from RSI Lab's read of the box `brain_mcp`, not v1.
2. v1's language and runtime (Python, Node/TS or Rust). This decides jieba vs jieba-rs, the keyring library, FTS5 bindings and ONNX runtime packaging.
3. v1's tool names and count per profile, and whether `search`/`fetch` already take a section or limit parameter. The rule is to keep tool count ≤ 6 for phone and default.
4. Does v1 already store an index (SQLite?) or scan files per query? Where should the index file live, and is it per vault?
5. How v1 represents SUPERSEDED and frontmatter status today, and whether it uses the brain-tools filter or its own.
6. Do v1's write paths (preview, signature, secret filter) already compute content hashes we can reuse for incremental embedding?
7. The installer and packaging story (notarised Mac app or Python wheel), and whether shipping a 570 MB model download on first run is acceptable to the Setup page.
8. Does v1 already have any model calls or API-key handling that must move to the keychain?
9. The licence-signing code path, which must stay out of any reviewer copy and away from model prompts.
10. Whether v1 already exposes `MEMORY.md` or an equivalent hub that an Agent Memory Repo export can reuse.

## Changelog
- 2026-10-18T09:40+08:00: v1.0 created by Claude 886 (Grok Bot). Agent Memory Repo verdict (later, as an adapter); designs for (a) token-first answers, (b) local search, (c) the model layer; schedule; open questions. Task brainlink-buildplan-1018.
