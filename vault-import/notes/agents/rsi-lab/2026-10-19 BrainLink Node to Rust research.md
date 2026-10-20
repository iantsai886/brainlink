---
ai_platform: Claude (paid, via Grok Bot box browser)
agent_or_role: RSI Lab
session_or_task_id: brainlink-rust-research-2026-10-19
written_at: 2026-10-19T15:43:04+08:00
source: "https://claude.ai/chat/ee0eaeb6-68d6-4ce0-b9a0-a81635036da2 ; prompt: /workspace/rsi-lab/brainlink-rust/research-prompt.md"
confidence: medium (unverified secondary synthesis; Claude's citations not spot-checked by RSI Lab beyond the 3 URLs listed below)
status: draft-for-Paulo
---
Made by: RSI Lab (Grok Bot)

## Provenance (RSI Lab)
- Produced by Ian's paid Claude (claude.ai, 'Ian · Pro' plan, Opus 5.5 at Medium effort with Research mode, about 4.5 min, 292 sources browsed).
- Chat: https://claude.ai/chat/ee0eaeb6-68d6-4ce0-b9a0-a81635036da2, started 2026-10-19 by RSI Lab via the box browser.
- Prompt: /workspace/rsi-lab/brainlink-rust/research-prompt.md. The one-line cover message wasn't sent, only the attached prompt, but Claude followed the file.
- Caveat: the account email wasn't visible, so the 886 account is inferred, not verified.
- Source file: /workspace/rsi-lab/brainlink-rust/claude-report.md (22,298 bytes, 164 lines, 57 numbered sources). Reproduced verbatim below; RSI Lab did not edit Claude's content.
- Estimates are Claude's, not measured. All agent-day efforts, latency expectations and token targets are Claude's estimates; nothing was benchmarked by RSI Lab.
- No code was run and /workspace/brainlink-src was not touched. The Thursday 10-22 Mac build was not touched.

### Spot-check of 3 cited primary sources (RSI Lab, WebFetch, 2026-10-19)
1. [1] crates.io/crates/tantivy: **verified, with one correction.** The page confirms MIT, "BM25 scoring (the same as Lucene)", "Tiny startup time (<10ms)", mmap directory, incremental indexing, and third-party Chinese tokenizers (tantivy-jieba, cang-jie) plus lindera for Japanese/Korean. Correction: 0.26.2 was published 2026-09-08, not October. The latest is **0.27.0, published 2026-10-17, MSRV 1.88**. The report's "Tantivy 0.26 MSRV 1.86" was not checked against the 0.26 page.
2. [13] modelcontextprotocol.io/docs/2026-07-28/sdk: **verified.** Rust (modelcontextprotocol/rust-sdk) and TypeScript are both listed as Tier 1. The promotion date (2026-08-21) is not on this page and remains unverified, as the report itself says.
3. [29] v2.tauri.app/develop/sidecar: **verified.** The page documents `bundle.externalBin` and requires a `-$TARGET_TRIPLE` suffix per architecture.

---

# BrainLink MCP: Node → Rust? Primary-source assessment (as of 2026-10-19)

**Bottom line: Rust will not cut BrainLink's tokens per answer by itself. Ship Thursday's Node build unchanged. After that, spend at most 3–5 agent-days on a Tantivy + jieba benchmark spike behind the existing store/search contract. Adopt Rust only for the search index, and only if the spike clears a hard go/no-go bar.**

## TL;DR
- **Tokens:** The things that cut tokens are ranking quality, chunk size, snippet trimming and stable prompt prefixes for provider caching. All of these can be done in Node today. Rust mainly improves latency, memory, index size and cold start.
- **Where Rust is worth it:** only in the search index (Tantivy plus a CJK tokenizer), and possibly later in local embeddings (fastembed-rs/ort). Sync, file watching, the MCP layer, the desktop shell and anything waiting on the LLM gain little or nothing.
- **How to do it:** Start with a sidecar or napi-rs addon for search, driven by the existing `brainlink-store` contract suite. Don't do a full rewrite. Revisit Tauri only if you later need a real desktop window.

## Executive summary (6 lines)
1. Status: **confirmed.** Rust's mature pieces are Tantivy 0.26.2, rmcp 3.x (Tier 1 MCP SDK), notify 8.x, fastembed 7.1 and napi-rs v3.
2. Status: **confirmed.** Tokens per answer depend on retrieval and context packing, not the implementation language.
3. Status: **proposed.** The search index is the only clear Rust candidate. The question is whether BM25 + jieba in Tantivy matches or beats the current 27/28 top-5 recall at lower latency.
4. Status: **proposed.** The rest stays in Node: MCP server, sync, Setup UI and packaging.
5. Status: **proposed.** Shell: keep Node + local web UI. Tauri v2 only becomes relevant if a native window or tray app is needed. Electron is not justified.
6. Status: **proposed.** Timing: start the spike no earlier than the week after the 2026-10-22 Mac release. Budget 3–5 agent-days for it, with a go/no-go gate.

## Key Findings

### 1. Which parts would gain from Rust

| Component | Rust option (version/date) | Expected gain | Verdict |
|---|---|---|---|
| Keyword search | **Tantivy 0.26.2** (crates.io, released Oct 2026, MIT). README: "BM25 scoring (the same as Lucene)", "Tiny startup time (<10ms)", mmap directory, incremental indexing. Chinese via third-party **tantivy-jieba** (jieba-rs 0.10, tantivy-tokenizer-api 0.7) or **cang-jie**. Japanese/Korean via **lindera**.\[1\] | Faster queries and indexing; an on-disk index with no rebuild at startup; lower RSS. Title/alias boosts become field boosts. RRF and graph boost stay as custom code. | **Strongest candidate** (proposed) |
| Sync / file watching | **notify 8.x** (docs.rs). Uses FSEvents on macOS. The docs warn that some FSEvents events "cannot be observed easily" for files you don't own, in which case it falls back to polling. Debouncer crates are separate.\[2\] | On Node, **chokidar v5** (Nov 2025, ESM, Node 20.19+) already normalises fs.watch. The chokidar README lists **v6 (Oct 2026)** as a rewrite with a native `fs.watch(recursive)` backend on macOS/Windows that requires Node 22+.\[3\] Sync is I/O- and Drive-bound. | **Little gain** — stay in Node |
| Embeddings | **fastembed-rs v7.1.0** (2026-09-22, Apache-2.0). Uses ort (ONNX Runtime wrapper) + HF tokenizers; v7 added candle models such as Qwen3 embeddings.\[4\]\[5\] | Removes the Ollama dependency and HTTP hop for users without Ollama. Batching to Ollama is already possible: `/api/embed` accepts an array input and returns L2-normalised vectors (Ollama docs).\[6\] Inference time dominates either way. | **Optional, later** |
| Tokenization (token counting for budgets) | HF `tokenizers` crate (0.23 used by fastembed)\[7\] | Exact counts per model; only matters if you enforce token budgets precisely | Low priority |
| MCP server | **rmcp** (official). Release history on docs.rs: 3.0.0 2026-07-28 → 3.4.1 2026-09-23; lib.rs lists 3.5.1 on 2026-10-05. Implements spec 2026-07-28 and stays compatible with 2025-11-25. Now listed as **Tier 1** on the official MCP SDK list (modelcontextprotocol.io). The promotion date of 2026-08-21 (PR #3287) comes only from digitalapplied.com. The official 2026-07-28 launch post still called Rust "in beta". MSRV 1.88. | The **TypeScript SDK is also Tier 1** on the official SDK list. Its v2 line (v2.3.0 2026-10-02; core/server 2.3.1 2026-10-05) is "the stable release line implementing the 2026-07-28 spec". Legacy `@modelcontextprotocol/sdk` 1.32.0 (2026-10-02) reportedly still defaults to 2025-11-25 (secondary source; unverified).\[8\]\[9\]\[10\]\[11\]\[12\]\[13\] Protocol handling is not a bottleneck. | **No gain** — stay in Node; plan a v1→v2 SDK migration |
| Setup UI, write-guards (secret scan, path-escape guard) | — | These are microsecond operations. Correctness matters more than speed. | **No gain** |
| Anything that waits on the LLM | — | Answer latency is set by model time-to-first-token and generation. That is seconds of work for DeepSeek, Kimi, Ollama or llama.cpp, against milliseconds for retrieval (estimate). | **Rust irrelevant** |

**Where Rust does not matter:** stdio/HTTP framing, Drive sync, the file watcher, the Setup UI and LLM-bound latency. Search has a 15k-chunk corpus and still doesn't use an index library. A well-written JS BM25 is probably already fast at that size (estimate; **unknown** until measured). So the spike has to *measure* the Rust gain, not assume it.

### 2. Desktop shell: Tauri v2 vs Electron vs current Node + web UI

| Aspect | Current (Node 22 embedded + 127.0.0.1 UI) | Tauri v2 | Electron |
|---|---|---|---|
| Installer/bundle size | The embedded Node runtime dominates. Exact size **unknown** (measure your .pkg). | Hopp benchmark (Apr 2025, macOS, 6-window demo app): **8.6 MiB**. Better Stack screen-recorder app: **57 MB**. Windows: an offline WebView2 install adds ~127 MB and a fixed WebView2 runtime ~180 MB (Tauri config reference).\[14\]\[15\]\[16\] The default bootstrapper adds ~0. | Hopp: **244 MiB**. Better Stack: **323 MB**\[14\]\[15\] |
| RAM | Node process only. No browser except the user's own. | Hopp: ~172 MB with 6 windows. Better Stack: 109 MB idle\[14\]\[15\] | Hopp: ~409 MB with 6 windows. Better Stack: 128 MB idle\[14\]\[15\] |
| macOS signing/notarization | Already working (Developer ID + notarytool) | Built in. Uses APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID or APPLE_API_KEY/APPLE_API_ISSUER; uses notarytool. "distributing outside the App Store also requires notarization" (v2.tauri.app)\[17\]\[18\]\[19\] | Via Forge with @electron/osx-sign + @electron/notarize (`tool: 'notarytool'`)\[20\]\[21\] |
| Windows | Inno Setup + node.exe; you sign it yourself | NSIS/MSI. WebView2 comes "preinstalled on Windows 11"; the installer ensures it on older Windows. `signCommand`/`certificateThumbprint`. SmartScreen reputation still builds over time (third-party guides)\[16\]\[22\]\[23\] | Squirrel/MSIX; Azure Artifact Signing documented\[20\] |
| Auto-update | None built in | Updater plugin: "needs a signature… This cannot be disabled". Desktop only. Since 2.10.0 it supports Deb, Rpm, AppImage, NSIS and MSI\[24\]\[25\] | update.electronjs.org is free for **open-source GitHub-released apps only**, macOS/Windows only. Otherwise you run your own server\[26\]\[27\] |
| Linux | Your own build | deb, rpm, AppImage (build on Ubuntu 22.04/Debian 12 baseline; depends on WebKitGTK 4.1)\[17\]\[28\] | Mature, larger |

**Caveat:** the size and RAM figures come from vendor and developer blogs with simple methodology (Hopp shows `du -h` on .app bundles).\[15\] They are not official Tauri/Electron numbers. Treat them as indicative. **Verdict:** BrainLink is a background MCP server with a settings page, so a browser on 127.0.0.1 is the lightest option you have. Tauri would only add value for tray presence, a native window or a built-in updater. Tauri's sidecar feature (`bundle.externalBin`, with binaries suffixed by target triple) can host either the Node server or a Rust core.\[29\]\[30\] Electron has the worst size and RAM figures and brings no capability BrainLink needs.

### 3. Migration paths

| Option | How | Pros | Cons / failure modes | Effort (estimate, agent-days) |
|---|---|---|---|---|
| **A. Full rewrite in Rust** (rmcp + Tantivy + notify + Tauri) | Port all ~11k lines | Single binary, smallest footprint | Highest regression risk across the safety guards (preview-unless-confirm, secret scan, path escape). Long compile-error loops for agents. Duplicates the TS SDK's Tier 1 maturity for no gain. Disrupts packaging | 40–70 |
| **B. napi-rs addon for hot paths** | napi-rs v3 (announced 2025-07-07; napi 3.12.x Aug–Sep 2026) exposes Rust search to Node\[31\]\[32\] | Node keeps MCP/UI/sync. In-process calls, no IPC. Optional WASM fallback (v3)\[31\] | Per-platform .node binaries must be signed/notarized inside the .pkg and the Inno Setup installer. A crash in Rust (panic/unsafe) takes down the server. Universal macOS needs two arches merged | 8–15 |
| **C. Rust sidecar binary over stdio/JSON-RPC** | `brainlink-index` process; Node spawns it | Crash isolation. Language-neutral protocol, so the existing contract tests drive it directly. Easy to A/B and to remove. Fits a future Tauri `externalBin` | IPC serialisation overhead (sub-ms per query at top-k sizes, estimate). Extra process lifecycle, plus signing of the extra binary | 6–12 |
| **D. Rust core + thin Node shell** | Everything except MCP/UI moves to Rust | Endgame if C succeeds | Most of A's risk, later | 25–40 |

**Contract tests as the spec (proposed pattern):** keep `contract-tests.mjs` as the source of truth. Add an adapter that implements `interface.d.ts` by forwarding each call to the Rust sidecar (JSON-RPC over stdio) or the napi module. Then run the same suite against three targets: the in-memory reference, the Node impl and the Rust impl, in CI on macOS/Windows/Linux. Add a golden retrieval test: the 28 questions, each with an expected top-5. Failure mode to watch: tests that rely on JS-specific ordering or float tie-breaks. Pin deterministic tie-breaking (score, then path) in the contract before porting.

### 4. What actually reduces tokens per answer

- **Reduces tokens (all language-neutral):** better top-k precision, so fewer chunks need sending; smaller, heading-aware chunks; trimming snippets to the matched sentences plus a small window; deduplicating near-identical chunks; returning IDs/paths and letting the model fetch more only on demand; and stable prompt prefixes. **None of these needs Rust.** Your ~950 tokens/answer (estimate) is driven by how many chunks you return and how long they are.
- **What Rust changes:** query latency, index build time, memory, persistent on-disk index size, cold start (Tantivy claims <10 ms startup) and, without Node, bundle size. Rust could indirectly cut tokens only if the faster engine lets you afford a reranking pass that tightens top-k. A local cross-encoder reranker via fastembed is one example. That gain comes from the reranker, not from Rust (**proposed**, unmeasured).
- **Provider fit:**
  - **DeepSeek:** context caching is on by default and hits on exact prefix matches. DeepSeek's "Context Caching on Disk" post priced cache hits at $0.014/M against $0.14/M for misses ("up to 90%" cheaper). flatkey.ai reports that on 2026-10-12 DeepSeek listed deepseek-flash at $0.003/M for a hit vs $0.15/M for a miss, off-peak (not checked against DeepSeek's own pricing page). Put the fixed instructions and tool schemas first and the retrieved snippets last.\[33\]\[34\]
  - **Kimi:** the same principle applies. Moonshot's official Kimi caching guide (platform.moonshot.ai) prices kimi-k3 at $0.30/M for a cache hit vs $3.00/M for a miss, plus a separate cache-write charge ($3.00/M at the default 5-minute TTL). It advises putting "stable system prompts, tool definitions… at the front". kimi-k2.7 and kimi-k2.6 do not support cache write.
  - **Ollama:** `/api/embed` supports batch input; `keep_alive` avoids reload cold starts.\[35\]
  - **llama.cpp:** small contexts favour aggressive snippet trimming.
  - **Implementation language:** both Node and Rust paths talk to these over HTTP, so neither is advantaged.

### 5. Competitors and peers (patterns only)

| Product | Stack/pattern | Licence |
|---|---|---|
| Basic Memory | Python, Markdown files + SQLite index, MCP tools carrying readOnly/destructive hints, FastEmbed vectors\[36\]\[37\]\[38\] | **AGPL-3.0 ⚠** |
| Khoj | Python/Next.js, self-hosted, Obsidian plugin, Ollama/DeepSeek support\[39\]\[40\] | **AGPL-3.0 ⚠** |
| Obsidian Copilot | TS plugin; Orama/local index for vault QA; closed backend for Plus\[41\]\[42\] | **AGPL-3.0 ⚠** |
| Smart Connections | JS plugin, local embeddings\[43\] | Smart Plugins License (source-available, non-compete clause; changed 2025-12-09) ⚠\[44\]\[45\] |
| Zed | Rust editor; GPUI\[46\]\[47\] | GPL-3.0 (editor), Apache-2.0 (GPUI). Original 2024 announcement said AGPL for server parts; a 2026 repo audit found none (unverified)\[47\]\[48\]\[49\] |
| Meilisearch | Rust engine; `charabia` tokenizer (CJK)\[50\]\[51\] | MIT (CE) / BUSL-1.1 (EE)\[52\]\[53\]\[54\] |
| Quickwit/Tantivy | Rust search library\[55\] | MIT |
| rust-mcp-sdk | Alternative Rust MCP SDK, 2.0.0 (2026-08-27), claims 100% conformance\[56\] (110/110 server, 440/440 client) | MIT (crates.io; MSRV 1.80) |
| mem0, Warp | — | **Unknown** (not researched in this pass) |

Pattern takeaway: most direct peers ship TS or Python with an embedded index. None needs Rust to win on retrieval quality. Avoid reading the AGPL code entirely, and describe behaviours only.

### 6. Risks, team skill and recommendation

- **AI-agent-written Rust:** borrow-checker and trait-bound compile loops are real (unverified as a measured rate). Mitigate by forbidding `unsafe` (`#![forbid(unsafe_code)]`), pinning crate versions (rmcp 3.x needs Rust ≥1.88; Tantivy 0.26 MSRV 1.86)\[1\]\[57\] and keeping the Rust surface small. Prefer the sidecar (C) over FFI (B) so panics can't kill the MCP server.
- **Supply chain/packaging:** each Rust binary adds signing/notarization steps on macOS and Windows, and a universal-binary merge on macOS.
- **Spec churn:** MCP 2026-07-28 made Streamable HTTP sessionless (rmcp 3.0 notes).\[57\] That migration hits the Node path too, so do it in Node first.

**Recommendation and first step:**
1. **Now → 2026-10-22:** nothing in Rust. Ship.
2. **Weeks of 2026-10-26 / 11-02:** first do the token work in Node: snippet trimming, dedup and a k-adaptive cutoff. Target <700 tokens/answer at ≥27/28 (estimate target).
3. **Spike (3–5 agent-days):** a standalone `brainlink-index` CLI using Tantivy + tantivy-jieba, with the same 2,135-note vault, the 28 golden questions and the contract suite run via the stdio adapter.
   - **GO** if all of these hold: top-5 ≥ 27/28 **and** p95 query latency ≤ 50% of Node **and** cold start-to-first-result ≤ 50% of Node **and** RSS ≤ 70% of Node **and** all contract tests pass.
   - **NO-GO** otherwise. Keep Node and revisit when vaults hit ~10× size.
4. If GO, ship it as sidecar (C) behind a feature flag. Reconsider Tauri only when a native UI is on the roadmap.

## Caveats
- Tauri/Electron size and RAM figures are from third-party benchmarks, not official measurements.
- rmcp's Tier 1 status is confirmed on the official SDK list, but its promotion date (2026-08-21) comes only from a secondary report. TS SDK release years are inferred from context.
- The current DeepSeek prices come from flatkey.ai and were not checked against DeepSeek's own pricing page.
- mem0/Warp stacks were not verified.
- All agent-day efforts and latency expectations are estimates.

## Sources

1. [tantivy - crates.io: Rust Package Registry](https://crates.io/crates/tantivy)
2. [notify - Rust](https://docs.rs/notify/)
3. [GitHub - paulmillr/chokidar: Minimal and efficient cross-platform file watching library · GitHub](https://github.com/paulmillr/chokidar)
4. [Releases · anush008/fastembed-rs · GitHub](https://github.com/anush008/fastembed-rs/releases)
5. [GitHub - anush008/fastembed-rs: Rust library for generating vector embeddings and reranking locally! · GitHub](https://github.com/anush008/fastembed-rs)
6. [Embeddings - Ollama](https://docs.ollama.com/capabilities/embeddings)
7. [FastEmbed — LLMs/agents in Rust // Lib.rs](https://lib.rs/crates/fastembed)
8. [Release @modelcontextprotocol/core@2.3.1 · modelcontextprotocol/typescript-sdk · GitHub](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/%40modelcontextprotocol/core%402.3.1)
9. [Release 1.32.0 · modelcontextprotocol/typescript-sdk · GitHub](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.32.0)
10. [Release 2.3.0 · modelcontextprotocol/typescript-sdk · GitHub](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.3.0)
11. [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/)
12. [Tracking: adopt MCP spec 2026-07-28 and TypeScript SDK v2 · Issue #241 · cesteral/mcp-open-advertising · GitHub](https://github.com/cesteral/mcp-open-advertising/issues/241)
13. [SDKs - Model Context Protocol](https://modelcontextprotocol.io/docs/2026-07-28/sdk)
14. [Tauri vs. Electron vs. Deno Desktop vs. Electrobun: A Practical Comparison](https://betterstack.com/community/guides/scaling-nodejs/tauri-vs-electron-vs-deno-vs-electrobun/)
15. [Tauri vs. Electron: performance, bundle size, and the real trade-offs](https://www.gethopp.app/blog/tauri-vs-electron)
16. [Configuration](https://v2.tauri.app/reference/config/)
17. [Distribute](https://v2.tauri.app/distribute/)
18. [tauri-bundler full changelog](https://v2.tauri.app/release/tauri-bundler/all-versions/)
19. [Environment Variables](https://v2.tauri.app/reference/environment-variables/)
20. [Code Signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
21. [Packaging Your Application](https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging)
22. [Ship Your Tauri v2 App Like a Pro: Code Signing for macOS and Windows (Part 1/2) - DEV Community](https://dev.to/tomtomdu73/ship-your-tauri-v2-app-like-a-pro-code-signing-for-macos-and-windows-part-12-3o9n)
23. [Webview Versions](https://v2.tauri.app/reference/webview-versions/)
24. [Updater](https://v2.tauri.app/plugin/updater/)
25. [updater](https://v2.tauri.app/release/updater/)
26. [Publishing and Updating](https://www.electronjs.org/docs/latest/tutorial/tutorial-publishing-updating)
27. [GitHub - electron/update.electronjs.org: 📡 A free service that makes it easy for open-source Electron apps to update themselves. · GitHub](https://github.com/electron/update.electronjs.org)
28. [AppImage](https://v2.tauri.app/distribute/appimage/)
29. [Embedding External Binaries](https://v2.tauri.app/develop/sidecar/)
30. [嵌入外部二进制文件](https://tauri.nodejs.cn/develop/sidecar/)
31. [Announcing NAPI-RS v3](https://napi.rs/blog/announce-v3)
32. [Releases · napi-rs/napi-rs · GitHub](https://github.com/napi-rs/napi-rs/releases)
33. [DeepSeek Context Caching: Cache Hits, Costs & Python](https://deepseek-usa.ai/docs/deepseek-context-caching/)
34. [The Ultimate Guide to DeepSeek API Context Caching (2026)](https://deepseek-usage.xyz/blog/deepseek-context-caching-guide)
35. [ollama/docs/api.md at main · ollama/ollama · GitHub](https://github.com/ollama/ollama/blob/main/docs/api.md)
36. [GitHub - mcp-research/basicmachines-co\_\_basic-memory: Basic Memory is a knowledge management system that allows you to build a persistent semantic graph from conversations with AI assistants, stored in standard Markdown files on your computer. Integrates directly with Obsidan.md](https://github.com/mcp-research/basicmachines-co__basic-memory)
37. [GitHub - basicmachines-co/basic-memory: AI conversations that actually remember. Never re-explain your project to your AI again. Join our Discord: https://discord.gg/tyvKNccgqN · GitHub](https://github.com/basicmachines-co/basic-memory)
38. [Basic Memory — MCP server](https://explainx.ai/mcp-servers/basic-memory)
39. [Deploy Khoj](https://railway.com/deploy/khoj)
40. [Khoj — Your AI second brain — chat with your docs, get answers from the web, custom agents · Run This Ai](https://runthisai.com/en/tool/khoj)
41. [obsidian-copilot/README.md at master · logancyang/obsidian-copilot · GitHub](https://github.com/logancyang/obsidian-copilot/blob/master/README.md)
42. [logancyang/obsidian-copilot](https://deepwiki.com/logancyang/obsidian-copilot)
43. [Smart Connections - Local Semantic Search for Obsidian](https://www.everydev.ai/tools/smart-connections)
44. [Smart Connections - Obsidian Plugin](https://community.obsidian.md/plugins/smart-connections)
45. [Smart Connections License: Smart Plugins License (Obsidian)](https://smartconnections.app/legal/license/)
46. [Rust-based Zed editor now open source](https://devclass.com/2024/01/25/rust-based-zed-editor-now-open-source-with-built-in-support-for-openai-and-github-copilot/)
47. [Zed is now open source — Zed's Blog](https://zed.dev/blog/zed-is-now-open-source)
48. [Zed — Orchestration & agents — Open Source AI Map](https://www.aipotluck.org/product/zed)
49. [Software Overview - Zed — Your last next editor](https://zed.dev/software-overview)
50. [Meilisearch loves open source](https://www.meilisearch.com/open-source)
51. [What Is Meilisearch? A Complete Guide (2026)](https://1bench.dev/guides/meilisearch)
52. [Changelog - Meilisearch Documentation](https://www.meilisearch.com/docs/changelog/changelog)
53. [Enterprise and Community editions - Meilisearch Documentation](https://www.meilisearch.com/docs/resources/self_hosting/enterprise_edition)
54. [Meilisearch vs Algolia](https://www.meilisearch.com/comparisons/meilisearch-vs-algolia)
55. [skiff-archive/tantivy: Tantivy is a full-text search engine library inspired by Apache Lucene and written in Rust - Codeberg.org](https://codeberg.org/skiff-archive/tantivy)
56. [rust-mcp-sdk — Rust parser // Lib.rs](https://lib.rs/crates/rust-mcp-sdk)
57. [modelcontextprotocol/rust-sdk rmcp-v3.0.0 on GitHub](https://newreleases.io/project/github/modelcontextprotocol/rust-sdk/release/rmcp-v3.0.0)
