# Personal, Organisation, and Client Twin profiles

Status: validated profile declarations and runtime scoping for explicitly assigned AI-agent tokens. Those agents are restricted to profile-listed vaults, granted operations, and enabled memory types. Session reads require an explicit `read_session` grant and exact profile ownership. Private closeouts require `propose_note` and filing-folder grants, use preview/confirmation, and store the profile owner. Handoff reads and sends require separate `handoff_read` / `write_handoff` grants and carry a profile owner. Handoff updates are append-only replies with validated lifecycle status; the local receipt shows the latest update while preserving the original request. Other client connections keep their existing scopes; this is not full Personal/Organisation/Client isolation.

## Contract

The optional `twin_profiles` array in `config.json` records a Twin identity and intended boundaries. Its optional `github_repository` object binds the profile to a GitHub owner/repository identity, one absolute local clone path, one non-private vault, an optional folder allowlist, and a user-confirmation timestamp. Setup validates the origin and prevents repository, clone, or vault reuse across profiles. Every sharing/import operation resolves the saved assignment before reading note candidates and verifies that the clone still has the assigned origin. This boundary applies only to BrainLink's authenticated local Setup GitHub workflow; it cannot constrain AI clients granted direct GitHub access outside BrainLink.

- `id`, `name`, `mode` (`personal`, `organisation`, or `client`), and an owner label;
- `vaults`: configured vault names and the declared access level (`read`, `propose`, `write`);
- `source_policy`: private-by-default, provenance-required, and session-capture policy;
- `memory_policy`: explicit booleans for working, semantic, procedural, and episodic memory;
- `allowed_actions`: supported operations for the profile;
- `agent_access`: each connected AI agent's explicit per-vault access level and operation subset.

Configuration validation rejects unknown vaults, unknown/revoked agents, duplicate profile/vault/agent references, unsupported actions, and an agent grant broader than its profile's declared action or per-vault access level. A recognized agent token assigned to one profile is restricted to that profile's configured vault subset; `tools/list` advertises only granted tools and the vault choices for each tool. Session ownership is persisted as `profile_id`; list filtering happens in the store before title/summary query matching, and per-ID reads enforce that same profile before metadata, excerpts, or messages are returned. Older/imported sessions with no owner remain unavailable to scoped agents. Profile closeouts save a private summary linked to that profile and only the approval-gated note proposal can write into an explicitly granted vault. Handoffs are tagged with a server-supplied profile owner; mailbox filtering checks bounded frontmatter before reading message bodies, and unassigned/foreign-profile handoffs are omitted. An unknown or unassigned token fails closed when any Twin profiles are configured. Unprofiled platform clients without a named-agent token continue using their existing connection scope. The authenticated local Setup `/api/state` response projects profile declarations and public agent names; token hashes and credentials are never part of the projection.

### Memory-type enforcement

The profile's four booleans are runtime access controls for named agent tokens. They filter tool discovery and direct tool calls; the same policy filters prompts and MCP resources. A caller cannot bypass a disabled type by calling a hidden tool name or guessing a resource URI. Current surface mapping:

| Type | Scoped surfaces |
|---|---|
| Working | Inter-agent handoff mailbox |
| Semantic | Durable note search/read/links, current summaries built from notes, and the source-ingestion queue |
| Procedural | BrainLink guide, role activation, and published `read_first` instructions |
| Episodic | Session list/read/closeout and session filing destinations |

Vault grants and memory-type policy must both allow an operation. This mapping is a first implementation and still needs cross-client acceptance and checks for other data surfaces.

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

This remains a partial gate, not full Twin isolation. Profile-scoped agents cannot use general note writes. Session logging remains blocked. Session reads are available only with an explicit `read_session` grant and exact stored profile ownership; imported/unassigned sessions stay hidden. The authenticated local Setup UI can assign an unowned session only to a configured profile with an agent explicitly granted `read_session`; this action is one-way, forces the session to remain private, and is not exposed to AI tools. Private session closeouts require `propose_note` plus folder-list access and retain the existing preview/confirmation flow. Handoff reads and sends each require a separate explicit grant; an update may reference only a valid, non-private handoff owned by the same Twin profile, checked through bounded frontmatter before its body is read. Missing and foreign-profile targets return the same error. New handoffs default to `REQUEST`; replies default to `ACKNOWLEDGED` and may use `IN_PROGRESS`, `BLOCKED`, `COMPLETED`, or `CANCELLED`. A reply is a new mailbox note linked by `ack_of`; the local receipt derives its current status from the newest visible reply, never mutating the original. Memory-type access is now enforced for tools, prompts, and resources. Validate every data surface and preset AI client, not only named tokens. These tests do not prove complete system-wide Twin isolation.
