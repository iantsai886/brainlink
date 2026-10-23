# Structured cross-AI handoff

Status: implemented and locally tested; not cross-client validated or released.

`send_handoff` now accepts either the original free-form `body` or a structured
handoff with `goal`. Optional fields are `current_state`, `decisions`,
`modified_files`, `tests`, `open_questions`, `next_steps`, `source_refs`,
`scope`, and `confidence`. The result is still one ordinary Markdown note in
the configured handoff mailbox, not a parallel session system. Existing
handoffs remain readable.

`source_refs` accepts up to eight Markdown paths inside the handoff vault.
Each path must pass the existing read gate before the handoff is written.
Missing, excluded, symlinked, and private notes are rejected with one generic
error; source contents are never copied into the handoff. A `scope` label is
descriptive metadata, **not** a new authorization mechanism. Effective access
still comes from the connection's enabled vaults and the note privacy gate.
The caller must not paste private data into free-text fields; automated
content classification is not claimed here.

The fictional-company regression creates a structured handoff to Codex,
checks the fields and public source link, then tries a private source link and
checks that no second handoff was written. It is an API-level local test, not
proof that Claude Code and Codex have completed a real handoff together.

Reproduce: `node --import ./test/_preload.mjs --test --test-name-pattern="structured handoff|handoffs: send" test/brainlink.test.mjs`.
Full `npm test` on Windows/Node 24.18.0 after this change: 207 tests,
201 pass, 1 fail (`brainlink-store/contract-tests.mjs` missing from the
available local package), 5 skip (symlink privilege and Linux-only tests).
Rollback: revert the commit adding this feature; existing free-form handoffs
remain in the mailbox as Markdown and require no migration.
