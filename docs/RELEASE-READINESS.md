# BrainLink implementation and release status

Status checked: 2026-10-30 (Asia/Taipei)  
Repository: `iantsai886/brainlink`  
Integration branch: `integration/brainlink-retrieval-evaluation`

## Product state

BrainLink's main product pieces are implemented in the development branch: local desktop Setup, multiple vaults and Personal/Organisation/Client profiles, four memory types, permission-scoped AI access, source-backed session filing and handoffs, a reviewable knowledge graph, Git-based shared knowledge, scheduled backup and restore, and governed RSI proposals.

“Implemented” means the feature exists in this source tree. It does not by itself mean customers have tested it or that every supported AI client has used it successfully.

## What has been checked

- **Local automated tests:** `npm run test:all` passed on code commit `310f3d3`: 599 core tests (591 passed, 0 failed, 8 Windows platform/privilege skips) and 44 desktop UI tests passed. This ran on Windows with Node.js 24.22.1. The focused session-import suite passed 24/24.
- **Weekly RSI control:** Setup offers a manual run and an optional schedule, off by default, for BrainLink's fixed fictional 20-question fixture. The user chooses a weekday and local time. It runs only while BrainLink is open, does not read connected vaults or call an AI model, and stores aggregate results with source revision details. Schedule and ISO-week records use the same configured timezone. It measures retrieval task success only; it is not generated-answer quality or proof of provider-billed token savings.
- **Backup recovery:** `npm run smoke:backup-recovery` passed on source commit `310f3d3`: encrypted fictional Personal, Organisation and Client-A data; four files verified and restored to a clean folder; wrong-key refusal, artifact restore and unchanged sources all passed. This is local Windows evidence, not a second-device recovery test.
- **Live AI check:** the signed-in Codex CLI completed one BrainLink handoff with temporary fictional vaults. The expected reply was saved and a planted private canary did not appear.
- **Windows install and upgrade checks:** a fresh unsigned 1.2.8 installer built from branch commit `b33eca8` passed `npm run smoke:installed:win`; `npm run smoke:upgrade:win` on branch commit `b305e22` also passed an isolated 1.2.7-to-1.2.8 upgrade. Both preserve test user data and clean up their isolated installs. Installer SHA-256: `FE886AA5BFA3D3DE92E58206CEA6F9E161F6A2CFD4EE649354E401E9A84C3679`. It is a local test artifact, not a published release.
- **Cross-client check:** not complete. The paired Claude Code-to-Codex smoke stopped before creating any fixture because Claude Code is signed out on this computer. Claude Desktop's saved local BrainLink settings expose `Connect to Anna`; the currently running Claude Desktop process started before the saved configuration update, so a fresh in-app Anna call remains unverified until a full app exit and relaunch loads the current settings.

## Still needed before calling this ready to sell

- Sign in to Claude Code, then pass the paired fictional Claude Code-to-Codex handoff test.
- Restore GitHub Actions test access. Run `41080930432` on commit `6f414f1` was stopped before steps by GitHub's account billing/spending-limit gate (check annotation verified through the GitHub API). After the account owner resolves it, rerun CI and inspect the actual job results.
- Linux x64 `.deb` and portable installers now build and pass isolated install, launch, vault-init, and uninstall checks in a Debian 12 container. Still test a real Linux desktop session (menu/browser launch), execute ARM64 packages on ARM hardware, and test macOS installers on their target system.
- Provision and pin the signed-update publisher key, then verify a real signed release and its upgrade/recovery flow.
- Get real-user feedback on setup, vault selection, graph editing, backup restore, and permission wording. Synthetic tests do not prove the interface is easy for customers.
- Measure token and time savings with matched real-world tasks. Current fixture scores and response-size estimates are not proof of provider-billed savings or generated-answer quality.

## Release claim

**Development implementation with substantial local test coverage; not yet release-ready or cross-client validated.** Do not describe the current branch as a production release. The canonical technical evidence and dated limitations are in [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md); the open acceptance checklist is [GitHub issue #1](https://github.com/iantsai886/brainlink/issues/1).
