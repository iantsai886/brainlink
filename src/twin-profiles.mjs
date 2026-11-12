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
        && ['read', 'propose'].includes(grant.access)
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
    enforcement: 'scoped_agent_read_only',
    profiles,
    next_gate: 'Named AI-agent tokens use profile-scoped vault and memory-type access. Working, semantic, procedural and episodic policies filter tools, prompts and resources. Session reads require an explicit read_session grant and exact profile_id match. Private session logging is a separate opt-in log_session grant; entries are forced private and profile-owned. Private closeouts require propose_note plus filing-folder access and are approval-gated. Handoff read/send require separate grants and carry a profile owner; append-only replies support ACKNOWLEDGED, IN_PROGRESS, BLOCKED, COMPLETED and CANCELLED, and can target only an available handoff owned by the same Twin. Same-time updates are flagged for human review, not auto-resolved. General note writes remain unavailable. Live cross-client acceptance is still unverified.',
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
  if (matches.length !== 1) return { mode: 'unassigned', profile_id: null, grants: [] };
  const { profile, entry } = matches[0];
  const grants = (entry.vaults || []).map(({ name, access, operations }) => ({ name, access, operations: Array.isArray(operations) ? [...operations] : [] }));
  return { mode: 'scoped', profile_id: profile.id, profile_name: profile.name, source_policy: { ...profile.source_policy }, memory_policy: effectiveAgentMemoryPolicy(profile, entry), grants };
}

// Memory policy is enforced on the same boundary as vault and operation grants. This map
// describes what each surface exposes; it does not change storage or require users to classify
// every note. Unknown or undeclared types fail closed for scoped agents.
const READ_TOOL_MEMORY = Object.freeze({
  brainlink_guide: 'procedural', agent_connect: 'procedural',
  vault_search: 'semantic', context_packet: 'semantic', vault_read_note: 'semantic', vault_related: 'semantic', search: 'semantic', fetch: 'semantic', propose_note: 'semantic',
  vault_recent: 'semantic', open_loops: 'semantic', brain_brief: 'semantic', vault_health: 'semantic',
  ingestion_queue: 'semantic', ingestion_read_source: 'semantic', ingestion_record: 'semantic',
  list_handoffs: 'working', send_handoff: 'working',
  session_list: 'episodic', session_read: 'episodic', session_log: 'episodic', session_close: 'episodic', session_filing_folders: 'episodic',
});

export function twinMemoryAllowed(ctx, memoryType) {
  const scope = ctx.twinScope || { mode: 'legacy' };
  if (scope.mode === 'legacy') return true;
  if (scope.mode !== 'scoped') return false;
  return ['working', 'semantic', 'procedural', 'episodic'].includes(memoryType)
    && scope.memory_policy?.[memoryType] === true;
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
  return [...required].every((memoryType) => scope.memory_policy?.[memoryType] === true);
}

