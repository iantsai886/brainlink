# Versioned Agent Skills

BrainLink keeps the canonical skill package in `skills/`. Repository clients have different discovery roots, so identical `SKILL.md` copies are checked in under `.agents/skills/` for Codex and `.claude/skills/` for Claude Code. `test/skills.test.mjs` fails if those copies drift or the required manifest fields, registry metadata, or key safety behaviors are missing.

The manifest follows the [Agent Skills specification](https://agentskills.io/specification): the skill directory and lowercase `name` match, `description` explains use, and BrainLink registry fields are string values under standard `metadata`. Client compatibility is explicit: matching file format does not by itself prove the workflow or MCP server works in a client.

## `brainlink-cross-ai-handoff` 0.2.0

- **Purpose:** prepare or pick up a task through BrainLink's existing structured handoff mailbox.
- **Clients:** Codex CLI and Claude Code, where the repo-local skill directory is enabled.
- **Tools:** connected BrainLink MCP `brainlink_guide`, `send_handoff`, and `list_handoffs`.
- **Scope:** no private source text, no cross-lane data, no guessed destination. Sending is preview-first and requires approval unless the user clearly authorized the handoff.
- **Validation:** Agent Skills manifest/parity test and local two-client fixture pass. Codex CLI 0.164.0-alpha.11.1 made live `brainlink_guide` and `vault_search` calls on a fictional vault; a planted private canary was not returned. Claude Code 2.1.310 reported the same fixture MCP server as connected, but Claude is signed out. A real Claude-to-Codex handoff and acknowledgement are still pending.
- **Rollback:** revert the Git change to the canonical skill and both client copies. No vault migration is needed.

## `brainlink-session-closeout` 1.1.0

- **Purpose:** guide an AI client to prepare and verify a private, source-aware session closeout through BrainLink's existing `session_close` flow.
- **Clients:** any Agent Skills-compatible client connected to BrainLink MCP; Claude Code and Codex have repository discovery copies.
- **Tools:** `brainlink_guide`, `session_close`; when separately granted, `session_filing_folders`, `vault_search`, `vault_read_note`, and `propose_note`.
- **Scope:** keeps the episode private and proposed; after saving it, optionally identifies up to three distinct, source-backed semantic/procedural candidates in the same authorized vault. Each durable candidate needs its own preview and user approval. Working context stays temporary; no duplicate episode is created.
- **Validation:** manifest, byte-identical discovery-copy, memory-type distinction, provenance, scope, and separate-approval assertions pass locally. No live model/client closeout, automatic transcript reading, or real-world filing accuracy is claimed.
- **Rollback:** revert the Git change to the canonical skill and both client copies. No vault migration is needed.

To validate the files and client copies, run `node --test test/skills.test.mjs`. To run the fictional two-client MCP flow, run `node --import ./test/_preload.mjs --test test/cross-client-handoff.test.mjs`. It exercises the real MCP tools without simulating model behavior or claiming live client completion.
