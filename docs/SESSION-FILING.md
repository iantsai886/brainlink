# Session-to-memory filing: first governed path

Status: local UI filing, connected-AI close operation, opt-in hook setup and session-end reminders are implemented and locally tested. Live client lifecycle acceptance remains unverified.

The local BrainLink Sessions screen now offers **File summary** when a stored session has a summary. The user chooses a destination vault, previews an episodic note, and explicitly saves it. The note inherits `private: true` regardless of the session's sharing toggle, carries the session ID and client as provenance, and remains `status: proposed` / `confidence: reported`. It never copies raw turns or promotes a summary to verified semantic knowledge. The note writer rejects credential-like content, respects writable-vault policy, uses an existing intake folder, and never overwrites an existing note. No source-backed links are invented.

The filing screen can remember a destination for the exact project identifier after an explicit user choice. Future sessions with that exact identifier receive a visible suggestion; titles, summaries, keywords, and similar project names are never used to guess a destination. A missing, inaccessible, or read-only destination is not suggested. This preference only routes the draft: review and confirmation are still required before saving.

This path reuses the existing `proposeNote` write and attribution controls. The local API requires its Setup token. The preview and save actions require a chosen vault; neither an AI client nor filename matching silently chooses a personal, company, or client destination. The UI is available in English, Traditional Chinese, and Portuguese.

Connected MCP clients also have `session_close` and the `close-session` prompt. A client sends a stable task ID, explicit vault, title, goal, actual outcome and optional decisions, actions, corrections, open questions and next steps. A preview writes nothing. After approval or the user's close instruction, `confirm=true` stores a private summary-only session and a private proposed episode in that vault. The closure's client ID is deliberately distinct from imported Codex/Claude Code sessions, so the imported-session sharing switch cannot reveal it. Reusing a task ID is refused rather than changing an earlier outcome. This is an AI-reported summary, not an automatic transcript reader or a verified fact.

The session and vault note are two separate writes, not a transaction. If the session write succeeds but the note write fails (for example, concurrent filename creation or disk failure), the tool returns the failure with `session_saved: true`; the user can inspect the private session in the local UI and file it there. Do not claim both were saved unless `written: true` is returned. Simultaneous closes from separate BrainLink processes have not been tested for cross-process atomicity.

Validation: `test/session-filing.test.mjs` and `test/session-close.test.mjs` use fictional company and personal vaults and verify preview-only behavior, private frontmatter and read blocking, chosen-vault-only writing, no overwrite, rejection of empty summary and secrets, exact-project destination recommendations, API authentication, exclusion of raw private turns, a scoped MCP close, and non-exposure through the imported-session sharing switch. Run with `node --import ./test/_preload.mjs --test test/session-filing.test.mjs test/session-close.test.mjs`.

## End-of-session integration boundary

Both Claude Code and Codex document local `SessionEnd` command hooks. Their hook payloads include a session identifier, working directory, reason, and transcript path. This makes a local end cue technically possible; it does not by itself produce a reviewed outcome summary or authorize saving one. BrainLink must not read transcript contents just because a lifecycle hook supplies a path. The opt-in command below records only a minimal local cue. Transcript ingestion would need a separate explicit setting, source-scope checks, secret filtering, and private-by-default storage.

Add this handler to the client's existing `SessionEnd` hook configuration (merge it with existing hooks; do not replace them):

```json
{
  "type": "command",
  "command": "brainlink session-end-cue --client claude-code"
}
```

The Sessions screen provides **Enable reminders** / **Disable reminders** for each client. Setup merges BrainLink's handler into user-level Claude Code settings or Codex hooks.json, backs up existing files, refuses malformed JSON, and preserves other hooks. Commands use absolute executable, script and application-data paths. Codex must separately review and trust the hook through `/hooks`; the UI labels configuration separately from verified runtime. No trust settings are modified. The `disconnect-all` command used by uninstallers removes only BrainLink's marked handlers.

Use `--client codex` for manual Codex configuration. The command reads hook JSON from stdin, discards `cwd` and `transcript_path`, and writes an idempotent cue under BrainLink's local application data. Reminders appear in the Sessions screen; **Dismiss reminder** hides one while retaining its local record. Duplicate deliveries do not revive dismissed reminders. Only client and end time are sent to this authenticated local UI alongside an opaque cue identifier. Run `brainlink session-end-cues` to inspect pending cues from the command line. Cues do not generate or file summaries.

Validation: `test/session-hooks.test.mjs` checks merge/disable preservation, backups, idempotent installation, malformed-file refusal, authenticated controls, explicit boolean selection, and actual shell execution of generated commands over fictional data, including paths with spaces. `test/session-end-cue.test.mjs` checks minimal event storage, duplicate deliveries, private-field exclusion, authenticated UI listing and retained dismissal. Browser review in an isolated fictional vault checked enable, trust guidance, dismissal and layout. See [UI evidence](evidence/session-closeout-ui.png). This does not replace a live client lifecycle test. Rollback: disable reminders in Sessions before reverting the change; saved cue records remain local.

Official references checked 2026-10-24: [Claude Code hooks reference](https://code.claude.com/docs/en/hooks#sessionend) and [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks).

Remaining for the complete product: AI-assisted summary with review, automatic destination recommendation with explainable evidence, source-linked and reversible classification, user correction, live hook and cross-client handoff verification, token/time measurement, and privacy evaluation across personal/company/client fixtures. A lifecycle cue or AI-reported summary alone is not a verified experience or long-term rule.
