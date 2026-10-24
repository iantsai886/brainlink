# GitHub-backed shared knowledge

Status: proposed full product capability; read-only preview and explicit local-commit slices are implemented. BrainLink still does not fetch, push, or synchronize GitHub repositories. The authenticated Setup flow and synthetic privacy tests are in `src/sync/github-preview.mjs`, `src/setup.mjs`, `ui/index.html`, and `test/github-preview.test.mjs`. See [HANDOFF-SYNC.md](HANDOFF-SYNC.md) and the live [implementation status](IMPLEMENTATION-STATUS.md).

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

The implemented local slices verify candidate filtering, secret refusal, credential-free GitHub origin validation, body-free preview, authenticated endpoints, refusal of dirty checkouts, explicit commit of only selected files, rollback after commit failure, and absence of note bodies from API results. Commit hooks are suppressed for this operation. No fetch, push, remote permission, or cross-device behavior has been implemented or tested.

## Implementation slices

1. Done: safe local-repository validation, authenticated candidate/preview endpoints, localized Setup UI, and separately confirmed local commits. No provider setting or remote operation is enabled.
2. Validate UI behavior, accessibility, and localized privacy messaging; add a reviewable commit receipt and recovery guidance.
3. Design opt-in push/pull with conflict retention and restore guidance, then implement only after security review.
4. Add profile-aware repository boundaries, localized privacy explanation, and per-repository remote status/history.
5. Run cross-device and cross-AI acceptance with fictional data before considering a customer release.

No GitHub credentials, repository URL, permissions, or user vault content are configured or transmitted by this proposal.
