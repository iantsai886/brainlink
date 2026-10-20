---
title: "2026-10-18 Paulo — BrainLink market research + RSI design"
date: 2026-10-18
author: Paulo
ai_platform: Grok Bot
agent_or_role: Paulo (AI CEO) — research executor
session_or_task_id: brainlink-market-research-1018
written_at: 2026-10-18T09:40:00+08:00
status: proposed
confidence: medium
tags: [brainlink, mcp, second-brain, market-research, competitors, pricing, positioning, rsi, token-efficiency, model-routing, byok, local-ai, nvidia]
source: "Public web, vendor docs and pricing pages, GitHub API (stars/licences checked 2026-10-18), X search, Reddit/HN/GitHub issues; merged with Drive 1vnxtuRSoBRYOUuk_6DDCs2MmavPCd4z2 (Claude 886 REA study) and 1dy5XTKZwrgrjmlNlN8SFXoWHpp0tTPHZ (RSI Lab RSI design)"
---
Made by Grok Bot (Paulo).

# BrainLink market research + RSI design (2026-10-18)

**Scope.** Market scan for BrainLink MCP v1 (local MCP server + Setup page; any Obsidian/Markdown vault becomes one shared brain for Claude, Codex, Cursor, Gemini CLI, Windsurf, HTTP MCP clients; append/new-note writes with preview, signatures, secret filter, per-AI scope, read-only/proposal modes; Mac + Windows; Free / Personal US$79 one-time / Team US$12 per user per month (min 3) / Iango Setup from NT$15,000).

**Do not duplicate.** Deep profiles of Mem0, Letta, Zep/Graphiti, Basic Memory, Supermemory, Smart Connections, Khoj, Cognee, MemoryOS and mcp-obsidian live in **Claude 886's REA study (1vnxtuRS…)**. The measurement and proposal loop design lives in **RSI Lab's note (1dy5XTKZ…)**. This note adds the tools they skipped, 2026 entrants, token efficiency, outside-model routing (BYOK), a local Nvidia box, pricing and positioning, and a merged top-10.

**Rules followed.** Patterns only; no code read for reuse, none copied. AGPL / non-compete products are flagged.

**Evidence markers.**
- **[V]** = checked on a primary page or the GitHub API today.
- **[S]** = vendor page seen through a search summary only.
- **[2nd]** = third-party source.
- **[E]** = my estimate.
- **[U]** = unverified.

---

## 1. Competitor table (the skipped tools plus a one-line recap of the rest)

