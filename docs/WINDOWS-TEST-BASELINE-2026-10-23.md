# Windows test baseline — 2026-10-23

Branch: `fix/private-session-excerpts` (commit to be recorded after this note).
Environment: Windows, Node 24.18.0, local `brainlink-store` 0.2.0 package
from a prior review checkout. The store package is linked through a temporary
sibling junction because the repository declares `file:../brainlink-store`
but that source is not in the checkout or accessible at the expected GitHub URL.

Command: `npm test` (Node test runner, restricted to `test/*.test.mjs`).
Result: 206 tests; 200 pass, 1 fail, 5 skip.

- Failure: `test/folder-store.test.mjs` cannot import
  `brainlink-store/contract-tests.mjs`; that file is absent from the available
  local package. The folder-store contract is **not verified** on this machine.
- Skips: three snapshot symlink tests and the adversarial privacy probe require
  symlink creation privileges unavailable in this Windows environment. A Linux
  integration test is skipped on Windows. Skipped tests are not passes.

This update also makes session import honor a supplied `HOME`/`USERPROFILE`
instead of accidentally reading real Claude/Codex histories in isolated tests
on Windows. CLI client discovery honors `HOME` when supplied. Close-loop
insights now parse CRLF Markdown field lines correctly. Fixture and UI tests
were adjusted to their actual platform paths and line endings.

The next verification step is to recover the correct versioned
`brainlink-store` source/package, run its contract tests, then run the symlink
privacy and snapshot tests on a symlink-capable environment. Do not present
this suite as green or BrainLink as release-ready before those checks pass.
