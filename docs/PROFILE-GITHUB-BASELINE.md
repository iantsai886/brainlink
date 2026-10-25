# Baseline and gap: profile-scoped GitHub repositories

Recorded before implementation. Base: `fix/private-session-excerpts` @ `f9d0229c85756ef8b7431912fb161a42979c0b8a` (fetched from `origin`, identical to the remote tip when work started). Evidence labels: **implemented** (code read), **tested** (a test asserts it), **unverified**, **absent**.

| Area | State | Evidence |
|---|---|---|
| Local-clone validation (absolute path, repo root, GitHub origin without credentials) | implemented, tested | `repositoryRoot`, `isGitHubRemote` in `src/sync/github-preview.mjs`; `test/github-preview.test.mjs` |
| Body-free preview, selected-note commit, one-commit push, add-only import | implemented, tested | same file; local bare remote only |
| Profile declarations (`twin_profiles`) and named-agent scoping | implemented, tested | `src/twin-profiles.mjs`, `src/config.mjs`, `test/twin-profiles.test.mjs` |
| **Binding between a profile and a repository** | **absent** | The GitHub routes in `src/setup.mjs` take `repository` and `vault` from the request body on every call. No config field stores a repository. |
| Profile check on GitHub operations | **absent** | The functions never consult `cfg.twin_profiles`; any configured non-private vault can be published to any GitHub clone. |
| Repository reuse across profiles | **absent** (nothing prevents it) | The same clone path or `owner/repo` can be used while "acting as" any profile. |
| Note-scope allowlist for GitHub | **absent** | Every non-private, non-generated, secret-free note in the vault is a candidate. |
| Commit receipt bound to a profile | **absent** | Push accepts any short SHA that matches local HEAD. |
| UI state reset on profile change | **absent** | There is no profile selector in the GitHub panel. |

## Gap this change closes

A durable, user-confirmed `github_repository` assignment inside each Twin profile (remote identity, local clone path, one vault, an explicit folder allowlist or whole-vault confirmation), enforced before listing, previewing, committing, pushing and importing. Missing, malformed, stale or mismatched assignments fail closed. One `owner/repo`, one clone path and one assigned vault map to one profile.

## Not changed

Git fetch/push/import mechanics, privacy filtering, secret scanning, symlink/dirty-tree/ancestry/conflict protections. Concurrent branch `feat/rsi-research-discovery` also edits `ui/index.html` and the locale files (different feature); merge conflicts there are possible but not semantic.

## Policy choices to confirm

1. With **no** `twin_profiles` configured the existing unscoped behavior is kept (no profile boundary exists to violate). Once any profile exists, every GitHub operation requires an explicit profile and assignment.
2. A vault declared by more than one profile cannot be assigned to a repository (ambiguous owner).

## Test receipt

Environment: macOS (Darwin), Node.js v22.22.3, Apple Git 2.50.1, `npm ci` then `npm run test:all`. No live GitHub contact; all remotes are temporary local bare repositories.

| Tree | Tests | Pass | Fail | Skipped |
|---|---|---|---|---|
| Base `f9d0229` (clean worktree) | 293 | 290 | 2 | 1 |
| This branch | 302 | 299 | 2 | 1 |

The same two tests fail on the unmodified base on this machine, so they are not caused by this change:

- `failed local commit restores selected files and leaves the index clean` (`test/github-preview.test.mjs`) — expects a commit to be refused without a Git identity; Git on this Mac still commits. Likely an environment difference (global Git identity); not investigated further.
- `local Setup assigns an unowned session only to a session-authorized Twin and keeps it private` (`test/twin-profiles.test.mjs`) — session profile assignment returns `null`. Cause not investigated; unrelated to GitHub.

Focused commands: `node --import ./test/_preload.mjs --test test/github-profile-assignment.test.mjs test/github-preview.test.mjs test/twin-profiles.test.mjs test/locales.test.mjs test/ui-i18n-safety.test.mjs test/privacy-probe.test.mjs test/sync.test.mjs` (51 tests, 49 pass, the same 2 failures).

Limits: UI behavior was exercised once in the in-app browser with a fictional config (review, confirm, operations unlocked, profile switch cleared state); the UI test in `test/github-profile-assignment.test.mjs` is structural only. No cross-client, live-GitHub, accessibility or Windows run was done for this change.
