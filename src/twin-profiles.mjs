// Profile declarations and the first runtime enforcement gate for named agent tokens.
import { recommendSessionVault } from './sessions/routing.mjs';
export function profileScopeEditable(profile) {
  const profileVaults = new Set((profile?.vaults || []).map((item) => item.name));
  return (profile?.agent_access || []).every((agent) => {
    const grants = agent.vaults || [];
    const names = grants.map((grant) => grant.name);
    const memory = agent.memory_policy;
    return grants.length > 0
      && new Set(names).size === names.length
      && grants.every((grant) => profileVaults.has(grant.name)
        && ['read', 'propose', 'write'].includes(grant.access)
        && Array.isArray(grant.operations)
        && grant.operations.length > 0)
      && (memory == null || ['working', 'semantic', 'procedural', 'episodic'].every((type) => typeof memory[type] === 'boolean'));
  });
}

const MEMORY_TYPES = ['working', 'semantic', 'procedural', 'episodic'];
const NOTE_TYPE_MEMORY = Object.freeze({
  'operating-manual': 'procedural', 'operations-manual': 'procedural', 'role-manual': 'procedural',
  'agent-manual': 'procedural', procedure: 'procedural', 'standard-operating-procedure': 'procedural',
  runbook: 'procedural', skill: 'procedural', 'agent-skill': 'procedural', 'role-instructions': 'procedural',
  handoff: 'working', 'handoff-request': 'working', task: 'working', 'open-loop': 'working', 'work-item': 'working',
  episode: 'episodic', 'session-episode': 'episodic', 'session-summary': 'episodic',
});
export function effectiveAgentMemoryPolicy(profile, agentAccess) {
  return Object.fromEntries(MEMORY_TYPES.map((type) => [
    type,
    profile?.memory_policy?.[type] === true
      && (agentAccess?.memory_policy == null || agentAccess.memory_policy[type] === true),
  ]));
}

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
    agents: (profile.agent_access || []).map((agentAccess) => {
      const agent = cfg.ai_agents.find((item) => item.id === agentAccess.agent_id);
      return {
        id: agentAccess.agent_id,
        name: agent?.name || 'Unknown agent',
        preset_client_id: agent?.preset_client_id || null,
        memory_policy: effectiveAgentMemoryPolicy(profile, agentAccess),
        memory_policy_inherited: agentAccess.memory_policy == null,
        vaults: (agentAccess.vaults || []).map(({ name, access, operations }) => ({ name, access, operations: [...operations] })),
      };
    }),
    editable_scope: profileScopeEditable(profile),
    declaration_status: 'agent_profile_scope_active',
    memory_policy_enforcement: 'tools_prompts_resources',
  }));
  return {
    schema: 1,
    enforcement: 'scoped_agent_profile_grants',
    profiles,
    next_gate: 'Named AI-agent tokens may be assigned to multiple Twin profiles. Each vault action is routed through its owning profile grants and memory policy. Session records and closeouts retain the profile ID of their destination. Private session logging remains opt-in and profile-owned. Handoff actions remain separately granted. Different Twin profiles cannot share content-reading vaults.',
  };
}

