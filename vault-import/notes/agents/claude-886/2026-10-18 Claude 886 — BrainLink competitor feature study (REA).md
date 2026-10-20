---
title: "2026-10-18 Claude 886 — BrainLink competitor feature study (REA)"
type: research
status: proposed
owner: Claude 886
ai_platform: Grok Bot
agent_or_role: Claude 886
session_or_task_id: brainlink-competitors-1018
written_at: 2026-10-18T09:55:00+08:00
source: public web (GitHub READMEs and licence files via the GitHub API, vendor docs, pricing pages, arXiv papers); URLs cited inline
confidence: medium
tags: [brainlink, mcp, second-brain, competitor-study, rea, agent-memory, context-engineering, rsi, licensing]
aliases: ["BrainLink competitor study", "BrainLink REA 1018", "Memory MCP competitor features"]
---
Made by Grok Bot (Claude 886).

# BrainLink competitor feature study (REA)

**Scope.** This study covers what to learn from public AI-memory and second-brain products for **BrainLink MCP v1**: one MCP server that gives any AI read and write access to a plain-Markdown Obsidian vault, with an RSI (self-improvement) loop built in.

**Method.** REA: reverse-engineering analysis of public docs, READMEs, licence files, pricing pages, changelogs and papers. Only patterns were studied. **No code was read for reuse and none was copied.** Every pattern below is in my own words.

**Freshness.** All facts were checked on 2026-10-18 (Taipei). Repo licence and activity data come from the GitHub API (`api.github.com/repos/<owner>/<repo>`) on the same day.

**Marker.** **[unverified]** means I couldn't confirm the claim from a primary source.

## 0. Lens: IBM Context Engineering, 4 failure modes

Source: the Clip Intake note "Intake — IBM Technology — Context Engineering 4 Failure Modes (Adopt)" in Brain. It is based on https://www.youtube.com/watch?v=BwXremQ-i6I

| # | Failure mode | Short name used below | IBM's fix |
|---|---|---|---|
| F1 | Poisoning: a wrong conclusion gets written to memory and is then treated as truth | **wrong notes** | validate before writing |
| F2 | Distraction: a long action history becomes the dominant pattern | **long history** | compact the history and move detail into files that are pulled in on demand |
| F3 | Confusion: too many tool definitions (the cited test failed with 46 tools and passed with 19) | **too many tools** | curate the tool set and fetch the rest on demand |
| F4 | Clash: contradictory versions sit side by side | **conflicting info** | prune or supersede the old version |