| Product | What / who | Price (Oct 2026) | Licence | Standout | Complaints | MCP? |
|---|---|---|---|---|---|---|
| **Notion AI** | AI inside a team workspace (teams, SMB) | AI is in Business, US$20 per member per month **[S]**. Custom Agents cost US$10 per 1,000 credits, with no rollover **[S]** | Proprietary | Agents, meeting notes, enterprise search; Custom Agents can call MCP servers (Business+) **[S]** | Reddit petitions say credit pricing is "unsustainable" and that runaway agent costs hit solo users **[2nd: r/Notion]** | Yes, hosted Notion MCP **[U: endpoint not re-checked today]**; agents act as MCP clients **[S]** |
| **Mem (mem.ai)** | "AI thought partner" notes (individuals) | Free, Plus US$9, Pro US$29, Pro 2×–20× US$49–199 per month (new usage ladder, Aug 2026) **[S]** | Proprietary | Proactive task/project tracking, routines | Pricing changed from a flat US$12 to a 7-tier ladder; the community asked about it **[2nd: r/MemIt]** | Yes, hosted `mcp.mem.ai/mcp` with OAuth, for Claude and ChatGPT **[S]** |
| **Tana** | Supertag outliner (power users) | Free; paid from US$8 per month **[S]**. AI credits: 500 / 2,000 / 5,000 **[2nd]** | Proprietary | **Free local MCP** in the desktop app at `localhost:8262` **[S]**; remote MCP in paid beta | Steep learning curve; credits run out with voice use **[2nd: r/TanaInc]** | Yes (local free, remote paid) |
| **Capacities** | Object-based notes (students, knowledge workers) | Pro US$9.99 per month billed annually or US$11.99 monthly; Believer from US$12.49; AI add-on US$8.33 **[S]** | Proprietary | MCP "AI Chat Connectors" on Pro, which don't use the AI budget **[S]** | Notes aren't Markdown files on disk; lag; some reports of data loss and export issues **[2nd: r/capacitiesapp; vendor docs]** | Yes (Pro) |
| **ChatGPT memory + Projects** | Built-in memory for ChatGPT users | Inside ChatGPT plans | Proprietary | Memory now pulls from chats, saved memories, Library files and connected apps; shows Sources; Project-only memory **[V: OpenAI Help]** | The memory summary "does not necessarily include every detail" **[V]**; reports of invented profile facts and incomplete deletes **[2nd: Reddit, OpenAI forum]** | Not as a memory store; ChatGPT is an MCP client (custom MCP is web-only, and writes need Business **[from Claude 886's plan, U today]**) |
| **Claude memory + Projects** | Built-in memory for Claude users | On by default for Free, Pro and Max on web, desktop and mobile **[V]** | Proprietary | One memory across chat and Cowork; editable topic files; sensitive topics off by default; import from other AIs **[V]** | Separate per project unless "use account memory" is on **[S]**; tied to one vendor | Claude is an MCP client; memory isn't exposed to other AIs |
| **Anthropic memory tool (API)** | Developer tool: client-side `/memories` file commands **[S]** | API token prices | Proprietary API | Paired with context editing: **84% fewer tokens** in a 100-turn eval; +39% with the memory tool **[S: Anthropic]** | Dev-only; you host the storage | N/A, but its pattern is BrainLink-like (files on your side) |
| **Reor** | Local AI notes app | Free | **AGPL-3.0 ⚠** | Auto-linking of related notes | **Archived** (GitHub API: archived, last push 2025-05) **[V]** | No |
| **Obsidian Copilot** | AI chat/agent inside Obsidian (Obsidian users) | Plus US$14.99 per month or US$139.99 per year **[S]** | **AGPL-3.0 ⚠** plugin (7.8k★) **[V]**; hosted backend proprietary | V4 "Agent Chat" with opencode, Claude Code and Codex; BYOK and local models free **[S]** | Slow indexing on big vaults **[S: own FAQ]** | No official MCP client or server; request closed for V3 **[S]** |
| Mem0 / Letta / Zep / Basic Memory (**AGPL ⚠**) / Supermemory / Smart Connections (**non-compete ⚠**, Pro US$10 per month or US$99 per year **[S]**) / Khoj (**AGPL ⚠**, cloud shut 2026-04-15) / Cognee | See Claude 886 REA §2 | | Mem0 67k★, Graphiti 32k★, Supermemory 31k★, Cognee 32k★, Khoj 38k★ **[V: GitHub API]** | | | |
| Rewind / Limitless | Screen and audio lifelog | — | — | — | Meta bought Limitless (Dec 2025); Rewind capture was disabled 2025-12-19 **[S: Reuters, vendor]**. Screenpipe is the local successor **[2nd]** | Market signal: "record everything" consumer memory got absorbed |

**Extra complaints to market against** (Claude 886 didn't cover these):
- **Mem0 junk audit** **[V: GitHub issue #4573]**. One team found 97.8% of 10,134 memories were junk. Causes:
  - restating the system prompt (52.7%)
  - a feedback loop, e.g. "User prefers Vim" stored 808 times
  - hallucinated profiles
  - secrets leaking into the store

  Mem0 says later releases fixed this: ADD-only extraction, temporal reasoning, decay.
- **Supermemory**'s ~99% LongMemEval stunt used 8 parallel prompts and 70-second queries **[2nd]**.
- **Graphiti** ingestion is LLM-heavy, e.g. US$0.80 for 40 chats, and slow on documents over 5 KB **[V: GitHub issues #467, #1516, titles]**.
- **Basic Memory** has had slow MCP startup **[S: GitHub issues]**.
- **All Obsidian MCP servers** need the computer on and can't serve ChatGPT or phones without a tunnel **[V: Pinto Notes comparison, 2026-09-30, vendor-biased]**.

### 1b. Notable 2026 entrants

| Entrant | What it is | Why it matters |
|---|---|---|
| **eugeniughelbur/obsidian-second-brain** **[V]** | MIT, **4,799★**. Obsidian vault as memory for 8 agents (Claude Code, Codex, Gemini, Grok Bot, …) | **Closest free rival.** "Crew" shared logbook; a lesson becomes a rule only when a human runs `keep`; nightly reconcile/synthesis/orphan-heal/index rebuild; "OKM" rule that every fact is timeless, dated or a pointer. **Free and dev-oriented (curl install, slash commands)**. We beat it on non-developer setup, safety guarantees and installers |
| **Hindsight (Vectorize)** **[V/S]** | MIT, **50.9k★** (fastest-growing memory repo) | retain / recall / reflect; hosted MCP with OAuth; cloud is pay-as-you-go: retain US$10/M tokens, recall US$0.75/M, reflect US$0.05 per call **[S]** |
| **Agent Memory Repo (Cognition/Devin)** **[V]** | MIT open standard, 801★ | Git repo of Markdown; required `MEMORY.md` entry point; one-line entries with `[source:…; added:…]`; `[[path]]` links. "Dreaming" agent merges duplicates, removes stale entries, checks sources. **BrainLink should read and write this format** |
| **Local REST API plugin v4+** **[V/2nd]** | MIT, 3.0k★ | Built-in MCP since May 2026 with heading/block/frontmatter edits. Free baseline every buyer can compare us to |
| **mcpvault** **[V/2nd]** | MIT, 1.7k★ | File-based server; Obsidian can be closed |
| Pinto Notes, Gnosem, Seturos, SuperLocalMemory, Silicon Cortex (US$59 founding seats, human-approved memory) | Small launches **[2nd/U]** | Silicon Cortex validates "AI drafts, human approves" at a ~US$59 price point |

---

## 2. Feature gap matrix vs BrainLink v1

Key: ✅ has · ◐ partial · ❌ no · ? unknown.

The BrainLink column comes from the Claude briefing plus RSI Lab's code read of `brain_mcp`. Its gaps match Claude 886 §5.

| Capability | BrainLink v1 | Mem0 | Letta | Zep/Graphiti | Basic Memory | Supermemory | Smart Conn. Pro | Local REST MCP | obsidian-second-brain | Notion | Mem | Tana | Capacities | ChatGPT mem | Claude mem | Hindsight |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| User's own Markdown files are the source of truth | ✅ | ❌ | ◐ MemFS | ❌ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ◐ | ❌ |
| One-click connect to many AI apps (no terminal) | ✅ | ◐ | ❌ | ❌ | ◐ cloud | ✅ OAuth | ◐ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | n/a | n/a | ✅ |
| Write preview / confirm before commit | ✅ | ❌ | ❌ | ❌ | ◐ | ❌ | ◐ inbox | ❌ | ◐ | ❌ | ❌ | ❌ | ❌ | ❌ | ◐ | ❌ |
| Signed provenance per AI / agent / session | ✅ | ◐ | ◐ | ✅ episodes | ❌ | ◐ | ❌ | ❌ | ◐ Crew log | ❌ | ❌ | ❌ | ❌ | ◐ Sources | ❌ | ? |
| Secret filter on write | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ? | ❌ | ❌ | ❌ | ❌ | ◐ | ◐ | ? |
| Per-AI vault scope / read-only mode | ✅ | ◐ | ◐ | ◐ | ◐ | ✅ spaces | ◐ | ❌ | ❌ | ✅ | ✅ | ? | ? | ◐ | ◐ | ✅ banks |
| Semantic / hybrid search | ❌ (keyword scan; CJK weak) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ◐ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Temporal supersede / valid-to | ◐ SUPERSEDED prefix | ✅ | ◐ | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ OKM | ❌ | ? | ❌ | ❌ | ◐ | ◐ | ✅ |
| Consolidation ("dream") job | ◐ nightly lint only | ✅ | ✅ | ◐ | ❌ | ✅ | ◐ dedupe | ❌ | ✅ | ❌ | ◐ | ❌ | ❌ | ✅ | ✅ | ✅ reflect |
| Retrieval eval / quality score | ❌ | ◐ benchmarks | ◐ | ◐ paper | ❌ | ◐ claims | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ◐ |
| Snapshots / undo | ❌ | ✅ history | ✅ git | ✅ | ✅ cloud | ? | ◐ | ◐ trash | ◐ git | ✅ | ✅ | ✅ | ◐ | ◐ | ✅ | ? |
| Phone / ChatGPT web access | ❌ | ✅ | ✅ | ✅ | ✅ cloud | ✅ | ◐ GPT | ❌ | ❌ | ✅ | ✅ | ◐ paid | ✅ | ✅ | ✅ | ✅ |
| Team shared vault with conflict handling | ❌ | ✅ | ✅ | ✅ | ✅ cloud | ✅ | ❌ | ❌ | ◐ | ✅ | ◐ | ✅ | ◐ | ◐ | ◐ | ✅ |
| Fully offline / local models | ✅ (no LLM needed) | ✅ OSS | ✅ | ◐ | ✅ | ◐ lite | ✅ | ✅ | ◐ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ OSS |
| Agent Memory Repo / MEMORY.md compatible | ❌ | ❌ | ◐ | ❌ | ❌ | ❌ | ❌ | ❌ | ◐ | ❌ | ❌ | ❌ | ❌ | ❌ | ◐ import | ❌ |
| Token-budgeted answers (map / snippet first) | ◐ MAP/INDEX | ✅ ~7k tokens/query | ✅ block limits | ✅ ~1.6k | ◐ | ✅ | ◐ context sizes | ❌ | ◐ | ? | ? | ? | ? | ? | ? | ✅ |

**Reading.** Nobody else has BrainLink's write-safety stack (preview + signature + secret filter + scope), and nobody ships a user-visible quality score. Our biggest gaps are semantic/hybrid search (especially Chinese), undo/snapshots, an eval score and remote/phone access.

---

## 3. Token efficiency (Ian: the #1 requirement)

**Baseline [E].** The naive pattern is "search, then fetch the top 5 notes in full". At about 1.5–2.5k tokens per note, plus about 20 tool definitions at ~200 tokens each loaded every session, that is **~8–12k input tokens per question plus ~4k per session**.

| Rank | Technique (seen in) | How BrainLink applies it | Est. saving per query **[E]** | Effort |
|---|---|---|---|---|
| 1 | **Hybrid local search, no LLM call** (Mem0 fused BM25+vector+entity; Graphiti cosine+BM25+graph; HN consensus BM25/FTS5+embeddings+RRF) | SQLite FTS5 (trigram for CJK) + local bge-m3 embeddings + RRF; optional local reranker. Better top-k means fewer fetches | 30–60% fewer fetched tokens; $0 model cost per search | M |
| 2 | **Snippets before full fetch** (Supermemory list→get; Basic Memory search/fetch) | `search` returns path, title, 2–3 lines of 200 characters, date and status; `fetch` takes a `section=` anchor and a `max_tokens` cap | 5 full notes (~10k) → 5 snippets (~600) + 1 section (~800): **~85%** | S |
| 3 | **MAP/INDEX-first answers** (Agent Memory Repo MEMORY.md; our MAP/INDEX) | `map` returns a ≤800-token hub; AIs follow links instead of searching blind | Saves 1–2 search rounds, ~1–3k | S (exists) |
| 4 | **Small tool profiles + lazy tools** (IBM failure mode: 46 tools failed, 19 passed; Supermemory 3 tools; Anthropic Tool Search: >85% fewer tool-definition tokens **[S]**) | 6-tool `phone`/default profile; advanced tools only in a `power` profile; short tool descriptions | ~4k → ~1k per session (**~75%**) | S |
| 5 | **Note size budgets + compressed summaries** (Letta chars_current / chars_limit; Mem0 ~7k tokens/query; Zep ~1.6k vs 115k) | Frontmatter `summary:` (≤60 words) and a `tokens:` estimate; lint flags notes over 1,500 tokens and proposes splitting them; search can return the summary only | 20–40% on long notes | M |
| 6 | **Prompt-cache-friendly output** (Anthropic cache reads ~10% of base **[S]**; DeepSeek cache hit ~2% of miss **[V]**; Kimi ~17% **[S]**) | Stable byte-identical MAP and profile prefix; deterministic ordering; dates as fields, not "today" | Not fewer tokens but 50–90% cheaper repeated input, on clients that cache | S |
| 7 | **Server-side result cache + content hash** (Supermemory delta billing; our hashguard) | Cache search results by query hash + vault revision; embeddings only re-run for changed files | Repeat queries ~0 extra; re-indexing ~95% cheaper | S |
| 8 | **Dedup + supersede hiding** (Mem0 Dream `latest_only`; Zep invalidation) | Default search hides SUPERSEDED and merged notes | 10–30% less noise per result set; fewer wrong-note retries | M |
| 9 | **"Not in brain" abstention** (SuperLocalMemory "supported / related / not in memory"; LongMemEval abstention) | If the score is below threshold, say so in 1 line instead of returning weak hits | Stops spirals of 2–4 extra calls on misses | S |
| 10 | **Context editing / session compaction** (Anthropic −84% in a 100-turn eval **[S]**) | Client-side; BrainLink adds a `session_digest` tool that writes a 150-word capture so the next session loads it, not the transcript | Big on long agent runs; outside our process | S |

**Target [E].** Ranks 1–4 together take a typical question from ~10k to **~1.5–2.5k tokens (~75–85% less)**. Make "tokens served per answer" a product metric. It's shown in the Brain Health panel (§6) and is a sales line: "your AI bills drop".

---

## 4. Model layer: 3 interchangeable backends + routing + BYOK

BrainLink's hot path (search, fetch, write) needs **no LLM**. Models are only for background jobs:
- embeddings
- rerank
- summary and tags
- consolidation proposals
- RSI evals
- optional "answer" tools

### 4.1 Backends (all speak OpenAI-compatible `/v1/chat/completions` + `/v1/embeddings`)

**(a) Local offline.** Ollama, llama.cpp server, vLLM or LM Studio at `http://127.0.0.1:<port>/v1`. NVIDIA lists these four for DGX Spark **[V: NVIDIA blog]**. This is the default.

**(b) Cheap outside APIs.** Official pages checked 2026-10-18. Prices are US$ per 1M tokens: input on a cache miss / cache-hit input / output.

| Provider | Model | Input / cache hit / output | Context | OpenAI-compatible | Data location and training (⚠ = risk) |
|---|---|---|---|---|---|
| **DeepSeek** **[V docs]** | `deepseek-flash` (V4.1 Flash 1017) | Off-peak **0.15 / 0.003 / 0.60**; peak 0.30 / 0.006 / 1.20 | 1M (384K output) | Yes (also an Anthropic format) | ⚠ **Stored in the PRC**. The policy allows training on inputs; it is unclear whether the opt-out covers the API **[S + 2nd]** |
| | `deepseek-v4-pro` | Off-peak 0.66 / 0.022 / 1.98; peak ×2 | 1M | Yes | Same ⚠ |
| **Moonshot Kimi** **[S]** | `kimi-k2.6` | 0.95 / 0.16 / 4.00 | 262K | Yes (`api.moonshot.ai/v1`) | Help Center: API data is not used for training. ToS (2026-07-30) says content may improve services unless an enterprise agreement says otherwise → **conflict ⚠**. Stored in Singapore; enterprise ZDR available **[S]** |
| | `kimi-k3` | 3.00 / 0.30 / 15.00 | 1M | Yes | Same |
| **Qwen (Alibaba Model Studio, Singapore "International")** **[V docs]** | `qwen-flash` | **0.05 / 0.01 / 0.40** (≤256K); batch at half price | 1M | Yes | Business data not used for training without consent; stored in the chosen Singapore region; ZDR for enterprise **[S]**. Best privacy story of the Chinese vendors |
| | `qwen-plus` | 0.40 / 0.08 / 1.20 (non-thinking) | 1M | Yes | Same |
| **Z.ai (GLM)** **[S pricing page]** | `glm-5.3-flash` | 0.15 / 0.03 / 0.50 | 1M | Yes (`api.z.ai/api/paas/v4`) | DPA: API inputs processed in real time, not stored; processed in Singapore; the DPA doesn't explicitly say "no training" **[S/2nd]** |
| | `glm-4.7-flash` | **Free** | 200K | Yes | Same; free tiers may be rate-limited **[U]** |
| | `glm-5.3` | 1.40 / 0.26 / 4.40 | 1M | Yes | Same |
| **MiniMax** **[S pricing page]** | `MiniMax-M3` (≤512K) | 0.30 / 0.06 / 1.20 (after a "permanent 50% off") | >512K tier exists; exact max **[U]** | Yes, OpenAI and Anthropic formats **[U: compat not re-checked]** | Policy: stored in a **US data centre**; the API terms allow using inputs to "improve services" ⚠ **[S]**. M2.5/M2.7 retire 2026-11-18 **[S]** |
| **OpenRouter** **[S]** | Router to all of the above + US models | Provider list price; 5.5% fee on credit purchases; BYOK free up to US$25k per month | per model | Yes | Doesn't train or store prompts unless you opt in; per-request `provider.zdr: true` and `data_collection: "deny"` **[S]**. Lets us pick non-PRC hosts for open models (e.g. Kimi K2.6 from US hosts at ~0.58–0.75 in **[2nd]**) |

Note: DeepSeek's marketing page shows older V4 Flash prices (0.14 / 0.28). The docs page above is newer and is what we use **[V]**.

**(c) Premium cloud.** Claude / GPT / Gemini via the user's own keys or their existing app subscriptions, for hard jobs only. Prices are not re-checked here.

### 4.2 Routing policy (default, user-editable)

1. **Private vaults → local only.** Vaults tagged `privacy: private` (Personal, Livva, journals) never leave the machine. The router refuses outside backends for them, even with a key present. The only override is per vault, typed confirmation, logged.
2. **Background jobs → local first, then cheap API.** Embeddings, tags, summaries, dedup candidates and RSI eval scoring run on local models. They fall back to the cheapest allowed outside API only for **shareable** vaults, and only if local is down or the queue is past a deadline.
3. **Hard jobs → premium, with approval.** Monthly synthesis, conflict adjudication on high-stakes notes, or judging a gold-set change go to premium. A per-job cost estimate is shown first; there's a monthly cap.
4. **Hot path → no model.** Search and fetch use the local index only.
5. **Region / privacy rules per provider.** Default allow-list for outside text: Qwen-Singapore, Z.ai and OpenRouter with ZDR + `data_collection: deny`. DeepSeek direct and MiniMax direct are off by default (PRC storage / training language). A user can enable them for public-source vaults such as Knowledge Intake clips.
6. **Secret and PII gate before any outside call.** The same filter as writes, plus redaction of account handles and phone numbers. Calls are logged as hash + size, not body (matching RSI Lab's audit schema).
7. **Budgets.** Per-provider monthly cap (default US$5), a nightly token cap, and a clean stop-and-resume (Cognee pattern).

### 4.3 Job → model recommendation (defaults; prices from §4.1)

| Job | Local default (Nvidia box) | Cheap API fallback (shareable vaults) | Premium |
|---|---|---|---|
| Embeddings (Chinese + English) | **bge-m3** (dense + sparse, multilingual) or Qwen3-Embedding-0.6B/4B **[U: current version names]** | Qwen `text-embedding` on Model Studio **[U price]** | — |
| Rerank top-50 | bge-reranker-v2-m3 / Qwen3-Reranker | — (keep local; cheap enough) | — |
| Tags, `summary:` line, frontmatter fill | 7–14B instruct (Qwen-class) | **qwen-flash** (≈US$0.0002 per note **[E]**) or GLM-4.7-Flash (free) | — |
| Dedup / merge proposals | 30B-class MoE (e.g. Qwen 30B-A3B-class) | glm-5.3-flash / deepseek-flash off-peak | — |
| Nightly consolidation / OKM dating | 30–120B MoE (e.g. GLM-Air-class, gpt-oss-120b on 128 GB) | deepseek-flash off-peak (public vaults only) | — |
| RSI eval judge (gold Q&A grading) | 30B-class, temperature 0 | qwen-plus | Claude / GPT for monthly audit of the judge |
| Conflict adjudication on key notes | — | kimi-k2.6 / glm-5.3 | **Premium + human approval** |

**Cost sanity [E].** Summarising 1,400 notes at ~1.5k in / 80 out each:
- qwen-flash: ≈ 2.1M in × US$0.05 + 0.11M out × US$0.40 ≈ **US$0.15 for the whole vault**.
- deepseek-flash off-peak: ≈ US$0.38.

So outside cost is trivial. **Privacy, not price, is the reason to stay local.**

### 4.4 BYOK design

- Keys live in the OS keychain (macOS Keychain / Windows Credential Manager). They are never stored in the vault, Drive or logs, and are shown masked.
- A "Models" tab in Setup:
  - add a backend (preset list + custom base URL)
  - a test button
  - a privacy card per provider (storage region, training stance, ZDR yes/no, from §4.1, with the date checked)
- Per-vault toggle "Allow outside models", default **OFF**. Private vaults have the toggle hard-locked off.
- A dry-run preview before the first outside call: "N notes, ~X tokens, ≈US$Y, sent to Provider Z in Region R".
- Licence tiers:
  - Free: local only.
  - Personal: BYOK.
  - Team: an admin allow-list of providers.

---

## 5. Local Nvidia mini PC (for Ian's coming box)

| Machine | Memory | Official / list price (Oct 2026) | Fit for BrainLink |
|---|---|---|---|
| **NVIDIA DGX Spark (GB10)** | 128 GB unified, 273 GB/s | **US$6,950** on the NVIDIA marketplace (out of stock) **[V]**. Up from US$3,999 at launch **[2nd]** | Best all-rounder: embeddings + rerank + a 30B model at once, or a ~120B MoE (gpt-oss-120b MXFP4 ≈ 63 GB **[2nd]**) for nightly consolidation |
| **DGX Spark 64 GB (OEM: Acer, ASUS, Dell, Gigabyte, HP, MSI)** | 64 GB | **From US$4,999, on sale 2026-10-23** **[V: NVIDIA blog]** | Enough for BrainLink jobs (≤30B at 4-bit + embeddings); not for 100B+ |
| Other GB10 boxes (ASUS Ascent GX10, MSI EdgeXpert, Gigabyte AI TOP ATOM, Dell Pro Max GB10, Lenovo PGX) | 128 GB | Street price ~US$4,500–8,500 **[2nd: componentregister, 2026-10-17]** | Same as Spark; check the 1 TB vs 4 TB SSD |
| **Jetson AGX Thor dev kit** | 128 GB, 273 GB/s | **US$5,499** (was 3,499) **[S: NVIDIA FAQ via 2nd]** | Robotics-oriented; works, but Spark is the better desktop choice |
| Jetson AGX Orin 64 GB dev kit | 64 GB | US$3,499 **[S]** | Older Ampere GPU; OK for embeddings + 7–14B |
| Jetson Orin Nano Super | 8 GB | US$399 (was 249) **[S]** | Embeddings + reranker only (bge-m3 ~0.6B fits) |
| RTX 5090-laptop-GPU mini PCs (e.g. ASUS ROG NUC 16) | 24 GB VRAM + 64 GB RAM | US$5,999.99 at Micro Center **[S]** | Fast for ≤14–30B at 4-bit; Windows-friendly; less memory than GB10 |

**Rule of thumb [E].** At 4-bit, a model needs ~0.55–0.6 GB per billion parameters, plus KV cache and the OS.
- 64 GB → up to ~30–40B dense or a ~100B MoE (tight).
- 128 GB → ~120B MoE comfortably.
- The embedding stack (bge-m3 + reranker) needs < 4 GB.

**Recommendation.** A 64 GB GB10 (from US$4,999) covers every BrainLink background job. Only buy 128 GB if Ian also wants a big local chat model. **Purchase needs Ian's OK.**

---

## 6. Self-improvement in the market, and the BrainLink RSI loop

**How competitors do it** (short; details in Claude 886 §2):

| Technique | Who does it |
|---|---|
| Reflection / synthesis | Mem0 Dream Synthesis (weekly on Pro, ≥20 memories, each pattern links to its evidence **[V]**); Letta sleep-time agents / MemFS dreaming; Hindsight `reflect`; ChatGPT Memory; Devin Dreaming |
| Supersede / conflict | Mem0 Supersede (non-destructive, `latest_only`) **[V]**; Zep bi-temporal invalidation; Cognee current / superseded / conflicting; obsidian-second-brain reconcile (source date + authority; ambiguous cases flagged to a human) |
| Dedup / merge | Mem0 Merge (hidden, kept); Smart Dedupe (review pairs; nothing auto-deleted) **[V]** |
| Decay | Mem0 recency boost of 1.5× up to dampening of 0.3× **[V: issue thread]**; MemoryOS heat |
| Graph extraction | Zep/Graphiti, Cognee, Mem0 Pro |
| Evals | LoCoMo / LongMemEval (contested benchmarks); Mem0's open harness; **nobody ships a per-user quality score** (white space confirmed on X) |
| Write-time gates (lessons from #4573) | Strip recalled memories before extraction; REJECT/NONE-by-default; typed notes; a 72-hour quarantine before promotion |

**Proposed BrainLink loop.** This builds on RSI Lab's design and doesn't replace it. RSI Lab owns the metrics, log schema, proposal flow and 24-question eval.

1. **Measure (nightly, local, $0).** RSI Lab's metrics, plus:
   - **tokens served per answer** (§3)
   - **abstention precision**
   - **CJK hit rate**
   - **outside-model spend**

   These roll up into a **Brain Health score** of 0–100 with a weekly 5-line digest.
2. **Diagnose.** Rule-based first (lint, hashes, link graph). The local model runs only on candidates.
3. **Propose.**
   - Content fixes go to the proposal inbox with diff, evidence links, expected eval delta and rollback. They are never auto-applied.
   - Retrieval *config* changes (BM25/vector weights, alias lists, snippet length) are A/B-tested against the held-out half of the eval.
4. **Gate.**
   - A config change auto-applies only if held-out hit@5 doesn't drop, **tokens per answer don't rise**, and private-leak count = 0.
   - A content change always needs a human (or a different agent's) approval with a hash check.
   - An agent never approves its own proposal.
5. **Apply and log.**
   - Through the normal preview → confirm path, signed `BrainLink-RSI`.
   - Old notes get `SUPERSEDED — ` + `superseded_by`.
   - A snapshot is taken before every batch.
6. **Safety rails.**
   - Recalled or retrieved text is tagged and never re-ingested as a new fact (prevents the 808× Vim loop).
   - Knowledge Intake / clipped content is untrusted: instructions inside notes are never acted on.
   - The eval set is frozen and hashed, grows only by human-approved rows, and 10 random results per week get a human spot-check (Goodhart guard).
   - Budget caps and a kill switch.
   - Private vaults use local models only.
7. **Product-level RSI (opt-in).** Anonymous metric counts only, never content or queries, feed Iango's roadmap. This needs a privacy-policy line first **[U: legal]**.

---

## 7. Pricing sanity check

| Comparable | Price | Model |
|---|---|---|
| Smart Connections Pro | US$10 per month or US$99 per year **[S]** | Subscription |
| Obsidian Copilot Plus | US$14.99 per month or US$139.99 per year **[S]** | Subscription |
| Basic Memory Cloud | US$15 per month (team US$15 → 12 per seat) **[V]** | Subscription |
| Supermemory Pro / Mem0 Starter | US$19 per month **[V]** | Usage credits |
| Letta Pro / Teams | US$20 per month / per seat **[V]** | Subscription + usage |
| Notion Business | US$20 per member per month + agent credits **[S]** | Seat + credits |
| Mem Plus / Pro | US$9 / 29 per month **[S]** | Usage ladder |
| Capacities Pro | ~US$120 per year **[S]** | Subscription |
| Silicon Cortex founding | US$59 one-time **[2nd/U]** | One-time |
| Free OSS: Local REST API MCP, mcpvault, obsidian-second-brain, Basic Memory local | US$0 | — |

**Verdict.**
- **Personal US$79 one-time is well placed.** It's below one year of any subscription rival, and "no credits, no subscription" is a selling point against the credit backlash.
- Recommended changes:
  - (i) A **launch / founding price US$49** for the first 100 buyers.
  - (ii) An **optional US$29 per year updates renewal** after year 1, so the one-time price stays sustainable.
  - (iii) A **14-day full trial** instead of relying only on Free.
- **Free tier tweak.** Read-only Free loses to free OSS that can write. Let Free use **proposal mode** (writes queue in the inbox, max 20 per month), so users feel the safety feature and upgrade.
- **Team US$12 per user per month (min 3)** is cheaper than Basic Memory Team (US$15) and Notion (US$20). **But v1 has no shared-vault conflict handling or sync**, so don't sell Team until the git/Drive conflict check and snapshots ship. Then US$12–15 is fair.
- **Iango Setup NT$15,000** (~US$470 **[E: FX ~32]**) is cheap next to English-market "Claude + Obsidian setup" offers (an X post cites US$2,400 setup **[2nd/U]**).
  - Keep it for Taiwan.
  - Add a **"Setup + local AI box" package** priced per quote once Ian's box proves the stack.

---

## 8. Three sharpest positioning angles

1. **"One brain for every AI — in files you own, with writes you approve."**
   - Plain Markdown, every AI app, preview + signature + secret filter.
   - Contrast: ChatGPT's memory summary "does not necessarily include every detail" (OpenAI's own words), and an audit found 97.8% junk in an automatic memory store.
2. **"The brain that cuts your AI bill."**
   - Token-first design (map → snippet → section, local hybrid search, 6-tool profile) targets ~75–85% fewer context tokens per question **[E, to be measured]**.
   - Background work runs on your own local box or US$0.05/M models, never metered credits.
3. **"The only second brain with a health score."**
   - A nightly self-check shows retrieval quality, stale or conflicting notes and tokens per answer, and proposes fixes you approve.
   - Measured improvement, not marketing benchmarks.

Proof point: dogfooded by Iango's own multi-agent team (Claude, Codex, Grok Bot agents) before launch.

---

## 9. Merged top-10 (ranked by sale impact ÷ effort)

Sources: **C886** = Claude 886 REA top-10; **RSI** = RSI Lab design; **P** = this note.

| # | Feature | Sale impact | Effort | Source |
|---|---|---|---|---|
| 1 | **Token-first retrieval**: snippets → section fetch → `max_tokens` cap; MAP-first; "not in brain" abstention; tokens-per-answer metric | Very high (Ian's #1; bill-saving pitch) | S | P (§3), C886 #2/#7 |
| 2 | **Local hybrid search** (FTS5 + CJK trigram + bge-m3 + RRF, optional reranker); no LLM in the hot path | Very high (closes the biggest gap; Chinese users) | M | C886 #6, RSI (CJK fail), P |
| 3 | **3-backend model layer + routing + BYOK** (local → cheap API → premium; private vaults local-only; provider privacy cards) | High (cheap, private, Nvidia-box story) | M | P (§4) |
| 4 | **Brain Health / RSI loop**: usage log, 24-question frozen eval, nightly report, held-out gate, weekly digest | High (unique; nobody ships a quality score) | M | RSI (a–e), C886 #9, P |
| 5 | **Proposal inbox + snapshots / undo**; Free tier gets proposal mode | High (trust; Free→paid hook) | S–M | C886 #3/#10, P |
| 6 | **Temporal supersede in frontmatter** (`valid_from`, `valid_to`, `superseded_by`, `expires`); hidden by default; dates beside facts | High (fixes conflicting info) | S | C886 #1/#5 |
| 7 | **Small tool profiles with MCP annotations** (phone/default ≤6, power ≤10) | Medium-high (efficiency + reliability) | S | C886 #2, P |
| 8 | **Sleep-time consolidator as proposals** (dedup, orphans, stale links, summaries) on local models | Medium-high | M | C886 #4, RSI (b), P |
| 9 | **Agent Memory Repo / MEMORY.md import-export + ChatGPT `search`/`fetch` shim** | Medium (compatibility; rides Cognition's standard) | S | P, C886 #10 |
| 10 | **Write-time anti-junk gate** (strip recalled text; typed notes; feedback-weighted ranking with decay and caps) | Medium (prevents the Mem0 failure; good marketing) | S–M | P, RSI (c), C886 #8 |

Prerequisites that aren't features but block sales: Apple notarisation, a tested and signed Windows build, the payment webhook, legal review.

---

## 10. Unverified / open

- Notion monthly price and current MCP endpoint; Tana and Capacities prices (search summaries only).
- Kimi's training stance (Help Center and ToS conflict).
- MiniMax OpenAI-compatibility and max context.
- Z.ai training stance (not explicit).
- Current open-weight model names and sizes in Oct 2026 (Qwen3.x embedding/reranker, GLM-Air class).
- Silicon Cortex price; US$2,400 setup comparable; all vendor benchmarks.
- The FX rate for NT$.
- Whether BrainLink v1 code (on Ian's Mac) already does anything beyond RSI Lab's `brain_mcp` reading: semantic search status unknown.
- Every purchase (hardware, API credit, Apple ID, Cloudflare) needs Ian's OK; nothing was bought or signed up.

## Changelog
- 2026-10-18 ~09:40 (UTC+8): v1 created by Paulo (Grok Bot). Merged Claude 886 REA and RSI Lab notes; added skipped tools, 2026 entrants, token efficiency, model routing/BYOK, Nvidia box, pricing, positioning, merged top-10.
- 2026-10-19: metadata only — added written_at (from v1 changelog time) (Steward Check 152atgew4Y_HpITFbNTpFr5cfGfQgEqwy §3). Made by Grok Bot (Paulo).
