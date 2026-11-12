// Customer configuration: vaults, agents, rules and per-connection settings. Everything that
// was hard-coded for one person in vault-agent v0.2 lives here, so the code names no person,
// vault, agent or timezone.
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { validateSync } from './sync/settings.mjs';
import { validateGitHubAssignments } from './sync/github-assignment.mjs';
import { normalizeBackupSchedule } from './backup-schedule.mjs';
import { validateRerankerSettings } from './rerank.mjs';
import { appHome } from './app-home.mjs';

export { appHome };

export const DEFAULT_PLATFORMS = ['Claude', 'ChatGPT', 'ChatGPT Codex', 'Gemini', 'Grok', 'Cursor', 'other'];
export const CLOSE_MODES = ['append-section', 'new-note', 'append-task', 'proposal-only'];
export const SCHEMAS = ['standard', 'provenance'];
export const WRITE_MODES = ['on', 'proposal-only', 'off'];
export const TWIN_MODES = ['personal', 'organisation', 'client'];
export const TWIN_ACTIONS = ['search', 'read_note', 'read_session', 'log_session', 'handoff_read', 'write_handoff', 'propose_note', 'write_note'];

export function configPath(env = process.env) {
  return env.BRAINLINK_CONFIG || path.join(appHome(env), 'config.json');
}

export const LOCALES = ['en', 'zh-TW', 'pt'];

// AI agents a person adds themselves (distinct from `agents`: vault role-players with
// activation/close phrases). Each has its own revocable token, shown once and stored only as a
// hash (sha256 hex, see src/mcp-agents.mjs); never persisted in plain text.
export const AGENT_KINDS = ['local', 'remote'];

// Bumped for R2: a config saved by any version before this one (v1.2.3 and earlier) could have
// sessions.shareSummaries=true on disk -- v1.2.2's own Setup wrote that normalized default the
// first time it saved anything, before shareSummaries defaulted to off. normalize() below forces
// both session-sharing flags back to false for any config whose on-disk version is older than
// this, exactly once (the config is then saved at the new version, so it is never re-migrated).
export const CONFIG_SCHEMA_VERSION = 2;

export function emptyConfig() {
  return { version: CONFIG_SCHEMA_VERSION, timezone: null, locale: null, vaults: [], agents: [], ai_agents: [], twin_profiles: [], handoff: null, platforms: DEFAULT_PLATFORMS, http: { port: 8765, token: null }, connections: {}, reranker: { enabled: false, url: 'http://127.0.0.1:8080/v1/rerank' }, sessions: { shareSummaries: false, shareFullText: false, hermesHome: null, localSummary: { enabled: false, model: '', autoDraftOnEnd: false, autoFileOnEnd: false } }, session_filing: { projectVaults: {}, projectFolders: {} }, backup: { enabled: false, folder: null, intervalHours: 24, scheduleMode: 'interval', time: '02:00', last_scheduled_date: null, keepCount: 0, encrypted: false }, ingestion: { enabled: false, mode: 'daily', intervalMinutes: 5, last_scan_at: null, autoDrafts: false, autoFile: false, vault: null, folder: null, targets: [], time: '02:00', last_scheduled_date: null, retry_count: 0, retry_date: null, retry_after: null }, brief: { enabled: false, vault: null, time: '08:00', last_scheduled_date: null }, weekly_benchmark: { enabled: false, weekday: 1, time: '09:00', last_scheduled_week: null, last_run_at: null, last_run_ok: null } };
}

