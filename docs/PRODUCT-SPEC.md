# BrainLink — Product and Engineering Specification

Status: living specification, updated 2026-10-25. This version supersedes the October 18 plan where they conflict, especially on onboarding, trial/licensing and the product's Personal/Organisation/Client Twin direction. Current code, tests and dated evidence in `docs/IMPLEMENTATION-STATUS.md` determine implementation status.

## 1. What it is

A desktop app + local MCP server that turns user-controlled Obsidian / Markdown vaults into a **governed memory layer shared by authorized AI agents**. Over time, that layer can support a Personal Twin for one person, an Organisation Twin for a company, and isolated Client Twins for client work, while keeping data scope, provenance and approval visible.

The local-first product connects authorized clients to BrainLink. Data is filtered by vault and permissions before retrieval; a remote client requires a separately configured, secured relay and is never assumed to have access by default.

**Promise:** "One brain. Every AI. Nothing overwritten."

## 2. Who buys it

| Segment | Pain | Why BrainLink |
|---|---|---|
| Solo founders / consultants using 2+ AIs | Each AI forgets; context re-pasted every day | One vault, agents with activation / close-loop phrases |
| Small teams with a shared Obsidian / Drive folder | AIs overwrite or pollute notes | Append/new-file only, attribution, preview-then-confirm, secret scan |
| Iango clients | Want an "AI operating memory" without a SaaS | Local, installable, Iango sets it up (service upsell) |

## 3. Product shape

