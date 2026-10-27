# Versioned Agent Skills

BrainLink keeps the canonical skill package in `skills/`. Repository clients have different discovery roots, so identical `SKILL.md` copies are checked in under `.agents/skills/` for Codex and `.claude/skills/` for Claude Code. Setup can also install the canonical skills into the user-level skill folder for connected Claude Code, Codex CLI, Gemini CLI, Google Antigravity App/IDE, Antigravity CLI, Hermes Agent, or DeepSeek Harness. It tracks hashes and only updates/removes files BrainLink still owns; local edits and conflicting files are preserved. A successful file install does not prove that a specific client has discovered or followed the skill. Antigravity App/IDE uses `~/.gemini/config/skills`; Antigravity CLI uses `~/.gemini/antigravity-cli/skills`, per [Google's docs](https://www.antigravity.google/docs/skills). Hermes defaults to `~/.hermes/skills` unless `HERMES_HOME` is set. `test/skills.test.mjs` checks repository copy parity and manifest/safety rules; `test/agent-skills.test.mjs` checks managed installation.

The manifest follows the [Agent Skills specification](https://agentskills.io/specification): the skill directory and lowercase `name` match, `description` explains use, and BrainLink registry fields are string values under standard `metadata`. Client compatibility is explicit: matching file format does not by itself prove the workflow or MCP server works in a client.

## `brainlink-cross-ai-handoff` 0.2.0

- **Purpose:** prepare or pick up a task through BrainLink's existing structured handoff mailbox.
- **Clients:** Claude Code, Codex CLI, Gemini CLI, Google Antigravity, Hermes Agent, and DeepSeek Harness. User-level installation is available in Setup after connecting the client.
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

## `brainlink-graph-curation` 1.0.0

- **Purpose:** guide an AI to turn one selected source into separate typed entities and evidence-backed relationship proposals in the existing Markdown graph.
- **Clients:** any Agent Skills-compatible client connected to BrainLink MCP; Claude Code and Codex have repository discovery copies. Setup can install it for the supported connected clients listed above.
- **Tools:** `brainlink_guide`, `vault_search`, `vault_read_note`, and `propose_note`.
- **Scope:** one authorized vault at a time; stable typed IDs; exact source evidence; only same-vault, same-scope current targets; every new entity and edge stays proposed until human review. It does not edit existing notes or claim measured token savings.
- **Validation:** Agent Skills manifest, client-copy parity, scope, evidence, and approval workflow assertions pass locally. Live client discovery and extraction quality remain unverified.
- **Rollback:** revert the canonical Skill, the two discovery copies, documentation, and tests. No vault migration is needed.

To validate the files and client copies, run `node --test test/skills.test.mjs`. To run the fictional two-client MCP flow, run `node --import ./test/_preload.mjs --test test/cross-client-handoff.test.mjs`. It exercises the real MCP tools without simulating model behavior or claiming live client completion.
