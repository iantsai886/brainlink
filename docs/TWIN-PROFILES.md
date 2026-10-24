# Personal and Organisation Twin profiles

Status: validated profile declarations and runtime scoping for explicitly assigned AI-agent tokens. This gate restricts those agents to profile-listed vaults and granted search/read operations. Session reads require an explicit `read_session` grant and exact profile ownership. Private closeouts require `propose_note` and filing-folder grants, use preview/confirmation, and store the profile owner. Other client connections keep their existing scopes; this is not full Personal/Organisation isolation.

## Contract

The optional `twin_profiles` array in `config.json` records a Twin's identity and intended boundaries:

- `id`, `name`, `mode` (`personal` or `organisation`), and an owner label;
- `vaults`: configured vault names and the declared access level (`read`, `propose`, `write`);
- `source_policy`: private-by-default, provenance-required, and session-capture policy;
- `memory_policy`: explicit booleans for working, semantic, procedural, and episodic memory;
- `allowed_actions`: supported operations for the profile;
- `agent_access`: each connected AI agent's explicit per-vault access level and operation subset.

Configuration validation rejects unknown vaults, unknown/revoked agents, duplicate profile/vault/agent references, unsupported actions, and an agent grant broader than its profile's declared action or per-vault access level. A recognized agent token assigned to one profile is restricted to that profile's configured vault subset; `tools/list` advertises only granted tools and the vault choices for each tool. Session ownership is persisted as `profile_id`; list filtering happens in the store before title/summary query matching, and per-ID reads enforce that same profile before metadata, excerpts, or messages are returned. Older/imported sessions with no owner remain unavailable to scoped agents. Profile closeouts save a private summary linked to that profile and only the approval-gated note proposal can write into an explicitly granted vault. An unknown or unassigned token fails closed when any Twin profiles are configured. Unprofiled platform clients without a named-agent token continue using their existing connection scope. The authenticated local Setup `/api/state` response projects profile declarations and public agent names; token hashes and credentials are never part of the projection.

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

This remains a partial gate, not full Twin isolation. Profile-scoped agents cannot use general note writes or handoffs. Session logging remains blocked. Session reads are available only with an explicit `read_session` grant and exact stored profile ownership; imported/unassigned sessions stay hidden. Private session closeouts require `propose_note` plus folder-list access and retain the existing preview/confirmation flow. The UI states that these restrictions apply only to named agent tokens assigned to profiles. Before enabling general profile writes or handoffs, BrainLink must enforce scope at each read, excerpt, summary, log, and mutation boundary. Also add separate fictional Personal, Organisation, and Client corpora, test cross-profile canaries at each boundary, provide a safe UI for assigning existing records, and validate preset AI clients, not only named tokens. These tests do not prove complete system-wide Twin isolation.