// Fill defaults so the rest of the code never checks for missing keys.
export function normalize(raw = {}) {
  const cfg = { ...emptyConfig(), ...raw };
  cfg.vaults = (raw.vaults || []).map((v) => ({
    private: false, schema: 'standard', intake_folder: 'Inbox', decisions: [], read_first: [], folders: {}, rules: [],
    writes: 'on', flat: false, protected: ['00 INDEX', '00 MAP'], extra_fields: {}, purpose: '', ...v,
  }));
  cfg.agents = (raw.agents || []).map((a) => ({ role: '', activation: [`Connect to ${a.name}`], close: [`${a.name} close loop`], connect_notes: [], tail_notes: [], recent_dir: null, stale_days: 14, capture_approved: false, ...a }));
  cfg.ai_agents = (raw.ai_agents || []).map((a) => ({ kind: 'local', tokenHash: null, revoked: false, connected: false, createdAt: null, lastSeenAt: null, ...a }));
  cfg.twin_profiles = raw.twin_profiles ?? [];
  cfg.http = { port: 8765, token: null, ...(raw.http || {}) };
  cfg.connections = raw.connections || {};
  try { cfg.reranker = validateRerankerSettings({ ...emptyConfig().reranker, ...(raw.reranker || {}) }); }
  catch { cfg.reranker = emptyConfig().reranker; }
  cfg.backup = { enabled: false, folder: null, intervalHours: 24, scheduleMode: 'interval', time: '02:00', last_scheduled_date: null, keepCount: 0, encrypted: false, ...(raw.backup || {}) };
  cfg.ingestion = { enabled: false, mode: 'daily', intervalMinutes: 5, last_scan_at: null, autoDrafts: false, autoFile: false, vault: null, folder: null, targets: [], time: '02:00', last_scheduled_date: null, retry_count: 0, retry_date: null, retry_after: null, ...(raw.ingestion || {}) };
  if (typeof cfg.ingestion.autoDrafts !== 'boolean') cfg.ingestion.autoDrafts = false;
  if (typeof cfg.ingestion.autoFile !== 'boolean') cfg.ingestion.autoFile = false;
  if (!Array.isArray(cfg.ingestion.targets)) cfg.ingestion.targets = [];
  if (!cfg.ingestion.targets.length && cfg.ingestion.vault && cfg.ingestion.folder) cfg.ingestion.targets = [{ vault: cfg.ingestion.vault, folder: cfg.ingestion.folder }];
  cfg.brief = { enabled: false, vault: null, time: '08:00', last_scheduled_date: null, ...(raw.brief || {}) };
  cfg.weekly_benchmark = { enabled: false, weekday: 1, time: '09:00', last_scheduled_week: null, last_run_at: null, last_run_ok: null, ...(raw.weekly_benchmark || {}) };
  cfg.session_filing = { projectVaults: {}, projectFolders: {}, ...(raw.session_filing || {}) };
  if (!cfg.session_filing.projectVaults || typeof cfg.session_filing.projectVaults !== 'object' || Array.isArray(cfg.session_filing.projectVaults)) cfg.session_filing.projectVaults = {};
  if (!cfg.session_filing.projectFolders || typeof cfg.session_filing.projectFolders !== 'object' || Array.isArray(cfg.session_filing.projectFolders)) cfg.session_filing.projectFolders = {};
  // Local-only choice that decides what connected AI apps may see of imported sessions. An AI
  // client can never set or override this (see src/sessions/mcp.mjs / src/server.mjs): only the
  // user, in BrainLink Settings, changes it. shareSummaries covers session_list + summary
  // metadata; shareFullText additionally permits key-turn excerpts and full=true
  // (the raw message text). Imports still default private per-session, and this now defaults OFF
  // too: an AI client sees none of a user's imported session history until the user opts in.
  // R2: a config from before CONFIG_SCHEMA_VERSION is force-reset to off here instead of trusting
  // whatever it already has on disk -- that's the only way to fix the sessions a pre-2 install
  // already saved with shareSummaries=true without the user ever having chosen that.
  const upgrading = !(Number(raw.version) >= CONFIG_SCHEMA_VERSION);
  cfg.sessions = upgrading
    ? { shareSummaries: false, shareFullText: false, hermesHome: null, localSummary: { enabled: false, model: '', autoDraftOnEnd: false, autoFileOnEnd: false } }
    : { shareSummaries: false, shareFullText: false, hermesHome: null, localSummary: { enabled: false, model: '', autoDraftOnEnd: false, autoFileOnEnd: false }, ...(raw.sessions || {}), localSummary: { enabled: false, model: '', autoDraftOnEnd: false, autoFileOnEnd: false, ...(raw.sessions?.localSummary || {}) } };
  cfg.sessions.importHistory = raw.sessions?.importHistory === true;
  cfg.version = CONFIG_SCHEMA_VERSION;
  return cfg;
}

