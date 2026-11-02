# BrainLink — Product and Engineering Specification

Status: living specification, updated 2026-10-30. This version supersedes the October 18 plan where they conflict, especially on onboarding, trial/licensing and the product's Personal/Organisation/Client Twin direction. Current code, tests and dated evidence in `docs/IMPLEMENTATION-STATUS.md` determine implementation status.

## 1. What it is

A desktop app + local MCP server that turns user-controlled Obsidian / Markdown vaults into a **governed memory layer shared by authorized AI agents**. Over time, that layer can support a Personal Twin for one person, an Organisation Twin for a company, and isolated Client Twins for client work, while keeping data scope, provenance and approval visible.

The local-first product connects authorized clients to BrainLink. Data is filtered by vault and permissions before retrieval; a remote client requires a separately configured, secured relay and is never assumed to have access by default.

**Promise:** "One governed memory layer for your supported AI tools. No silent overwrites."

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
│  Claude / Codex / Cursor / Gemini / Antigravity / Hermes / DeepSeek Harness / Windsurf ── stdio ► core │
│  Grok bot / custom agents ─────────── http://127.0.0.1 + bearer ──────► core  │
│  ChatGPT connectors ── (Pro, opt-in) customer's own HTTPS tunnel ─────► core  │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **Runtime:** the Node application and its pinned production dependencies ship with the official Node 24.22.1 runtime so customers do not need a separate Node installation.
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

The `remember` command stores short, user-reported facts with their stated source and a `reported` confidence label. It does not mark a fact independently verified. Existing memory notes remain readable, and connected agents receive the compact fact text rather than the provenance suffix.

For the raw-source → reviewed linked-knowledge flow, see [Raw-to-Wiki knowledge flow](RAW-WIKI-INGESTION-MODEL.md). Setup supports up to 20 explicit folder targets across public vaults. Users can scan manually, scan once daily at a chosen local time, or poll the selected folders every 1, 5, 15, 30, or 60 minutes while BrainLink is open. Failed background scans retry twice, 15 minutes apart; turning background scanning off pauses future runs. Scans prepare a review queue. Supported sources include Markdown, common UTF-8 text/data formats, text-based PDFs up to 100 pages, DOCX, XLSX, PPTX, and PNG/JPEG/BMP images. Office extraction and image OCR run locally with bounded files and output; hidden spreadsheet sheets, rows and columns, and hidden presentation slides are omitted. Image OCR uses bundled English, Portuguese, and Traditional Chinese language data. Scanned PDFs, legacy Word, and other image formats remain unsupported. When the user selects one source, or separately enables automatic local drafts, BrainLink uses the fixed local Ollama service to create an unverified, source-linked draft. Each run is capped at five new source drafts. Failed local model calls use the same bounded retry schedule; drafts already saved for review are skipped on retry. Drafts persist in local app data. By default they await review; a separate auto-file opt-in can save new linked proposals to a selected same-vault destination and never replaces an existing note.

Backup Settings lets users choose a destination and either an hour interval or a fixed daily local time. Daily backups run in the background, verify the new copy, and retry a failed run after a delay. The first verified backup is created when the schedule is saved; encrypted backups require recovery-key confirmation. Legacy configurations keep their interval schedule unless the user changes it.

