# Personal and Organisation Twin profiles

Status: a validated, read-only declaration and Setup status view. Profile declarations are **not runtime authorization** and must not be used as a security boundary. Existing vault and connection permissions remain governed by the current BrainLink config and runtime paths.

## Contract

The optional `twin_profiles` array in `config.json` records a Twin's identity and intended boundaries:

- `id`, `name`, `mode` (`personal` or `organisation`), and an owner label;
- `vaults`: configured vault names and the declared access level (`read`, `propose`, `write`);
- `source_policy`: private-by-default, provenance-required, and session-capture policy;
- `memory_policy`: explicit booleans for working, semantic, procedural, and episodic memory;
- `allowed_actions`: supported operations for the profile;
- `agent_access`: each connected AI agent's explicit per-vault access level and operation subset.

Configuration validation rejects unknown vaults, unknown/revoked agents, duplicate profile/vault/agent references, unsupported actions, and an agent grant broader than its profile's declared action or per-vault access level. The authenticated local Setup `/api/state` response projects only profile declarations and public agent names; token hashes and credentials are never part of the projection. The Settings view labels the grants as declaration-only.

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

This is the first profile contract slice, not full Twin isolation. No agent can currently select a profile token grant at runtime, so the status surface says `enforcement: not_active`. Before enabling profile-based access or adding profile-write controls, BrainLink must bind each client identity to a profile and enforce profile, vault, operation, and read/write scope before note indexing, ranking, excerpts, summaries, handoff creation, activity logs, and every mutation. Add separate fictional Personal, Organisation, and Client corpora, test cross-profile canaries at each boundary, and only then expose profile creation/editing. Existing private-note ordering tests continue to cover current retrieval paths; they do not prove Twin-profile enforcement.
