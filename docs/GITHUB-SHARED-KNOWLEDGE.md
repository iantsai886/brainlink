# GitHub-backed shared knowledge

Status: partial implementation. Read-only preview, explicit local commit, selected-commit push, add-only import, receipt-gated fast-forward updates, local-preserving conflict copies, and confirmed profile-scoped repository assignments are implemented. Each configured profile binds a distinct repository identity and clone to one non-private vault, with an optional folder allowlist. Operations resolve and verify that assignment before listing or reading notes. Profiles without an assignment fail closed; configurations without any Twin profile also fail closed because BrainLink cannot infer the data owner. An opt-in local scheduler now runs profile-scoped safe pull/commit/push using the existing checks. It defaults off, pauses for conflicts or local checkout edits, rotates through large candidate lists, rechecks opt-in and the exact assignment before every write, and persists an exact pending commit for network retry. This new scheduler is locally tested with fictional data only; live GitHub account permissions, cross-device use, and cross-client access remain unverified.

## Product goal

Let a user keep selected Markdown knowledge in a GitHub repository so authorized AI clients can reuse the same notes and changes have a reviewable history. GitHub is an optional shared publication and version-history layer; the user's existing Obsidian vault remains usable without it. BrainLink remains the policy and retrieval layer for connected agents.

## Recommended model

- Connect a user-selected, already-cloned repository. Use the installed Git client and its OS credential helper; never ask BrainLink users to paste a personal access token into BrainLink configuration.
- Treat repository visibility and GitHub collaborator access as the outer access boundary. A subfolder inside one repository is **not** a GitHub access-control boundary.
- Default to a separate repository for each security scope: personal, organisation, and each client. Do not combine these scopes just to make one graph or one AI context.
- Let the user explicitly select which vault folders/notes may be published. Private vaults, private notes, sessions, secrets, local config, credentials, caches, and excluded folders are denied by default before indexing, staging, preview, commit, push, or logs.
- Keep agents connected through BrainLink for permission-filtered search, reads and handoffs. Direct GitHub access by an AI is a separate permission grant and can bypass BrainLink's per-agent rules; explain this clearly during setup.
- Show a change preview before first publication. After an explicit opt-in, a user may enable automatic sync for the selected allowlist. Never force-push, rewrite history, or silently choose a conflict winner.

## User flow

1. Choose **GitHub knowledge** in Sync, select a Twin profile and vault, then use **Browse** to select an existing local clone or enter its path. On systems without a native folder dialog, BrainLink opens its accessible path-entry fallback. The following review detects the repository identity and branch before assignment; BrainLink does not clone repositories or log the user into GitHub.
2. Confirm the GitHub owner/repository, branch, privacy scope and allowed folders. Explain that pushing transfers note content to GitHub and that private-repository history may retain prior versions after a note is edited or removed.
3. Review a first-sync preview containing paths, change direction, and conflict status. The preview must not show excluded/private bodies.
4. Choose manual sync or explicitly enable scheduled sync. BrainLink fetches/pulls before applying changes; pushes only allowlisted files. Each BrainLink sync commit records the operation, time and an optional pseudonymous agent identifier without embedding full prompt or transcript text.
5. Browse the shared notes and provenance through BrainLink. AI clients receive only notes their configured profile and agent can access.
6. On conflict, stop and show both versions; preserve both until the user resolves them. A previously imported note may be updated only when its local content still matches BrainLink's content-hash receipt and the fetched remote history descends from the recorded commit. The update requires a separate user selection and confirmation. Provide a clone-based restore procedure and clearly explain that deleting a note from the current branch does not erase its older Git history.

## Security and data handling requirements

- Use an allowlist as the source of truth. A missing, malformed or unrecognized scope declaration fails closed.
- Enforce exclusions against canonical paths and symlinks. Check staged paths and content again immediately before commit/push, not only when building the search index.
- Keep Personal, Organisation and Client repositories separate by default. Never infer that a client can see an organisation note because both are present in one checkout.
- Use the operating system's Git credential helper. Do not store tokens in `config.json`, the repo, URLs, command history or activity logs. Avoid logging remote URLs if they contain credentials.
- Never force-push or rewrite remote history. Report partial sync and retain a recoverable local state on network or auth failure.
- Do not claim that GitHub history is immutable, encrypted end-to-end, or a backup by itself. GitHub is an external hosted service; users must choose its account, repository visibility, retention, and access policy.

## Acceptance gates

1. Fictional Personal, Organisation and Client fixtures prove that private/excluded notes, raw sessions, secrets and cross-scope canaries never enter previews, Git index, commits, pushes, search results or logs.
2. A clean clone on a second device can pull a shared note and show its commit history; a second authorized AI can retrieve the note through BrainLink with source attribution.
3. An unauthorized profile cannot search or read another scope even when it uses the same BrainLink service. Direct GitHub access is tested separately as repository-level permission, not represented as BrainLink-enforced filtering.
4. Simultaneous edits, offline operation, authentication failure, interrupted push and restore preserve both versions and never drop uncommitted work.
5. Measure retrieval task success, latency, and actual model input tokens against a full-vault context baseline. Git history proves change tracking; it does not by itself prove token savings.

