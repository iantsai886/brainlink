import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize, saveConfig, loadConfig } from '../src/config.mjs';
import { createContext } from '../src/core.mjs';
import { createMcp } from '../src/server.mjs';
import { hashToken } from '../src/mcp-agents.mjs';
import { startSetup } from '../src/setup.mjs';
import { proposeNote } from '../src/writes.mjs';
import { loadVault, readNote } from '../src/core.mjs';

test('an explicitly assigned Twin can read a private vault but cannot write to it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-private-twin-'));
  const vault = path.join(root, 'vault');
  await mkdir(path.join(vault, 'Inbox'), { recursive: true });
  await writeFile(path.join(vault, 'Public within vault.md'), '# Allowed\n\nFictional launch plan is ready.\n');
  await writeFile(path.join(vault, 'Private note.md'), '---\nprivate: true\n---\n# Hidden\n\nPRIVATE_CANARY\n');
  const env = { HOME: root, BRAINLINK_HOME: path.join(root, 'app'), BRAINLINK_SEMANTIC: '0' };
  const configFile = path.join(env.BRAINLINK_HOME, 'config.json');
  const token = 'fictional-private-scope-token';
  const cfg = normalize({ vaults: [{ name: 'Private Vault', path: vault, private: true, writes: 'on' }],
    ai_agents: [{ id: 'private_agent', name: 'Fictional agent', kind: 'local', tokenHash: hashToken(token) }] });
  await saveConfig(cfg, configFile);
  const app = await startSetup({ env, home: root, os: process.platform, port: 0, useCli: false });
  t.after(async () => { await new Promise((resolve) => app.server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const request = { name: 'Fictional Twin', owner: 'fictional owner', mode: 'personal',
    vaults: [{ name: 'Private Vault', access: 'propose' }],
    memory_policy: { working: false, semantic: true, procedural: false, episodic: false },
    agent_access: [{ agent_id: 'private_agent', vaults: [{ name: 'Private Vault', operations: ['search', 'read_note', 'propose_note'] }] }] };
  const response = await fetch(`http://127.0.0.1:${app.port}/api/twins/create`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': app.token }, body: JSON.stringify(request) });
  assert.equal(response.status, 200, await response.text());
  const saved = await loadConfig(configFile);
  const ctx = createContext(saved, { env: { ...env, BRAINLINK_AGENT_TOKEN: token, BRAINLINK_AI_PLATFORM: 'Fictional' } });
  const mcp = createMcp(ctx);
  const call = async (name, args) => (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;
  const read = await call('vault_read_note', { vault: 'Private Vault', path: 'Public within vault.md' });
  assert.match(JSON.stringify(read), /Fictional launch plan/);
  const found = await call('vault_search', { vault: 'Private Vault', query: 'fictional launch plan' });
  assert.match(JSON.stringify(found), /Fictional launch plan/i);
  assert.doesNotMatch(JSON.stringify(found), /PRIVATE_CANARY/);
  const hidden = await call('vault_read_note', { vault: 'Private Vault', path: 'Private note.md' });
  assert.doesNotMatch(JSON.stringify(hidden), /PRIVATE_CANARY/);
  const proposal = await call('propose_note', { vault: 'Private Vault', folder: 'Inbox', title: 'Fictional proposal', body: 'Fictional text', source: 'fixture', confidence: 'reported', session_or_task_id: 'fixture-1', confirm: true });
  assert.equal(proposal.structuredContent.written, false, JSON.stringify(proposal));
  assert.match(proposal.structuredContent.preview, /Fictional text/);
  assert.deepEqual(await readdir(path.join(vault, 'Inbox')), []);
  assert.deepEqual(createContext(saved, { env }).enabled, [], 'unassigned connections do not inherit the private vault');
});

test('shared vault notes stay shared even when the legacy profile private_default is true', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-shared-profile-'));
  const vault = path.join(root, 'shared');
  await mkdir(path.join(vault, 'Inbox'), { recursive: true });
  const tokens = { writer: 'fictional-writer-token', reader: 'fictional-reader-token' };
  const cfg = normalize({
    vaults: [{ name: 'Shared Brain', path: vault, private: false, writes: 'on', intake_folder: 'Inbox' }],
    ai_agents: Object.entries(tokens).map(([name, token]) => ({ id: `agent_${name}`, name, kind: 'local', tokenHash: hashToken(token) })),
    twin_profiles: [{
      id: 'shared_brain', name: 'Shared Brain', owner: 'fictional owner', mode: 'organisation',
      vaults: [{ name: 'Shared Brain', access: 'write' }],
      source_policy: { private_default: true, provenance_required: false, session_capture: 'metadata-only' },
      memory_policy: { working: true, semantic: true, procedural: true, episodic: true },
      allowed_actions: ['search', 'read_note', 'propose_note', 'write_note'],
      agent_access: Object.keys(tokens).map((name) => ({ agent_id: `agent_${name}`, vaults: [{ name: 'Shared Brain', access: name === 'writer' ? 'write' : 'read', operations: name === 'writer' ? ['search', 'read_note', 'propose_note', 'write_note'] : ['search', 'read_note'] }] })),
    }],
  });
  const env = { HOME: root, BRAINLINK_HOME: path.join(root, 'app'), BRAINLINK_SEMANTIC: '0' };
  t.after(() => rm(root, { recursive: true, force: true }));
  const writer = createContext(cfg, { env: { ...env, BRAINLINK_AGENT_TOKEN: tokens.writer, BRAINLINK_AI_PLATFORM: 'Writer' } });
  const reader = createContext(cfg, { env: { ...env, BRAINLINK_AGENT_TOKEN: tokens.reader, BRAINLINK_AI_PLATFORM: 'Reader' } });
  const result = await proposeNote(writer, { vault: 'Shared Brain', title: 'Shared operating fact', body: 'A fictional fact for every authorized agent.', source: 'fixture', session_or_task_id: 'shared-1', confirm: true, auto_link: false });
  assert.equal(result.written, true, JSON.stringify(result));
  const saved = await readFile(path.join(vault, 'Inbox', path.basename(result.path)), 'utf8');
  assert.doesNotMatch(saved, /^private:\s*true/im);
  assert.match((await readNote(reader, 'Shared Brain', `Inbox/${path.basename(result.path)}`)).body, /fictional fact for every authorized agent/i);
  assert.match((await loadVault(reader, 'Shared Brain')).notes.map((note) => note.body).join('\n'), /fictional fact for every authorized agent/i);
});

test('a preset client receives private vault access only when it is explicitly selected', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-private-preset-'));
  const vault = path.join(root, 'vault');
  await mkdir(vault);
  await mkdir(path.join(root, '.cursor'));
  await writeFile(path.join(vault, 'Note.md'), '# Fictional\n\nExplicitly selected private vault.\n');
  const env = { HOME: root, BRAINLINK_HOME: path.join(root, 'app'), BRAINLINK_SEMANTIC: '0' };
  const configFile = path.join(env.BRAINLINK_HOME, 'config.json');
  const cfg = normalize({ vaults: [{ name: 'Private Vault', path: vault, private: true, writes: 'on' }], twin_profiles: [{
    id: 'fictional_private', name: 'Fictional', owner: 'fictional owner', mode: 'personal',
    vaults: [{ name: 'Private Vault', access: 'propose' }], memory_policy: { working: false, semantic: true, procedural: false, episodic: false },
    source_policy: { private_default: true, provenance_required: true, session_capture: 'metadata-only' }, allowed_actions: [], agent_access: [],
  }] });
  await saveConfig(cfg, configFile);
  const app = await startSetup({ env, home: root, os: 'linux', port: 0, useCli: false });
  t.after(async () => { await new Promise((resolve) => app.server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const post = (body) => fetch(`http://127.0.0.1:${app.port}/api/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': app.token }, body: JSON.stringify(body) });
  assert.equal((await post({ client: 'cursor', profile_id: 'fictional_private', vaults: [] })).status, 400);
  const connected = await post({ client: 'cursor', profile_id: 'fictional_private', vaults: [{ name: 'Private Vault', operations: ['search', 'read_note'] }] });
  assert.equal(connected.status, 200, await connected.text());
  const cursor = JSON.parse(await readFile(path.join(root, '.cursor', 'mcp.json'), 'utf8'));
  const saved = await loadConfig(configFile);
  const ctx = createContext(saved, { env: { ...env, BRAINLINK_AGENT_TOKEN: cursor.mcpServers.brainlink.env.BRAINLINK_AGENT_TOKEN } });
  assert.deepEqual(ctx.enabled, ['Private Vault']);
  const mcp = createMcp(ctx);
  const reply = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vault_read_note', arguments: { vault: 'Private Vault', path: 'Note.md' } } });
  assert.match(JSON.stringify(reply), /Explicitly selected private vault/);
});
