# brainlink-store — contract v0.2 (canonical, Node)

Made by Claude 886, 2026-10-19. Obsidian-independent data layer for BrainLink.

- `interface.d.ts` — the contract (BrainStore: notes, links, blobs, change events, snapshots, dated supersede, undo, sessions, search).
- `errors.mjs` — error classes with stable codes (`E_NOT_FOUND E_CONFLICT E_INVALID E_PRIVACY E_SUPERSEDED E_READ_ONLY E_SNAPSHOT E_CURSOR`).
- `memory-store.mjs` — `createMemoryStore({ vaults:[{name,private}], clock?, readOnly?, logRetention? })`: reference impl; drop-in for `src/sync/mock-store.mjs`.
- The advertised `contract-tests.mjs` was absent from the recoverable local package. BrainLink's own adapter tests cover selected behavior; the original contract suite remains unverified.
- `python-noncanonical/` — early Python sketch, NOT canonical.

v0.2 adds: `search(query, {limit, scope, includeSessions})` (reference ranking only — real deployments route through BrainLink core, see `docs/mcp.md`); `Session.project` and `Session.private` (default `false`; importers set it `true` explicitly) with `setSessionPrivate(id, bool)`; the lean `SessionRecord` projection (`id, client, project, started_at, turns, summary, private`) that sync and `session_list` carry around.

**Consuming this from BrainLink:** this recovered implementation is checked in at `vendor/brainlink-store`. BrainLink depends on `file:./vendor/brainlink-store` so a fresh checkout has the code required to install. Provenance and remaining verification limits are in `docs/STORE-RECOVERY.md`.

Run BrainLink's `npm test` for its current integration and adapter tests. Do not claim conformance to the missing original contract suite.
