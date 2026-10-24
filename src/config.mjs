// Customer configuration: vaults, agents, rules and per-connection settings. Everything that
// was hard-coded for one person in vault-agent v0.2 lives here, so the code names no person,
// vault, agent or timezone.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { validateSync } from './sync/settings.mjs';

export const DEFAULT_PLATFORMS = ['Claude', 'ChatGPT', 'ChatGPT Codex', 'Gemini', 'Grok', 'Cursor', 'other'];
export const CLOSE_MODES = ['append-section', 'new-note', 'append-task', 'proposal-only'];
export const SCHEMAS = ['standard', 'provenance'];
export const WRITE_MODES = ['on', 'proposal-only', 'off'];

// Where BrainLink keeps config.json, activity.log and backups for this OS user.
export function appHome(env = process.env, platform = process.platform, home = homedir()) {
  if (env.BRAINLINK_HOME) return env.BRAINLINK_HOME;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'BrainLink');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'BrainLink');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'brainlink');
}

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
  return { version: CONFIG_SCHEMA_VERSION, timezone: null, locale: null, vaults: [], agents: [], ai_agents: [], handoff: null, platforms: DEFAULT_PLATFORMS, http: { port: 8765, token: null }, connections: {}, sessions: { shareSummaries: false, shareFullText: false }, session_filing: { projectVaults: {} }, backup: { enabled: false, folder: null, intervalHours: 24 } };
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
  cfg.http = { port: 8765, token: null, ...(raw.http || {}) };
  cfg.connections = raw.connections || {};
  cfg.backup = { enabled: false, folder: null, intervalHours: 24, ...(raw.backup || {}) };
  cfg.session_filing = { projectVaults: {}, ...(raw.session_filing || {}) };
  if (!cfg.session_filing.projectVaults || typeof cfg.session_filing.projectVaults !== 'object' || Array.isArray(cfg.session_filing.projectVaults)) cfg.session_filing.projectVaults = {};
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
    ? { shareSummaries: false, shareFullText: false }
    : { shareSummaries: false, shareFullText: false, ...(raw.sessions || {}) };
  cfg.version = CONFIG_SCHEMA_VERSION;
  return cfg;
}

export function validate(cfg) {
  const errors = [];
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
  if (cfg.handoff && (!names.has(cfg.handoff.vault) || !cfg.handoff.folder)) errors.push('handoff needs an existing vault and a folder');
  if (cfg.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: cfg.timezone }); } catch { errors.push(`unknown timezone "${cfg.timezone}"`); } }
  if (cfg.locale && !LOCALES.includes(cfg.locale)) errors.push(`locale must be one of ${LOCALES.join(', ')}`);
  if (typeof cfg.sessions?.shareSummaries !== 'boolean') errors.push('sessions.shareSummaries must be a boolean');
  if (typeof cfg.sessions?.shareFullText !== 'boolean') errors.push('sessions.shareFullText must be a boolean');
  if (typeof cfg.backup.enabled !== 'boolean') errors.push('backup.enabled must be a boolean');
  if (cfg.backup.enabled && (!cfg.backup.folder || !path.isAbsolute(cfg.backup.folder))) errors.push('backup.folder must be an absolute path when enabled');
  if (!Number.isInteger(cfg.backup.intervalHours) || cfg.backup.intervalHours < 1 || cfg.backup.intervalHours > 168) errors.push('backup.intervalHours must be 1–168');
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

// Atomic write so a crash never leaves a half-written config.
export async function saveConfig(cfg, file = configPath()) {
  const errors = validate(normalize(cfg));
  if (errors.length) throw new Error(errors.join('; '));
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, file);
}
