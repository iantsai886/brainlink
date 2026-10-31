# RSI live source validation and research triage — 2026-10-30

## Purpose

Validate the opt-in RSI research connector against real public metadata services and triage the resulting ideas against BrainLink's current design. This was a temporary QA run, not an enabled user setting or a claim that the research improves the product.

## Run and privacy boundary

- Code: `src/rsi-discovery.mjs`, at repository revision `02e2dcae271b9660085d3391c4517ef8b228bdb8`.
- Sources queried: arXiv Atom, Crossref, and public GitHub repository search.
- Generic query topic: `AI agent memory`.
- Generic problem signal: AI agents need reliable context retrieval and safe cross-agent handoff between work sessions.
- No vault, session, private problem statement, credential, or customer data was supplied. Only the public topic was sent to the selected public endpoints.
- Settings and proposal ledger lived in a fresh temporary directory and were deleted after the run.

Receipt: 3/3 feeds fetched successfully; 60 raw entries parsed; 3 proposals created; 0 duplicates; 10 malformed entries dropped; 20 irrelevant entries dropped; 27 beyond the per-run limit; 0 detected secrets; 0 instruction-like entries; 0 source errors. All proposals were labeled low confidence and left in `discovered`. This proves the three live adapters could fetch and parse metadata once; it does not establish service availability, broad relevance quality, user acceptance, or scientific validity.

## Live proposals and research triage

1. [SuperLocalMemory V3: Information-Geometric Foundations for Zero-LLM Enterprise Agent Memory](https://arxiv.org/abs/2603.14588). Its abstract proposes an information-geometric retrieval metric, lifecycle dynamics, and a model for contradictions across memory contexts. The paper reports results on six LoCoMo conversations. Treat the reported gains as author claims from a preprint; the sample is too small to justify copying the method or claiming product benefit.
2. [Graph-Native Cognitive Memory for AI Agents: Formal Belief Revision Semantics for Versioned Memory Architectures](https://arxiv.org/abs/2603.17244). Its abstract discusses immutable revisions, mutable tag pointers, typed dependency edges, event extraction, and prospective indexing. It reports benchmark results and also references an independent reproduction. Those results still need independent inspection and a BrainLink-specific reproduction before adoption.
3. [Is Agent Memory a Database? Rethinking Data Foundations for Long-Term AI Agent Memory](https://arxiv.org/abs/2605.26252). This is a vision paper that frames ingestion, revision, forgetting, and retrieval as one evolving-memory workload. It is a useful design checklist, not evidence of a ready-to-use implementation.

## Comparison with BrainLink

BrainLink already has Markdown as the readable source, optional Git history, typed entity and relation notes, evidence-backed proposed edges, explicit review, scoped retrieval, episodic capture, and a governed RSI ledger. Therefore, these papers do not justify replacing the current architecture with Redis, Neo4j, or another service.

The useful gap to study is **safe revision over time**: detect when a new approved note may replace, qualify, or conflict with an older claim; show both sources and dates; and ask a person to resolve it. Never auto-delete, silently rewrite, or promote uncertain claims. First measure the existing filing/link/retrieval baseline on a larger independent fictional set, then consider a review-only supersession/conflict proposal workflow. Keep any claim about improved recall or token savings unknown until the same tasks pass quality and privacy gates.

## Decision

No code, skills, vault notes, or live research settings changed in this run. Preserve the three citations as low-confidence RSI proposals only in this QA record; do not treat them as approved product decisions. The next technical step is an independent, labeled test set for dated fact revision, explicit supersession, true contradiction, and near-miss cases across Personal, Organisation, and Client scopes. Measure false proposals, missed conflicts, citation correctness, latency, and response size; require privacy canaries to remain absent.
