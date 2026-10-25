# Personal, Organisation, and Client Twin profiles

Status: validated profile declarations and runtime scoping for explicitly assigned AI-agent tokens. This gate restricts those agents to profile-listed vaults and granted search/read operations. Session reads require an explicit `read_session` grant and exact profile ownership. Private closeouts require `propose_note` and filing-folder grants, use preview/confirmation, and store the profile owner. Handoff reads and sends require separate `handoff_read` / `write_handoff` grants and carry a profile owner. Handoff updates are append-only replies with validated lifecycle status; the local receipt shows the latest update while preserving the original request. Other client connections keep their existing scopes; this is not full Personal/Organisation/Client isolation.

## Contract

The optional `twin_profiles` array in `config.json` records a Twin identity and intended boundaries. Its optional `github_repository` field binds the profile to one absolute local clone path. Setup validates the GitHub origin, rejects assignments that reuse a local clone or remote repository across profiles, and resolves sharing/import operations from the saved assignment while checking the requested vault against the profile's declared list. This boundary applies only to BrainLink's authenticated local Setup GitHub workflow; it cannot constrain AI clients granted direct GitHub access outside BrainLink.

- `id`, `name`, `mode` (`personal`, `organisation`, or `client`), and an owner label;
- `vaults`: configured vault names and the declared access level (`read`, `propose`, `write`);
- `source_policy`: private-by-default, provenance-required, and session-capture policy;
- `memory_policy`: explicit booleans for working, semantic, procedural, and episodic memory;
- `allowed_actions`: supported operations for the profile;
- `agent_access`: each connected AI agent's explicit per-vault access level and operation subset.

Configuration validation rejects unknown vaults, unknown/revoked agents, duplicate profile/vault/agent references, unsupported actions, and an agent grant broader than its profile's declared action or per-vault access level. A recognized agent token assigned to one profile is restricted to that profile's configured vault subset; `tools/list` advertises only granted tools and the vault choices for each tool. Session ownership is persisted as `profile_id`; list filtering happens in the store before title/summary query matching, and per-ID reads enforce that same profile before metadata, excerpts, or messages are returned. Older/imported sessions with no owner remain unavailable to scoped agents. Profile closeouts save a private summary linked to that profile and only the approval-gated note proposal can write into an explicitly granted vault. Handoffs are tagged with a server-supplied profile owner; mailbox filtering checks bounded frontmatter before reading message bodies, and unassigned/foreign-profile handoffs are omitted. An unknown or unassigned token fails closed when any Twin profiles are configured. Unprofiled platform clients without a named-agent token continue using their existing connection scope. The authenticated local Setup `/api/state` response projects profile declarations and public agent names; token hashes and credentials are never part of the projection.

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

## Security and next gate

This remains a partial gate, not full Twin isolation. Profile-scoped agents cannot use general note writes. Session logging remains blocked. Session reads are available only with an explicit `read_session` grant and exact stored profile ownership; imported/unassigned sessions stay hidden. The authenticated local Setup UI can assign an unowned session only to a configured profile with an agent explicitly granted `read_session`; this action is one-way, forces the session to remain private, and is not exposed to AI tools. Private session closeouts require `propose_note` plus folder-list access and retain the existing preview/confirmation flow. Handoff reads and sends each require a separate explicit grant; an update may reference only a valid, non-private handoff owned by the same Twin profile, checked through bounded frontmatter before its body is read. Missing and foreign-profile targets return the same error. New handoffs default to `REQUEST`; replies default to `ACKNOWLEDGED` and may use `IN_PROGRESS`, `BLOCKED`, `COMPLETED`, or `CANCELLED`. A reply is a new mailbox note linked by `ack_of`; the local receipt derives its current status from the newest visible reply, never mutating the original. The UI states that these restrictions apply only to named agent tokens assigned to profiles. Before enabling general profile writes, BrainLink must enforce scope at each read, excerpt, summary, log, and mutation boundary. Personal, Organisation, and Client profile modes now exist in the schema. Fictional session canaries check each named profile against the other profiles and an unassigned session; fictional handoff canaries check that a Client Twin sees its own update but cannot read or acknowledge an Organisation handoff. Validate more data surfaces and preset AI clients, not only named tokens. These tests do not prove complete system-wide Twin isolation.
