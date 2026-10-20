# BrainLink MCP — Product Spec v1 (approved)

Status: **approved by Ian 2026-10-18** · drafted 2026-10-17 · Platforms decided with Ian: **macOS + Windows desktop** (no iPhone/iPad in v1); **Linux added 2026-10-19** at Ian's request. First build: **macOS**.

## 1. What it is

A desktop app + local MCP server that turns any Obsidian / Markdown folder into a **shared, rule-following second brain for every AI** the customer uses: Claude (Desktop, Code), ChatGPT Codex, Cursor, Gemini CLI, Grok/any Streamable-HTTP client, and ChatGPT connectors (via an optional tunnel).

The customer's notes never leave their machine. The AI connects to `brainlink` locally; BrainLink enforces the customer's vault rules on every read and write.

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
│   1. Pick vault folder(s)  2. Choose a rule pack  3. Define agents             │
│   4. "Connect" buttons per AI  5. Enter licence key                            │
│                                                                                │
│  config.json  (macOS ~/Library/Application Support/BrainLink,                  │
│                Windows %APPDATA%\BrainLink)                                    │
│                                                                                │
│  Claude Desktop / Claude Code / Cursor / Codex / Gemini CLI ── stdio ──► core  │
│  Grok bot / custom agents ─────────── http://127.0.0.1 + bearer ──────► core  │
│  ChatGPT connectors ── (Pro, opt-in) customer's own HTTPS tunnel ─────► core  │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **Runtime:** the existing zero-dependency Node 22 core, shipped with an embedded official Node runtime so the customer installs nothing else.
- **No cloud service in v1.** Licence check is offline (signed key). This keeps cost ~0 and privacy simple.

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

## 4c. Retrieval quality on a real vault (2026-10-18)

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

1. Install (.pkg / .exe) → app opens Setup UI in the browser.
2. **Pick vault folder** (native folder dialog: `osascript` on Mac, PowerShell on Windows; or paste a path). BrainLink scans it and shows note count.
3. **Pick a rule pack**, name agents and phrases (e.g. "Connect to Max" / "Max close loop").
4. **Connect AIs**: one button each. BrainLink detects installed clients and writes their MCP config, keeping a timestamped backup: Claude Desktop (`claude_desktop_config.json`), Claude Code (`~/.claude.json` via `claude mcp add` when present), Cursor (`~/.cursor/mcp.json`), Codex (`~/.codex/config.toml`), Gemini CLI (`~/.gemini/settings.json`). For HTTP clients it shows URL + generated token.
5. **Test**: "Ask your AI: *Connect to Max*" — Setup UI shows the live call log so the user sees it work.

## 6. Packaging & distribution

| | macOS | Windows |
|---|---|---|
| Installer | `.pkg` (pkgbuild + productbuild): `/Applications/BrainLink.app` + `/usr/local/bin/brainlink` symlink | Inno Setup `.exe` (per-user, no admin) in v1; MSIX in v1.1 |
| Runtime | official Node 22 universal (arm64 + x64) inside the app bundle | official Node 22 x64 `node.exe` inside the install dir |
| Signing | **Developer ID Application + Developer ID Installer** certificates (Apple Developer Program, US$99/yr) → `notarytool submit` → `stapler staple`. Until then: unsigned test build (right-click → Open) | Authenticode via **Azure Trusted Signing** (~US$10/mo) or an OV cert; avoids SmartScreen warnings |
| Store | **Not Mac App Store**: its sandbox blocks writing other apps' MCP config files and reading arbitrary vault folders without per-folder bookmarks. Direct download. | Microsoft Store optional later (MSIX) — same sandbox caveats, lower priority |
| Updates | in-app "check for update" against a signed `latest.json` on Iango's site (v1.1) | same |

## 7. Licensing & payment

- **Merchant of record: Lemon Squeezy or Paddle** — handles card payment, VAT/GST, invoices, Taiwan business payouts; both issue licence keys via webhook.
- **Licence key = Ed25519-signed token** (`BL1.<payload>.<sig>`, payload `{email, plan, seats, expires, updates_until}`), verified **offline** with the public key in the app. Iango keeps the private key (`brainlink-license issue …` tool, never shipped).
- **Free mode without key:** 1 vault, read + search only, 2 AI connections. Key unlocks writes, agents, unlimited AIs, HTTP mode.
- 14-day trial key issued from the website.

## 8. Pricing (proposal)

| Plan | Price | Includes |
|---|---|---|
| Free | US$0 | 1 vault, read/search, 2 AIs |
| **Personal** | **US$79 one-time** (1 year of updates; renew updates US$39/yr) | Unlimited vaults & AIs, agents + close loop, safe writes, HTTP mode, 2 devices |
| Team | US$12 / user / month (min 3) | Shared-folder setup, team rule pack, priority support |
| Iango Setup | from NT$15,000 | Iango designs the customer's vault, agents and rules (consulting upsell) |

Rationale: one-time pricing sells well for local developer tools (no server cost to cover); Team is where recurring revenue and Iango's consulting margin live.

## 9. v1 build scope (this session)

1. `brainlink` core: generic config, bundled graph module, BRAINLINK_* env, timezone, rule packs, licence verify.
2. Setup UI + "Connect AI" config writers (with backups) + folder picker.
3. Synthetic sample vault ("Acme Studio") — no Ian data.
4. macOS `.pkg` build script → unsigned test installer; signing/notarisation steps scripted, run when certificates exist.
5. Windows: NSIS installer `.exe` + portable zip built on macOS; Windows code paths covered by tests; **not yet run on a real Windows PC**.
5b. Linux: `.deb` (amd64, arm64) + per-user tar.gz installer; tested in Debian 12, Ubuntu 24.04 and Fedora 41 containers.
6. Tests (`npm test`) covering core, config, licence, connectors, installer layout.
7. Sales one-pager.

Out of v1: iPhone/iPad, hosted relay, embeddings, auto-update, MSIX, Team sync.

## 10. Legal / IP

- Clean-room code; no code from Obsidian Copilot / Khoj (AGPL). Patterns only, documented.
- Bundled Node.js runtime is MIT; include its LICENSE in the app.
- No customer data leaves the device; privacy policy states this.