```
┌───────────────────────── Customer's Mac / Windows PC ─────────────────────────┐
│                                                                                │
│  BrainLink.app / BrainLink.exe        brainlink (CLI, same runtime)            │
│   └─ opens Setup UI ─────────┐         ├─ brainlink serve      (stdio MCP)      │
│                              ▼         ├─ brainlink serve --http (local HTTP)   │
│   Setup UI (http://127.0.0.1:<port>, local only, one-time session token)        │
│   1. Add/manage vaults  2. Review privacy  3. Connect AI clients               │
│   4. Browse/edit notes, links, graph, backup and session filing                 │
│                                                                                │
│  config.json  (macOS ~/Library/Application Support/BrainLink,                  │
│                Windows %APPDATA%\BrainLink)                                    │
│                                                                                │
│  Claude Desktop / Claude Code / Cursor / Codex / Gemini CLI ── stdio ──► core  │
│  Grok bot / custom agents ─────────── http://127.0.0.1 + bearer ──────► core  │
│  ChatGPT connectors ── (Pro, opt-in) customer's own HTTPS tunnel ─────► core  │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **Runtime:** the zero-dependency Node core, shipped with the pinned official Node 24.22.1 runtime so the customer installs nothing else.
- **Current build:** every implemented feature is enabled. There is no trial timer, expiration, licence key or account check. Commercial plans and limits are not implemented or approved.
- **Local first:** no cloud relay is implied. Any remote client connection needs an explicit transport, authentication, privacy and deployment design.

## 3a. Twin and memory model

BrainLink is the memory, permissions, provenance and handoff layer; AI agents are replaceable clients. Personal, Organisation and Client Twin describe the product experience built on that layer, not an autonomous person or authority to act. The system organizes four memory types internally without making users file every item into four separate screens:

| Memory type | BrainLink responsibility | User-facing outcome |
|---|---|---|
| Working | Current task, scoped context and handoff state | Continue work across authorized agents |
| Episodic | Session summaries, outcomes, corrections and source links | Find what happened and what changed |
| Semantic | Durable notes, decisions and linked knowledge | Retrieve concise, cited context |
| Procedural | Versioned skills, role instructions and repeatable workflows | Reuse validated ways of working |

For the raw-source → reviewed linked-knowledge flow, see [Raw-to-Wiki knowledge flow](RAW-WIKI-INGESTION-MODEL.md). Setup supports a manual scan or a daily scan at a user-selected local time for one explicitly selected folder. Scans prepare a review queue; they do not create knowledge notes unattended.

At session close, BrainLink should prepare a reviewed summary, explain its destination, preserve source links, and let the user correct or withdraw a proposal. Destination choice should reuse an exact user-approved project route first; otherwise it may suggest a folder from related notes in the explicitly selected vault and abstain when evidence is ambiguous. Saving remains preview-gated. RSI is a core product capability: BrainLink should continually discover ideas from allowed signals and current, source-backed research; triage and deduplicate them; create testable hypotheses; evaluate against fresh cases; and retain only reviewed, reversible gains. A local append-only RSI idea ledger is implemented in Setup, together with opt-in, pausable discovery from user-selected fixed arXiv, Crossref and GitHub public repository metadata endpoints that file relevant papers or projects as `discovered` proposals explaining which user problem and memory workflow they relate to (see [RSI research discovery](RSI-DISCOVERY.md)); always-on research and sandbox experiment execution are not. It may evaluate placement, links, retrieval quality, continuity, reliability and token/time cost; it must not silently promote uncertain facts, broaden permissions, or change live behavior without validation and rollback. “Recursive gain” requires evidence that the improvement method itself improves later experiments. See [BrainLink RSI operating model](RSI-OPERATING-MODEL.md) for status, autonomy and acceptance gates.

For company and workflow knowledge, BrainLink now supports an optional typed semantic layer over the existing note-link graph: entity and workflow records connected by explicit predicates such as `owned_by`, `runs`, `consumes`, and `produces`. Current support requires manually authored, verified Markdown frontmatter; it does not automatically extract or propose relationships. Edges require provenance, confidence, review state, current records, matching scope, and authorized endpoints. See [Typed knowledge graph design review](GRAPH-KNOWLEDGE-MODEL.md). This first slice is locally tested; improved answer quality or token savings have not been demonstrated.

## 3b. GitHub-backed shared knowledge (partial implementation)

Users may opt to keep selected Markdown knowledge in GitHub so authorized AI clients can reuse it and edits have a reviewable commit history. GitHub is an optional shared publication layer; it does not replace the existing vault or BrainLink permission-filtered access. The implementation includes an authenticated Setup UI, read-only preview, separately confirmed local commit and push, privacy-filtered import, receipt-gated fast-forward updates, and local-preserving conflict copies. Each operation requires a Personal, Organisation, or Client Twin profile with a confirmed repository assignment; no-profile and unassigned-profile setups fail closed. Automatic remote sync is not implemented; live GitHub account permissions and cross-device behavior remain unverified. See [GitHub-backed shared knowledge](GITHUB-SHARED-KNOWLEDGE.md) for the user flow and acceptance criteria.

Security defaults: separate repositories for Personal, Organisation and each Client scope; explicit folder allowlists; private notes, sessions and secrets excluded before preview, staging, import, and push; credentials supplied by the OS Git helper; no force-push or silent conflict resolution. A repository's collaborator access applies to the whole repository, not an individual folder, so an AI granted direct GitHub access can bypass BrainLink's per-agent filtering. First publication must be reviewed, and automatic sync requires a separate opt-in. GitHub history may retain content after edits or deletes; do not describe GitHub as end-to-end encrypted or as a complete backup. Profile-aware repository assignment and API scoping are implemented and locally tested; live account permissions, cross-device use, automatic synchronization, and customer readiness remain unverified.

## 4. Core (from vault-agent v0.2, made generic)

Everything Ian-specific moves into **config**. Nothing in code names Ian, Iango, Anna, Brain, Drive or Taipei.

| v0.2 hard-code | v1 |
|---|---|
| 3 vaults + Drive base path | `vaults[]`: `{name, path, private, schema, intake_folder, read_first[], folders{}, rules[], writes: "on"|"proposal-only"|"off"}` |
| Anna / John / Paula / Livva + Anna-specific CSV loaders | `agents[]`: `{name, vault, role, activation[], close[], connect_notes[], recent_dir, tail_notes[], close_target{mode, path|dir}}`; modes `append-section`, `new-note`, `append-task`, `proposal-only` |
| Brain / personal / livva frontmatter | schema presets `standard` (ai_platform, agent_or_role, session_or_task_id, written_at…) and `provenance` (created_by_* …) + `extra_fields{}` |
| Asia/Taipei | `timezone` (IANA, default = OS zone) |
| Handoff mailbox in Brain | `handoff: {vault, folder}` (optional) |
| Brain 3D graph import from Drive | bundled clean graph module (wikilinks, md links, terms, related suggestions) |
| `IANGO_*` env | `BRAINLINK_*` env (platform, vaults, read-only) per AI connection |

**Rule packs** (templates the Setup UI offers): *Simple* (one vault, intake folder, one "Assistant" agent), *Founder OS* (company vault + CEO agent + close-loop captures + handoff mailbox — the generic shape of Ian's Anna), *Private journal* (proposal-only writes). Customers edit any of it.

Tools stay the same names (`agent_connect`, `agent_close_loop`, `vault_search`, `vault_read_note`, `vault_related`, `propose_note`, `send_handoff`, `list_handoffs`, `search`, `fetch`, `brainlink_guide`) so prompts and phrases work across AIs.

Safety kept: per-connection vault scope, read-only mode, preview-unless-confirm, new/append only, existing folders only, generated index notes protected, secret scan, private vaults excluded from connector search, path-escape guard.

## 4b. Smart features (v1.1, added 2026-10-18 at Ian's request)

Clean-room implementations of the strongest patterns in Obsidian Copilot, Khoj and meeting-note tools, plus BrainLink's own linking:

| Feature | What the user gets | Pattern source |
|---|---|---|
| **Auto-linking** | Every note an AI writes gets a Related section: existing notes it mentions by name, then the most similar notes. Close-loop captures get a Related line. Old notes are never edited. | Obsidian unlinked mentions; TF-IDF similarity |
| **Home map** | `BrainLink/Home.md` links every note, recent changes and unlinked notes; rebuilt after each write; never replaces a user's own note | Obsidian MOC practice |
| **Meaning-based search** | If Ollama with an embedding model is installed, search fuses keyword and meaning results; vectors cached per chunk hash on this computer; off otherwise | Khoj bi-encoder + hash-incremental index |
| **Smarter keyword search** | Stemming, `#tag` and `[[Note]]` guaranteed hits, rephrasings fused (RRF), folder / tag / date filters, graph boost from links, co-citations and shared tags | Copilot v3 search, query expansion, graph boost |
| **Memories** | "Remember that…" saves a fact every AI sees when it connects; duplicates skipped | Copilot saved memories |
| **Open loops & brief** | Unchecked tasks, next actions, unresolved questions, decisions waiting; "Brief me" combines changes, open items and link health | Khoj automations (on-demand) |
| **Templates** | Meeting (transcripts → attendees as links, action items as tasks), decision, person, project, idea | Meetily / Anarlog meeting notes |
| **Daily note** | Quick capture into today's note, honouring Obsidian's daily-note folder and format | Obsidian daily notes |
| **Link health** | Unlinked notes, broken links, duplicate titles, stale active notes | — |
| **Shared commands** | Notes in `BrainLink/Commands` become slash-command prompts in every MCP client (weekly review, meeting notes, link my notes ship as starters) | Copilot commands shared across agents |
| **Smart connect** | "Connect to …" also loads what changed this week, open loops and memories | — |
| **Graph view** | Setup shows the vault as a live link map with notes / links / unlinked counts | Brain 3D |

