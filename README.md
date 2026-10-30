# BrainLink

Obsidian / Markdown vaults that authorized AI agents can search and write to safely through supported connectors: Claude Desktop and Claude Code, ChatGPT Codex, Cursor, Gemini CLI, Google Antigravity, Hermes Agent, DeepSeek Harness, Windsurf, and custom Streamable-HTTP MCP clients. Remote clients need a separately configured secure HTTPS relay. Product spec: [docs/PRODUCT-SPEC.md](docs/PRODUCT-SPEC.md). Typed company/workflow graph design: [docs/GRAPH-KNOWLEDGE-MODEL.md](docs/GRAPH-KNOWLEDGE-MODEL.md).

## For customers

1. Install `BrainLink-<version>.pkg` (macOS), `BrainLink-Setup-<version>.exe` (Windows), or on Linux the `.deb` or `brainlink-<version>-linux-<arch>.tar.gz` (run `./install.sh`).
2. Setup opens in a dedicated Edge app window on Windows (or your default browser if Edge is unavailable); on macOS/Linux it opens in your default browser. Choose your vault folder and a rule pack, then name your agent.
3. Press **Connect** for each AI app, then restart that app.
4. In the AI, say **"Connect to <agent>"**. Say **"<agent> close loop"** to save the session to your vault.

## Command line

```
brainlink setup | init | connect <client|all> | disconnect <client> | clients | status | sync | ui | demo | serve [--http]
```

`connect` also accepts `--all`. `sync` runs one sync pass (local-only by default; choose Drive, iCloud or Dropbox in Setup).

## Smart features

- **Auto-linking:** every note an AI writes links the notes it mentions or is about, and `BrainLink/Home.md` links everything, so notes connect even without Obsidian.
- **Search:** keyword (stemmed, filters, `#tag`, `[[Note]]`, fused rephrasings) plus meaning-based search when Ollama is installed (`ollama pull nomic-embed-text`).
- **Separate workspaces:** connect multiple vaults and Personal, Organisation, or Client Twins with their own allowed data and memory types.
- **Four memory types:** BrainLink organizes current work, past sessions, lasting knowledge, and reusable skills in the background. Users do not need to sort every note by hand.
- **Interactive 3D graph:** rotate and zoom the note-link map, click a note to open it, or use the keyboard-accessible note list; private notes stay filtered unless explicitly shown in local Setup.
- **Tools:** `brain_brief`, `vault_recent`, `open_loops`, `vault_health`, `remember`, `append_daily`, `propose_note` templates (meeting, decision, person, project, idea), and the Raw-to-Wiki review flow (`ingestion_queue` / `ingestion_record`). Setup can scan one selected non-private folder manually or once daily; scans only prepare a review queue and never file knowledge automatically. `session_list` and `session_read` access approved local AI history; `session_log` saves short notes. For profile-scoped AIs, session logging is a separate opt-in permission; entries are forced private and tied to that Personal, Organisation, or Client profile. See `docs/SESSION-INDEX.md`.
- **Shared commands:** notes in `BrainLink/Commands/` can appear as prompts in supported MCP clients that load configured BrainLink prompts.
- **Portable Agent Skills:** `brainlink-session-closeout`, `brainlink-raw-to-wiki`, and `brainlink-cross-ai-handoff` are versioned in Git, with Claude/Codex-compatible copies. Desktop installers include these skills and all runtime packages.
- **Scheduled backup:** choose a backup folder and schedule. BrainLink checks each backup; restore tools help recover a vault when needed. Encrypted backups use a recovery key.
- **Governed improvement:** optional RSI research and health checks create review proposals. They do not change code, permissions, or vault content by themselves.

## How it is safe

- AI note tools create new notes or append to approved targets; they do not replace an existing note. The user can still edit or delete notes through their vault and editor.
- Note proposals show a preview and need explicit confirmation. Optional automatic closeout can save only a private, unverified draft to a previously approved route.
- Attribution on every write (`ai_platform`, `agent_or_role`, `session_or_task_id`, timestamp) in the vault's schema (`standard` or `provenance`).
- Vault scope per AI connection (`BRAINLINK_VAULTS`), read-only connections (`BRAINLINK_READ_ONLY=1`), proposal-only vaults and agents.
- Scans proposed text for common secret patterns and blocks flagged content; this cannot guarantee that every secret is detected.
- Private vaults are left out of connector `search`/`fetch`.
- HTTP mode listens on 127.0.0.1 only and needs a bearer token. The Setup UI is local-only, uses a per-session token and checks the Host header.

