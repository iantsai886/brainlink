# Changelog

This log covers the development branch. Entries marked **unreleased** are not published product releases. See [release readiness](docs/RELEASE-READINESS.md) for the current evidence and remaining release gates.

## 2026-10-31 — Development, unreleased

- The Agent Skills installer now accepts LF and CRLF metadata while preserving the original skill bytes and ownership hashes. A date-dependent test now works across time zones and midnight.
- **Local tests:** code commit `441c3f0` passed the full Windows suite (592 core passed, 0 failed, 8 platform skips; UI 44/44) and Linux suite (598 core passed, 0 failed, 2 Windows-only skips; UI 44/44). The changed Skill and Twin-profile tests then passed 36/36 on both platforms.
- **Package checks:** the Windows installed-app smoke passed on `441c3f0`; Linux x64 and ARM64 packages built with verified SHA-256 sidecars, and the x64 Debian and portable packages passed isolated install and uninstall checks. Backup recovery passed on code commit `2646341` using fictional data.
- **Cross-client:** Claude Code is signed out, so the live Claude Code-to-Codex handoff has not been tested. A local BrainLink token check is not a substitute for a live client handoff.
- **GitHub CI:** runs `41087143309` and `41087156710` did not execute steps; the check annotation says the repository billing or spending limit prevented runner startup.
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
