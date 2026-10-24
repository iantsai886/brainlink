# Personal and Organisation Twin profiles

Status: validated profile declarations and initial read-only runtime scoping for explicitly assigned AI-agent tokens. This gate restricts those agents to profile-listed vaults and granted search/read operations. Other client connections keep their existing scopes; this is not full Personal/Organisation isolation.

## Contract

The optional `twin_profiles` array in `config.json` records a Twin's identity and intended boundaries:

- `id`, `name`, `mode` (`personal` or `organisation`), and an owner label;
- `vaults`: configured vault names and the declared access level (`read`, `propose`, `write`);
- `source_policy`: private-by-default, provenance-required, and session-capture policy;
- `memory_policy`: explicit booleans for working, semantic, procedural, and episodic memory;
- `allowed_actions`: supported operations for the profile;
- `agent_access`: each connected AI agent's explicit per-vault access level and operation subset.

Configuration validation rejects unknown vaults, unknown/revoked agents, duplicate profile/vault/agent references, unsupported actions, and an agent grant broader than its profile's declared action or per-vault access level. A recognized agent token assigned to one profile is restricted to that profile's configured vault subset; `tools/list` advertises only granted read/search tools and the vault choices for each tool. An unknown or unassigned token fails closed when any Twin profiles are configured. Unprofiled platform clients without a named-agent token continue using their existing connection scope. The authenticated local Setup `/api/state` response projects profile declarations and public agent names; token hashes and credentials are never part of the projection.

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

This is an initial read-only gate, not full Twin isolation. Profile-scoped agents cannot write notes, read or write session history, or read/write handoffs yet; those tools are withheld and direct calls are rejected. The UI states that these restrictions apply only to named agent tokens assigned to profiles. Before enabling profile writes, BrainLink must bind session and handoff data to the same profile and enforce scope before excerpting, summarising, logging, and mutation. Also add separate fictional Personal, Organisation, and Client corpora, test cross-profile canaries at each boundary, and validate preset AI clients, not only named tokens. The current canary test proves an unassigned vault is outside a bound agent's context; it does not prove complete system-wide Twin isolation.
