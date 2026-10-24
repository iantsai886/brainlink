# Versioned Agent Skills

BrainLink keeps the canonical skill package in `skills/`. Repository clients have different discovery roots, so identical `SKILL.md` copies are checked in under `.agents/skills/` for Codex and `.claude/skills/` for Claude Code. `test/skills.test.mjs` fails if those copies drift or the required manifest fields, registry metadata, or key safety behaviors are missing.

The manifest follows the [Agent Skills specification](https://agentskills.io/specification): the skill directory and lowercase `name` match, `description` explains use, and BrainLink registry fields are string values under standard `metadata`. Client compatibility is explicit: matching file format does not by itself prove the workflow or MCP server works in a client.

## `brainlink-cross-ai-handoff` 0.1.0

- **Purpose:** prepare or pick up a task through BrainLink's existing structured handoff mailbox.
- **Clients:** Codex CLI and Claude Code, where the repo-local skill directory is enabled.
- **Tools:** connected BrainLink MCP `brainlink_guide`, `send_handoff`, and `list_handoffs`.
- **Scope:** no private source text, no cross-lane data, no guessed destination. Sending is preview-first and requires approval unless the user clearly authorized the handoff.
- **Validation:** Agent Skills manifest/parity test; BrainLink structured-handoff and privacy fixture tests; Codex CLI local prompt-input discovery check. Claude Code CLI is not installed in the validation environment; live two-client handoff is still pending.
- **Rollback:** revert the Git change to the canonical skill and both client copies. No vault migration is needed.

To validate the files and client copies, run `node --test test/skills.test.mjs`. The broader BrainLink tests exercise the real handoff tool's preview, source filtering, and privacy behavior; they do not simulate a real model or claim cross-client completion.
