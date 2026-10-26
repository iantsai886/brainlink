# Sync implementation handoff

Status snapshot: 2026-10-25. This note describes the current sync boundaries; `docs/IMPLEMENTATION-STATUS.md` is the evidence ledger.

## Local folder sync

`src/host.mjs` wraps the pure exports in `src/sync/settings.mjs` — `syncSettings`, `suggestFolders`, `validateSync`, and `chooseSync` — with `config.json` load/save for the Settings UI. Keep the wrapper signature compatible with `settingsService()` in `src/host.mjs`.

`brainlink sync` and the Setup **Sync now** button connect `src/sync/engine.mjs` to `src/store/folder-store.mjs` and the configured on-disk vault. For safety it picks a public vault named `brain`; if none exists, it may use the sole public vault. When several public vaults exist without a `brain` vault, it stops with `vault-ambiguous` instead of guessing. Private vaults never qualify. It also refuses a sync folder located inside the selected vault. Sync runs only when the user invokes it; background scheduling is not implemented. The receiving folder must be a folder already synced by the user's Drive/iCloud/Dropbox desktop client.

Local tests now exercise send and receive between two temporary folders, the Setup endpoint, private-vault refusal, ambiguous-vault refusal, and target-inside-vault refusal. The full serialized core and UI suites pass on Windows/Node 24.22.1. A real Drive/iCloud/Dropbox desktop client run and a second-device acceptance check remain unverified. Sync state is local per device. Conflict handling keeps both copies; deletes are never propagated.

## GitHub shared knowledge

The authenticated Setup API in `src/sync/github-preview.mjs` now supports:

- Listing eligible local vault notes, with private/generated/secret-bearing notes excluded.
- Body-free local-clone preview and an explicitly confirmed commit of selected notes only.
- A separate, explicitly confirmed push of that exact single commit. It fetches the tracked `origin` branch, verifies ancestry and selected paths/content, refuses dirty or unrelated work, uses Git's configured credential helper, and never force-pushes.
- A remote-note check that fetches the tracked branch, lists only public Markdown notes after privacy/secret filtering, and classifies each as new, unchanged, or conflict.
- An explicitly confirmed import of selected new notes into the chosen non-private vault. Existing content is never overwritten; if any selected path conflicts, the batch is rejected without importing other selected files.

Every GitHub operation now requires a profile with a user-confirmed `github_repository` assignment (see `docs/GITHUB-SHARED-KNOWLEDGE.md`). Remote pull currently imports new files only. Updating an existing shared note, conflict resolution UI, automatic sync, cross-device acceptance, live GitHub account authentication, and customer deployment are not verified. The isolated tests use a local bare Git remote and do not stand in for live GitHub acceptance.

GitHub collaborator permissions apply to the repository, not BrainLink folders. Keep Personal, Organisation, and each Client scope in separate repositories by default. Continue to use BrainLink's profile grants for agent access; direct GitHub access is a separate grant and can bypass BrainLink filtering.