const READ_TOOL_ACTION = Object.freeze({
  brainlink_guide: 'read_note',
  vault_search: 'search', context_packet: 'search', vault_recent: 'search', open_loops: 'search', brain_brief: 'search',
  vault_health: 'search', vault_related: 'search', vault_read_note: 'read_note', propose_note: 'propose_note',
  ingestion_queue: 'search', ingestion_read_source: 'read_note', ingestion_record: 'propose_note',
  session_list: 'read_session', session_read: 'read_session', session_log: 'log_session', session_close: 'propose_note',
  list_handoffs: 'handoff_read', send_handoff: 'write_handoff',
  session_filing_folders: 'search', agent_connect: 'read_note', search: 'search', fetch: 'read_note',
});
const VAULT_ARGUMENT_TOOLS = new Set(['vault_search', 'context_packet', 'vault_recent', 'ingestion_queue', 'ingestion_read_source', 'ingestion_record', 'open_loops', 'brain_brief', 'vault_health', 'vault_read_note', 'vault_related', 'propose_note', 'session_filing_folders', 'session_close']);
const HANDOFF_TOOLS = new Set(['list_handoffs', 'send_handoff']);

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
  if (['session_log', 'session_close'].includes(name) && scope.source_policy?.session_capture === 'metadata-only') return { allowed: false, reason: 'This Twin profile allows metadata-only session capture.' };
  if (name === 'session_read' && args.full === true && scope.source_policy?.session_capture !== 'full-text-opt-in') return { allowed: false, reason: 'Full session text requires this Twin profile to opt in to full-text capture.' };
  const action = READ_TOOL_ACTION[permissionName];
  if (!action) return { allowed: false, reason: `This operation is not available to profile-scoped agents yet: ${name}.` };
  const memoryType = READ_TOOL_MEMORY[permissionName];
  if (!twinMemoryAllowed(ctx, memoryType)) return { allowed: false, reason: `Twin profile policy does not allow ${memoryType || 'unclassified'} memory access.` };
  // This tool returns scoped configuration and usage rules, not note bodies. A profile with a
  // dedicated handoff-only vault still needs the guide to learn the approved mailbox workflow.
  if (permissionName === 'brainlink_guide') return ctx.enabled.length > 0
    ? { allowed: true }
    : { allowed: false, reason: 'This Twin profile has no enabled vault grants.' };
  if (HANDOFF_TOOLS.has(permissionName)) return handoffGrant(ctx, action)
    ? { allowed: true }
    : { allowed: false, reason: `Twin profile scope does not allow ${action} in its handoff vault.` };
  const savedSessionVault = name === 'session_close' && !args.vault
    ? recommendSessionVault({ project: args.project }, ctx.cfg).vault
    : null;
  const targetVault = args.vault || savedSessionVault || (permissionName === 'fetch' ? String(args.id || '').split('::')[0] : null);
  if (targetVault) {
    const grant = scope.grants.find((item) => item.name === targetVault);
    const permitted = ctx.enabled.includes(targetVault) && grant?.operations.includes(action);
    if (permitted) return { allowed: true };
    if (permissionName === 'session_close' && !args.vault && savedSessionVault) return { allowed: false, reason: 'Twin profile scope does not allow the saved destination for this session.' };
    return { allowed: false, reason: `Twin profile scope does not allow ${action} in vault "${targetVault}".` };
  }
  // Cross-vault tools are available only when every enabled vault has the same operation grant.
  // This keeps a tool that searches the whole connection from quietly widening a narrower grant.
  const permitted = ctx.enabled.length > 0 && ctx.enabled.every((name) => scope.grants.some((item) => item.name === name && item.operations.includes(action)));
  return permitted ? { allowed: true } : { allowed: false, reason: `Twin profile scope does not allow ${action} across every enabled vault.` };
}

export function twinToolListed(ctx, name) {
  const permissionName = name.startsWith('agent_connect_') ? 'agent_connect' : name;
  const scope = ctx.twinScope || { mode: 'legacy', grants: [] };
  if (scope.mode === 'legacy') return true;
  if (scope.mode !== 'scoped') return false;
  if (['session_log', 'session_close'].includes(permissionName) && scope.source_policy?.session_capture === 'metadata-only') return false;
  if (!twinMemoryAllowed(ctx, READ_TOOL_MEMORY[permissionName])) return false;
  const action = READ_TOOL_ACTION[permissionName];
  if (!action) return false;
  if (permissionName === 'brainlink_guide') return ctx.enabled.length > 0;
  if (HANDOFF_TOOLS.has(permissionName)) return handoffGrant(ctx, action);
  if (VAULT_ARGUMENT_TOOLS.has(permissionName)) return scope.grants.some((grant) => ctx.enabled.includes(grant.name) && grant.operations.includes(action));
  return ctx.enabled.length > 0 && ctx.enabled.every((vault) => scope.grants.some((grant) => grant.name === vault && grant.operations.includes(action)));
}

export function twinToolVaultChoices(ctx, name) {
  const permissionName = name.startsWith('agent_connect_') ? 'agent_connect' : name;
  const scope = ctx.twinScope || { mode: 'legacy', grants: [] };
  if (scope.mode === 'legacy') return ctx.enabled;
  const action = READ_TOOL_ACTION[permissionName];
  if (HANDOFF_TOOLS.has(permissionName)) return handoffGrant(ctx, action) ? [ctx.cfg.handoff.vault] : [];
  return action ? scope.grants.filter((grant) => ctx.enabled.includes(grant.name) && grant.operations.includes(action)).map((grant) => grant.name) : [];
}