Not yet: scheduled briefs (needs a background helper), cross-encoder rerank, cloud embedding providers.

## 4c. Historical retrieval-quality experiment (2026-10-18)

This is a historical development receipt, not a current product-quality or marketing claim. It used small question sets, including a 7-query held-out set; see `docs/RETRIEVAL-EVAL.md` and the current implementation ledger for the stricter evaluation requirements.

Scored read-only on Iango's own Brain vault (2,135 notes, 15k chunks; nothing written), with the Technical Reviewer's independent gold sets. Questions were typed as written; the evaluation notes themselves were excluded.

| Set | BrainLink 1.1 | Grok prototype brain_mcp v0.4 (same questions) |
|---|---|---|
| Gold set, 28 answerable: answer in top 5 | **27/28**, MRR@5 0.82 | 22/28 typed as written (27/28 with keyword-rewritten queries, MRR 0.85) |
| Chinese questions | 8/9 | 8/8 (keyword) |
| False "not in brain" on answerable questions | **0** | 5 |
| Held-out set (7, mostly Chinese → English notes), with the AI's translation | 6/7, MRR 0.61 (2/7 without translation) | not reported |
| Private-topic traps answered "not in brain" | 2/4 without translation; near-misses flagged "weak" | 2/4 |
| Tokens per answer (est.) | ~950 | ~1,060 |

