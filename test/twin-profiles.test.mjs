import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize, validate, saveConfig } from '../src/config.mjs';
import { twinProfileStatus } from '../src/twin-profiles.mjs';
import { startSetup } from '../src/setup.mjs';
import { createContext } from '../src/core.mjs';
import { createMcp } from '../src/server.mjs';
import { hashToken } from '../src/mcp-agents.mjs';
import { openSessionStore } from '../src/sessions/index.mjs';

const fixture = (vaultPath) => normalize({
  version: 2,
  vaults: [{ name: 'Fictional Org', path: vaultPath }],
  ai_agents: [{ id: 'agent_codex', name: 'Fictional Codex', kind: 'local', tokenHash: hashToken('fictional-agent-token'), connected: true }],
  twin_profiles: [{
    id: 'org_twin_1', name: 'Acme Organisation Twin', mode: 'organisation', owner: 'fictional-owner',
    vaults: [{ name: 'Fictional Org', access: 'propose' }],
    source_policy: { private_default: true, provenance_required: true, session_capture: 'summary-proposal' },
    memory_policy: { working: true, semantic: true, procedural: true, episodic: true },
    allowed_actions: ['search', 'read_note', 'propose_note'],
    agent_access: [{ agent_id: 'agent_codex', vaults: [{ name: 'Fictional Org', access: 'read', operations: ['search', 'read_note'] }] }],
  }],
});

test('Twin profile declarations validate references and prevent permission escalation in their contract', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-twin-contract-'));
  const vaultPath = path.join(root, 'vault');
  await mkdir(vaultPath);
  const cfg = fixture(vaultPath);
  assert.deepEqual(validate(cfg), []);
  const unknownVault = structuredClone(cfg);
  unknownVault.twin_profiles[0].vaults[0].name = 'Other';
  assert.match(validate(unknownVault).join('; '), /unknown vault/);
  const escalated = structuredClone(cfg);
  escalated.twin_profiles[0].agent_access[0].vaults[0].operations.push('write_note');
  assert.match(validate(escalated).join('; '), /agent operations/);
  const overVaultGrant = structuredClone(cfg);
  overVaultGrant.twin_profiles[0].allowed_actions.push('write_note');
  overVaultGrant.twin_profiles[0].agent_access[0].vaults[0] = { name: 'Fictional Org', access: 'write', operations: ['write_note'] };
  assert.match(validate(overVaultGrant).join('; '), /agent vault access exceeds/);
  const duplicateAgent = structuredClone(cfg);
  duplicateAgent.twin_profiles.push({ ...structuredClone(cfg.twin_profiles[0]), id: 'second_profile', mode: 'personal' });
  assert.match(validate(duplicateAgent).join('; '), /only one Twin profile/);
  const revoked = structuredClone(cfg);
  revoked.ai_agents[0].revoked = true;
  assert.match(validate(revoked).join('; '), /unknown or revoked/);
});

test('Twin status shows limited runtime scope and never exposes agent credentials', () => {
  const status = twinProfileStatus(fixture('C:\\fictional-vault'));
  assert.equal(status.enforcement, 'scoped_agent_read_only');
  assert.equal(status.profiles[0].declaration_status, 'agent_profile_scope_active');
  assert.equal(status.profiles[0].agents[0].name, 'Fictional Codex');
  assert.equal(status.profiles[0].agents[0].vaults[0].operations.includes('write_note'), false);
  assert.doesNotMatch(JSON.stringify(status), /tokenHash|f{64}/);
});

test('Twin status appears in the main UI and escapes every profile-provided label', async () => {
  const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="twin-profiles-panel"/);
  assert.match(html, /id="twin-profiles"/);
  assert.match(html, /esc\(p\.name\)/);
  assert.match(html, /esc\(t\('twinProfiles\.owner', \{ owner: p\.owner \}\)\)/);
  assert.match(html, /twinProfiles\.limits/);
});

