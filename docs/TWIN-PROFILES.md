# Personal, Organisation, and Client Twin profiles

Status: validated profile declarations and runtime scoping for explicitly assigned AI-agent tokens. Setup now provides local profile creation, permission editing, and per-app assignment for built-in AI clients. Each built-in client gets its own token-backed identity and can receive per-vault search, note reading, session history, private session-closeout proposals, and handoff permissions. Session access must be selected for every vault granted to that AI because session history is a profile-wide tool. Handoff actions are available only in the configured mailbox vault. Disconnect revokes that token. The built-in-client health check is an in-process MCP call; loading the settings in a real running AI app remains unverified. Named agents are restricted to profile-listed vaults, granted operations, and enabled memory types. Session reads require an explicit `read_session` grant and exact profile ownership. Private closeouts require `propose_note` and filing-folder grants, use preview/confirmation, and store the profile owner. Handoff reads and sends require separate `handoff_read` / `write_handoff` grants and carry a profile owner. Handoff updates are append-only replies with validated lifecycle status; the local receipt shows the latest update while preserving the original request. Tokenless AI connections fail closed when any Twin profile exists. This is a partial permission gate, not complete Personal/Organisation/Client isolation or cross-client acceptance.

### Creating a profile in Setup

The Twin section in local Setup lets a user choose a name, type, owner, available non-private vaults, maximum vault access, named AI agents, each agent's allowed operations, and the four memory switches. The app asks for confirmation before saving. The authenticated `POST /api/twins/create` endpoint rechecks every choice, rejects private or unavailable vaults and unsupported operations, validates the resulting full configuration, and returns only the public profile view. New profiles default to private-by-default sources, required provenance, and metadata-only session capture. Creating a profile does not connect an AI agent, assign a GitHub repository, grant access to private vaults, or prove isolation for clients outside the named-agent token path. The owner label defaults to the profile name if left blank.

Each editable profile card can reopen the same form for permission changes. Saving updates the existing profile ID, preserves its source policy and GitHub assignment, and validates the full config before saving. The Twin type and owner are fixed after creation so old sessions and handoffs cannot be relabeled across privacy boundaries. The confirmation names each selected vault and access level, each agent and its actions per vault, and the enabled memory types; it also warns when selected agents may read older sessions belonging to this Twin. Each named agent can receive separate action grants for each selected vault. Server validation rejects grants outside the selected profile vaults, duplicate grants, unsupported actions, empty grants, and note proposals when that vault was not granted propose access. Older clients that submit one action list per agent remain supported and apply that list uniformly to selected vaults. It refuses removing the vault currently bound to GitHub; clear that assignment separately first. Profile deletion is not offered because sessions and handoffs can refer to a profile ID.

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

This remains a partial gate, not full Twin isolation. Profile-scoped agents and built-in clients cannot use general note writes. Session logging remains blocked. Session reads are available only with an explicit `read_session` grant and exact stored profile ownership; imported/unassigned sessions stay hidden. The authenticated local Setup UI can assign an unowned session only to a configured profile with an agent explicitly granted `read_session`; this action is one-way, forces the session to remain private, and is not exposed to AI tools. Private session closeouts require `propose_note` plus folder-list access and retain the existing preview/confirmation flow. Handoff reads and sends each require a separate explicit grant; an update may reference only a valid, non-private handoff owned by the same Twin profile, checked through bounded frontmatter before its body is read. Missing and foreign-profile targets return the same error. New handoffs default to `REQUEST`; replies default to `ACKNOWLEDGED` and may use `IN_PROGRESS`, `BLOCKED`, `COMPLETED`, or `CANCELLED`. A reply is a new mailbox note linked by `ack_of`; the local receipt derives its current status from the newest visible reply, never mutating the original. Memory-type access is enforced for tools, prompts, and resources. Tokenless connections fail closed. Shared-vault note access across Twin profiles is rejected; mailbox-only handoff sharing is allowed. Native client pickup, app-to-app handoff, desktop usability, complete isolation across every data surface, and release gates remain open.
