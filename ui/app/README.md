# BrainLink UI — milestone 2

## Status (2026-11-16)

This directory is retained as an isolated host-adapter prototype. It is not mounted by `brainlink setup` and is not the product's active Setup UI. Keep it separate until a host supplies the documented `BrainStore` and service contract; do not add a second Setup entry point or copy its screens into the active UI without an explicit integration plan. The running Setup continues to use `../index.html` and `src/setup.mjs`. The active UI's destination-based extraction is a separate unfinished refactor.

Dependency-free ES modules for Node 22 hosts and modern browsers. Import `startApp(root, createApi({ store, services, access }))` from `app/app.mjs` and `app/lib/api.mjs`. Host injects a BrainStore and independent `services.connectors`; the browser UI does not use filesystem or network APIs. Without a host, `index.html` displays a configuration message.

Routes: `#connect`, `#sessions`, `#search`, `#notes`. Connectors: `detect(): [{client,installed,connected}]`; `connect(client)`, `test(client)` and `disconnect(client)` return `{ok,message}`. Per-session privacy uses `store.setSessionPrivate` when available, else the legacy complete-history vault move; readout prefers `Session.private`. Imported sessions should be created with `private: true` by host importers and kept local-only by the store. Ranked search delegates directly to `store.search(query,{limit,scope?,includeSessions:false})` when available, or M1 scoring fallback otherwise.

Notes: vault/folder browsing, Markdown rendered safely (including wikilinks), read-only frontmatter table and editable JSON frontmatter, editable Markdown textarea, backlinks, creation, optional rename, no delete. Save uses the full `etag` as `expected_etag` for compare-and-swap; `sha12` is display-only, never used as a write token. Conflict retains unsaved edits. Cmd/Ctrl+S saves; leaving with edits prompts. Rendering supports ordinary headings, lists, inline emphasis, code spans and fenced blocks, links and wikilinks; it is not a complete CommonMark parser. Frontmatter is edited as JSON corresponding to the store's parsed YAML map, rather than re-serializing YAML.

## Tests

Run with the real reference store supplied separately (not distributed in this ZIP):

```sh
BRAINLINK_STORE_DIR=/path/to/reference-store node --test app/test/*.test.mjs
```

Directory must contain `memory-store.mjs` and `errors.mjs`. The test harness uses that store and fictional data; there are no bundled store implementations or support fixture files. M2 was verified with the provided v0.2 reference store: **16 passed, 0 failed**.

### M3/M4 host extensions
Optional `services.settings` supplies `get()`, `suggestFolders()`, `validate(sync)` and `save(sync)`; returns `{ok,message}` for validate/save. Without the full service the settings UI is disabled. The theme preference uses optional `access.prefs.get('theme')` and `access.prefs.set('theme', value)`; it never accesses browser storage directly. Sync operates through the host only, not directly from browser JS. Graph notes are read through the existing BrainStore adapter.