test('profile-scoped agents see only granted vaults and only supported read tools', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-twin-runtime-'));
  const orgPath = path.join(root, 'org');
  const personalPath = path.join(root, 'personal');
  await mkdir(orgPath);
  await mkdir(personalPath);
  await writeFile(path.join(orgPath, 'Public Brief.md'), 'Fictional public organisation note.');
  await writeFile(path.join(personalPath, 'Private.md'), 'Private canary TWIN_PERSONAL_CANARY_77.');
  const cfg = fixture(orgPath);
  cfg.vaults.push({ name: 'Fictional Personal', path: personalPath, private: true });
  const ctx = createContext(cfg, { env: { BRAINLINK_AGENT_TOKEN: 'fictional-agent-token' } });
  assert.deepEqual(ctx.enabled, ['Fictional Org']);
  assert.equal(ctx.twinScope.mode, 'scoped');
  const mcp = createMcp(ctx);
  const listed = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = listed.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('vault_search'));
  assert.ok(names.includes('vault_read_note'));
  assert.deepEqual(names.includes('vault_search') && listed.result.tools.find((tool) => tool.name === 'vault_search').inputSchema.properties.vault.enum, ['Fictional Org']);
  assert.ok(!names.includes('propose_note'));
  assert.ok(!names.includes('session_list'));
  assert.ok(!names.includes('send_handoff'));
  const promptList = await mcp.handle({ jsonrpc: '2.0', id: 5, method: 'prompts/list' });
  assert.deepEqual(promptList.result.prompts.map((prompt) => prompt.name), ['brief']);
  const resources = await mcp.handle({ jsonrpc: '2.0', id: 7, method: 'resources/list' });
  assert.ok(resources.result.resources.some((resource) => resource.uri === 'brainlink://guide'));
  assert.ok(resources.result.resources.every((resource) => !resource.uri.includes('Fictional%20Personal')));
  const guideResource = await mcp.handle({ jsonrpc: '2.0', id: 8, method: 'resources/read', params: { uri: 'brainlink://guide' } });
  const scopedGuide = JSON.parse(guideResource.result.contents[0].text);
  assert.deepEqual(scopedGuide.server.enabled_vaults, ['Fictional Org']);
  assert.equal(scopedGuide.twin_profile_scope.writes_available, false);
  assert.match(scopedGuide.write_rules.join(' '), /General note writes/);
  assert.doesNotMatch(guideResource.result.contents[0].text, /Fictional Personal|TWIN_PERSONAL_CANARY_77/);
  const guide = await mcp.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'brainlink_guide', arguments: {} } });
  assert.equal(guide.result.structuredContent.twin_profile_scope.profile_id, 'org_twin_1');
  assert.equal(guide.result.structuredContent.twin_profile_scope.writes_available, false);
  const deniedSessionPrompt = await mcp.handle({ jsonrpc: '2.0', id: 9, method: 'prompts/get', params: { name: 'close-session' } });
  assert.ok(deniedSessionPrompt.error);
  const deniedVault = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'vault_search', arguments: { vault: 'Fictional Personal', query: 'TWIN_PERSONAL_CANARY_77' } } });
  assert.equal(deniedVault.result.isError, true);
  assert.doesNotMatch(JSON.stringify(deniedVault), /TWIN_PERSONAL_CANARY_77|Private\.md/);
  const deniedWrite = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'propose_note', arguments: { vault: 'Fictional Org', title: 'No write', body: 'Should stay blocked', source: 'test' } } });
  assert.equal(deniedWrite.result.isError, true);
  assert.match(deniedWrite.result.content[0].text, /not available to profile-scoped agents/);
  const deniedSession = await mcp.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'session_list', arguments: {} } });
  assert.equal(deniedSession.result.isError, true);
  assert.match(deniedSession.result.content[0].text, /does not allow read_session/);
  const unassigned = createContext(cfg, { env: { BRAINLINK_AGENT_TOKEN: 'unknown-token' } });
  assert.deepEqual(unassigned.enabled, []);
  assert.equal(unassigned.twinScope.mode, 'unassigned');
});