## Config

`~/Library/Application Support/BrainLink/config.json` (macOS) or `%APPDATA%\BrainLink\config.json` (Windows). Vaults (`name, path, private, schema, intake_folder, decisions, read_first, folders, rules, writes, flat, protected, extra_fields`), agents (`name, vault, role, activation, close, connect_notes, tail_notes, recent_dir, close_target {mode: append-section | new-note | append-task | proposal-only}`), optional `handoff {vault, folder}`, `timezone`, `locale`, `http`, optional `sync {provider: local|gdrive|icloud|dropbox, folder, device}` (local by default).

## Developers

Current feature, test, cross-client and release status: [docs/RELEASE-READINESS.md](docs/RELEASE-READINESS.md). This development branch has local test evidence, but is not yet release-ready.

```bash
npm install               # uses the checked-in store implementation (file:./vendor/brainlink-store)
npm test                  # core suite (Node 22+)
npm run test:ui           # local UI-model suite
npm run test:all          # core + UI suites
node bin/brainlink.mjs demo   # try the milestone UI on a throwaway sample vault, nothing real touched
node bin/brainlink.mjs ui     # same UI on the vaults in config.json
npm run build:mac        # dist/BrainLink-<version>.pkg (unsigned build: packaging/macos/INSTALL-UNSIGNED.md)
npm run build:win        # dist/BrainLink-Setup-<version>.exe + portable zip (needs makensis)
npm run build:win-preview # dist/BrainLink-Preview-<version>-windows.zip — no installer, no bundled Node, Node 22+ required
npm run build:linux      # dist/*.deb + linux tar.gz for x64 and arm64
```

Dependency: `brainlink-store` (`vendor/brainlink-store`) — the recovered local v0.2 implementation, checked in so a fresh install does not need an unknown sibling checkout. Its advertised original contract-test file was not available; see `docs/STORE-RECOVERY.md`. `src/store/folder-store.mjs` is the real vault backing it: every note is a plain Markdown file in the vault folder (frontmatter is left byte-for-byte untouched until that note is actually edited through the API), with CAS/versions/sessions/snapshots delegated to `brainlink-store`'s reference implementation and search routed through `src/core.mjs` (the same ranking the MCP tools use).

Packaging notes: [Windows](packaging/windows/README.md), [macOS unsigned install](packaging/macos/INSTALL-UNSIGNED.md), [Linux](packaging/linux/README.md). Clean-room code: no code from Obsidian Copilot or Khoj (AGPL).

## Change Log

- 2026-10-19: `brainlink ui` and `brainlink demo` serve the milestone UI (`ui/app/`, unmodified) on 127.0.0.1 with a per-launch token, backed by a real Markdown-folder `BrainStore` (`src/host.mjs`, `src/store/folder-store.mjs`, `src/ui-server.mjs`). `demo` copies `samples/acme-studio` into a throwaway temp vault first, so trying it never touches a real vault or `config.json`. Windows: `packaging/windows/build-portable-zip.sh` (`npm run build:win-preview`) makes a no-installer preview zip for a machine that already has Node. macOS: `packaging/macos/INSTALL-UNSIGNED.md` plus a postinstall fix so a failed `/usr/local/bin` link shows up in the install log instead of silently vanishing.
- 2026-10-19: Session tools (`session_list`, `session_read`, `session_log`) over a local, private-by-default session store, with read-only importers for Claude Code and Codex (`src/sessions/`, `docs/SESSION-INDEX.md`). `brainlink sync` wires `config.json`'s new optional `sync` key to the sync engine (local by default). `brainlink connect` accepts `--all`; `detect()` now reports ChatGPT honestly as needing a remote HTTPS connector (pending Ian). Depends on `brainlink-store` v0.2 (`search`, `Session.project`/`private`, `SessionRecord`).
