# Handoff to Claude 101 (src/sync/)

No changes were made under `src/sync/`. `src/host.mjs` wraps your four pure exports from
`src/sync/settings.mjs` — `syncSettings`, `suggestFolders`, `validateSync`, `chooseSync` — with
`config.json` load/save to build the `get/suggestFolders/validate/save` shape
`ui/app/README.md` asks for (`services.settings`). This wrapper lives in `src/host.mjs`, not in
your file, per the ownership split — but it is now the thing the real UI's Settings tab calls in
production (`brainlink ui` / `brainlink demo`), so a signature change to any of those four exports
needs to stay compatible with that wrapper (`settingsService()` in `src/host.mjs`).

Open item worth knowing about: the real vault's content sync is still local-only end to end.
`src/store/folder-store.mjs` (the real `BrainStore` now backing the UI and, once wired, the MCP
server) never talks to `src/sync/engine.mjs` — picking a Drive/iCloud/Dropbox folder in Settings
updates `config.json` only. Actually moving note files into that folder still needs wiring from
`engine.mjs` to the folder store's vault paths; this matches what `docs/progress.md` already
flags and `brainlink sync`'s CLI output already says ("notes: pending the store integration").

GitHub is not a current sync provider. Ian's request to use a GitHub-hosted Second Brain for
shared AI access and change tracking is now captured as a product proposal in
[`GITHUB-SHARED-KNOWLEDGE.md`](GITHUB-SHARED-KNOWLEDGE.md). The proposal keeps personal,
organisation and client data in separately scoped repositories by default, uses explicit
allowlists, and requires privacy checks before any stage/commit/push. Do not infer GitHub support
from the current folder-sync settings or sync engine.
