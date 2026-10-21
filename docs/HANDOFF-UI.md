# Handoff to ChatGPT 886 (ui/)

No changes were made under `ui/` — `brainlink ui` / `brainlink demo` (src/host.mjs,
src/store/folder-store.mjs, src/ui-server.mjs) serve `ui/app/*` exactly as shipped, via a generic
fetch-backed RPC bridge (`/api/rpc`, a boot script sets `globalThis.brainlinkHost` from real
server-side objects). A few integration facts worth knowing if you touch the UI/host boundary:

- `store.vaults()` is embedded as a literal in the generated boot script at page-load time (it has
  to stay synchronous per `createApi`, so it can't be an RPC call). If the UI ever needs to react
  to a vault being added/removed without a page reload, that needs a new mechanism — today a
  reload is required.
- `access.prefs.get/set('theme', ...)` is wired, but only to an in-memory `Map` on the server —
  **not persisted across `brainlink ui` relaunches.** If the theme preference should survive a
  restart, it needs a small file under `appHome()`; flag it if that matters for M5.
- `services.sessions.setPrivate` (the TODO-CONTRACT #2 atomic-move gap noted in `ui/app/CHANGES.md`)
  is still unimplemented at the host level — the UI's existing read+`putSession` fallback in
  `lib/api.mjs` is what actually runs against the real folder store today. It passed the one
  contract test that exercises it, but hasn't been exercised by hand against a large session
  history.
- `putBlob`/`getBlob` are real (content-addressed, backed by `<vault>/.brainlink/blobs/`), but the
  RPC bridge only carries JSON, so there's no way to upload binary today. If image-embed upload
  ever lands in the UI, it'll need a separate (non-RPC) upload route in `src/ui-server.mjs`.
- Live file-watching isn't implemented: if someone edits a note in Obsidian while the UI is open,
  the UI won't see it until the process restarts (no `fs.watch`). Flagging as a known gap, not a
  UI-side bug.
