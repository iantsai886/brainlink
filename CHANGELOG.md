# Changelog

This log covers the development branch. Entries marked **unreleased** are not published product releases. See [release readiness](docs/RELEASE-READINESS.md) for the current evidence and remaining release gates.

## 2026-10-31 — Development, unreleased

- Fixed a config race where a scheduled folder scan could restore a scan target after its vault had been marked private. The schedule, privacy toggle, vault removal, and scan schedule settings now serialize their related config updates. Regression test: 20/20 repeated passes; full Windows suite on source commit `107b1e0`: core 600 total (592 passed, 0 failed, 8 platform/privilege skips), UI 44/44.
- Updated the customer setup steps to fully quit/reopen each AI app and start a new chat so it loads the latest BrainLink tools.
- On source commit `b579fb2`, the isolated Windows install smoke passed, and the 1.2.7-to-1.2.8 upgrade preserved a user-data canary and passed Setup health. These are unsigned local installer checks, not a published release.
- Re-ran `npm ci && npm run test:all` in a Linux x64 `node:24-bookworm` container on exact repository commit `67e8e82`: core 600 total (598 passed, 0 failed, 2 Windows-only skips), UI 44/44, exit code 0. This is local Linux evidence; GitHub-hosted CI did not start runner steps because of the account billing/spending-limit block.
- Re-ran `npm run test:all` on clean repository commit `2ee9787`, Windows/Node.js 24.22.1: core 600 total (592 passed, 0 failed, 8 Windows privilege/platform skips) and UI 44/44. Application code is unchanged since the Linux-tested `441c3f0` revision.

- Re-ran the 30-case frozen retrieval comparison on clean source commit `46958e5`: 17/30 task proxies in both arms, source recall 1.000, zero privacy violations, and estimated result size 14.1% lower. Receipt: `samples/evaluation/reports/retrieval-independent-46958e5.json`. These estimates do not prove billed token savings or answer quality.
- Checked Claude Desktop's saved BrainLink token against the current local server; the available role tools include Anna and Brain. Claude Desktop still needs a full exit and new chat before live activation can be verified.
- The Agent Skills installer now accepts LF and CRLF metadata while preserving the original skill bytes and ownership hashes. A date-dependent test now works across time zones and midnight.
- **Local tests:** code commit `441c3f0` passed the full Windows suite (592 core passed, 0 failed, 8 platform skips; UI 44/44) and Linux suite (598 core passed, 0 failed, 2 Windows-only skips; UI 44/44). The changed Skill and Twin-profile tests then passed 36/36 on both platforms.
- **Package checks:** the Windows installed-app smoke passed on `441c3f0`; Linux x64 and ARM64 packages built with verified SHA-256 sidecars, and the x64 Debian and portable packages passed isolated install and uninstall checks. Backup recovery passed on code commit `2646341` using fictional data.
- **Cross-client:** Claude Code is signed out, so the live Claude Code-to-Codex handoff has not been tested. A local BrainLink token check is not a substitute for a live client handoff.
- **GitHub CI:** latest push run `41088015684` for `a058201` had zero steps in the Windows/Linux jobs. GitHub annotations say recent payments failed or the spending limit needs to be increased; those jobs did not test the source.
- **Release status:** development build, not release-ready. ARM hardware, a real Linux desktop, macOS installer acceptance, user acceptance, and live cross-client validation are still outstanding.

## 2026-10-30 — Development, unreleased

- Setup gained an optional weekly retrieval benchmark on a fixed fictional 20-case fixture. It runs only while BrainLink is open, is off by default, and records aggregate results with source revision details. It does not measure generated-answer quality or prove provider-billed token savings.
- The test run for that earlier revision passed on Windows/Node.js 24.22.1: 586 core tests passed, 0 failed, 8 platform skips; UI 44/44. Its installer and encrypted backup checks were run on separate earlier commits; see the dated receipts in [IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md).
- Live Codex receiver testing passed. Claude Code-to-Codex was not verified because Claude Code was signed out.
- GitHub Actions did not start runner steps because of an account billing/spending limit. **Not release-ready.**

## 2026-10-19 — Development, unreleased

- `brainlink ui` and `brainlink demo` served the local milestone UI on 127.0.0.1 with a per-launch token, backed by the Markdown folder store. The demo used a throwaway sample vault so it did not touch a real vault or `config.json`.
- Added local, private-by-default session tools and read-only Claude Code and Codex importers. `brainlink sync` used local-only behavior by default, and `brainlink connect` accepted `--all`.
- The Windows preview ZIP required a machine with Node already installed. The macOS installer was unsigned; its post-install link error was made visible in the install log.
