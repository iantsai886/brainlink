# Personal, Organisation, and Client Twin profiles

Status: validated profile declarations and runtime scoping for explicitly assigned AI-agent tokens. Setup provides local profile creation, permission editing, and per-app assignment for built-in AI clients. Each client gets its own token-backed identity and per-vault operations. An explicit `write_note` grant allows direct creation/appending in that granted vault after `confirm=true`; it never overwrites existing notes and does not bypass excluded-path, secret, or read-only checks. Without the write grant, note creation remains a preview. Session reads require `read_session`; private session logging requires `log_session`; closeouts require episodic access plus a granted destination and save only summary text, never a raw transcript. Handoff reads and sends remain separate grants and are available only in the configured mailbox vault. Disconnect revokes that token. The built-in-client health check is an in-process MCP call; loading settings in a real running AI app remains unverified until that app is restarted. Tokenless AI connections fail closed when any Twin profile exists. This is a partial permission gate, not complete Personal/Organisation/Client isolation or cross-client acceptance.

The `brainlink_guide` response reports `writes_available`, `write_vaults`, and proposal-only vaults. When `private_default` is true, new profile-scoped notes stay private. When `provenance_required` is true, every note requires a source, stable `session_or_task_id`, and confidence (`verified`, `reported`, `inferred`, or `unknown`). `write_note` permits a confirmed direct save only to its granted vault; other vaults remain proposal-only. The Raw-to-Wiki MCP prompt is exposed only when its guide, read, search, proposal, and filing-receipt tools are all granted and related memory types are enabled.

In Setup and the built-in AI connection dialog, note access is semantic; `read_session`, `log_session`, and private session closeout are episodic. Session logging is opt-in, profile-owned and forced private. `metadata-only` blocks content logging and closeout; `summary-proposal` allows private summary/log paths but refuses full-text reads; `full-text-opt-in` permits full-text reads only for that Twin, and imported private sessions still require the separate global “share full text” choice.

Setup's connection check also permits an AI that has only `propose_note`: it checks that the granted tool is listed and does not create a test note. The profile create, edit, and connect endpoints all enforce the same semantic-versus-episodic mapping as the UI.

### Creating a profile in Setup

The Twin section lets a user choose available vaults with read, propose, or full read/write access, then select the operations and memory types for each AI. Full read/write assignments default to search, read, and new-note writes. The existing **Apply read and propose access** preset remains available. The built-in app connection dialog applies only the selected profile grants and still requires confirmation. The create/update/connect endpoints recheck each choice and validate the full configuration. New profiles default to private-by-default sources, required provenance, and summary-only closeout support; full-text session access remains off. Profile creation alone does not connect an AI agent or assign a GitHub repository.

Each editable profile card can reopen the same form for permission changes. Saving updates the existing profile ID and preserves its GitHub assignment. The Twin type and owner remain fixed. The confirmation names vault access, each agent's actions, and enabled memory types. Server validation rejects grants outside profile vaults, duplicate grants, unsupported actions, empty grants, and write operations beyond the selected access level. Existing notes cannot be overwritten. The app refuses removing a vault currently bound to GitHub; clear that assignment separately first. Profile deletion is not offered because sessions and handoffs can refer to a profile ID.

## Contract

The optional `twin_profiles` array in `config.json` records a Twin identity and intended boundaries. Its optional `github_repository` object binds the profile to a GitHub owner/repository identity, one absolute local clone path, one non-private vault, an optional folder allowlist, and a user-confirmation timestamp. Setup validates the origin and prevents repository, clone, or vault reuse across profiles. Every sharing/import operation resolves the saved assignment before reading note candidates and verifies that the clone still has the assigned origin. This boundary applies only to BrainLink's authenticated local Setup GitHub workflow; it cannot constrain AI clients granted direct GitHub access outside BrainLink.

- `id`, `name`, `mode` (`personal`, `organisation`, or `client`), and an owner label;
- `vaults`: configured vault names and the declared access level (`read`, `propose`, `write`);
- `source_policy`: private-by-default, provenance-required, and session-capture policy;
- `memory_policy`: explicit booleans for working, semantic, procedural, and episodic memory;
- `allowed_actions`: supported operations for the profile;
- `agent_access`: each connected AI agent's explicit per-vault access level and operation subset.

Configuration validation rejects unknown vaults, unknown/revoked agents, duplicate profile/vault/agent references, unsupported actions, and an agent grant broader than its profile's declared action or per-vault access level. A recognized agent token assigned to one profile is restricted to that profile's configured vault subset; `tools/list` advertises only granted tools and the vault choices for each tool. Built-in AI clients receive a distinct random token; the hash stays in BrainLink config and the raw token is only placed in that app's local MCP config. Setup grants only the actions selected by the user, never general note writes. Session ownership is persisted as `profile_id`; list filtering happens in the store before title/summary query matching, and per-ID reads enforce that same profile before metadata, excerpts, or messages are returned. Older/imported sessions with no owner remain unavailable to scoped agents. Profile closeouts save a private summary linked to that profile and only the approval-gated note proposal can write into an explicitly granted vault. Handoffs are tagged with a server-supplied profile owner; mailbox filtering checks bounded frontmatter before reading message bodies, and unassigned/foreign-profile handoffs are omitted. An unknown, unassigned, or tokenless AI connection fails closed when any Twin profiles are configured. Local Setup and its background jobs use a separate trusted-local context. The authenticated local Setup `/api/state` response projects profile declarations and public agent names; token hashes and credentials are never part of the projection.

