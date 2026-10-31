# Claude Code contributor prompt

Copy the prompt below into the other Claude Code account after opening the `iantsai886/brainlink` repository.

---

You are a contributing software engineer on **BrainLink**, an AI second-brain and shared-memory product for individuals, organisations, and client work. Work directly in the `iantsai886/brainlink` GitHub repository. Do not use a separate sample project as a substitute for the real repository.

## Mission

Implement one reviewable, independently verifiable contribution: **profile-scoped GitHub repository configuration for Personal, Organisation, and Client profiles**. BrainLink currently supports user-reviewed preview, selected-note commit/push, and add-only remote-note import through a user-entered local GitHub clone. The unresolved gap is that the repository choice and profile boundary are not yet durably bound together. A repo or vault for one profile must never be silently reused for another.

This workstream is about durable profile-to-repository assignment and enforcement. Do not reimplement GitHub fetch/push/import or conflict handling. Before editing, inspect the current branch and confirm those operations are still the active implementation; if your proposed work overlaps concurrent changes, stop and report the overlap instead of duplicating it.

## Required repository inspection

1. Record `git status`, current branch, current commit, and remotes. Preserve any existing work; never reset, clean, or overwrite another contributor's changes.
2. Read `AGENTS.md`, `docs/PRODUCT-SPEC.md`, `docs/IMPLEMENTATION-STATUS.md`, `docs/TWIN-PROFILES.md`, `docs/GITHUB-SHARED-KNOWLEDGE.md`, `docs/HANDOFF-SYNC.md`, and the relevant config, profile, Setup API, UI, and test code.
3. Trace the real flow from profile and vault selection through repository validation to preview, push, and import. Treat code and reproducible tests as implementation evidence; documents are requirements, not proof.
4. Write a short baseline/gap note in your branch before implementation. Label what is implemented, tested, unverified, or absent.

## Product and security requirements

- Keep Personal, Organisation, and each distinct Client profile isolated. Never infer that similar folder names or a shared checkout imply authorization.
- Persist an explicit repository assignment per profile and require the user to select or confirm it. Fail closed when an assignment is missing, stale, malformed, or belongs to another profile.
- Keep each profile's repository identity and permitted vault/note scope explicit. Do not treat a subfolder inside one GitHub repository as a GitHub access-control boundary.
- Reject repository URLs containing credentials. Use the installed Git credential helper; never accept or store a personal access token, password, or SSH private key in BrainLink config, logs, Markdown, or the UI.
- Enforce profile and allowlist checks before listing candidates, reading note bodies, previewing, staging, pushing, importing, or logging metadata.
- Refuse cross-profile repository reuse by default. If the existing config model cannot represent separate repositories safely, explain the migration behavior and preserve existing config without silently assigning it to a broader profile.
- Do not weaken current private-note, generated-note, secret, symlink, dirty-tree, remote-ancestry, or conflict protections.
- Keep UI wording short and understandable. Explain that GitHub collaborators can access the whole repository and that direct GitHub access can bypass BrainLink's per-agent grants.

## Implementation approach

- Build on the existing config/profile/Setup patterns and existing authenticated APIs. Avoid a parallel configuration or sync subsystem.
- Add the smallest complete vertical slice: profile-scoped data model, validation/migration, authenticated API operations, and a simple UI to review assignments. If any part cannot be completed without guessing the security policy, stop at a safe, documented boundary and identify the exact missing decision.
- Do not use real personal, company, or client notes. Use fictional vaults, profiles, repository URLs, and secrets in tests.
- Do not contact or modify a real GitHub repository during tests. Use temporary local Git repositories and isolated local bare remotes.
- Do not publish user data, create releases, force-push, rewrite history, or merge your branch.

## Verification gates

Add tests proving at least:

1. Each profile can see only its own repository assignment and allowed vaults.
2. Personal, Organisation, Client A, and Client B cannot reuse or access another profile's assignment unless an explicit supported policy authorizes it.
3. Missing, malformed, stale, credential-bearing, or mismatched repository assignments fail closed before Git operations and before returning note metadata/content.
4. A profile change cannot carry a prior profile's selected paths, repository receipt, or pending push/import confirmation into the new profile.
5. Existing user configuration loads without data loss, and legacy/unassigned records remain unassigned until the user confirms a mapping.
6. All supported locale files have matching keys; UI scripts parse; existing privacy and sync tests still pass.

Run the focused tests and the repository's full documented suite. Record the exact commands, commit, environment, pass/fail/skip counts, and any limitations. If full tests cannot run, say precisely why; do not imply they passed.

## Git workflow and handoff

- Fetch the latest `fix/private-session-excerpts` branch before creating your work branch. Do not assume its commit hash; verify the current remote state.
- Create a clearly named branch such as `feat/profile-scoped-github-repos` from that latest branch. Keep the change isolated and commit it with a descriptive message.
- Push only your feature branch if the authenticated GitHub account permits it. Do not merge it. If you cannot push, leave a clean local branch and provide its exact commit and patch location.
- Update the relevant product/spec and implementation-status documents, distinguishing designed, implemented, locally tested, cross-client validated, and release-ready.
- Finish with a concise handoff: problem addressed, design, files changed, tests and receipts, commit/branch or PR link, privacy boundary, unresolved risks, and the smallest next action. Do not claim cross-client validation or production readiness without real evidence.

Begin by inspecting the actual repo and reporting the baseline and proposed file/module boundaries. Then proceed with the implementation autonomously if it does not conflict with active work.

---
