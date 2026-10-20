// User-added AI agents (Ian's RB7 feature 1): any number of agents on top of the preset apps
// in src/connectors.mjs. Each gets its own random token, shown once and stored only as a sha256
// hash; revocable without deleting the agent's history. Pure config transforms, no I/O — callers
// (src/setup.mjs) load/save config.json around these.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { AGENT_KINDS } from './config.mjs';

export { AGENT_KINDS };

const genId = () => randomBytes(8).toString('hex');
export const generateAgentToken = () => `bla_${randomBytes(24).toString('hex')}`;
export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

// What's safe to show in the UI / return from the API: never the token or its hash.
export const publicAgent = (a) => ({ id: a.id, name: a.name, kind: a.kind, connected: a.connected, revoked: a.revoked, createdAt: a.createdAt, lastSeenAt: a.lastSeenAt });

export function addAgent(cfg, { name, kind } = {}, now = new Date()) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Give the agent a name.');
  if (cfg.ai_agents.some((a) => a.name.toLowerCase() === clean.toLowerCase())) throw new Error(`An agent named "${clean}" already exists.`);
  const k = AGENT_KINDS.includes(kind) ? kind : 'local';
  const token = generateAgentToken();
  const agent = { id: genId(), name: clean, kind: k, tokenHash: hashToken(token), connected: false, revoked: false, createdAt: now.toISOString(), lastSeenAt: null };
  return { cfg: { ...cfg, ai_agents: [...cfg.ai_agents, agent] }, agent, token };
}

function mustFind(cfg, id) {
  const a = cfg.ai_agents.find((x) => x.id === id);
  if (!a) throw new Error('Unknown agent. It may already have been removed.');
  return a;
}

export function renameAgent(cfg, id, name) {
  mustFind(cfg, id);
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Give the agent a name.');
  if (cfg.ai_agents.some((a) => a.id !== id && a.name.toLowerCase() === clean.toLowerCase())) throw new Error(`An agent named "${clean}" already exists.`);
  return { ...cfg, ai_agents: cfg.ai_agents.map((a) => (a.id === id ? { ...a, name: clean } : a)) };
}

export function removeAgent(cfg, id) {
  mustFind(cfg, id);
  return { ...cfg, ai_agents: cfg.ai_agents.filter((a) => a.id !== id) };
}

// Disables the token (no one can call as this agent again) without erasing the agent's name/history.
export function revokeAgent(cfg, id) {
  mustFind(cfg, id);
  return { ...cfg, ai_agents: cfg.ai_agents.map((a) => (a.id === id ? { ...a, revoked: true, tokenHash: null, connected: false } : a)) };
}

export function markConnected(cfg, id, now = new Date()) {
  mustFind(cfg, id);
  return { ...cfg, ai_agents: cfg.ai_agents.map((a) => (a.id === id ? { ...a, connected: true, lastSeenAt: now.toISOString() } : a)) };
}

// Constant-time match against every live (non-revoked) agent token. Returns the raw config
// record (with tokenHash) since callers that matched a token are allowed to know which agent it
// was; use publicAgent() before this ever reaches a client response.
export function findAgentByToken(cfg, token) {
  const t = String(token || '');
  if (!t) return null;
  const want = Buffer.from(hashToken(t));
  let hit = null;
  for (const a of cfg.ai_agents) {
    if (a.revoked || !a.tokenHash) continue;
    const have = Buffer.from(a.tokenHash);
    if (have.length === want.length && timingSafeEqual(have, want)) hit = a; // keep looping: constant-time
  }
  return hit;
}

// The local setup code: a generic stdio MCP entry (like connectors.mjs's CLIENTS, but for any
// client the user names themselves) carrying the agent's token so BrainLink can tell the calls
// apart. No network exposure: stdio runs as a local child process, same as every preset app.
export function localAgentSnippet(agent, token, launch) {
  return { mcpServers: { [`brainlink-${agent.id}`]: { command: launch.command, args: [...launch.args], env: { BRAINLINK_AGENT_TOKEN: token, BRAINLINK_AI_PLATFORM: agent.name } } } };
}

// The remote setup code: an HTTP MCP entry. BrainLink only binds to 127.0.0.1 with no tunnel, so
// this cannot be reached from the cloud yet; shown so the agent is ready to use the moment it can.
export function remoteAgentSnippet(agent, token, port) {
  return { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } };
}
