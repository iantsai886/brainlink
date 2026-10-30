# BrainLink implementation and release status

Status checked: 2026-10-30 (Asia/Taipei)  
Repository: `iantsai886/brainlink`  
Integration branch: `integration/brainlink-retrieval-evaluation`

## Product state

BrainLink's main product pieces are implemented in the development branch: local desktop Setup, multiple vaults and Personal/Organisation/Client profiles, four memory types, permission-scoped AI access, source-backed session filing and handoffs, a reviewable knowledge graph, Git-based shared knowledge, scheduled backup and restore, and governed RSI proposals.

“Implemented” means the feature exists in this source tree. It does not by itself mean customers have tested it or that every supported AI client has used it successfully.

## What has been checked

- **Local automated tests:** `npm run test:all` passed on code commit `7d04dcd`: 594 core tests (586 passed, 0 failed, 8 Windows platform/privilege skips) and 44 desktop UI tests passed. This ran on Windows with Node.js 24.22.1.
- **Weekly RSI control:** Setup offers a manual run and an optional schedule, off by default, for BrainLink's fixed fictional 20-question fixture. The user chooses a weekday and local time. It runs only while BrainLink is open, does not read connected vaults or call an AI model, and stores aggregate results with source revision details. Schedule and ISO-week records use the same configured timezone. It measures retrieval task success only; it is not generated-answer quality or proof of provider-billed token savings.
- **Live AI check:** the signed-in Codex CLI completed one BrainLink handoff with temporary fictional vaults. The expected reply was saved and a planted private canary did not appear.
- **Windows install checks:** a fresh unsigned 1.2.8 installer built from branch commit `b33eca8` passed `npm run smoke:installed:win`: bundled runtime launch, both shortcuts, Setup health/UI, temporary Hermes hook handling, isolated uninstall, user-data preservation, and PATH restoration. Installer SHA-256: `FE886AA5BFA3D3DE92E58206CEA6F9E161F6A2CFD4EE649354E401E9A84C3679`. It is a local test artifact, not a published release.
- **Cross-client check:** not complete. The paired Claude Code-to-Codex smoke stopped before creating any fixture because Claude Code is signed out on this computer. Claude Desktop's local BrainLink settings expose `Connect to Anna`, but a fresh in-app Anna call is not yet verified.

## Still needed before calling this ready to sell

- Sign in to Claude Code, then pass the paired fictional Claude Code-to-Codex handoff test.
- Restore GitHub Actions runner access. Current workflow runs stop before tests because GitHub reports an account payment or spending-limit problem.
- Test macOS and Linux installers on their target systems.
- Provision and pin the signed-update publisher key, then verify a real signed release and its upgrade/recovery flow.
- Get real-user feedback on setup, vault selection, graph editing, backup restore, and permission wording. Synthetic tests do not prove the interface is easy for customers.
- Measure token and time savings with matched real-world tasks. Current fixture scores and response-size estimates are not proof of provider-billed savings or generated-answer quality.

## Release claim

**Development implementation with substantial local test coverage; not yet release-ready or cross-client validated.** Do not describe the current branch as a production release. The canonical technical evidence and dated limitations are in [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md); the open acceptance checklist is [GitHub issue #1](https://github.com/iantsai886/brainlink/issues/1).
