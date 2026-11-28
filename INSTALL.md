# Installing BrainLink (AI-Native Guide)

> **For users:** Paste `"Read INSTALL.md and install BrainLink for me"` into **Antigravity**, **Claude Code**, **Codex**, or **Cursor**.
> **For AI agents:** Follow each step in order. Never skip consent prompts, never overwrite user config or vault notes, and always verify with `brainlink doctor` at the end.

---

## 1. Structural Boundary: `SYSTEM/` vs `USER/`

BrainLink strictly separates upgradeable software from user-owned data so upgrades never clobber your work:

| Layer | Ownership | Paths | Upgrade Rule |
|---|---|---|---|
| **`SYSTEM`** | BrainLink (upgradeable) | App code (`bin/`, `src/`, `ui/`, `scripts/`, `skills/`, installed binary under `%LOCALAPPDATA%\Programs\BrainLink` or `/Applications/BrainLink.app`) | Safely replaced on upgrade |
| **`USER`** | You (never overwritten) | Your Obsidian / Markdown vaults, BrainLink config (`%APPDATA%\BrainLink\config.json` or `~/.config/brainlink/config.json`), `errata.jsonl`, `amber/amber-ledger.jsonl`, `doctor-preferences.json`, RSI ledgers, and AI client MCP configs | Additive merge + timestamped backup only; ledgers are append-only |

---

## 2. Step-by-Step Agent Install Protocol

### Step A — Explicit Consent (REQUIRED before touching any machine config)
Ask the user to confirm:
1. Which vault folder(s) BrainLink may connect to (confirm private/excluded folders stay excluded).
2. Which AI client config files may be updated additively (e.g., Antigravity, Claude Code, Codex, Cursor).
3. **Do not write any config file until the user approves the dry-run preview.**

### Step B — Capability Opt-In (`now` / `later` / `decline`)
Ask the user how they want each optional capability handled:
- **Local semantic embeddings (`semantic` via Ollama `nomic-embed-text`)** → `now` / `later` / `decline`
- **Network / remote probes (`network`)** → `now` / `later` / `decline`

For any capability the user chooses **`decline`**, persist it immediately so BrainLink never nags or marks it red:
```bash
node bin/brainlink.mjs doctor decline <capability> --reason "User opted out during install"
```

### Step C — Dry-Run Additive Config Preview (Default Safe Mode)
Run the deterministic additive merger in dry-run mode first (writes nothing):
```bash
node scripts/install-settings.mjs --target <CLIENT_CONFIG_JSON> --server-cmd node --server-arg "$HOME/brainlink/bin/brainlink.mjs" --server-arg serve
```
Show the user the preview diff and confirm:
- Existing MCP servers, hooks, and custom settings are preserved.
- Existing `BRAINLINK_AGENT_TOKEN` values are never overwritten.
- `$HOME` and `%USERPROFILE%` are expanded safely at write time.

### Step D — Apply with Automatic Backup
Only after the user approves the dry-run output, run with `--apply`:
```bash
node scripts/install-settings.mjs --apply --target <CLIENT_CONFIG_JSON> --server-cmd node --server-arg "$HOME/brainlink/bin/brainlink.mjs" --server-arg serve
```
This creates a timestamped backup (`<file>.brainlink-backup-<timestamp>`) before writing the merged JSON.

### Step E — Mandatory Verification (`brainlink doctor`)
Always finish with:
```bash
node bin/brainlink.mjs doctor --reconcile
```
Report every capability state honestly:
- `live ✅` — verified working
- `broken ❌` — failing (print the exact `fix:` command)
- `declined ⏸` — opted out by user
- `UNMEASURED` / `MISSING` — never claim healthy when telemetry was not measured.