export function resolveTwinAgentScope(cfg, agent, tokenProvided = false) {
  const profiles = Array.isArray(cfg.twin_profiles) ? cfg.twin_profiles : [];
  // A supplied agent credential must never fall back to the unrestricted legacy connection
  // when it is revoked or unknown, including before the first Twin profile exists.
  if (tokenProvided && !agent) return { mode: 'unassigned', profile_id: null, grants: [] };
  if (!profiles.length) return { mode: 'legacy', profile_id: null, grants: [] };
  // Once the owner has configured Twin boundaries, an unidentified connector must never
  // silently inherit the old all-vault scope. Local Setup/background work opts into its own
  // trusted context; AI connections must present a registered token.
  if (!tokenProvided) return { mode: 'unassigned', profile_id: null, grants: [] };
  if (!agent) return { mode: 'unassigned', profile_id: null, grants: [] };
  const matches = profiles.flatMap((profile) => (profile.agent_access || [])
    .filter((entry) => entry.agent_id === agent.id)
    .map((entry) => ({ profile, entry })));
  if (!matches.length) return { mode: 'unassigned', profile_id: null, grants: [] };
  const scopes = matches.map(({ profile, entry }) => ({
    profile_id: profile.id, profile_name: profile.name, profile_mode: profile.mode, owner: profile.owner,
    source_policy: { ...profile.source_policy }, memory_policy: effectiveAgentMemoryPolicy(profile, entry),
    grants: (entry.vaults || []).map(({ name, access, operations }) => ({
      name, access, operations: Array.isArray(operations) ? [...operations] : [], profile_id: profile.id,
      profile_name: profile.name, profile_mode: profile.mode, owner: profile.owner,
      source_policy: { ...profile.source_policy }, memory_policy: effectiveAgentMemoryPolicy(profile, entry),
    })),
  }));
  const grants = scopes.flatMap((scope) => scope.grants);
  const soleProfile = scopes.length === 1 ? scopes[0] : null;
  return {
    mode: 'scoped', profile_id: soleProfile?.profile_id || null, profile_name: soleProfile?.profile_name || null,
    profile_ids: scopes.map((scope) => scope.profile_id), profiles: scopes, grants,
    source_policy: soleProfile?.source_policy || null,
    memory_policy: soleProfile?.memory_policy || Object.fromEntries(MEMORY_TYPES.map((type) => [type, scopes.some((scope) => scope.memory_policy[type])])),
  };
}

export function twinProfileForVault(ctx, vaultName) {
  const scope = ctx.twinScope || { mode: 'legacy' };
  if (scope.mode !== 'scoped') return null;
  const grant = scope.grants.find((item) => item.name === vaultName);
  return grant ? { profile_id: grant.profile_id, profile_name: grant.profile_name, mode: grant.profile_mode, owner: grant.owner, source_policy: grant.source_policy, memory_policy: grant.memory_policy } : null;
}

export function twinSessionProfileIds(ctx) {
  return (ctx.twinScope?.profiles || []).filter((profile) => profile.memory_policy?.episodic === true
    && profile.grants.some((grant) => grant.operations.includes('read_session'))).map((profile) => profile.profile_id);
}

// Memory policy is enforced on the same boundary as vault and operation grants. This map
// describes what each surface exposes; it does not change storage or require users to classify
// every note. Unknown or undeclared types fail closed for scoped agents.
const READ_TOOL_MEMORY = Object.freeze({
  brainlink_guide: 'procedural', agent_connect: 'semantic',
  vault_search: 'semantic', context_packet: 'semantic', vault_read_note: 'semantic', vault_related: 'semantic', search: 'semantic', fetch: 'semantic', propose_note: 'semantic',
  remember: 'semantic', append_daily: 'episodic', agent_close_loop: 'episodic',
  vault_recent: 'semantic', open_loops: 'semantic', brain_brief: 'semantic', vault_health: 'semantic',
  ingestion_queue: 'semantic', ingestion_read_source: 'semantic', ingestion_record: 'semantic',
  list_handoffs: 'working', send_handoff: 'working',
  session_list: 'episodic', session_read: 'episodic', session_log: 'episodic', session_close: 'episodic', session_filing_folders: 'episodic',
});

export function twinMemoryAllowed(ctx, memoryType, vaultName) {
  const scope = ctx.twinScope || { mode: 'legacy' };
  if (scope.mode === 'legacy') return true;
  if (scope.mode !== 'scoped') return false;
  if (vaultName) return scope.grants.some((grant) => grant.name === vaultName && grant.memory_policy?.[memoryType] === true);
  return ['working', 'semantic', 'procedural', 'episodic'].includes(memoryType)
    && scope.profiles.some((profile) => profile.memory_policy?.[memoryType] === true);
}