**RSI loop stages** used in the mapping (BrainLink's own loop):
- **R1 capture**: write or ingest
- **R2 validate**: gate, hash and conflict check
- **R3 consolidate**: merge, supersede, compact
- **R4 retrieve**: rank and assemble
- **R5 evaluate**: tests and benchmarks
- **R6 adjust**: tune rules and weights from the results

## 1. Licence summary (read first)

| Product | Licence (source) | Flag |
|---|---|---|
| Mem0 | Apache-2.0 (https://api.github.com/repos/mem0ai/mem0) | OK |
| Letta (MemGPT) | Apache-2.0 for both `letta-ai/letta` and the current `letta-ai/letta-code` (https://api.github.com/repos/letta-ai/letta-code) | OK |
| Zep / Graphiti | Graphiti is Apache-2.0 (https://api.github.com/repos/getzep/graphiti). Zep Cloud's engine is proprietary (https://github.com/getzep/graphiti, "Graphiti and Zep" section) | OK (OSS core) |
| **Basic Memory** | **AGPL-3.0** (https://api.github.com/repos/basicmachines-co/basic-memory; README badge) | **⚠ AGPL: patterns only, no code** |
| Supermemory | MIT for the repo (https://api.github.com/repos/supermemoryai/supermemory). The hosted memory model is proprietary ("Powered by our own model", https://supermemory.ai/pricing/) | OK (repo) |
| **Smart Connections** | **Custom "Smart Plugins License Agreement"**: source-available, with a non-compete clause against general-purpose products for Obsidian-like apps (https://raw.githubusercontent.com/brianpetro/obsidian-smart-connections/main/LICENSE) | **⚠ NOT OSI open source. The non-compete is directly relevant because BrainLink is an Obsidian-adjacent product. Patterns only, no code.** |
| **Khoj** | **AGPL-3.0** (https://api.github.com/repos/khoj-ai/khoj) | **⚠ AGPL: patterns only, no code** |
| Cognee | Apache-2.0 (https://api.github.com/repos/topoteretes/cognee). Its Postgres-graph production build is a "licensed product" (README) | OK (core) |
| MemoryOS (BAI-LAB) | Apache-2.0 (https://api.github.com/repos/BAI-LAB/MemoryOS) | OK |
| mcp-obsidian (MarkusPfundstein) | MIT (https://api.github.com/repos/MarkusPfundstein/mcp-obsidian) | OK |

Even for the permissive projects, BrainLink should take ideas, not code. That keeps the licensing story clean for a paid release.

---

## 2. Competitor profiles

### 2.1 Mem0
- **What it is.** The best-known "memory layer for AI agents". It comes as a library, a self-hosted server and a cloud platform (https://github.com/mem0ai/mem0 README). The repo has about 67k stars (GitHub API).
- **MCP.** There is a hosted MCP endpoint (`mcp.mem0.ai`) that needs an API key. The standalone `mem0-mcp` repo was archived in March 2026, and OpenMemory MCP was folded into the self-hosted server. Both points come from a third-party write-up and are **[secondary source]**: https://contextbolt.com/blog/mem0-mcp/ and https://www.contextely.com/blog/openmemory-mcp-explained. OpenMemory's original four tools were add, search, list and delete-all (https://mem0.ai/blog/introducing-openmemory-mcp).
- **Key patterns:**
  - **Extraction.** The April 2026 algorithm does a single-pass, ADD-only extraction: one LLM call, no UPDATE or DELETE, so memories accumulate and nothing is overwritten (README, "New Memory Algorithm").
  - **Retrieval ranking.** Semantic, BM25 keyword and entity matches are scored in parallel and fused. Entity linking boosts related memories, and a temporal step ranks "the right dated instance" for questions about current, past or future state (README).
  - **Agent facts.** Facts an agent generates, such as a confirmed action, carry equal weight (README).
  - **Consolidation.** A "Dream (Memory Consolidation)" feature exists on the Pro and Enterprise tiers only (https://mem0.ai/pricing).
  - **Scopes.** Memory is kept at user, session and agent level (README).
  - **Evals.** Mem0 claims LoCoMo 92.5, LongMemEval 94.4 and BEAM-1M 64.1 at about 7k tokens per query, with an open-sourced eval harness at https://github.com/mem0ai/memory-benchmarks. The README notes that these scores are from the managed platform with proprietary optimisations, so open-source users should expect less. The vendor numbers are **[unverified independently]**.
  - **Multi-client.** A browser extension spans ChatGPT, Perplexity and Claude, and there are CLI and "agent skills" packs (README).
  - **Pricing.** Hobby is free (10k adds and 1k retrievals per month), Starter is $19, Pro is $249, and Enterprise is custom (https://mem0.ai/pricing).
- **Borrow (pattern):**
  - Append-only capture plus a later consolidation pass. Never overwrite in the hot path, which matches our SUPERSEDED rule.
  - Multi-signal fused ranking: keyword + semantic + entity + recency.
  - A public, reproducible eval harness.
- **Avoid:**
  - Benchmark numbers that only the hosted tier can reach.
  - Retrieval metering that punishes the agent for checking memory. ContextBolt notes that the 1k-retrieval free cap runs out fast.
  - An add-only store with no supersede marking, which simply grows clash (F4).

### 2.2 Letta (formerly MemGPT)
- **What it is.** A stateful-agent platform. Active code now lives in `letta-code`, and the old V1 server is on an `archive` branch (https://github.com/letta-ai/letta README).
- **MCP.**
  - Letta is an MCP client: agents can register stdio, SSE and Streamable HTTP servers, and their tools are namespaced (https://docs.letta.com/agent-sdk/mcp/index.md, via search summary).
  - Letta also hosts its own MCP server at `api.letta.com/mcp` with agent-management tools (https://docs.letta.com/platform/hosted-mcp/index.md, via search summary). **[snippet-level verification]**
- **Key patterns:**
  - **Memory blocks.** Core memory is a set of labelled blocks that are always in context. Each block has a description, a character limit shown to the model (chars_current / chars_limit), an optional read-only flag, and can be shared across agents (https://docs.letta.com/v1-sdk/memory/memory-blocks/index.md).
  - **Sleep-time agents.** A background agent owns the memory-editing tools and rewrites memory between conversations, so the primary agent doesn't manage memory mid-chat. It can run on a stronger, slower model, and its frequency is configurable (https://www.letta.com/blog/sleep-time-compute/; https://github.com/letta-ai/skills/blob/HEAD/letta/letta-api-client/sleeptime.md).
  - **MemFS.** Memory lives in a git-backed filesystem. A `/doctor` command audits placement, duplication and the system-prompt token load, and "dreaming" subagents consolidate lessons in the background (https://docs.letta.com/configuration/memory/index.md).
  - **Mobile.** chat.letta.com works in a mobile browser, and agents can be reached over Slack, Telegram and Discord (README).
  - **Pricing.** There is a free tier. Pro and API plans are $20 a month, API plans add $0.10 per active agent per month plus tool-execution seconds, and LLM usage is billed on top (https://docs.letta.com/pricing/, via search summary). **[snippet-level verification]**
  - **Evals.** MemGPT set the Deep Memory Retrieval (DMR) benchmark at 93.4% (as cited in https://arxiv.org/abs/2501.13956).
- **Borrow (pattern):**
  - A sleep-time consolidator: a separate offline process with write rights, while the live agent only reads and proposes. This is effectively our nightly brain-tools run, made explicit as a product feature.
  - Show each note's size budget to the model (chars and limit) so it compacts on its own (F2).
  - A `/doctor`-style audit for duplication and token load.
  - Git-backed history of memory.
- **Avoid:**
  - Giving the conversational agent direct self-edit rights over core memory. That is the original MemGPT design, which Letta itself moved away from for reliability.
  - Locking memory into a platform-specific agent runtime.

### 2.3 Zep / Graphiti
- **What it is.** Graphiti is an open-source temporal "context graph" framework, and Zep is the managed platform built on it (https://github.com/getzep/graphiti README). The paper is at https://arxiv.org/abs/2501.13956.
- **MCP.** The Graphiti MCP server is open source but labelled experimental. Its tools cover adding and deleting episodes, searching nodes and facts, group IDs and graph maintenance, over HTTP at `/mcp/` (https://github.com/getzep/graphiti/blob/main/mcp_server/README.md; https://help.getzep.com/graphiti/getting-started/mcp-server.mdx). Zep's paid plans sell "Memory MCP Server seats" (https://www.getzep.com/pricing/).
- **Key patterns:**
  - **Bi-temporal facts.** Every fact edge carries a valid-from and valid-to time, plus created and expired times in the system. A contradicting new fact *invalidates* the old edge without deleting it, and new information wins (paper, §2.2.3).
  - **Provenance.** Every derived fact traces back to a raw "episode", so the store is non-lossy (README; paper §2.1).
  - **Ontology.** Developers can predefine entity and edge types or let them be learned (README).
  - **Retrieval.** Cosine, BM25 and breadth-first graph search find candidates. They are then reranked with RRF, MMR, an episode-mention-frequency reranker, a node-distance reranker or a cross-encoder. A "constructor" renders facts *with their date ranges* into the context string (paper §3).
  - **Communities.** Label-propagation clusters carry summaries for a global view (paper §2.3).
  - **Evals.** LongMemEval_s: 71.2% vs 60.2% for full context on gpt-4o, with about 1.6k context tokens vs 115k and roughly 90% lower latency. Performance *dropped* on single-session-assistant questions (paper Tables 2–3).
  - **Pricing.** Credits are charged per episode (1 per 350 bytes), and retrieval and storage are free. Free use gets 10k credits a month, Flex is $125 and Flex Plus is $375 (https://www.getzep.com/pricing/).
- **Borrow (pattern):**
  - Validity windows in frontmatter (`valid_from`, `valid_to`, `superseded_by`) so supersede is *temporal*, not just a title prefix.
  - Always render dates next to facts in retrieved context.
  - Provenance links from each claim to its source note.
  - Charge for ingest, not retrieval, so the AI isn't punished for checking memory.
- **Avoid:**
  - A heavy graph-database dependency (Neo4j, FalkorDB or Neptune) for a personal vault, since Markdown plus an index is enough.
  - LLM-only contradiction detection with no human or hash gate.
  - Shipping an "experimental" MCP surface.

### 2.4 Basic Memory ⚠ AGPL-3.0
- **What it is.** A local-first MCP server over plain Markdown files that AI and humans share, and the closest product to BrainLink (https://github.com/basicmachines-co/basic-memory README).
- **MCP.** MCP is native. Tools fall into groups: content (write, read, edit, move, delete notes), search, recent activity, list directory, `build_context` over `memory://` URLs, projects, schema (`schema_infer`, `schema_validate`, `schema_diff`), and OpenAI-compatible `search` and `fetch` for ChatGPT. Every tool carries MCP behaviour hints: read-only, destructive, idempotent, open-world (README "MCP tools").
- **Key patterns:**
  - **Note grammar.** Entities carry "Observations" (categorised fact lines) and "Relations" (typed wikilinks), so a knowledge graph emerges from Markdown (README).
  - **Overwrite guard.** `write_note` guards against accidental overwrites (README).
  - **Progressive tool discovery** via annotations (README).
  - **Search.** Semantic search with optional cross-encoder reranking (README).
  - **Cloud tier.** At $15 a month (beta, locked for life) it adds mobile and web access, bidirectional sync with conflict resolution (rclone), and snapshots with point-in-time restore. Teams get a shared workspace with real-time co-editing (README "Basic Memory Cloud", "Pricing").
  - **Compatibility.** It works with Claude Desktop and Code, Codex, Cursor, VS Code and ChatGPT Custom GPTs (README table).
- **Borrow (pattern only):**
  - MCP tool annotations: read-only, destructive, idempotent.
  - A schema infer, validate and diff step for frontmatter, which maps onto our lint.
  - OpenAI-style `search` and `fetch` compatibility tools so ChatGPT can connect.
  - Snapshots and point-in-time restore as the safety net for phone writes.
- **Avoid:**
  - **Any code, prompts or file formats copied verbatim (AGPL).**
  - Shipping ~20 tools to every client: that is the F3 risk, so we expose a profile-scoped subset.
  - A sync that resolves conflicts silently, without the hash check we already have.

### 2.5 Supermemory
- **What it is.** A memory and context engine with an API, plugins, MCP and a local single binary (https://github.com/supermemoryai/supermemory README).
- **MCP.** A hosted server at `mcp.supermemory.ai/mcp` exposes just three tools: `memory` (save or forget), `recall` (search plus a profile summary) and `context` (inject the profile at session start). Memory is scoped by project "container tags" (README "MCP").
- **Key patterns:**
  - **Automatic forgetting.** Temporary facts, such as an exam tomorrow, expire once their date passes, and contradictions are "resolved automatically" (README "Automatic forgetting").
  - **Profiles.** A user profile is split into static facts and dynamic recent context, and is returned in about 50 ms (README).
  - **Search.** Hybrid search covers RAG documents and memories in one query (README).
  - **Connectors.** Drive, Gmail, Notion, OneDrive and GitHub sync via webhooks (README).
  - **Pricing.** Credit-based: Free $0 (with $5 of credit), Pro $19, Max $100, Scale $399. Updates under the same `customId` are billed only for the net-new token delta (https://supermemory.ai/pricing/; https://supermemory.ai/docs/overview/billing).
  - **Evals.** It claims #1 on LongMemEval, LoCoMo and ConvoMem, with "95% Recall at 15 with 99.4% context reduction" (README). These are vendor claims **[unverified independently]**.
- **Borrow (pattern):**
  - A three-tool MCP surface as the minimal phone profile, which is strong evidence for our 6-tool profile (F3).
  - Expiry dates on time-bound facts (`expires:` frontmatter) so stale notes auto-mark themselves superseded (F4).
  - A session-start `context` call that returns a compact profile and MAP slice.
  - Content-hash dedupe: unchanged content costs nothing, which matches our hashguard.
- **Avoid:**
  - Opaque "automatic" contradiction resolution with no audit trail.
  - A proprietary hosted model as the core.
  - Benchmark-leaderboard marketing.

### 2.6 Smart Connections ⚠ source-available with a non-compete
- **What it is.** An Obsidian plugin that ships a local embedding model, a "Connections" view of semantically related notes and blocks, a Lookup semantic search, and "Send to Smart Context" for copying related notes into any AI chat (https://github.com/brianpetro/obsidian-smart-connections README).
- **MCP.** Through **Connect Pro** (paid), it runs a local Streamable HTTP MCP endpoint while Obsidian Desktop is open. The endpoint is loopback-only with **no authentication**, and its docs warn not to expose it publicly. Some tools change notes directly, while "proposal tools" go through an Inbox review. A separate Remote GPT path serves ChatGPT (https://smartconnections.app/connect-pro/getting-started/).
- **Key patterns:**
  - Local-first embeddings with zero setup and no API key.
  - Works on mobile, inside Obsidian Mobile (README).
  - Pin or hide connections, which feed Pro ranking algorithms (README).
  - Include and exclude rules for indexing, with warnings when exclusions block a folder (README).
  - **Pricing.** Pro is an all-access subscription with a 14-day trial (https://smartconnections.app/pro-plugins/). The exact price is **[unverified]**: the page shows it only at checkout.
- **Borrow (pattern only):**
  - **Proposal tools with an inbox review** for AI writes. This is exactly the per-write human approval that Technical Reviewer requires for phone writes.
  - User pin and hide signals as ranking feedback for RSI (R6).
  - Exclusion rules surfaced as warnings, which pairs with our privacy gates.
- **Avoid:**
  - **Any code reuse. The licence forbids using the software in a competing general-purpose Obsidian product.**
  - An unauthenticated local endpoint.
  - A server that only runs while the desktop app is open.

### 2.7 Khoj ⚠ AGPL-3.0
- **What it is.** An "AI second brain" app: chat over your documents with any LLM, reachable from a browser, Obsidian, Emacs, desktop, phone and WhatsApp, with custom agents and scheduled research newsletters (https://github.com/khoj-ai/khoj README).
- **MCP.** Khoj is an MCP *client* only: admins add MCP servers, which are used in research mode (https://www.anchorterminal.com/tools/khoj, third-party, **[secondary source]**).
- **Status.** Khoj Cloud shut down on 15 April 2026 (https://app.khoj.dev/ shows "Service Deprecated"). Maintainer activity has slowed (anchorterminal review, **[secondary source]**).
- **Key patterns:** many client surfaces on one server, scheduled automations and notifications, and agent personas with their own knowledge (README).
- **Borrow (pattern only):**
  - Meet users in the clients they already use, especially a messaging channel for phone access.
  - Scheduled digests, such as a weekly "what changed in Brain" note, as an RSI output.
- **Avoid:**
  - **AGPL code.**
  - Bundling chat UI, search and model hosting into one monolith, which led to a hosted-service shutdown.
  - Telemetry on by default (anchorterminal review, **[secondary source]**).

### 2.8 Cognee (similar #1)
- **What it is.** An open-source AI memory platform that turns documents, code and conversations into a knowledge graph plus vectors, and runs locally with no API key (https://github.com/topoteretes/cognee README). Paper: https://arxiv.org/abs/2505.24478.
- **MCP.** There is an MCP server for Cursor, Cline and others, and a Claude Code memory plugin (README).
- **Key patterns:**
  - **Four verbs:** remember, recall, improve and forget (README).
  - **`improve()` is an explicit self-improvement stage** (https://docs.cognee.ai/core-concepts/main-operations/improve). It runs fixed stages:
    - Feedback weights: rated answers raise or lower the weight of the graph elements they used.
    - Distill sessions: a curator proposes durable lessons and a writer/rejecter checks them against existing ones, after harmful or low-confidence items are gated out.
    - Optional conflict review: disputed facts are marked current, superseded or conflicting, using their source dates.
    - A global context index of summaries.
    - A per-stage report: completed, skipped with a reason, or errored.
    - Budget-exhaustion stop and resume watermarks.
  - **Portability.** Memory can be imported from Mem0, Letta, Zep and Graphiti via a "COGX" exchange format (README).
- **Borrow (pattern):**
  - The RSI loop as an explicit, staged, idempotent "improve" run with a per-stage status report. Our RUN_STATUS is already close.
  - Feedback-weighted ranking (R6).
  - A curator plus rejecter for any lesson promoted to permanent memory (F1).
  - Conflict marks with three states: current, superseded, conflicting.
  - Stopping cleanly when the LLM budget runs out, which matters for us because of the Claude usage cap.
- **Avoid:**
  - Requiring a multi-database stack.
  - Production features held behind a "licensed product".

### 2.9 MemoryOS (BAI-LAB) (similar #2)
- **What it is.** A research "memory operating system" with short-, mid- and long-term tiers (https://github.com/BAI-LAB/MemoryOS). Paper: https://arxiv.org/abs/2506.06326 (EMNLP 2025).
- **MCP.** MemoryOS-MCP is open source (README).
- **Key patterns:**
  - **Tiering.** Short-term dialogue pages move first-in-first-out into mid-term topic segments.
  - **Heat.** Each segment's heat combines its visit count, its interaction length and an exponential recency decay.
  - **Promotion and eviction.** Hot segments are promoted to long-term persona memory, and cold ones are evicted when the tier is full (https://arxiv.org/html/2506.06326, via search summary).
  - **Evals.** It claims +49% F1 on LoCoMo (README).
- **Borrow (pattern):**
  - A transparent "heat" score from access count, links and recency to rank notes in MAP/INDEX.
  - Demote cold notes to an archive tier (F2 and F4).
- **Avoid:**
  - Silent eviction of user-authored notes. In a second brain, decay should only *demote in ranking*, never delete.

### 2.10 Obsidian MCP servers (similar #3), e.g. mcp-obsidian (MIT)
- **What it is.** A thin MCP bridge to Obsidian via the Local REST API community plugin (https://github.com/MarkusPfundstein/mcp-obsidian README).
- **MCP tools.** Its tools include `search`, `patch_content` (insert relative to a heading, block reference or frontmatter field), `append_content` and `delete_file` (README).
- **Borrow (pattern):** heading, block and frontmatter-targeted patching instead of rewriting whole files. That means smaller diffs and fewer clobbers.
- **Avoid:**
  - Needing the Obsidian desktop app running.
  - An API key in client config.
  - Exposing `delete_file` to an AI by default.

---

## 3. Benchmarks worth adopting (for R5 evaluate)

- **LongMemEval.** 500 questions covering five abilities: information extraction, multi-session reasoning, temporal reasoning, **knowledge updates** and **abstention** (https://arxiv.org/abs/2410.10813). Findings that apply to BrainLink:
  - Fact-augmented key expansion improved recall at k by about 9.4%.
  - Time-aware query expansion improved temporal recall by 7–11%.
  - Even with perfect retrieval, the reading strategy (extract notes, then answer, with structured input) swings accuracy by about 10 points.
  - Benchmark and code: https://github.com/xiaowu0162/LongMemEval
- **LoCoMo.** Very long-term conversational memory: single-hop, multi-hop, temporal and adversarial questions (https://aclanthology.org/2024.acl-long.747/).
- **Recommendation.** Build a small **BrainLink-Eval** from our own vault with synthetic, private-data-free fixtures. It should include knowledge-update cases (a note superseded by a later one), abstention ("not in Brain"), and temporal questions. Run it as an acceptance test in the nightly job. This follows the agent-teams note's "one agent plus acceptance tests" rule (Brain note, 2026-10-18 brief from Paulo).

---

## 4. Ranked top-10 "borrow" list

| Rank | Pattern (own words) | Seen in | Failure mode | RSI stage |
|---|---|---|---|---|
| 1 | **Temporal supersede in frontmatter**: `valid_from`, `valid_to`, `superseded_by`, `expires`. Retrieval hides invalid notes by default and shows dates beside every fact | Zep/Graphiti, Supermemory | F4 conflicting info, F1 | R3, R4 |
| 2 | **Profile-scoped tiny toolsets with MCP annotations** (read-only, destructive, idempotent). The phone profile has ≤6 tools and the default has ≤10 | Supermemory (3 tools), Basic Memory (annotations) | F3 too many tools | R4 |
| 3 | **Propose-then-approve writes**: the AI writes to an inbox, a person or a gate approves, and the hash check runs on apply | Smart Connections Connect Pro, Letta (read-only blocks) | F1 wrong notes | R1, R2 |
| 4 | **Sleep-time consolidator**: an offline job that alone has rewrite rights. It merges duplicates, compacts long notes and marks superseded. Live clients only read and propose | Letta, Mem0 "Dream", Cognee `improve` | F2 long history, F4 | R3 |
| 5 | **Three-state conflict marks** (current, superseded, conflicting) with source dates, surfaced in search results and in MAP | Cognee conflict review, Zep invalidation | F4 | R2, R3 |
| 6 | **Fused multi-signal ranking**: BM25 + embeddings + wikilink graph + recency/heat, with the MAP/INDEX boost kept as a signal | Mem0, Graphiti, MemoryOS | F2, F4 | R4 |
| 7 | **Size budgets shown to the model** (chars and limit per note or block), plus a `/doctor`-style audit for duplication and token load | Letta | F2 | R3, R5 |
| 8 | **Feedback-weighted retrieval**: pins, hides and useful/not-useful ratings adjust note weights nightly | Cognee feedback weights, Smart Connections pin/hide | F1, F4 | R6 |
| 9 | **Own acceptance eval** in the style of LongMemEval (knowledge-update, abstention, temporal), run nightly as a gate, with a public harness | Mem0 memory-benchmarks, LongMemEval | all four | R5 |
| 10 | **Snapshots plus ChatGPT-compatible `search`/`fetch`**: point-in-time restore as the safety net for writes, and two compatibility tools so non-MCP-native clients can read | Basic Memory Cloud | F1 (recovery) | R1, R6 |

Honourable mentions:
- Heading and frontmatter-targeted patching (mcp-obsidian).
- Charging for ingest rather than retrieval (Zep).
- Staged improve reports with budget-stop and resume (Cognee).
- An exchange format for importing other memories (Cognee COGX).

## 5. Where BrainLink already differs

- **Files are the source of truth, not a database.** Mem0, Zep, Supermemory and Cognee keep memory in their own stores. BrainLink keeps plain Markdown in the user's vault, and indexes are disposable. Only Basic Memory (AGPL) and the Obsidian bridges share this stance.
- **Explicit SUPERSEDED with stable ids.** We never delete. Old notes are renamed and filtered, and deletes stay a human decision. Most competitors either overwrite (an LLM update) or silently "forget". Zep's invalidation is the closest analogue, but it lives inside a graph DB.
- **Hash-checked staging and promotion** (expected sha256 per file, a staged → promoted gate with a reviewer) plus a write conflict check that refuses stale writes. No competitor documents a reviewer-gated promotion pipeline. Smart Connections' inbox is the nearest.
- **Privacy redaction gates before anything leaves the box**: account handles, private-vault ids and biometric terms. Competitors offer scoping or containers, but none publicly documents a pre-upload redaction gate.
- **MAP/INDEX curated retrieval** gives a human-readable map that any AI can read with no embeddings at all, so it degrades gracefully on clients with no vector search.
- **Small toolset by design**, the F3 answer, where Basic Memory exposes about 20 tools and Graphiti's MCP is broad.
- **AI-agnostic and no vendor model.** BrainLink has no proprietary extraction model and no per-retrieval metering.
- **Gaps vs competitors** (honest):
  - no semantic or embedding ranking yet;
  - no temporal validity fields;
  - no snapshots and restore;
  - no eval harness;
  - no ChatGPT `search`/`fetch` shim;
  - no mobile path beyond the Drive connectors.

## 6. Notes and caveats

- Benchmark numbers from Mem0, Supermemory and MemoryOS are self-reported. Zep's come from its own paper. None were reproduced here.
- The third-party sources (contextbolt.com, contextely.com, anchorterminal.com) are marked as secondary. Confirm them before quoting externally.
- **No code from any project was read for reuse or copied.** Re-check the AGPL (Basic Memory, Khoj) and Smart Connections licences before any future contributor looks at their source.

## Changelog
- 2026-10-18T09:55+08:00: v1.0 created by Claude 886 (Grok Bot). Ten competitors profiled, licence flags, top-10 borrow list mapped to IBM F1–F4 and RSI R1–R6. Task brainlink-competitors-1018.
