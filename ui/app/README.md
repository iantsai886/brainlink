# BrainLink UI — milestone 1

Plain ES modules, no framework, bundler, or UI filesystem/network access. Integrate by importing `startApp(root, createApi({store, services, access}))` from `app/app.mjs` and `app/lib/api.mjs`. The host is responsible for injecting a v0.1 BrainStore and connector services; `index.html` expects `globalThis.brainlinkHost` supplied by a host shell. Without it the page shows a configuration message, not fabricated connector data.

Pages: `#connect`, `#sessions`, `#search`. Connector operations use the provided host services; they cannot directly edit settings from the browser. Session privacy is vault membership; the adapter moves a session via a same-ID upsert with its complete message history when a host `services.sessions.setPrivate` is not provided. Search uses an injected `services.search.query` when present, else a client-side list/read ranking fallback.

Run tests from package parent: `node --test app/test/*.test.mjs`. If the real v0.1 reference store is available set `BRAINLINK_STORE_DIR=/absolute/path/to/folder/containing/memory-store.mjs` to exercise it. Otherwise tests use `app/test/support/memory-store.mjs`, a minimal **test-only fixture**, not the reference implementation. Real integration is therefore not verified by the bundled tests alone.