// Whole-vault tools share one Markdown index, so tool-level checks alone are not enough:
// a semantic search must also omit documents that BrainLink knows are procedural, working,
// or episodic. Apply this before reading bodies and use the same rule for direct note reads.
export function twinNoteMemoryAllowed(ctx, vaultName, rel, meta = {}) {
  const scope = ctx.twinScope || { mode: 'legacy' };
  if (scope.mode === 'legacy') return true;
  if (scope.mode !== 'scoped') return false;
  const required = new Set();
  const samePath = (candidate) => typeof candidate === 'string' && candidate.replace(/^\/+|\/+$/g, '') === rel;
  const folderContains = (folder) => typeof folder === 'string' && rel.toLowerCase().startsWith(`${folder.replace(/^\/+|\/+$/g, '').toLowerCase()}/`);
  const vault = ctx.byName?.get(vaultName);
  if ((vault?.read_first || []).some(samePath)) required.add('procedural');
  for (const agent of ctx.agents || []) {
    if (agent.vault !== vaultName) continue;
    if ((agent.connect_notes || []).some(samePath)) required.add('procedural');
    if ((agent.tail_notes || []).some(samePath)) required.add('working');
    const target = agent.close_target || {};
    if (['append-section', 'proposal-only'].includes(target.mode) && samePath(target.path)) required.add('episodic');
    if (target.mode === 'append-task' && samePath(target.path)) required.add('working');
    if (target.mode === 'new-note' && folderContains(target.dir) && /(?:^|[,\s\["'])close-loop(?:$|[,\s\]"'])/i.test(String(meta.tags || ''))) required.add('episodic');
  }
  if (ctx.cfg?.handoff?.vault === vaultName && folderContains(ctx.cfg.handoff.folder)) required.add('working');

  const declaredValue = meta.memory_type ?? meta.brainlink_memory_type;
  if (declaredValue !== undefined && String(declaredValue).trim() !== '') {
    const declared = String(declaredValue).trim().toLowerCase();
    if (!MEMORY_TYPES.includes(declared)) return false;
    required.add(declared);
  }
  const type = String(meta.type || meta.note_type || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (NOTE_TYPE_MEMORY[type]) required.add(NOTE_TYPE_MEMORY[type]);
  const tags = Array.isArray(meta.tags) ? meta.tags.flat(Infinity) : String(meta.tags || '').replace(/^\[|\]$/g, '').split(',');
  for (const tag of tags.map((item) => String(item).trim().replace(/^['"]|['"]$/g, '').toLowerCase().replace(/[\s_]+/g, '-'))) {
    if (NOTE_TYPE_MEMORY[tag]) required.add(NOTE_TYPE_MEMORY[tag]);
  }
  // Untyped, otherwise unclassified notes are ordinary semantic knowledge. Do not let an
  // empty classification set bypass every memory switch; malformed declarations fail closed.
  if (!required.size) required.add('semantic');
  const vaultGrant = scope.grants.find((grant) => grant.name === vaultName);
  return Boolean(vaultGrant) && [...required].every((memoryType) => vaultGrant.memory_policy?.[memoryType] === true);
}

const READ_TOOL_ACTION = Object.freeze({
  brainlink_guide: 'read_note',
  vault_search: 'search', context_packet: 'search', vault_recent: 'search', open_loops: 'search', brain_brief: 'search',
  vault_health: 'search', vault_related: 'search', vault_read_note: 'read_note', propose_note: 'propose_note',
  remember: 'propose_note', append_daily: 'propose_note', agent_close_loop: 'propose_note',
  ingestion_queue: 'search', ingestion_read_source: 'read_note', ingestion_record: 'propose_note',
  session_list: 'read_session', session_read: 'read_session', session_log: 'log_session', session_close: 'propose_note',
  list_handoffs: 'handoff_read', send_handoff: 'write_handoff',
  session_filing_folders: 'search', agent_connect: 'read_note', search: 'search', fetch: 'read_note',
});
const VAULT_ARGUMENT_TOOLS = new Set(['vault_search', 'context_packet', 'vault_recent', 'ingestion_queue', 'ingestion_read_source', 'ingestion_record', 'open_loops', 'brain_brief', 'vault_health', 'vault_read_note', 'vault_related', 'propose_note', 'remember', 'append_daily', 'session_filing_folders', 'session_close']);
const HANDOFF_TOOLS = new Set(['list_handoffs', 'send_handoff']);

function grantAllows(grant, action) {
  return grant?.operations?.includes(action)
    || (action === 'propose_note' && grant?.operations?.includes('write_note'));
}

export function twinCanWriteNotes(ctx, vaultName) {
  return ctx.twinScope?.mode === 'scoped'
    && (ctx.twinScope.grants || []).some((grant) => grant.name === vaultName && grant.operations?.includes('write_note'));
}

function handoffGrant(ctx, action) {
  const name = ctx.cfg?.handoff?.vault;
  if (!name || !ctx.enabled.includes(name)) return false;
  return (ctx.twinScope?.grants || []).some((grant) => grant.name === name && grant.operations.includes(action));
}

export function twinToolAuthorization(ctx, name, args = {}) {
  const permissionName = name.startsWith('agent_connect_') ? 'agent_connect' : name;
  const scope = ctx.twinScope || { mode: 'legacy', grants: [] };
  if (scope.mode === 'legacy') return { allowed: true };
  if (scope.mode !== 'scoped') return { allowed: false, reason: 'This AI agent token is not assigned to an active Twin profile.' };
  const action = READ_TOOL_ACTION[permissionName];
  if (!action) return { allowed: false, reason: `This operation is not available to profile-scoped agents yet: ${name}.` };
  const memoryType = READ_TOOL_MEMORY[permissionName];
  // This tool returns scoped configuration and usage rules, not note bodies. A profile with a
  // dedicated handoff-only vault still needs the guide to learn the approved mailbox workflow.
  if (permissionName === 'brainlink_guide') return ctx.enabled.length > 0 && twinMemoryAllowed(ctx, memoryType)
    ? { allowed: true }
    : { allowed: false, reason: 'This Twin profile has no enabled vault grants.' };
  // Listing/activating a named role returns metadata plus only the notes allowed by
  // its memory policy. Do not hide the role itself just because procedural memory
  // is disabled; each returned note is still filtered in connectAgent.
  if (permissionName === 'agent_connect') return scope.grants.some((grant) => ctx.enabled.includes(grant.name)
    && grantAllows(grant, action))
    ? { allowed: true }
    : { allowed: false, reason: 'No assigned agent role is available under this Twin profile scope.' };
  if (HANDOFF_TOOLS.has(permissionName)) return handoffGrant(ctx, action)
    ? { allowed: true }
    : { allowed: false, reason: `Twin profile scope does not allow ${action} in its handoff vault.` };
  let agentVault = null;
  if (permissionName === 'agent_connect') {
    const role = ctx.agents.find((item) => item.name === args.agent || item.activation?.includes(args.agent));
    agentVault = role?.vault || null;
  } else if (permissionName === 'agent_close_loop') {
    const requested = String(args.agent || '').trim().toLowerCase();
    const role = ctx.agents.find((item) => item.name.toLowerCase() === requested
      || item.activation?.some((phrase) => phrase.trim().toLowerCase() === requested));
    agentVault = role?.vault || null;
    if (!agentVault) return { allowed: false, reason: 'Close-loop role is not the role activated for this call.' };
  }
  const savedSessionVault = name === 'session_close' && !args.vault
    ? recommendSessionVault({ project: args.project }, ctx.cfg).vault
    : null;
  const targetVault = permissionName === 'agent_close_loop'
    ? agentVault
    : args.vault || agentVault || savedSessionVault || (permissionName === 'fetch' ? String(args.id || '').split('::')[0] : null);
  if (targetVault) {
    const grant = scope.grants.find((item) => item.name === targetVault);
    const captureAllowed = !['session_log', 'session_close'].includes(permissionName) || grant?.source_policy?.session_capture !== 'metadata-only';
    const fullTextAllowed = permissionName !== 'session_read' || args.full !== true || grant?.source_policy?.session_capture === 'full-text-opt-in';
    const permitted = ctx.enabled.includes(targetVault) && grantAllows(grant, action)
      && twinMemoryAllowed(ctx, memoryType, targetVault) && captureAllowed && fullTextAllowed;
    if (permitted) return { allowed: true };
    if (permissionName === 'session_close' && !args.vault && savedSessionVault) return { allowed: false, reason: 'Twin profile scope does not allow the saved destination for this session.' };
    return { allowed: false, reason: `Twin profile scope does not allow ${action} in vault "${targetVault}".` };
  }
  if (['session_list', 'session_read'].includes(permissionName)) {
    const candidates = scope.profiles.filter((profile) => profile.memory_policy?.episodic === true
      && profile.grants.some((grant) => grant.operations.includes('read_session')));
    if (permissionName === 'session_read' && args.full === true && !candidates.some((profile) => profile.source_policy.session_capture === 'full-text-opt-in')) {
      return { allowed: false, reason: 'Full session text requires a Twin profile to opt in to full-text access.' };
    }
    return candidates.length ? { allowed: true } : { allowed: false, reason: 'No Twin profile grants session history access.' };
  }
  // Cross-vault tools are available only when every enabled vault has the same operation grant.
  // This keeps a tool that searches the whole connection from quietly widening a narrower grant.
  const permitted = ctx.enabled.length > 0 && ctx.enabled.every((vaultName) => scope.grants.some((item) => item.name === vaultName
    && grantAllows(item, action) && twinMemoryAllowed(ctx, memoryType, vaultName)));
  return permitted ? { allowed: true } : { allowed: false, reason: `Twin profile scope does not allow ${action} across every enabled vault.` };
}

export function twinToolListed(ctx, name) {
  const permissionName = name.startsWith('agent_connect_') ? 'agent_connect' : name;
  const scope = ctx.twinScope || { mode: 'legacy', grants: [] };
  if (scope.mode === 'legacy') return true;
  if (scope.mode !== 'scoped') return false;
  const action = READ_TOOL_ACTION[permissionName];
  if (!action) return false;
  if (permissionName === 'brainlink_guide') return ctx.enabled.length > 0 && twinMemoryAllowed(ctx, READ_TOOL_MEMORY[permissionName]);
  if (permissionName === 'agent_connect') return scope.grants.some((grant) => ctx.enabled.includes(grant.name)
    && grantAllows(grant, action));
  if (['session_list', 'session_read'].includes(permissionName)) return scope.profiles.some((profile) => profile.memory_policy?.episodic === true
    && profile.grants.some((grant) => grant.operations.includes('read_session')));
  if (permissionName === 'session_log') return scope.grants.some((grant) => grant.operations.includes(action)
    && grant.source_policy?.session_capture !== 'metadata-only' && twinMemoryAllowed(ctx, READ_TOOL_MEMORY[permissionName], grant.name));
  if (permissionName === 'session_close') return scope.grants.some((grant) => grantAllows(grant, action)
    && grant.source_policy?.session_capture !== 'metadata-only' && twinMemoryAllowed(ctx, READ_TOOL_MEMORY[permissionName], grant.name));
  if (HANDOFF_TOOLS.has(permissionName)) return handoffGrant(ctx, action);
  if (VAULT_ARGUMENT_TOOLS.has(permissionName)) return scope.grants.some((grant) => ctx.enabled.includes(grant.name)
    && grantAllows(grant, action) && twinMemoryAllowed(ctx, READ_TOOL_MEMORY[permissionName], grant.name));
  return ctx.enabled.length > 0 && ctx.enabled.every((vaultName) => scope.grants.some((grant) => grant.name === vaultName
    && grantAllows(grant, action) && twinMemoryAllowed(ctx, READ_TOOL_MEMORY[permissionName], vaultName)));
}

export function twinToolVaultChoices(ctx, name) {
  const permissionName = name.startsWith('agent_connect_') ? 'agent_connect' : name;
  const scope = ctx.twinScope || { mode: 'legacy', grants: [] };
  if (scope.mode === 'legacy') return ctx.enabled;
  const action = READ_TOOL_ACTION[permissionName];
  if (HANDOFF_TOOLS.has(permissionName)) return handoffGrant(ctx, action) ? [ctx.cfg.handoff.vault] : [];
  return action ? scope.grants.filter((grant) => ctx.enabled.includes(grant.name) && grantAllows(grant, action)).map((grant) => grant.name) : [];
}
