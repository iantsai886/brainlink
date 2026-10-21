// RB7 item 1: Agents on top of the preset apps. Token auth, per-agent call attribution, revoke,
// and "Connected only after a verified call that used that agent's token".
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startSetup } from '../src/setup.mjs';
import { normalize } from '../src/config.mjs';
import { createContext } from '../src/core.mjs';
import { createMcp } from '../src/server.mjs';
import { addAgent, revokeAgent } from '../src/mcp-agents.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (p) => mkdtemp(path.join(tmpdir(), `brainlink-${p}-`));

async function withSampleVault(label) {
  const home = await tmp(`${label}-home`);
  const vaultPath = path.join(home, 'Acme Studio');
  await cp(path.join(ROOT, 'samples', 'acme-studio'), vaultPath, { recursive: true });
  const env = { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' };
  const s = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${s.port}`;
  const api = (p, body) => fetch(base + p, { method: 'POST', headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
  const apiGet = (p) => fetch(base + p, { headers: { 'X-BrainLink-Token': s.token } }).then((r) => r.json());
  const r = await api('/api/vault', { path: vaultPath, name: 'Acme Studio', pack: 'simple', scaffold: false });
  assert.equal(r.ok, true, JSON.stringify(r));
  return { home, env, s, api, apiGet, vaultPath };
}

// ---- Setup UI wiring: add / list / rename / remove ----

test('/api/agents/add: returns the real token once; state() never exposes it', async () => {
  const { s, api, apiGet } = await withSampleVault('agents-add');
  try {
    const r = await api('/api/agents/add', { name: 'Grok Bot', kind: 'remote' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.token && r.token.length > 20);
    assert.equal(r.agent.connected, false, 'not connected until a verified call happens');
    assert.ok(r.snippet.url, 'remote agents get a copy-paste MCP URL/key, not a local command');
    assert.doesNotMatch(JSON.stringify(r.snippet), /0\.0\.0\.0/);

    const st = await apiGet('/api/state');
    assert.equal(st.ai_agents.length, 1);
    assert.equal(st.ai_agents[0].name, 'Grok Bot');
    assert.ok(!('token' in st.ai_agents[0]) && !('tokenHash' in st.ai_agents[0]), 'the token must never come back from state');
  } finally { s.server.close(); }
});

test('/api/agents/add: local kind gets a stdio command snippet carrying the token', async () => {
  const { s, api } = await withSampleVault('agents-local-kind');
  try {
    const r = await api('/api/agents/add', { name: 'My Script', kind: 'local' });
    const key = Object.keys(r.snippet.mcpServers)[0];
    assert.equal(r.snippet.mcpServers[key].env.BRAINLINK_AGENT_TOKEN, r.token);
  } finally { s.server.close(); }
});

test('/api/agents/rename and /api/agents/remove', async () => {
  const { s, api, apiGet } = await withSampleVault('agents-rename-remove');
  try {
    const added = await api('/api/agents/add', { name: 'Old Name' });
    const renamed = await api('/api/agents/rename', { id: added.agent.id, name: 'New Name' });
    assert.equal(renamed.ok, true);
    assert.equal((await apiGet('/api/state')).ai_agents[0].name, 'New Name');
    const removed = await api('/api/agents/remove', { id: added.agent.id });
    assert.equal(removed.ok, true);
    assert.deepEqual((await apiGet('/api/state')).ai_agents, []);
  } finally { s.server.close(); }
});

// ---- Connected only after a verified call ----

test('/api/agents/test: a fresh agent is not connected; a real call with its token connects it', async () => {
  const { s, api, apiGet } = await withSampleVault('agents-verify');
  try {
    const added = await api('/api/agents/add', { name: 'Verifier' });
    assert.equal((await apiGet('/api/state')).ai_agents[0].connected, false);

    const health = await api('/api/agents/test', { token: added.token });
    assert.equal(health.ok, true, JSON.stringify(health));
    assert.equal(health.tool, 'brainlink_guide');

    assert.equal((await apiGet('/api/state')).ai_agents[0].connected, true);
  } finally { s.server.close(); }
});

test('/api/agents/test: a wrong or made-up key never connects anything', async () => {
  const { s, api, apiGet } = await withSampleVault('agents-wrong-key');
  try {
    await api('/api/agents/add', { name: 'Someone' });
    const health = await api('/api/agents/test', { token: 'not-a-real-token' });
    assert.equal(health.ok, false);
    assert.equal((await apiGet('/api/state')).ai_agents[0].connected, false);
  } finally { s.server.close(); }
});

test('/api/agents/revoke: a revoked agent\'s key stops authenticating and connected resets', async () => {
  const { s, api, apiGet } = await withSampleVault('agents-revoke');
  try {
    const added = await api('/api/agents/add', { name: 'Revocable' });
    await api('/api/agents/test', { token: added.token });
    assert.equal((await apiGet('/api/state')).ai_agents[0].connected, true);

    const revoked = await api('/api/agents/revoke', { id: added.agent.id });
    assert.equal(revoked.ok, true);
    const st = await apiGet('/api/state');
    assert.equal(st.ai_agents[0].connected, false);
    assert.equal(st.ai_agents[0].revoked, true);
    assert.equal(st.ai_agents[0].name, 'Revocable', 'revoke keeps the agent visible; remove is the delete');

    const retried = await api('/api/agents/test', { token: added.token });
    assert.equal(retried.ok, false, 'a revoked token must never authenticate again');
  } finally { s.server.close(); }
});

// ---- Per-agent call attribution (createContext + createMcp directly: the real MCP path) ----

test('createContext + createMcp: a call made with an agent token is attributed to that agent, not another one', async () => {
  const home = await tmp('attrib-home');
  const vaultPath = path.join(home, 'Acme Studio');
  await cp(path.join(ROOT, 'samples', 'acme-studio'), vaultPath, { recursive: true });
  let cfg = normalize({ vaults: [{ name: 'Acme Studio', path: vaultPath }] });
  const { cfg: c1, agent: agentA, token: tokenA } = addAgent(cfg, { name: 'Agent A' });
  const { cfg: c2, agent: agentB, token: tokenB } = addAgent(c1, { name: 'Agent B' });
  cfg = c2;

  const ctxA = createContext(cfg, { env: { BRAINLINK_AGENT_TOKEN: tokenA, BRAINLINK_SEMANTIC: '0' } });
  assert.equal(ctxA.mcpAgent.name, 'Agent A');
  assert.equal(ctxA.platform, 'Agent A', 'falls back to the agent name when no explicit platform is set');

  const calls = [];
  const mcpA = createMcp(ctxA, { onCall: (e) => calls.push(e) });
  await mcpA.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brainlink_guide', arguments: {} } });
  assert.equal(calls[0].agent, 'Agent A');

  const ctxB = createContext(cfg, { env: { BRAINLINK_AGENT_TOKEN: tokenB, BRAINLINK_SEMANTIC: '0' } });
  const mcpB = createMcp(ctxB, { onCall: (e) => calls.push(e) });
  await mcpB.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brainlink_guide', arguments: {} } });
  assert.equal(calls[1].agent, 'Agent B');
  assert.notEqual(calls[0].agent, calls[1].agent);
});

test('createContext: an unknown or revoked token resolves to no agent at all (never a guess)', async () => {
  const home = await tmp('attrib-unknown-home');
  const vaultPath = path.join(home, 'Acme Studio');
  await cp(path.join(ROOT, 'samples', 'acme-studio'), vaultPath, { recursive: true });
  let cfg = normalize({ vaults: [{ name: 'Acme Studio', path: vaultPath }] });
  const { cfg: c1, agent, token } = addAgent(cfg, { name: 'Agent' });
  cfg = revokeAgent(c1, agent.id);

  const ctx = createContext(cfg, { env: { BRAINLINK_AGENT_TOKEN: token, BRAINLINK_SEMANTIC: '0' } });
  assert.equal(ctx.mcpAgent, null);

  const noToken = createContext(cfg, { env: { BRAINLINK_SEMANTIC: '0' } });
  assert.equal(noToken.mcpAgent, null);
});
