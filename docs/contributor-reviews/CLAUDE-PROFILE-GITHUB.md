# Contributor review: profile-scoped GitHub repositories

Date: 2026-10-25 (Asia/Taipei)

## Submitted contribution

- Repository: `iantsai886/brainlink`
- Contributor branch: `feat/profile-scoped-github-repos`
- Contributor commit: `eba463a`
- Reported base: `f9d0229`
- Integration branch: `integration/profile-github-and-conflict-preservation`
- Integration commit: `754c3fb`

Claude's report proposed a confirmed repository assignment per Twin profile, validated before GitHub note operations. The assignment binds a repository identity, clone path, vault, optional folder scope, and confirmation time. It also adds profile identity to push receipts and tests isolation using fictional profiles and local Git remotes.

## Review and decisions

The contribution was integrated because it closes a real isolation gap: a request could otherwise choose a vault and clone independently. Review and confirmation are now required before a configured profile can use GitHub, and the assignment is checked before candidate notes are accessed.

Integration changes from the submitted branch:

- Folder-only scope can be selected, or the owner must explicitly confirm whole-vault scope. The UI does not silently interpret an omitted folder list as whole-vault permission.
- The existing conflict-copy feature was preserved and routed through the profile assignment authorization. It saves the remote version as a deterministic copy and never overwrites the local note.
- At review time, configurations with no Twin profiles retained legacy unscoped behavior. This policy was superseded on 2026-10-25: no-profile GitHub operations now fail closed until the user confirms a Twin owner and repository assignment. See `docs/GITHUB-SHARED-KNOWLEDGE.md` and the dated update in `docs/IMPLEMENTATION-STATUS.md`.
- A missing `createHash` import discovered by the combined conflict-copy tests was fixed before integration.

## Evidence

Claude reported testing its branch on macOS with Node.js 22.22.3: 302 tests, 299 passed, two failures also present on the reported base, and one skipped. Those branch results were not independently reproduced on macOS. Claude also reported a one-time browser check using a fictional setup; no live GitHub access or cross-client validation was performed.

The combined integration branch was tested locally on Windows with Node.js 24.18.0. `npm run test:all` passed: core 303 tests (297 passed, six skipped) and UI 28 tests (28 passed). A focused profile/GitHub/locale run passed 42/42. Fixtures used fictional vaults and temporary local repositories; no live GitHub account was accessed. Six skipped tests depend on Linux/macOS or Windows symlink privileges.

## Current limits and follow-up

- Live GitHub permission behavior, the user's desktop setup flow, cross-device use, and Claude Code ↔ Codex CLI acceptance remain unverified.
- GitHub collaborator access is governed by GitHub repository permissions; BrainLink profile grants cannot override a collaborator's direct access.
- The implementation is not a release-readiness claim. Current integration results and limitations are tracked in `IMPLEMENTATION-STATUS.md`.