test('profile-scoped session reads stay inside the profile and closeouts remain approval-gated', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-twin-sessions-'));
  const orgPath = path.join(root, 'org');
  const privatePath = path.join(root, 'personal');
  await mkdir(path.join(orgPath, 'Inbox'), { recursive: true });
  await mkdir(privatePath);
  const cfg = fixture(orgPath);
  cfg.vaults.push({ name: 'Fictional Personal', path: privatePath, private: true });
  const profile = cfg.twin_profiles[0];
  profile.vaults[0].access = 'propose';
  profile.allowed_actions.push('read_session', 'propose_note');
  profile.agent_access[0].vaults[0] = { name: 'Fictional Org', access: 'propose', operations: ['search', 'read_note', 'read_session', 'propose_note'] };
  const env = { BRAINLINK_HOME: path.join(root, 'app'), HOME: root, BRAINLINK_AGENT_TOKEN: 'fictional-agent-token' };
  const mcp = createMcp(createContext(cfg, { env }));
  const store = await openSessionStore(env);
  const own = await store.putSession({ client: 'fictional-org-ai', source_id: 'own-1', profile_id: 'org_twin_1', vault: 'Sessions', project: 'Example', title: 'Own session', summary: 'ORG_SESSION_CANARY_77', started_at: new Date().toISOString(), private: true, messages: [{ role: 'assistant', at: new Date().toISOString(), text: 'ORG_MESSAGE_CANARY_77' }] });
  const foreign = await store.putSession({ client: 'fictional-person-ai', source_id: 'private-1', profile_id: 'personal_twin_2', vault: 'Sessions', project: 'Private', title: 'Private session', summary: 'PERSONAL_SESSION_CANARY_88', started_at: new Date().toISOString(), private: true, messages: [{ role: 'assistant', at: new Date().toISOString(), text: 'PERSONAL_MESSAGE_CANARY_88' }] });
  const unassigned = await store.putSession({ client: 'fictional-import', source_id: 'legacy-1', vault: 'Sessions', project: 'Legacy', title: 'Unassigned import', summary: 'UNASSIGNED_SESSION_CANARY_99', started_at: new Date().toISOString(), private: true, messages: [{ role: 'assistant', at: new Date().toISOString(), text: 'UNASSIGNED_MESSAGE_CANARY_99' }] });

  const listedTools = (await mcp.handle({ jsonrpc: '2.0', id: 20, method: 'tools/list' })).result.tools.map((tool) => tool.name);
  assert.ok(listedTools.includes('session_list'));
  assert.ok(listedTools.includes('session_read'));
  assert.ok(listedTools.includes('session_close'));
  const listed = await mcp.handle({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'session_list', arguments: { q: 'SESSION_CANARY' } } });
  assert.deepEqual(listed.result.structuredContent.sessions.map((session) => session.id), [own.id]);
  assert.doesNotMatch(JSON.stringify(listed), /PERSONAL_SESSION_CANARY_88|UNASSIGNED_SESSION_CANARY_99/);
  const readOwn = await mcp.handle({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'session_read', arguments: { id: own.id, full: true } } });
  assert.match(JSON.stringify(readOwn), /ORG_MESSAGE_CANARY_77/);
  for (const id of [foreign.id, unassigned.id]) {
    const denied = await mcp.handle({ jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'session_read', arguments: { id, full: true } } });
    assert.equal(denied.result.isError, true);
    assert.doesNotMatch(JSON.stringify(denied), /PERSONAL_SESSION_CANARY_88|UNASSIGNED_SESSION_CANARY_99|PERSONAL_MESSAGE_CANARY_88|UNASSIGNED_MESSAGE_CANARY_99/);
  }
  const closeArgs = { vault: 'Fictional Org', title: 'Fictional scoped close', goal: 'Verify scoped closure', outcome: 'Stored only as a profile-owned private summary.', session_or_task_id: 'scoped-close-1' };
  const preview = await mcp.handle({ jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: 'session_close', arguments: closeArgs } });
  assert.equal(preview.result.structuredContent.session_saved, false);
  assert.equal(preview.result.structuredContent.written, false);
  const saved = await mcp.handle({ jsonrpc: '2.0', id: 25, method: 'tools/call', params: { name: 'session_close', arguments: { ...closeArgs, confirm: true } } });
  assert.equal(saved.result.structuredContent.session_saved, true);
  const savedSession = await (await openSessionStore(env)).readSession(saved.result.structuredContent.session_id, { profile_id: 'org_twin_1' });
  assert.equal(savedSession.session.profile_id, 'org_twin_1');
  assert.equal((await store.listSessions({ profile_id: 'personal_twin_2' })).some((session) => session.id === savedSession.session.id), false);
});

test('authenticated local status exposes Twin scopes without returning agent credentials', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-twin-status-'));
  const home = path.join(root, 'home');
  const vaultPath = path.join(root, 'vault');
  await mkdir(vaultPath);
  await writeFile(path.join(vaultPath, 'Brief.md'), 'Fictional company content only.');
  const env = { BRAINLINK_HOME: path.join(home, 'app') };
  await saveConfig(fixture(vaultPath), path.join(env.BRAINLINK_HOME, 'config.json'));
  const setup = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${setup.port}`;
  try {
    const denied = await fetch(`${base}/api/state`);
    assert.equal(denied.status, 401);
    const response = await fetch(`${base}/api/state`, { headers: { 'X-BrainLink-Token': setup.token } });
    const state = await response.json();
    assert.equal(state.twin_profiles.enforcement, 'scoped_agent_read_only');
    assert.equal(state.twin_profiles.profiles[0].mode, 'organisation');
    assert.equal(state.twin_profiles.profiles[0].vaults[0].access, 'propose');
    assert.equal(state.twin_profiles.profiles[0].agents[0].vaults[0].access, 'read');
    assert.doesNotMatch(JSON.stringify(state.twin_profiles), /tokenHash|f{64}|Fictional company content/);
  } finally { setup.server.close(); }
});
