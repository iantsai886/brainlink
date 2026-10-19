# BrainLink MCP

One Obsidian / Markdown vault that every AI can search and write to safely: Claude Desktop and Claude Code, ChatGPT Codex, Cursor, Gemini CLI, Windsurf, and any Streamable-HTTP MCP client (such as Grok bots). Product spec: [docs/PRODUCT-SPEC.md](docs/PRODUCT-SPEC.md).

## For customers

1. Install `BrainLink-<version>.pkg` (macOS), `BrainLink-Setup-<version>.exe` (Windows), or on Linux the `.deb` or `brainlink-<version>-linux-<arch>.tar.gz` (run `./install.sh`).
2. Setup opens in your browser: choose your vault folder and a rule pack, then name your agent.
3. Press **Connect** for each AI app, then restart that app.
4. In the AI, say **"Connect to <agent>"**. Say **"<agent> close loop"** to save the session to your vault.

## Command line

```
brainlink setup | init | connect <client|all> | disconnect <client> | clients | license [KEY] | status | sync | serve [--http]
```

`connect` also accepts `--all`. `sync` runs one sync pass (local-only by default; choose Drive, iCloud or Dropbox in Setup).

## Smart features

- **Auto-linking:** every note an AI writes links the notes it mentions or is about, and `BrainLink/Home.md` links everything, so notes connect even without Obsidian.
- **Search:** keyword (stemmed, filters, `#tag`, `[[Note]]`, fused rephrasings) plus meaning-based search when Ollama is installed (`ollama pull nomic-embed-text`).
- **Tools:** `brain_brief`, `vault_recent`, `open_loops`, `vault_health`, `remember`, `append_daily`, `propose_note` templates (meeting, decision, person, project, idea). `session_list`, `session_read`, `session_log` read local AI session history (imported from Claude Code and Codex, or logged directly) — summary-first and private by default; see `docs/SESSION-INDEX.md`.
- **Shared commands:** notes in `BrainLink/Commands/` become slash commands in every AI.

## How it is safe

- New notes or appends only. Nothing is ever overwritten or deleted.
- Every write is previewed first; `confirm=true` writes it. A close phrase authorises its capture.
- Attribution on every write (`ai_platform`, `agent_or_role`, `session_or_task_id`, timestamp) in the vault's schema (`standard` or `provenance`).
- Vault scope per AI connection (`BRAINLINK_VAULTS`), read-only connections (`BRAINLINK_READ_ONLY=1`), proposal-only vaults and agents.
- Refuses secret-looking content (API keys, tokens, card or account numbers).
- Private vaults are left out of connector `search`/`fetch`.
- HTTP mode listens on 127.0.0.1 only and needs a bearer token. The Setup UI is local-only, uses a per-session token and checks the Host header.

## Config

`~/Library/Application Support/BrainLink/config.json` (macOS) or `%APPDATA%\BrainLink\config.json` (Windows). Vaults (`name, path, private, schema, intake_folder, decisions, read_first, folders, rules, writes, flat, protected, extra_fields`), agents (`name, vault, role, activation, close, connect_notes, tail_notes, recent_dir, close_target {mode: append-section | new-note | append-task | proposal-only}`), optional `handoff {vault, folder}`, `timezone`, `license`, `http`, optional `sync {provider: local|gdrive|icloud|dropbox, folder, device}` (local by default).

## Developers

```bash
npm install               # links the sibling brainlink-store checkout (file:../brainlink-store)
npm test                  # one test suite, no external dependencies (Node 22+)
npm run build:mac        # dist/BrainLink-<version>.pkg
npm run build:win        # dist/BrainLink-Setup-<version>.exe + portable zip (needs makensis)
npm run build:linux      # dist/*.deb + linux tar.gz for x64 and arm64
node tools/license-issue.mjs issue --email buyer@example.com --plan personal   # vendor only
```

Dependency: `brainlink-store` (`../brainlink-store`, this repo's sibling) — the Obsidian-independent store contract. Not vendored; see that repo's README for how the UI (`ui/app/`) resolves the same checkout.

Packaging notes: [Windows](packaging/windows/README.md), [Linux](packaging/linux/README.md). Clean-room code: no code from Obsidian Copilot or Khoj (AGPL).

## Change Log

- 2026-10-19: Session tools (`session_list`, `session_read`, `session_log`) over a local, private-by-default session store, with read-only importers for Claude Code and Codex (`src/sessions/`, `docs/SESSION-INDEX.md`). `brainlink sync` wires `config.json`'s new optional `sync` key to the sync engine (local by default). `brainlink connect` accepts `--all`; `detect()` now reports ChatGPT honestly as needing a remote HTTPS connector (pending Ian). Depends on `brainlink-store` v0.2 (`search`, `Session.project`/`private`, `SessionRecord`).
