# Handoff lifecycle

BrainLink models a handoff as an immutable request plus zero or more immutable replies. Replies point back to the request through `ack_of`; they never edit the original Markdown file.

## Status rules

- A new handoff defaults to `REQUEST`. Only `REQUEST` is valid without `ack_of`.
- A reply defaults to `ACKNOWLEDGED`. Replies must include `ack_of` and may use `ACKNOWLEDGED`, `IN_PROGRESS`, `BLOCKED`, `COMPLETED`, or `CANCELLED`.
- Invalid states, a reply without its parent, and a new request marked with a reply state are rejected before writing.
- The target is checked inside the configured mailbox. For a profile-scoped agent it must be non-private, visible, and owned by the same Twin profile. The check reads bounded frontmatter before any target body.
- Every update is a new Markdown record with the sender, timestamp, status, subject, and optional structured work details. The local receipt derives the displayed state from the newest visible update. Old `ACK`, `DONE`, and `COMPLETE` states are normalized for display.

The local UI shows the current lifecycle state, latest update subject, sender, and time. If two or more replies have the same newest timestamp, it shows **Multiple updates need review** instead of selecting a winner. The mailbox remains the source of truth; a person can compare the replies there. BrainLink does not resolve conflicting outcomes automatically.

## Evidence and limits

The fictional tests cover default states, valid and invalid transitions, multiple updates, latest-state selection, same-time conflicting updates, unchanged original request bytes, same-profile updates, foreign-profile rejection, and private handoff non-disclosure. Run `node --import ./test/_preload.mjs --test test/brainlink.test.mjs test/cross-client-handoff.test.mjs test/twin-profiles.test.mjs`.

For an opt-in live receiver check, run `node scripts/smoke-live-codex-handoff.mjs --live` from a signed-in Codex CLI host. It makes one model turn using only temporary fictional vaults, an ephemeral Codex session, and per-command BrainLink MCP settings; it does not read the user's real vault or change the normal Codex config. The check verifies a sender-created request, Codex tool use, an append-only response, and a hidden private canary. It does not verify Claude as the live sender or replace user acceptance. The smoke uses Codex CLI's read-only sandbox and makes no shell or file changes through the model.

This is not a transactional distributed workflow engine. Same-time updates are surfaced for human reconciliation; BrainLink does not resolve them. There is no platform identity proof beyond configured named-agent tokens. One live Codex receiver smoke passed with a fictional sender; a live Claude Code sender and real Claude-to-Codex continuation remain unverified. Non-profile clients continue to use their existing connection scope. Do not interpret a status written by an AI as independently verified completion.
