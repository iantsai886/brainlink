// Profile declarations and the first runtime enforcement gate for named agent tokens.
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
    declaration_status: 'agent_profile_scope_active',
  }));
  return {
    schema: 1,
    enforcement: 'scoped_agent_read_only',
    profiles,
    next_gate: 'Named AI-agent tokens use profile-scoped vault access. Session reads require an explicit read_session grant and an exact profile_id match; private closeouts require propose_note plus filing-folder access and are approval-gated. Other clients keep their existing connection scope. General writes and handoffs remain unavailable until their data paths are profile-scoped.',
  };
}

export function resolveTwinAgentScope(cfg, agent, tokenProvided = false) {
  const profiles = Array.isArray(cfg.twin_profiles) ? cfg.twin_profiles : [];
  if (!profiles.length) return { mode: 'legacy', profile_id: null, grants: [] };
  if (!tokenProvided) return { mode: 'legacy', profile_id: null, grants: [] };
  if (!agent) return { mode: 'unassigned', profile_id: null, grants: [] };
  const matches = profiles.flatMap((profile) => (profile.agent_access || [])
    .filter((entry) => entry.agent_id === agent.id)
    .map((entry) => ({ profile, entry })));
  if (matches.length !== 1) return { mode: 'unassigned', profile_id: null, grants: [] };
  const { profile, entry } = matches[0];
  const grants = (entry.vaults || []).map(({ name, access, operations }) => ({ name, access, operations: Array.isArray(operations) ? [...operations] : [] }));
  return { mode: 'scoped', profile_id: profile.id, profile_name: profile.name, grants };
}

const READ_TOOL_ACTION = Object.freeze({
  brainlink_guide: 'read_note',
  vault_search: 'search', vault_recent: 'search', open_loops: 'search', brain_brief: 'search',
  vault_health: 'search', vault_related: 'search', vault_read_note: 'read_note',
  session_list: 'read_session', session_read: 'read_session', session_close: 'propose_note',
  session_filing_folders: 'search', agent_connect: 'read_note', search: 'search', fetch: 'read_note',
});
const VAULT_ARGUMENT_TOOLS = new Set(['vault_search', 'vault_recent', 'open_loops', 'brain_brief', 'vault_health', 'vault_read_note', 'vault_related', 'session_filing_folders', 'session_close']);

export function twinToolAuthorization(ctx, name, args = {}) {
  const scope = ctx.twinScope || { mode: 'legacy', grants: [] };
  if (scope.mode === 'legacy') return { allowed: true };
  if (scope.mode !== 'scoped') return { allowed: false, reason: 'This AI agent token is not assigned to an active Twin profile.' };
  const action = READ_TOOL_ACTION[name];
  if (!action) return { allowed: false, reason: `This operation is not available to profile-scoped agents yet: ${name}.` };
  const targetVault = args.vault || (name === 'fetch' ? String(args.id || '').split('::')[0] : null);
  if (targetVault) {
    const grant = scope.grants.find((item) => item.name === targetVault);
    const permitted = ctx.enabled.includes(targetVault) && grant?.operations.includes(action);
    return permitted ? { allowed: true } : { allowed: false, reason: `Twin profile scope does not allow ${action} in vault "${targetVault}".` };
  }
  // Cross-vault tools are available only when every enabled vault has the same operation grant.
  // This keeps a tool that searches the whole connection from quietly widening a narrower grant.
  const permitted = ctx.enabled.length > 0 && ctx.enabled.every((name) => scope.grants.some((item) => item.name === name && item.operations.includes(action)));
  return permitted ? { allowed: true } : { allowed: false, reason: `Twin profile scope does not allow ${action} across every enabled vault.` };
}

export function twinToolListed(ctx, name) {
  const scope = ctx.twinScope || { mode: 'legacy', grants: [] };
  if (scope.mode === 'legacy') return true;
  if (scope.mode !== 'scoped') return false;
  const action = READ_TOOL_ACTION[name];
  if (!action) return false;
  if (VAULT_ARGUMENT_TOOLS.has(name)) return scope.grants.some((grant) => ctx.enabled.includes(grant.name) && grant.operations.includes(action));
  return ctx.enabled.length > 0 && ctx.enabled.every((vault) => scope.grants.some((grant) => grant.name === vault && grant.operations.includes(action)));
}

export function twinToolVaultChoices(ctx, name) {
  const scope = ctx.twinScope || { mode: 'legacy', grants: [] };
  if (scope.mode === 'legacy') return ctx.enabled;
  const action = READ_TOOL_ACTION[name];
  return action ? scope.grants.filter((grant) => ctx.enabled.includes(grant.name) && grant.operations.includes(action)).map((grant) => grant.name) : [];
}
