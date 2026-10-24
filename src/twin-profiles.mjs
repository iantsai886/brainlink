// Read-only projection of declared Personal/Organisation Twin boundaries for local Setup.
// The contract is intentionally not an authorization mechanism yet; runtime enforcement must
// land and be tested before any profile grant is treated as effective.
export function twinProfileStatus(cfg) {
  const profiles = (cfg.twin_profiles || []).map((profile) => ({
    id: profile.id,
    name: profile.name,
    mode: profile.mode,
    owner: profile.owner,
    vaults: (profile.vaults || []).map(({ name, access }) => ({ name, access })),
    source_policy: { ...profile.source_policy },
    memory_policy: { ...profile.memory_policy },
    allowed_actions: [...(profile.allowed_actions || [])],
    agents: (profile.agent_access || []).map(({ agent_id, vaults }) => ({
      id: agent_id,
      name: cfg.ai_agents.find((agent) => agent.id === agent_id)?.name || 'Unknown agent',
      vaults: vaults.map(({ name, access, operations }) => ({ name, access, operations: [...operations] })),
    })),
    declaration_status: 'declared_only',
  }));
  return {
    schema: 1,
    enforcement: 'not_active',
    profiles,
    next_gate: 'Implement and verify runtime profile authorization before relying on these declarations to restrict agent access.',
  };
}