At session close, BrainLink prepares a summary, explains its destination, preserves source links, and lets the user correct or withdraw a proposal. Destination choice reuses an exact user-approved project route first; manual filing may suggest a folder from related notes in the explicitly selected vault and abstains when evidence is ambiguous. Local AI summaries are opt-in. By default, they stay as private drafts for review. A separate opt-in can automatically save a draft only to a writable folder previously saved for that exact project; it never guesses or falls back to intake. Auto-filed notes remain private, proposed, reported-confidence and explicitly unverified. Without a valid exact route, the draft stays in local BrainLink app data. Claude Code and Codex can trigger drafts from their session-end cues; DeepSeek Harness has only a completed-turn cue, so its draft waits until 30 minutes pass with no newer visible message. This is an inactivity guess, not proof that a conversation ended. BrainLink rechecks the cue after local inference. Live Ollama inference and real client lifecycle behavior remain unverified. RSI is a core product capability: BrainLink should continually discover ideas from allowed signals and current, source-backed research; triage and deduplicate them; create testable hypotheses; evaluate against fresh cases; and retain only reviewed, reversible gains. A local append-only RSI idea ledger is implemented in Setup, together with opt-in, pausable discovery from user-selected fixed arXiv, Crossref and GitHub public repository metadata endpoints that file relevant papers or projects as `discovered` proposals explaining which user problem and memory workflow they relate to (see [RSI research discovery](RSI-DISCOVERY.md)); always-on research and sandbox experiment execution are not. The weekly retrieval benchmark can now run on a user-selected weekday and local time while BrainLink is open, or on demand with **Run benchmark**. It always uses the built-in fictional vault, records aggregate evidence only, and is off by default. It does not read connected vaults or call an AI model. A missed run is retried after restart only when BrainLink starts later on that same scheduled day; failed completed runs wait until the next week unless run manually. This score measures retrieval matching, not answer quality or billed-token savings. It may evaluate placement, links, retrieval quality, continuity, reliability and token/time cost; it must not silently promote uncertain facts, broaden permissions, or change live behavior without validation and rollback. “Recursive gain” requires evidence that the improvement method itself improves later experiments. See [BrainLink RSI operating model](RSI-OPERATING-MODEL.md) for status, autonomy and acceptance gates.

The local session index can also read ended Hermes CLI sessions from one selected profile database. Import is read-only, private by default, and excludes messaging, in-progress or archived history, tool data, and model reasoning. Users can choose a profile folder in **Settings → Sessions** or use Hermes’s default profile; BrainLink never merges profiles automatically. Previously imported sessions remain in local history when the selected profile changes and follow the normal session-sharing settings. See [Session filing and privacy](SESSION-FILING.md).

For company and workflow knowledge, BrainLink supports an optional typed semantic layer over the existing note-link graph: entity and workflow records connected by explicit predicates such as `owned_by`, `runs`, `consumes`, `produces`, and `communicates_with`. Deterministic discovery can suggest a communication link when a sentence explicitly names a visible person/team and says it communicates, talks, coordinates, or hands work off to them. AI clients can also propose evidence-backed typed records and relation candidates through `propose_note`; BrainLink forces the record and edges to remain proposed, validates targets against the same privacy-filtered vault and matching scope, and materializes edges only after a person reviews the Markdown. The graph now includes a central, bounded review queue across enabled non-private vaults; approval still re-reads the source note and requires its current revision. Extraction quality, improved answer quality, and token savings have not been demonstrated. See [Typed knowledge graph design review](GRAPH-KNOWLEDGE-MODEL.md).

Research discovery also has an optional, off-by-default batch check for older saved public citations. After a manual or scheduled discovery run, it checks up to three citations at least 30 days old, only from sources still selected by the user. It records source metadata fingerprints without changing the proposal; the request does not include vault, session, or problem-statement content.

## 3b. GitHub-backed shared knowledge (partial implementation)

Users may opt to keep selected Markdown knowledge in GitHub so authorized AI clients can reuse it and edits have a reviewable commit history. GitHub is an optional shared publication layer; it does not replace the existing vault or BrainLink permission-filtered access. The implementation includes an authenticated Setup UI, read-only preview, separately confirmed local commit and push, privacy-filtered import, receipt-gated fast-forward updates, local-preserving conflict copies, and opt-in per-Twin scheduled sync with manual run, conflict pauses, and exact-commit retry. Each operation requires a Personal, Organisation, or Client Twin profile with a confirmed repository assignment; no-profile and unassigned-profile setups fail closed. Automated tests use a temporary local bare Git remote. Live GitHub account permissions, native sign-in startup, and cross-device behavior remain unverified. See [GitHub-backed shared knowledge](GITHUB-SHARED-KNOWLEDGE.md) for the user flow and acceptance criteria.