**Shared-vault rule:** one vault may be listed under multiple Twin profiles only when every profile's agent grants for that vault are restricted to `handoff_read` and/or `write_handoff`. If two profiles grant `search`, `read_note`, `propose_note`, or `write_note` on the same vault, configuration validation rejects the setup. Keep Personal, Organisation, and Client notes in separate vaults; a shared mailbox is the narrow exception. This is enforced when loading and saving config, including Twin creation and edits.

### Memory-type enforcement

The profile's four booleans are runtime access controls for named agent tokens. They filter tool discovery and direct tool calls; the same policy filters prompts and MCP resources. A caller cannot bypass a disabled type by calling a hidden tool name or guessing a resource URI. Current surface mapping:

| Type | Scoped surfaces |
|---|---|
| Working | Inter-agent handoff mailbox and configured working-state tails in agent activation context |
| Semantic | Durable note search/read/links, current summaries, recent notes, open loops, saved memories, and the source-ingestion queue |
| Procedural | BrainLink guide, role activation, and published `read_first` instructions |
| Episodic | Session list/read/closeout, session filing destinations, and configured capture summaries in agent activation context |

Vault grants and memory-type policy must both allow an operation. `agent_connect` itself requires procedural access, but its mixed context packet checks the working, semantic, and episodic switches separately before reading those sections. The shared semantic note index also omits documents BrainLink can identify as another memory type: configured `read_first` and role notes (procedural), configured tails and handoff folders (working), configured closeout targets (working or episodic), and explicit `memory_type` or known episode/handoff frontmatter. It checks bounded frontmatter before reading a note body, then rechecks after the body read to handle a file changing during indexing. Direct note reads use the same filter. Generic notes without a known type remain semantic. This is a first implementation; cross-client acceptance and other data surfaces still need review.

Focused synthetic canary validation: `test/twin-profiles.test.mjs` and `test/brainlink.test.mjs` passed 95 tests, 0 failed, 1 platform-only skip on Windows. For each disabled non-semantic type, canaries are checked across semantic search, direct reads, recent notes, open loops, brief, link health, and related-note suggestions; enabled type content and generic semantic knowledge remain available. A direct note read also rechecks memory type after reading the body, so changed frontmatter cannot bypass a stale index. This verifies the local MCP boundary only, not live behavior in every external AI client.

Example values are synthetic. They illustrate the declaration shape, not effective access:

```json
{
  "twin_profiles": [{
    "id": "fictional_org",
    "name": "Example Organisation Twin",
    "mode": "organisation",
    "owner": "fictional-owner",
    "vaults": [{ "name": "Example Company", "access": "propose" }],
    "source_policy": {
      "private_default": true,
      "provenance_required": true,
      "session_capture": "summary-proposal"
    },
    "memory_policy": {
      "working": true,
      "semantic": true,
      "procedural": true,
      "episodic": true
    },
    "allowed_actions": ["search", "read_note", "propose_note"],
    "agent_access": [{
      "agent_id": "fictional_agent_id",
      "vaults": [{
        "name": "Example Company",
        "access": "read",
        "operations": ["search", "read_note"]
      }]
    }]
  }]
}
```

## GitHub repository assignment

A profile may declare one confirmed `github_repository` (remote identity, local clone, vault, optional folders). GitHub sharing for that profile works only with that assignment and fails closed otherwise; repositories, clones and vaults are exclusive to one profile. Details: [GITHUB-SHARED-KNOWLEDGE.md](GITHUB-SHARED-KNOWLEDGE.md#profile-scoped-repositories). This does not extend named-agent scoping to other data surfaces.

## Security and next gate

This remains a partial gate, not full Twin isolation. Profile-scoped agents and built-in clients cannot use general note writes. Session reads require an explicit `read_session` grant and exact stored profile ownership; imported/unassigned sessions stay hidden. Session logging requires a separate `log_session` grant, always forces private storage, and may append only to sessions owned by that profile. The authenticated local Setup UI can assign an unowned session only to a configured profile with an agent explicitly granted `read_session`; this action is one-way, forces the session to remain private, and is not exposed to AI tools. Private session closeouts require `propose_note` plus folder-list access and retain the existing preview/confirmation flow. Handoff reads and sends each require a separate explicit grant; an update may reference only a valid, non-private handoff owned by the same Twin profile, checked through bounded frontmatter before its body is read. Missing and foreign-profile targets return the same error. New handoffs default to `REQUEST`; replies default to `ACKNOWLEDGED` and may use `IN_PROGRESS`, `BLOCKED`, `COMPLETED`, or `CANCELLED`. A reply is a new mailbox note linked by `ack_of`; the local receipt derives its current status from the newest visible reply, never mutating the original. Memory-type access is enforced for tools, prompts, and resources. Tokenless connections fail closed. Shared-vault note access across Twin profiles is rejected; mailbox-only handoff sharing is allowed. Native client pickup, app-to-app handoff, desktop usability, complete isolation across every data surface, and release gates remain open.
