# BrainLink implementation and release status

Status checked: 2026-10-31 (Asia/Taipei)
Repository: `iantsai886/brainlink`  
Integration branch: `integration/brainlink-retrieval-evaluation`

## Product state

BrainLink's main product pieces are implemented in the development branch: local desktop Setup, multiple vaults and Personal/Organisation/Client profiles, four memory types, permission-scoped AI access, source-backed session filing and handoffs, a reviewable knowledge graph, Git-based shared knowledge, scheduled backup and restore, and governed RSI proposals.

“Implemented” means the feature exists in this source tree. It does not by itself mean customers have tested it or that every supported AI client has used it successfully.

## What has been checked

- **Latest local automated tests:** code commit `441c3f0` passed Windows/Node.js 24.22.1 `npm run test:all`: core 600 total (592 passed, 0 failed, 8 platform/privilege skips), UI 44/44. Linux x64/Node.js 24 in Docker passed on the same application change: core 600 total (598 passed, 0 failed, 2 Windows-only skips), UI 44/44. The Linux full run used the patched parser; its date-sensitive fixture was then made timezone-independent and the affected Windows/Linux suites passed 36/36 on both platforms. These are local runs; hosted Actions remains blocked before jobs start.
- **Weekly RSI control:** Setup offers a manual run and an optional schedule, off by default, for BrainLink's fixed fictional 20-question fixture. The user chooses a weekday and local time. It runs only while BrainLink is open, does not read connected vaults or call an AI model, and stores aggregate results with source revision details. Schedule and ISO-week records use the same configured timezone. It measures retrieval task success only; it is not generated-answer quality or proof of provider-billed token savings.
- **Backup recovery:** `npm run smoke:backup-recovery` passed on source commit `2646341`: encrypted fictional Personal, Organisation and Client-A data; four files verified and restored to a clean folder; wrong-key refusal, artifact restore and unchanged sources all passed. This is local Windows evidence, not a second-device recovery test.
- **Live AI check:** the signed-in Codex CLI completed one BrainLink handoff with temporary fictional vaults. The expected reply was saved and a planted private canary did not appear.
- **Retrieval/context evidence:** the 30-case fictional comparison at source commit `64c12fa` kept task-success proxy at 17/30, source recall at 1.000, and privacy violations at zero; estimated result size fell 14.1% (497 to 427 tokens). This is recorded in `samples/evaluation/reports/retrieval-independent-windows-v4.json`. It is not proof of generated-answer quality or provider-billed token savings.
- **Windows install and upgrade checks:** on source commit `441c3f0`, `npm run smoke:installed:win` passed the bundled-runtime launch, both shortcuts, authenticated Setup health/UI, temporary Hermes-hook controls, isolated uninstall, user-data preservation, and PATH restoration. `npm run smoke:upgrade:win` also passed an isolated 1.2.7-to-1.2.8 upgrade and cleanup. The installer is unsigned and local; it is not a published release.
- **Linux packages:** on source matching the `441c3f0` parser change, all four x64/ARM64 tar and Debian artifacts built and their SHA-256 sidecars verified. The x64 Debian package and portable archive passed install, version, fictional-vault initialization, uninstall, and settings-preservation checks in Debian Bookworm. ARM64 artifacts were checksum-verified but not executed on ARM hardware.
- **Cross-client check:** not complete. Re-running `npm run smoke:live-cross-client-handoff` on the current branch stopped before creating any fixture because Claude Code is signed out on this computer. Claude Desktop's saved local BrainLink settings expose `Connect to Anna`; the currently running Claude Desktop process started before the saved configuration update, so a fresh in-app Anna call remains unverified until a full app exit and relaunch loads the current settings.

## Still needed before calling this ready to sell

- Sign in to Claude Code, then pass the paired fictional Claude Code-to-Codex handoff test.
- Restore GitHub Actions test access. Run `41080930432` on commit `6f414f1` was stopped before steps by GitHub's account billing/spending-limit gate (check annotation verified through the GitHub API). After the account owner resolves it, rerun CI and inspect the actual job results.
- Linux x64 `.deb` and portable installers now build and pass isolated install, launch, vault-init, and uninstall checks in a Debian 12 container. Still test a real Linux desktop session (menu/browser launch), execute ARM64 packages on ARM hardware, and test macOS installers on their target system.
- Provision and pin the signed-update publisher key, then verify a real signed release and its upgrade/recovery flow.
- Get real-user feedback on setup, vault selection, graph editing, backup restore, and permission wording. Synthetic tests do not prove the interface is easy for customers.
- Measure token and time savings with matched real-world tasks. Current fixture scores and response-size estimates are not proof of provider-billed savings or generated-answer quality.

## Release claim

**Development implementation with substantial local test coverage; not yet release-ready or cross-client validated.** Do not describe the current branch as a production release. The canonical technical evidence and dated limitations are in [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md); the open acceptance checklist is [GitHub issue #1](https://github.com/iantsai886/brainlink/issues/1).