Security defaults: separate repositories for Personal, Organisation and each Client scope; explicit folder allowlists; private notes, sessions and secrets excluded before preview, staging, import, and push; credentials supplied by the OS Git helper; no force-push or silent conflict resolution. A repository's collaborator access applies to the whole repository, not an individual folder, so an AI granted direct GitHub access can bypass BrainLink's per-agent filtering. First publication must be reviewed, and automatic sync requires a separate opt-in. GitHub history may retain content after edits or deletes; do not describe GitHub as end-to-end encrypted or as a complete backup. Profile-aware repository assignment, API scoping and scheduled sync are implemented and locally tested; live account permissions, cross-device use and customer readiness remain unverified.

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
| **Auto-linking** | Eligible new notes can get a Related section with visible notes they mention by name and similar notes. Close-loop captures can get a Related line. Old notes are not changed by this linking step. | Obsidian unlinked mentions; TF-IDF similarity |
| **Home map** | `BrainLink/Home.md` links every note, recent changes and unlinked notes; rebuilt after each write; never replaces a user's own note | Obsidian MOC practice |
| **Meaning-based search** | If Ollama with an embedding model is installed, search fuses keyword and meaning results; vectors cached per chunk hash on this computer; off otherwise | Khoj bi-encoder + hash-incremental index |
| **Context packets** | For a question, return a small, cited set of bounded excerpts; open the exact source only when more detail is needed | BrainLink |
| **Smarter keyword search** | Stemming, `#tag` and `[[Note]]` guaranteed hits, rephrasings fused (RRF), folder / tag / date filters, graph boost from links, co-citations and shared tags | Copilot v3 search, query expansion, graph boost |
| **Memories** | "Remember that…" saves a reported fact. An agent can receive it only when its profile enables semantic memory and grants access to that vault; duplicates are skipped. | Copilot saved memories |
| **Open loops & brief** | Unchecked tasks, next actions, unresolved questions, decisions waiting; "Brief me" combines changes, open items and link health. Setup can run it on demand or daily for one explicitly chosen vault, including a private vault; private data stays in the local Setup app. | Khoj automations |
| **Templates** | Meeting (transcripts → attendees as links, action items as tasks), decision, person, project, idea | Meetily / Anarlog meeting notes |
| **Daily note** | Quick capture into today's note, honouring Obsidian's daily-note folder and format | Obsidian daily notes |
| **Link health** | Unlinked notes, broken links, duplicate titles, stale active notes | — |
| **Shared commands** | Notes in `BrainLink/Commands` can be listed as prompts by supported MCP clients that load BrainLink prompts (weekly review, meeting notes, link my notes ship as starters) | Copilot commands shared across agents |
| **Smart connect** | "Connect to …" also loads what changed this week, open loops and memories | — |
| **Graph view** | Setup shows a rotatable 3D map of note links and approved typed relationships. Users can zoom, reset the view, click to open notes, or use the keyboard-accessible note list. Typed relationship suggestions stay out of the graph until separately approved. | Brain 3D |

Not yet: cross-encoder rerank, cloud embedding providers. Scheduled briefs run locally while BrainLink is open; there are no remote notifications, and the brief is stored in BrainLink's local app data rather than written into the vault or shared with connected agents.

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