export function validate(cfg) {
  const errors = [];
  try { validateRerankerSettings(cfg.reranker || {}); } catch (error) { errors.push(error.message); }
  const names = new Set();
  for (const v of cfg.vaults) {
    if (!v.name || /[\/\\:]/.test(v.name)) errors.push(`vault name "${v.name}" must be set and contain no / \\ :`);
    if (names.has(v.name)) errors.push(`duplicate vault name "${v.name}"`);
    names.add(v.name);
    if (!v.path || !path.isAbsolute(v.path)) errors.push(`vault "${v.name}": path must be absolute`);
    if (!SCHEMAS.includes(v.schema)) errors.push(`vault "${v.name}": schema must be ${SCHEMAS.join(' | ')}`);
    if (!WRITE_MODES.includes(v.writes)) errors.push(`vault "${v.name}": writes must be ${WRITE_MODES.join(' | ')}`);
  }
  const agents = new Set();
  for (const a of cfg.agents) {
    if (!a.name) errors.push('agent without name');
    if (agents.has(a.name?.toLowerCase())) errors.push(`duplicate agent "${a.name}"`);
    agents.add(a.name?.toLowerCase());
    if (!names.has(a.vault)) errors.push(`agent "${a.name}": unknown vault "${a.vault}"`);
    const t = a.close_target;
    if (!t || !CLOSE_MODES.includes(t.mode)) errors.push(`agent "${a.name}": close_target.mode must be ${CLOSE_MODES.join(' | ')}`);
    else if (t.mode === 'new-note' ? !t.dir : !t.path) errors.push(`agent "${a.name}": close_target needs ${t.mode === 'new-note' ? 'dir' : 'path'}`);
  }
  const aiAgentNames = new Set();
  for (const a of cfg.ai_agents) {
    if (!a.id) errors.push('an agent is missing an id');
    if (!a.name) errors.push('an agent is missing a name');
    if (aiAgentNames.has(a.name?.toLowerCase())) errors.push(`duplicate agent "${a.name}"`);
    aiAgentNames.add(a.name?.toLowerCase());
    if (!AGENT_KINDS.includes(a.kind)) errors.push(`agent "${a.name}": kind must be ${AGENT_KINDS.join(' | ')}`);
  }
  const profileIds = new Set();
  const assignedTwinAgents = new Set();
  if (!Array.isArray(cfg.twin_profiles)) errors.push('twin_profiles must be an array');
  for (const p of Array.isArray(cfg.twin_profiles) ? cfg.twin_profiles : []) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) { errors.push('twin profile must be an object'); continue; }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(p.id || '') || profileIds.has(p.id)) errors.push('twin profile needs a unique short id');
    profileIds.add(p.id);
    if (!p.name || typeof p.name !== 'string' || p.name.length > 120) errors.push(`twin profile "${p.id || ''}": name is required (max 120 characters)`);
    if (!TWIN_MODES.includes(p.mode)) errors.push(`twin profile "${p.id || ''}": mode must be ${TWIN_MODES.join(' | ')}`);
    if (!p.owner || typeof p.owner !== 'string' || p.owner.length > 160) errors.push(`twin profile "${p.id || ''}": owner is required (max 160 characters)`);
    if (!Array.isArray(p.vaults) || !p.vaults.length) errors.push(`twin profile "${p.id || ''}": vaults must be a non-empty array`);
    const profileVaults = new Set();
    for (const item of Array.isArray(p.vaults) ? p.vaults : []) {
      if (!item || !names.has(item.name)) errors.push(`twin profile "${p.id || ''}": references an unknown vault`);
      else if (profileVaults.has(item.name)) errors.push(`twin profile "${p.id || ''}": duplicate vault "${item.name}"`);
      else profileVaults.add(item.name);
      if (!['read', 'propose', 'write'].includes(item?.access)) errors.push(`twin profile "${p.id || ''}": vault access must be read | propose | write`);
    }
    if (!Array.isArray(p.allowed_actions) || p.allowed_actions.some((action) => !TWIN_ACTIONS.includes(action))) errors.push(`twin profile "${p.id || ''}": allowed_actions must use supported actions`);
    if (!p.source_policy || typeof p.source_policy !== 'object' || typeof p.source_policy.private_default !== 'boolean' || typeof p.source_policy.provenance_required !== 'boolean' || !['metadata-only', 'summary-proposal', 'full-text-opt-in'].includes(p.source_policy.session_capture)) errors.push(`twin profile "${p.id || ''}": source_policy needs private_default, provenance_required and a supported session_capture policy`);
    if (!p.memory_policy || ['working', 'semantic', 'procedural', 'episodic'].some((key) => typeof p.memory_policy[key] !== 'boolean')) errors.push(`twin profile "${p.id || ''}": memory_policy must declare all four memory types`);
    if (!Array.isArray(p.agent_access)) errors.push(`twin profile "${p.id || ''}": agent_access must be an array`);
    const profileAgents = new Set();
    for (const access of Array.isArray(p.agent_access) ? p.agent_access : []) {
      if (!cfg.ai_agents.some((agent) => agent.id === access.agent_id && !agent.revoked)) errors.push(`twin profile "${p.id || ''}": agent_access references an unknown or revoked AI agent`);
      if (access.memory_policy !== undefined) {
        const types = ['working', 'semantic', 'procedural', 'episodic'];
        if (!access.memory_policy || typeof access.memory_policy !== 'object' || Array.isArray(access.memory_policy) || types.some((type) => typeof access.memory_policy[type] !== 'boolean')) errors.push(`twin profile "${p.id || ''}": each agent memory_policy must declare all four memory types`);
        else if (types.some((type) => access.memory_policy[type] && p.memory_policy?.[type] !== true)) errors.push(`twin profile "${p.id || ''}": an agent memory policy cannot exceed the Twin profile policy`);
      }
      if (profileAgents.has(access.agent_id)) errors.push(`twin profile "${p.id || ''}": duplicate agent access`);
      if (assignedTwinAgents.has(access.agent_id)) errors.push('an AI agent may be assigned to only one Twin profile');
      profileAgents.add(access.agent_id);
      assignedTwinAgents.add(access.agent_id);
      if (!Array.isArray(access.vaults) || !access.vaults.length) errors.push(`twin profile "${p.id || ''}": agent vault access must be a non-empty subset of profile vaults`);
      const agentVaults = new Set();
      for (const grant of Array.isArray(access.vaults) ? access.vaults : []) {
        const profileGrant = p.vaults?.find((item) => item.name === grant?.name);
        if (!profileGrant) errors.push(`twin profile "${p.id || ''}": agent vault access must be a subset of profile vaults`);
        if (agentVaults.has(grant?.name)) errors.push(`twin profile "${p.id || ''}": duplicate agent vault access`);
        agentVaults.add(grant?.name);
        const accessRank = { read: 0, propose: 1, write: 2 };
        if (!['read', 'propose', 'write'].includes(grant?.access) || accessRank[grant?.access] > accessRank[profileGrant?.access]) errors.push(`twin profile "${p.id || ''}": agent vault access exceeds the profile grant`);
        if (!Array.isArray(grant?.operations) || grant.operations.some((op) => !TWIN_ACTIONS.includes(op) || !p.allowed_actions?.includes(op))) errors.push(`twin profile "${p.id || ''}": agent operations must be supported and allowed by the profile`);
        const requiredAccess = { propose_note: 1, write_handoff: 1, write_note: 2 };
        if (Array.isArray(grant?.operations) && grant.operations.some((op) => requiredAccess[op] > accessRank[grant?.access])) errors.push(`twin profile "${p.id || ''}": agent operation exceeds its vault access`);
      }
    }
  }
  // A vault may be listed by more than one profile only when the shared access is
  // limited to the handoff mailbox. Shared note access would let one Twin read or
  // change another Twin's content because scope is enforced at the vault boundary.
  const vaultReaders = new Map();
  for (const profile of Array.isArray(cfg.twin_profiles) ? cfg.twin_profiles : []) {
    for (const agent of Array.isArray(profile?.agent_access) ? profile.agent_access : []) {
      for (const grant of Array.isArray(agent?.vaults) ? agent.vaults : []) {
        if (!grant?.name || !Array.isArray(grant.operations)) continue;
        const contentOps = grant.operations.filter((operation) => ['search', 'read_note', 'propose_note', 'write_note'].includes(operation));
        if (!contentOps.length) continue;
        const owners = vaultReaders.get(grant.name) || new Set();
        owners.add(profile.id);
        vaultReaders.set(grant.name, owners);
      }
    }
  }
  for (const [vaultName, owners] of vaultReaders) {
    if (owners.size > 1) errors.push(`vault "${vaultName}" cannot grant note access to multiple Twin profiles; share it only for handoff actions`);
  }
  errors.push(...validateGitHubAssignments(cfg));
  if (cfg.handoff && (!names.has(cfg.handoff.vault) || !cfg.handoff.folder)) errors.push('handoff needs an existing vault and a folder');
  if (cfg.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: cfg.timezone }); } catch { errors.push(`unknown timezone "${cfg.timezone}"`); } }
  if (cfg.locale && !LOCALES.includes(cfg.locale)) errors.push(`locale must be one of ${LOCALES.join(', ')}`);
  if (typeof cfg.sessions?.shareSummaries !== 'boolean') errors.push('sessions.shareSummaries must be a boolean');
  if (cfg.sessions?.importHistory !== undefined && typeof cfg.sessions.importHistory !== 'boolean') errors.push('sessions.importHistory must be a boolean');
  if (typeof cfg.sessions?.shareFullText !== 'boolean') errors.push('sessions.shareFullText must be a boolean');
  if (cfg.sessions?.hermesHome !== null && (typeof cfg.sessions?.hermesHome !== 'string' || !path.isAbsolute(cfg.sessions.hermesHome) || cfg.sessions.hermesHome.length > 4096)) errors.push('sessions.hermesHome must be null or an absolute folder path');
  if (typeof cfg.sessions?.localSummary?.enabled !== 'boolean' || typeof cfg.sessions?.localSummary?.model !== 'string' || cfg.sessions.localSummary.model.length > 160 || typeof cfg.sessions.localSummary?.autoDraftOnEnd !== 'boolean' || typeof cfg.sessions.localSummary?.autoFileOnEnd !== 'boolean' || (cfg.sessions.localSummary.enabled && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(cfg.sessions.localSummary.model)) || (cfg.sessions.localSummary.autoDraftOnEnd && !cfg.sessions.localSummary.enabled) || (cfg.sessions.localSummary.autoFileOnEnd && (!cfg.sessions.localSummary.enabled || !cfg.sessions.localSummary.autoDraftOnEnd))) errors.push('sessions.localSummary must contain valid enabled, model, autoDraftOnEnd, and autoFileOnEnd settings');
  if (typeof cfg.backup.enabled !== 'boolean') errors.push('backup.enabled must be a boolean');
  if (cfg.backup.enabled && (!cfg.backup.folder || !path.isAbsolute(cfg.backup.folder))) errors.push('backup.folder must be an absolute path when enabled');
  if (!Number.isInteger(cfg.backup.intervalHours) || cfg.backup.intervalHours < 1 || cfg.backup.intervalHours > 168) errors.push('backup.intervalHours must be 1–168');
  try { normalizeBackupSchedule(cfg.backup); } catch (error) { errors.push(error.message); }
  if (!Number.isInteger(cfg.backup.keepCount) || cfg.backup.keepCount < 0 || cfg.backup.keepCount > 365) errors.push('backup.keepCount must be 0 (unlimited) or 1–365');
  if (typeof cfg.backup.encrypted !== 'boolean') errors.push('backup.encrypted must be a boolean');
  if (cfg.sync) errors.push(...validateSync(cfg.sync));
  return errors;
}

export async function loadConfig(file = configPath()) {
  if (!existsSync(file)) return normalize(emptyConfig());
  const cfg = normalize(JSON.parse(await readFile(file, 'utf8')));
  const errors = validate(cfg);
  if (errors.length) throw new Error(`Invalid BrainLink config (${file}):\n- ${errors.join('\n- ')}`);
  return cfg;
}

// Atomic write so a crash never leaves a half-written config. On Windows, antivirus
// scanners or readers can briefly hold the destination during replacement. Unique temp
// names also prevent overlapping settings requests from colliding on one process-wide file.
export async function saveConfig(cfg, file = configPath()) {
  const errors = validate(normalize(cfg));
  if (errors.length) throw new Error(errors.join('; '));
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await rename(tmp, file); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 19) throw error;
        await delay(25);
      }
    }
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}
