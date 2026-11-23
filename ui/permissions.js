const ACTION_MEMORY = Object.freeze({ search: 'semantic', read_note: 'semantic', write_note: 'semantic', read_session: 'episodic', log_session: 'episodic', propose_note: 'semantic', handoff_read: 'working', write_handoff: 'working' });
const presetActionList = Object.freeze(['search', 'read_note', 'write_note', 'read_session', 'log_session', 'propose_note', 'handoff_read', 'write_handoff']);

export function presetGrantActions(grant, { mailboxVault = '' } = {}) {
  if (!grant || !['read', 'propose', 'write'].includes(grant.access)) return [];
  const allowed = grant.access === 'write' ? ['search', 'read_note', 'write_note', 'read_session', 'log_session', 'propose_note']
    : grant.access === 'propose' ? ['search', 'read_note', 'read_session', 'propose_note'] : ['search', 'read_note', 'read_session'];
  if (mailboxVault === grant.name) allowed.push('handoff_read', ...(grant.access === 'write' ? ['write_handoff'] : []));
  return presetActionList.filter(action => allowed.includes(action) && (!['handoff_read', 'write_handoff'].includes(action) || mailboxVault === grant.name));
}

export function presetActionAllowed({ action, access, memoryPolicy = {}, selectedMemory = {}, selected = true }) {
  if (!selected || !ACTION_MEMORY[action]) return false;
  if (memoryPolicy[ACTION_MEMORY[action]] !== true || selectedMemory[ACTION_MEMORY[action]] !== true) return false;
  if (action === 'write_note' && access !== 'write') return false;
  if (action === 'write_handoff' && access !== 'write') return false;
  if (action === 'propose_note' && !['propose', 'write'].includes(access)) return false;
  return true;
}

export function twinActionAllowed({ action, access, memoryPolicy = {}, selected = true, profileVaultSelected = true }) {
  return presetActionAllowed({ action, access, memoryPolicy, selectedMemory: memoryPolicy, selected: selected && profileVaultSelected });
}

export function formatPresetPermissionSummary(rows) {
  return (rows || []).filter(row => row?.profile && row.vaults?.length).map(row => `${row.profile}: ${row.vaults.map(vault => `${vault.name} (${(vault.actions || []).join(', ')})`).join('; ')}`).join(' · ');
}

globalThis.BrainLinkPermissions = { presetGrantActions, presetActionAllowed, twinActionAllowed, formatPresetPermissionSummary };
