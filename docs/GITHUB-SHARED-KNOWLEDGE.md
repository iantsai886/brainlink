# GitHub-backed shared knowledge

Status: proposed full product capability; read-only preview, explicit local commit, explicit one-commit push, and add-only remote-note import are implemented. BrainLink fetches the tracked origin branch only after the user requests a remote check or confirms Push/Import. Push verifies the selected-note commit is the sole child of the fetched tip. Pull filters private/generated/secret-bearing notes before listing, imports only selected new files, and refuses any selected batch containing a local conflict without overwriting. Each GitHub operation is now bound to a user-confirmed, profile-scoped repository assignment (see [Profile-scoped repositories](#profile-scoped-repositories)). Updating existing remote notes, automatic synchronization, and conflict resolution remain unimplemented. The authenticated Setup flow and synthetic privacy tests are in `src/sync/github-preview.mjs`, `src/setup.mjs`, `ui/index.html`, and `test/github-preview.test.mjs`. See [HANDOFF-SYNC.md](HANDOFF-SYNC.md) and the live [implementation status](IMPLEMENTATION-STATUS.md).

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

1. Choose **GitHub knowledge** in Sync and select a local clone (or clone a repository through the signed-in Git credential helper).
2. Confirm the GitHub owner/repository, branch, privacy scope and allowed folders. Explain that pushing transfers note content to GitHub and that private-repository history may retain prior versions after a note is edited or removed.
3. Review a first-sync preview containing paths, change direction, and conflict status. The preview must not show excluded/private bodies.
4. Choose manual sync or explicitly enable scheduled sync. BrainLink fetches/pulls before applying changes; pushes only allowlisted files. Each BrainLink sync commit records the operation, time and an optional pseudonymous agent identifier without embedding full prompt or transcript text.
5. Browse the shared notes and provenance through BrainLink. AI clients receive only notes their configured profile and agent can access.
6. On conflict, stop and show both versions; preserve both until the user resolves them. Provide a clone-based restore procedure and clearly explain that deleting a note from the current branch does not erase its older Git history.

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

The implemented slices verify candidate filtering, secret refusal, credential-free GitHub origin validation, body-free preview, authenticated endpoints, refusal of dirty checkouts, explicit commit of only selected files, rollback after commit failure, and absence of note bodies from API results. Push is separately confirmed and limited to the exact BrainLink commit, with a fetch-before-push parent check, selected-path/content revalidation, OS credential-helper use, no force-push, and refusal of unrelated local commits. Pull checks remote note visibility before listing, rejects private/generated/secret-bearing content, imports only selected new files, and preserves existing local conflicts. Tests use an isolated local bare remote; they do not prove live GitHub authentication, actual user-account permissions, cross-device retrieval, or cross-AI access. Commit hooks are suppressed for the local publication commit.

## Profile-scoped repositories

Status: implemented and locally tested with fictional data and isolated local Git remotes; not validated in a desktop session or against live GitHub.

A Twin profile may carry one `github_repository` record in `config.json`:

```json
{ "remote": "fictional-org/org-brain", "path": "/abs/path/to/clone", "vault": "Org Vault", "folders": ["Shared"], "confirmed_at": "2026-10-25T00:00:00.000Z" }
```

- `remote` is the lowercase `owner/repo` identity read from the clone's origin; URLs and credentials are never stored, and any other field makes the record invalid.
- The user creates it in Setup by choosing a profile, vault and clone, reviewing the detected repository, and re-confirming the exact `owner/repo`. Review (`/api/github/assignment/inspect`) writes nothing.
- One repository identity, one clone path and one vault map to one profile. A vault declared by two profiles cannot be assigned (ambiguous owner). Private vaults cannot be assigned.
- `folders` is an optional vault-relative allowlist. Absent means every eligible note in the assigned vault; it is a BrainLink publishing filter, not a GitHub access boundary.
- Every operation (candidate list, preview, commit, push, remote check, import) names a profile and is authorised before notes are listed or read: profile exists, assignment present and well-formed, vault matches, clone path matches, and the clone's origin still resolves to the assigned `owner/repo`. Anything missing, malformed, stale or mismatched fails closed. Remote notes outside `folders` are skipped before their bodies are read.
- A BrainLink commit made for a profile carries a `BrainLink-Profile: <id>` trailer; push refuses a receipt whose trailer names a different profile.
- Existing configs load unchanged; profiles stay unassigned until the user confirms. With no profiles configured at all, the earlier unscoped behavior is kept because no profile boundary exists.
- Direct GitHub access, repository collaborators and history already pushed are outside BrainLink's control; Setup says so.

## Implementation slices

1. Done: safe local-repository validation, authenticated candidate/preview endpoints, localized Setup UI, separately confirmed local commits, and explicit selected-commit push with remote ancestry/path validation.
2. Validate UI behavior, accessibility, localized privacy messaging, and the GitHub credential-helper flow using a user-controlled test repository.
3. Done (locally tested): connect repository choices to Personal/Organisation/Client profile scopes. Still open: an explicit conflict-resolution workflow that retains both versions and requires the user to choose or merge.
4. Evaluate automatic sync separately, only after user opt-in, profile isolation, error recovery, and live multi-device acceptance are proven.
5. Run cross-device and cross-AI acceptance with fictional data before considering a customer release.

No GitHub credentials, repository URL, permissions, or user vault content are configured or transmitted by this proposal.
