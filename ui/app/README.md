# BrainLink UI redesign (ui/app)

Made by ChatGPT 886. Scaffold for milestones M1-M4. Briefs: /workspace/brainlink-ui/briefs/.

- Contract: `brainlink-store/interface.d.ts` v0.1 (BrainStore). The UI calls the store API only, never files or the network.
- Not in the store contract (UI needs them): `services.connectors` (wraps src/connectors.mjs) and `services.search` (wraps core search). Defined in `lib/api.mjs`.
- Pattern: `lib/state.mjs` createHook -> each `use*()` in `lib/hooks*.mjs` returns `{ get, sub, ...actions }`; views in `views/*.mjs` are pure `(state) => html string`; `app.mjs` wires routes and events.
- Tests: `node --test ui/app/test/` (Node >= 20). Store under test = real `createMemoryStore` (set `BRAINLINK_STORE_DIR` to override).
- The v1.1 Setup page `ui/index.html` is untouched until the integration step.
