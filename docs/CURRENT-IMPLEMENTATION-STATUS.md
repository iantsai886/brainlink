# BrainLink implementation status

Checked 2026-11-17 (Asia/Taipei). Repository: `iantsai886/brainlink`. Working branch: `codex/complete-review-work-order` (use the current remote branch head). Product version in `package.json`: `1.3.8` (development, unreleased).

## Completed work and evidence

- P0: The 29 original failures have an individual verdict and rationale in [P0-1-failing-test-verdicts.md](P0-1-failing-test-verdicts.md). Permission checks and scoped connection instructions use per-grant memory policy; the compatibility summary cannot widen access. A multi-Twin connection with no active role is refused except for the guide; missing grants fail closed; package jobs depend on tests.
- P1: Existing-vault adoption previews and avoids file creation; mailbox changes are previewed and warn for private destinations; pack re-application preserves unrelated roles; a private-by-default personal pack exists; retrieval ordering favors reviewed material; `vault_health` is bounded. P1-5 now excludes `00 Home/` by default for vaults receiving a newly generated `.brainlinkignore`; existing ignore files are never rewritten, and owners can remove the rule explicitly.
- P2: Daily self-test while Setup is open creates deduplicated, content-free RSI proposals; replayed misses can be pinned; local retrieval-use reporting stores visible note paths without query text; the RSI-001 synthetic comparison is documented with corrected rates (50.0% fixed list versus 35.7% frequency-selected). No recursive gain is claimed.
- P3: Proposal edits are previewed with destination/reason/similar notes; errors remain accessible in place, requests time out and can be cancelled, and destructive confirmations use in-page dialogs. Setup markup and API routes are split by destination; tests render the composed page. `ui/app/` remains a separate desktop client with its own host bridge and tests.
- F1–F6 implementation is in the branch: teach from a miss; trust-aware answer receipts; `since_last_session`; decision review dates; deterministic conflict review (stage 1); and previewed, on-demand tidy batches. Tidy remains on demand, duplicate candidates route to conflict review, and archive candidates remain omitted until retrieval-use data supports them.

## Verification receipts

- Windows, Node.js 22.23.5 (downloaded from nodejs.org and SHA-256 verified): full suite passed **705/715** (0 failures, 10 platform/privilege skips) and exited normally in 451.3 seconds. Windows Node.js 24.22.1: after P0-3, two full-suite attempts encountered a native access violation (`3221225477`) in the `test/brainlink.test.mjs` child process during ingestion/OCR. That file passes alone at 94/96 (2 expected Windows skips), and its scanned-PDF/OCR test passes alone at 1/1. `npm run test:ui` passed **48/48** after the final P0-3 change.
- A diagnostic rerun before that clean full run encountered a transient Windows `EPERM` while replacing a temporary config and a file-worker native access violation. The affected brief-schedule test passed 3/3 alone, and `brainlink.test.mjs` passed 94 tests with 2 expected platform skips alone. The complete subsequent run passed.
- After the full run, the packaging builder and installed-smoke assertion received small packaging-only edits. `test/packaging-runtime.test.mjs` then passed 3/3.
- On 2026-11-17, `test/twin-profiles.test.mjs` passed 31/31 after removing the last server-instructions fallback to `ctx.twinScope.memory_policy`. A regression assertion deliberately widens that compatibility summary while the grant denies semantic memory; scoped initialization still reports only grant-authorized types.
- Windows package stage matched all bundled source files. The isolated install smoke passed Setup navigation, English/Portuguese/Traditional Chinese OCR, scanned-PDF OCR, safe HTML extraction, the sign-in launcher, and uninstall with test data and PATH preserved.
- After commit `19f9956`, rebuilt `dist/BrainLink-Setup-1.3.8-19f9956.exe`, 63,686,670 bytes; SHA-256 `9C5BE91BA57FB67DEC9D9094F5F23A8BD15698BAE5026D525A862BDF7DACD4C6`. Installed it over the existing per-user installation; Inno Setup returned 0, installed package and CLI report `1.3.8`, and the existing `%APPDATA%\BrainLink\config.json` hash remained unchanged. The isolated QA install/uninstall smoke also passed with user data and PATH preserved.
- Hosted GitHub Actions on the current branch did not start (all six test jobs have zero steps); prior check output reported an account payment/spending-limit gate, and all package jobs were skipped. This is not a hosted test result.

## Remaining decisions and external validation

Ian confirmed these defaults on 2026-11-17:

1. F1 owner-taught answers use `verified` confidence.
2. F3 includes the short `since_last_session` brief on agent connection by default.
3. F5 conflict review stays deterministic; no local-model stage 2.
4. F6 tidy remains on demand.
5. P1-5 excludes `00 Home/` by default for newly generated ignore files.

The work order also reserves real-vault configuration changes (mailbox location, Ian Personal privacy/rules, Anna Office location, source snapshot/backup exclusions, whether all clients use BrainLink only, and the master status document). No such real-vault migration was performed.

The native macOS `.pkg` was not built or executed here. GitHub Actions is billing-blocked, so build it on a Mac using [MACOS-BUILD-HANDOFF.md](MACOS-BUILD-HANDOFF.md). It will be an unsigned test package unless Apple Developer ID and notarization credentials are configured. Do not call version 1.3.8 a public release until outstanding decisions and release acceptance are resolved.
