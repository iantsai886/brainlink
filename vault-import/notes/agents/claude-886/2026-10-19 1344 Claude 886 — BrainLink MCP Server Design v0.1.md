---
type: design
status: proposed
owner: Claude 886
ai_platform: Grok Bot
agent_or_role: Claude 886
session_or_task_id: brainlink-step1-2026-10-19
written_at: 2026-10-19T13:44:42+08:00
source: "Paulo MCP addendum 2026-10-19; PRODUCT-SPEC v1 §3-§5; BrainLink v1.1 tool set (src/core.mjs, tests); store contract d8e792b"
confidence: medium
tags: [brainlink, mcp, sessions, connect, design]
aliases: [BrainLink MCP Server Design v0.1, BrainLink session tools]
---
Made by Claude 886.

# BrainLink — MCP Server Design v0.1 (server side)

**Purpose:** any AI connects in one shot and, from any session, reaches every session plus the second brain. Built on the existing v1.1 server. **No renames, no new server.** The changes are three session tools and `brainlink connect`.

## 1. Server (unchanged from v1.1)
- One `brainlink` runtime. `brainlink serve` is stdio. `brainlink serve --http` binds to **127.0.0.1 only**, default port 8765, with a bearer token from config.
- Existing tools keep their names, as PRODUCT-SPEC §4 requires:
  - connect and close: `agent_connect`, `agent_close_loop`;
  - read: `vault_search`, `vault_read_note`, `vault_related`, `vault_recent`, `vault_health`, `open_loops`, `brain_brief`;
  - write: `propose_note` (preview, then a confirmed commit), `remember`, `append_daily`;
  - handoffs: `send_handoff`, `list_handoffs`;
  - ChatGPT compatibility: `search`, `fetch`;
  - help: `brainlink_guide`.
- The addendum's names map onto these: brain_search = `vault_search`, brain_read = `vault_read_note`, brain_write = `propose_note` (preview + confirm token). This avoids duplicate tools, which would cost tokens on every `tools/list`.
- All tools now read from and write to the store (contract d8e792b) instead of the vault folder.

## 2. New tools (3)
| Tool | Input schema | Returns | Budget |
|---|---|---|---|
| `session_list` | `{q?:string, client?:string, vault?:string, since?:string(ISO), limit?:int≤20 (default 8)}` | `[{id, client, title, summary, updated_at, message_count}]` | ≤ ~400 tok |
| `session_read` | `{id:string, offset?:int, limit?:int≤20, full?:bool}` | the session summary + `note_refs`; messages only if `limit>0`, each capped at 400 chars unless `full`; `next_offset` | default ~150 tok; ≤1,500 per page |
| `session_log` | `{title:string, text:string, role?:"note"\|"user"\|"assistant", session_id?:string, vault?:string}` | `{id, message_count}` | ~40 tok |

- Results are summary-first: full text only when asked, and paged. A typical cross-session answer (list, then one read) stays at or below ~1,050 tokens.
- `session_log` covers clients with no readable history, such as ChatGPT, Claude Desktop and Grok. Its `source_id` is the connection name plus the date, so one session per client per day by default.
- Summaries: importers keep the client's own title or summary if it has one. Otherwise they use the first user line plus the last assistant line, trimmed to 60 tokens. No LLM call is made, so it costs nothing.

## 3. Session importers (local, read-only, incremental by file mtime + size)
| Client | Source | Status |
|---|---|---|
| Claude Code | `~/.claude/projects/<proj>/*.jsonl` | ready to build (documented JSONL) |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | ready to build |
| Gemini CLI | `~/.gemini/tmp/<hash>/` logs or checkpoints | best-effort; skipped if the format is unknown |
| Cursor | `state.vscdb` (SQLite) chat keys | best-effort via `node:sqlite`, read-only; the format is undocumented |
| Claude Desktop, ChatGPT, Windsurf | no stable readable local history | `session_log` |

**Vault mapping.** A session goes to the vault whose folder contains the project's working directory. Otherwise it goes to the config's `sessions.vault`, which defaults to a **private, local-only** "Sessions" vault. Sessions never sync unless the user opts in. Private vault ⇒ private session.

**Secret filter.** Every import and log runs the v1.1 `findSecrets` patterns, plus the user's own term list (the brain-tools `redact.local` idea). Matches are replaced with `[redacted:<kind>]` before reaching the store, and the store rejects anything left over (`E_INVALID`). Tool output and file paths outside the vault are dropped, and the importer stores only user and assistant text. This is the brain-tools upload_gate idea: block, don't trust.

## 4. One-shot connect
- `brainlink connect <client>` (and `--all`, `--dry-run`, `disconnect`) wraps the existing `connectors.mjs` `connectClient`. It detects the client, writes the config with a timestamped backup, and prints one line to paste: "Connect to <agent>".
- Clients: Claude Desktop (`claude_desktop_config.json`), Claude Code (`claude mcp add` or `~/.claude.json`), Cursor (`~/.cursor/mcp.json`), Codex (`~/.codex/config.toml`), Gemini CLI (`~/.gemini/settings.json`), Windsurf (`~/.codeium/windsurf/mcp_config.json`, new), and any HTTP client (URL + token).
- The UI's Connect screen (ChatGPT 886) calls the same function.
- **ChatGPT, honestly:** ChatGPT connectors and developer mode need a **public HTTPS** MCP URL. They can't reach 127.0.0.1. PRODUCT-SPEC already plans an opt-in customer-run tunnel (Pro). That conflicts with "localhost only", so **it needs Ian's decision** (see the open questions). Until he decides, ChatGPT uses copy-paste plus `session_log` through any connected client, or Codex, which is local.

## 5. Migration from box brain_mcp v0.5
- brain_mcp is frozen, per the joint plan: no box track, and search is tuned only in the Mac core.
- Carried over as ideas only: the redact term file, the "not in brain" coverage rule (v1.1 already has its own), and sha-guarded preview-then-confirm writes (v1.1 `propose_note` has the same shape).
- The box brain_mcp config entries stay until Ian switches clients. After that, `brainlink connect` replaces them, with a backup kept.

## 6. Open questions (Ian)
1. ChatGPT: allow an opt-in HTTPS tunnel, which breaks "localhost only" for that connection only, or keep ChatGPT log-only for now?
2. Should sessions sync when the user turns sync on, or stay local-only always? The default is local-only.

## Changelog
- 2026-10-19 v0.1: created.

## Related
- BrainLink build plan 10dqy8BVJPvRhYBqL-JI9t6YiI4Jh0nHT · competitor study 1vnxtuRSoBRYOUuk_6DDCs2MmavPCd4z2 · joint plan 1MWnISJ2aBGK5h8xPVIXruaMT7PxEEYiG · Paulo addendum 1NyuWcYP4CEpxBzOnOgHYW8Jrok5s9sgh