1. Install (.pkg / .exe / .deb or Linux tar.gz) → app opens Setup UI in a dedicated Edge, Chrome, or Chromium app window when one is installed, with the platform's default browser as a fallback. The window contains only BrainLink's loopback Setup URL. Real install and click-to-open acceptance on each OS remain release checks.
2. **Add vault folders** (native folder dialog where available, or paste a path). BrainLink scans each and shows note count and privacy scope.
3. **Pick a rule pack**, name agents and phrases (e.g. "Connect to Max" / "Max close loop").
4. **Connect AIs**: one button each. BrainLink detects or lets users select supported clients and writes their MCP config, keeping a timestamped backup: Claude Desktop (`claude_desktop_config.json`), Claude Code (`~/.claude.json` via `claude mcp add` when present), Cursor (`~/.cursor/mcp.json`), Codex (`~/.codex/config.toml`), Gemini CLI (`~/.gemini/settings.json`), Google Antigravity (`~/.gemini/config/mcp_config.json`), Hermes Agent (`$HERMES_HOME/config.yaml`; otherwise `%LOCALAPPDATA%\hermes\config.yaml` on Windows or `~/.hermes/config.yaml` on macOS/Linux; an existing legacy Windows `~/.hermes/config.yaml` is also detected), DeepSeek Harness (`$DSH_HOME/profiles/<name>/cordis.patch.yml` for a named profile, or the shared `$DSH_HOME/cordis.patch.yml`; the usual home is `~/.dsh`), and Windsurf. Harness uses its documented `@deepseek-ai/dsh-mcp-client` local stdio config. A named profile gets its own Twin-scoped token; a home-level patch is shared by all Harness profiles and should be used only when that shared access scope is intended. The config writer is locally tested. On 2026-10-30, DeepSeek Harness made live model-driven `vault_search`, `context_packet`, `vault_read_note`, `vault_recent`, and `open_loops` calls through BrainLink using its read-and-propose Organisation profile. The content-free local activity log records successful calls and no writes. This proves one live Harness-to-BrainLink tool path; the task did not test note proposals, privacy canaries, restart behavior, or production readiness. For HTTP clients BrainLink shows URL + generated token. The **Agents** panel also creates a named custom local stdio or remote HTTP MCP entry and shows its exact snippet and unique key once. See `docs/DEEPSEEK-HARNESS-SECONDBRAIN-CONNECTION-PROMPT.md`.
5. **Test**: "Ask your AI: *Connect to Max*" — Setup UI shows the live call log so the user sees it work.

## 6. Packaging & distribution

Native Windows, macOS and Linux packages include the complete runtime dependency set from `package.json`, plus the versioned portable Agent Skills under `skills/`. The installed package must be runnable offline after installation and must not depend on the developer checkout's `node_modules` or skill files.

Setup can install or update BrainLink's versioned Agent Skills in the user-level skill folders for connected Claude Code, Codex CLI, Gemini CLI, Antigravity App/IDE, Antigravity CLI, Hermes Agent, and DeepSeek Harness clients. Antigravity App/IDE and CLI use separate global skill folders but share the same MCP connection. BrainLink tracks owned file hashes and protects user edits and unrelated skills. Skill installation is optional and does not prove live client discovery or model behavior. See `docs/IMPLEMENTATION-STATUS.md` and `skills/README.md`.

| | macOS | Windows | Linux |
|---|---|---|---|
| Installer | `.pkg` (pkgbuild + productbuild): `/Applications/BrainLink.app` + CLI link | Inno Setup `.exe` (per-user, no admin) | `.deb` (amd64/arm64) or per-user tar.gz installer |
| Runtime | official Node 24.22.1 universal (arm64 + x64) inside the app bundle | official Node 24.22.1 x64 `node.exe` inside the install dir | official Node 24.22.1 x64 or arm64 inside the package |
| Signing | Developer ID signing and notarisation are still release gates | Authenticode signing is still a release gate | Signed repository/package distribution is not yet designed |
| Store | Direct download; Mac App Store sandbox needs separate design | Microsoft Store/MSIX needs separate design | Package repository and update policy need separate design |
| Updates | Ed25519 manifest verification, Setup check/download, SHA-256 recheck, and an explicit OS package-open action are implemented; user confirms installation in the OS | same | same |

The verifier accepts only a pinned Ed25519 public key, a signed canonical manifest, a newer version for the requested channel, and a size-bounded package hosted at this repository's matching GitHub release path. Setup downloads only the signed asset, verifies its exact size and SHA-256, then offers a short-lived download link and an explicit OS open action. The OS still asks the user to confirm installation; BrainLink does not silently install updates. The publisher public key is intentionally not provisioned in this development build, so live update checks return unavailable. There is no production signing key, signed release manifest, or public update feed configured. Platform package signing and public-release acceptance remain open gates.

The repository also provides `npm run updates:sign-manifest -- --payload FILE --key PRIVATE_KEY_FILE --out ENVELOPE_FILE`. It validates a release payload through the shipped verifier, signs canonical JSON with an Ed25519 key, derives the key ID, refuses to overwrite an existing envelope, and never writes private key material to output. Unix key files must be owner-only. No production key is stored in the repository; the signer is release tooling and does not enable in-app updates.

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