What made the difference: one result per note; title/alias field ranking weighted by word rarity; index, draft and staging copies demoted; date matching ("10-09" → 2026-10-09); Chinese function-word filtering; language-weighted fusion of the question and its translation; "not in brain" only when coverage is low and the question uses none of the vault's own words.

Still weak: cross-language and synonym questions without a translation (needs a multilingual embedding model such as bge-m3 via Ollama, already supported); proving a private topic is absent (lexical search can only flag "weak").

## 5. Onboarding (target: under 1 minute)

1. Install (.pkg / .exe / .deb or Linux tar.gz) → app opens Setup UI in the browser.
2. **Add vault folders** (native folder dialog where available, or paste a path). BrainLink scans each and shows note count and privacy scope.
3. **Pick a rule pack**, name agents and phrases (e.g. "Connect to Max" / "Max close loop").
4. **Connect AIs**: one button each. BrainLink detects installed clients and writes their MCP config, keeping a timestamped backup: Claude Desktop (`claude_desktop_config.json`), Claude Code (`~/.claude.json` via `claude mcp add` when present), Cursor (`~/.cursor/mcp.json`), Codex (`~/.codex/config.toml`), Gemini CLI (`~/.gemini/settings.json`). For HTTP clients it shows URL + generated token.
5. **Test**: "Ask your AI: *Connect to Max*" — Setup UI shows the live call log so the user sees it work.

## 6. Packaging & distribution

| | macOS | Windows | Linux |
|---|---|---|---|
| Installer | `.pkg` (pkgbuild + productbuild): `/Applications/BrainLink.app` + CLI link | Inno Setup `.exe` (per-user, no admin) | `.deb` (amd64/arm64) or per-user tar.gz installer |
| Runtime | official Node 24.22.1 universal (arm64 + x64) inside the app bundle | official Node 24.22.1 x64 `node.exe` inside the install dir | official Node 24.22.1 x64 or arm64 inside the package |
| Signing | Developer ID signing and notarisation are still release gates | Authenticode signing is still a release gate | Signed repository/package distribution is not yet designed |
| Store | Direct download; Mac App Store sandbox needs separate design | Microsoft Store/MSIX needs separate design | Package repository and update policy need separate design |
| Updates | Signed update manifest and updater are not implemented | same | same |

## 7. Commercial model and legal terms

No pricing, paid feature limits, payment provider, licence-key system, or account plan has been approved or implemented. The previous free-tier limits and 14-day trial proposal are superseded. Keep the full development build enabled and non-expiring. Before sale, research current alternatives and costs, choose a model with Ian, and obtain legal review of final terms. Do not add trial countdowns or feature gates as an implementation shortcut.

## 8. Release and quality gates

The repository's GitHub Actions workflow runs the core and UI suites on Windows, macOS and Linux with Node 22/24 and builds unsigned desktop packages using the pinned Node runtime. Workflow artifacts are development evidence, not a public release. A release still needs successful remote build receipts, real install/upgrade/uninstall checks, signing, accessibility and user-task validation, privacy evaluation, a backup restore drill, and an approved commercial/legal package.

## 9. Current implementation target

The current source branch targets the next development build, `1.2.8`, after the separate `v1.2.7` release tag. `package.json` is the sole version source; the server, installers and lockfile must stay aligned. No new release tag is created by ordinary development pushes.

Keep the priority on a simple desktop app, multi-vault management, interactive graph and note editing, governed cross-AI handoff, reviewable session filing, permission-aware retrieval, measurable token/time efficiency, backup/restore, and evidence-based RSI. Current implementation and unresolved release gaps are tracked in `docs/IMPLEMENTATION-STATUS.md`.

## 10. Legal / IP

- Clean-room code; no code from Obsidian Copilot / Khoj (AGPL). Patterns only, documented.
- Bundled Node.js runtime is MIT; include its LICENSE in the app.
- BrainLink does not upload vaults to Iango. Connected AI providers may receive the specific context a user requests; product privacy terms must explain that clearly.
