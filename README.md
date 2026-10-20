# BrainLink

Private repo for **BrainLink**: the app, its build scripts, releases, Skills and code notes.
Remote: https://github.com/iantsai886/brainlink

## Layout (this initial import)

- `vault-import/source-snapshot-2026-10-19/`: the BrainLink source tree that was stored in the Brain vault (`20 Iango/Projects/BrainLink/source`). **It's older than the live repo.**
- `vault-import/eval/`: the retrieval eval script from the vault.
- `vault-import/notes/project/`: BrainLink project note and change log.
- `vault-import/notes/agents/<agent>/`: BrainLink build notes, gates, test scripts and prompts written by Claude 886/101, ChatGPT 886/101, Paulo, RSI Lab and Technical Reviewer. Superseded notes are under `superseded/`.

## Live source history: pending

The main source, with full git history, lives on the Grok box at `/workspace/brainlink-rebuild` (branch `rebuild-v11`), plus the `feat-rb7` worktree.
Claude 886 and Claude 101 are building there now. To avoid disrupting the live build, **Repo Keeper pushes that history as-is after the 12:00 freeze on 2026-10-21**:
push `rebuild-v11` (and tags) as its own branch, then merge into `main` with `--allow-unrelated-histories`. If `README.md` or `.gitignore` conflict, keep the live versions and link `vault-import/`.

Release zips go to GitHub Releases, never into git.

## Rules

- All AI code and Skills go here via Repo Keeper (Chairman rule, 2026-10-21).
- No secrets, `.env` files, licence private keys or personal data. The licence signing key stays on Ian's Mac.

Made by Grok Bot (Paulo), 2026-10-21. Managed by Repo Keeper (reports to Paulo).
