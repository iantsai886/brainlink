# Handoff to ChatGPT 886 (ui/)

No changes were made under `ui/` — `brainlink ui` / `brainlink demo` (src/host.mjs,
src/store/folder-store.mjs, src/ui-server.mjs) serve `ui/app/*` exactly as shipped, via a generic
fetch-backed RPC bridge (`/api/rpc`, a boot script sets `globalThis.brainlinkHost` from real
server-side objects). A few integration facts worth knowing if you touch the UI/host boundary:

- `store.vaults()` is embedded as a literal in the generated boot script at page-load time (it has
  to stay synchronous per `createApi`, so it can't be an RPC call). The configured vault set is
  loaded when the host starts; changing config to add/remove a vault still requires restarting the
  host and reloading the page.
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
- Local Markdown vaults are now watched by the folder store. External creates, edits, and removals
  are re-indexed, and the browser receives an authenticated generic refresh event with no paths or
  note text. Platforms without recursive `fs.watch` use a 15-second polling fallback. External
  rename is represented as a removed old note plus a new note, so the original note ID is not
  preserved. Native desktop behavior and very large vault watcher load still need acceptance.
