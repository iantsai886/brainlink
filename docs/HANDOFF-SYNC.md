# Sync implementation handoff

Status snapshot: 2026-10-25. This note describes the current sync boundaries; `docs/IMPLEMENTATION-STATUS.md` is the evidence ledger.

## Local folder sync

`src/host.mjs` wraps the pure exports in `src/sync/settings.mjs` — `syncSettings`, `suggestFolders`, `validateSync`, and `chooseSync` — with `config.json` load/save for the Settings UI. Keep the wrapper signature compatible with `settingsService()` in `src/host.mjs`.

The configured Drive/iCloud/Dropbox folder is still a settings-only path: the real `BrainStore` in `src/store/folder-store.mjs` is not yet wired to `src/sync/engine.mjs` for actual vault file movement. The CLI currently reports that note sync is pending store integration. Do not infer end-to-end local-folder sync from the Settings control.

## GitHub shared knowledge

The authenticated Setup API in `src/sync/github-preview.mjs` now supports:

- Listing eligible local vault notes, with private/generated/secret-bearing notes excluded.
- Body-free local-clone preview and an explicitly confirmed commit of selected notes only.
- A separate, explicitly confirmed push of that exact single commit. It fetches the tracked `origin` branch, verifies ancestry and selected paths/content, refuses dirty or unrelated work, uses Git's configured credential helper, and never force-pushes.
- A remote-note check that fetches the tracked branch, lists only public Markdown notes after privacy/secret filtering, and classifies each as new, unchanged, or conflict.
- An explicitly confirmed import of selected new notes into the chosen non-private vault. Existing content is never overwritten; if any selected path conflicts, the batch is rejected without importing other selected files.

Every GitHub operation now requires a profile with a user-confirmed `github_repository` assignment (see `docs/GITHUB-SHARED-KNOWLEDGE.md`). Remote pull currently imports new files only. Updating an existing shared note, conflict resolution UI, automatic sync, cross-device acceptance, live GitHub account authentication, and customer deployment are not verified. The isolated tests use a local bare Git remote and do not stand in for live GitHub acceptance.

GitHub collaborator permissions apply to the repository, not BrainLink folders. Keep Personal, Organisation, and each Client scope in separate repositories by default. Continue to use BrainLink's profile grants for agent access; direct GitHub access is a separate grant and can bypass BrainLink filtering.
