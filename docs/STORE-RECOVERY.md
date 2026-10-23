# Storage implementation recovery

Status: recovered local implementation, not a verified copy of the original
`brainlink-store` repository.

The main repository previously declared `brainlink-store` as
`file:../brainlink-store`. That sibling source was unavailable in this
workspace and at the tested GitHub URL. The available local review checkout
contained version 0.2.0's `memory-store.mjs`, `errors.mjs`, `interface.d.ts`,
`README.md`, and `package.json` under its installed `node_modules`. Their
contents were copied mechanically into `vendor/brainlink-store` so a fresh
BrainLink checkout no longer needs the unknown sibling folder.

The local package did **not** contain its advertised `contract-tests.mjs` or
its own `test/` directory. We removed that broken export and replaced the
unrunnable external import in BrainLink's folder-store tests with explicit
adapter checks for stale-etag rejection, private-vault remote denial,
byte-stable scan, and rename. These tests do not constitute the original
published contract suite. If the original source is later found, compare
hashes and behavior before accepting or replacing this recovered copy.

No production installation, release, or customer migration has been made.
Verification on Windows/Node 24.18.0: `npm ci --ignore-scripts` completed from
the tracked lockfile; four folder-store adapter tests passed. Full `npm test`
reported 210 tests, 205 passed, 0 failed, 5 skipped. The skips are four
symlink-dependent security/snapshot checks (Windows lacks symlink privilege)
and one Linux-only check. The original store contract suite is still absent,
so these figures must not be described as full contract or release validation.
The packaging scripts passed shell syntax checks using Git Bash; the
installers themselves were not built or executed in this turn.

The rollback is to revert this change and restore a verified sibling
`brainlink-store` checkout; doing so reintroduces the external install
dependency and requires the original contract tests to pass.
