# Structured cross-AI handoff

Status: implemented and locally tested through a two-client MCP integration fixture. A live Codex CLI privacy probe passed, and Claude Code's MCP health check connected; the full model-driven Claude Code ↔ Codex handoff remains unverified and unreleased.

`send_handoff` now accepts either the original free-form `body` or a structured
handoff with `goal`. Optional fields are `current_state`, `decisions`,
`modified_files`, `tests`, `open_questions`, `next_steps`, `source_refs`,
`scope`, `confidence`, and `git`. The result is still one ordinary Markdown note in
the configured handoff mailbox, not a parallel session system. Existing
handoffs remain readable.

The optional `git` object records `{repo, branch, head, dirty, ahead}`. The
repository is an `owner/name` label only; URLs and local paths are refused.
Branch names, commit SHAs, booleans and counts are checked before preview or
write. BrainLink cannot inspect the sender's checkout, so the note labels these
values as reported by the sender. On pickup, the receiving agent checks its
own checkout and reports a match, behind state, divergence, or sender-reported
uncommitted work. This does not run Git commands for the sender or switch the
receiver's branch.

`source_refs` accepts up to eight Markdown paths inside the handoff vault.
Each path must pass the existing read gate before the handoff is written.
Missing, excluded, symlinked, and private notes are rejected with one generic
error; source contents are never copied into the handoff. A `scope` label is
descriptive metadata, **not** a new authorization mechanism. Effective access
still comes from the connection's enabled vaults and the note privacy gate.
The caller must not paste private data into free-text fields; automated
content classification is not claimed here.

Preview and confirmation: the preview returns the exact handoff path. Pass it
back as `preview_path` with `confirm=true`; BrainLink verifies that it stays in
the configured mailbox and matches the sender, recipient and subject. If the
path was claimed after preview, BrainLink refuses the write and asks for a new
preview. Existing same-minute names receive a numeric suffix. This prevents an
approved preview from silently changing paths and prevents concurrent writers
from overwriting a handoff.

The fictional-company regression creates a structured handoff to Codex,
checks the fields and public source link, then tries a private source link and
checks that no second handoff was written. It is an API-level local test, not
proof that Claude Code and Codex have completed a real handoff together.

`test/cross-client-handoff.test.mjs` adds a local two-client protocol fixture. It creates separate Claude Code and Codex MCP contexts over fictional company data, verifies preview-before-confirm, blocks a private source reference, has Codex pick up the saved task, and returns an acknowledgement through `ack_of`. It also checks a sender-reported Git checkpoint and rejects unsafe checkpoint values. Recipient filtering reads only bounded frontmatter before opening the body, and correctly supports hyphenated names such as “Claude Code.” This verifies BrainLink's MCP behavior and handoff format; it does not run either AI model or establish live client interoperability.

### Isolated CLI probe (2026-10-26)

Codex CLI 0.164.0-alpha.11.1, using `gpt-6-luna`, called `brainlink_guide` and searched a temporary fictional vault for `ZQXPRIVATECLI_CANARY_71A9`. BrainLink returned `not_in_brain` with no results. The Codex run was ephemeral, used a read-only shell, and had only the temporary BrainLink server enabled. Claude Code 2.1.310's `claude mcp list` health check reported `Connected` to that same temporary fixture. `claude auth status` reported signed out, so Claude made no model call and did not pick up or acknowledge the task. The fixture contains only synthetic files and an isolated BrainLink home; its recursive cleanup was blocked by automatic review, so it remains in the Windows temporary folder for removal. This validates one live Codex model-to-MCP path, the private-note search gate for that probe, and Claude's MCP server startup; it does not validate a cross-client task transfer.

Reproduce the complete local handoff flow with `node --import ./test/_preload.mjs --test test/cross-client-handoff.test.mjs test/brainlink.test.mjs`.
Latest full suite on Windows/Node 24.18.0: `npm run test:all` — core 329 tests
(323 passed, 0 failed, 6 skipped) and UI 28/28 passed. Skips are platform or
privilege-specific; see `docs/IMPLEMENTATION-STATUS.md` for dated evidence.
Rollback: revert the commit adding this feature; existing free-form handoffs
remain in the mailbox as Markdown and require no migration.