The implemented slices verify candidate filtering, secret refusal, credential-free GitHub origin validation, body-free preview, authenticated endpoints, refusal of dirty checkouts, explicit commit of only selected files, rollback after commit failure, and absence of note bodies from API results. Push is separately confirmed and limited to the exact BrainLink commit, with a fetch-before-push parent check, selected-path/content revalidation, OS credential-helper use, no force-push, and refusal of unrelated local commits. Pull checks remote note visibility before listing, rejects private/generated/secret-bearing content, imports only selected new files, and preserves existing local conflicts. For imported notes, BrainLink stores a local receipt containing only profile/vault/path identity, repository, branch, commit and SHA-256 content hash; an update is offered only if the local bytes still match that receipt and Git history remains a fast-forward from the recorded commit. Updates are opt-in per note, rechecked on apply, and use a temporary file plus atomic replacement. Tests use an isolated local bare remote; they do not prove live GitHub authentication, actual user-account permissions, cross-device retrieval, or cross-AI access. Commit hooks are suppressed for the local publication commit.

## Profile-scoped repositories

Status: partial implementation. Read-only preview, explicit local commit, selected-commit push, add-only import, receipt-gated fast-forward updates, local-preserving conflict copies, and confirmed profile-scoped repository assignments are implemented. Each configured profile binds a distinct repository identity and clone to one non-private vault, with an optional folder allowlist. Operations resolve and verify that assignment before listing or reading notes. Profiles without an assignment fail closed; configurations without any Twin profile also fail closed because BrainLink cannot infer the data owner. An opt-in local scheduler now runs profile-scoped safe pull/commit/push using the existing checks. It defaults off, pauses for conflicts or local checkout edits, rotates through large candidate lists, rechecks opt-in and the exact assignment before every write, and persists an exact pending commit for network retry. This new scheduler is locally tested with fictional data only; live GitHub account permissions, cross-device use, and cross-client access remain unverified.

A Twin profile may carry one `github_repository` record in `config.json`:

```json
{ "remote": "fictional-org/org-brain", "path": "/abs/path/to/clone", "vault": "Org Vault", "folders": ["Shared"], "whole_vault": false, "confirmed_at": "2026-10-25T00:00:00.000Z" }
```

- `remote` is the lowercase `owner/repo` identity read from the clone's origin; URLs and credentials are never stored, and any other field makes the record invalid.
- The user creates it in Setup by choosing a profile, vault and clone, reviewing the detected repository, and re-confirming the exact `owner/repo`. Review (`/api/github/assignment/inspect`) writes nothing.
- One repository identity, one clone path and one vault map to one profile. A vault declared by two profiles cannot be assigned (ambiguous owner). Private vaults cannot be assigned.
- The user must choose a non-empty vault-relative `folders` allowlist or explicitly confirm `whole_vault: true`. The whole-vault choice includes every eligible note. This is a BrainLink publishing filter, not a GitHub access boundary.
- Every operation (candidate list, preview, commit, push, remote check, import) names a profile and is authorised before notes are listed or read: profile exists, assignment present and well-formed, vault matches, clone path matches, and the clone's origin still resolves to the assigned `owner/repo`. Anything missing, malformed, stale or mismatched fails closed. Remote notes outside `folders` are skipped before their bodies are read.
- A BrainLink commit made for a profile carries a `BrainLink-Profile: <id>` trailer; push refuses a receipt whose trailer names a different profile.
- Existing configs load unchanged; profiles stay unassigned until the user confirms. A configuration without Twin profiles cannot list, preview, commit, push, or import GitHub notes. The user must create a Personal, Organisation, or Client Twin and explicitly confirm its repository assignment first. Existing vaults and configuration are not modified by this requirement.
- Direct GitHub access, repository collaborators and history already pushed are outside BrainLink's control; Setup says so.

## Implementation slices

1. Done: safe local-repository validation, authenticated candidate/preview endpoints, localized Setup UI, separately confirmed local commits, and explicit selected-commit push with remote ancestry/path validation.
2. Done in local implementation: the assignment form has a native folder picker with a manual-path fallback, localized labels, and the same authenticated, exact-identity review step. Still required: validate the desktop dialog behavior, accessibility, localized privacy messaging, and GitHub credential-helper flow using a user-controlled test repository.
3. Profile-to-repository binding is locally tested. Remaining: validate assignment and conflict-copy flows in the desktop UI with a user-controlled test account.
4. Done in local implementation: per-profile opt-in schedule (1/6/12/24 hours), manual run, safe import/publication, conflict pause, pending-commit retry, and body-free status receipts. Still required: installed-app usability review and user-controlled GitHub acceptance.
5. Run cross-device and cross-AI acceptance with fictional data before considering a customer release.

No GitHub credentials, repository URL, permissions, or user vault content are configured or transmitted by this proposal.
