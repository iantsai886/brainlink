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
  cfg.twin_profiles[0].github_repository = path.join(root, 'org-clone');
  assert.deepEqual(validate(cfg), []);
  const relativeRepository = structuredClone(cfg);
  relativeRepository.twin_profiles[0].github_repository = 'relative/repo';
  assert.match(validate(relativeRepository).join('; '), /github_repository must be an absolute local repository path/);
  const duplicateRepository = structuredClone(cfg);
  duplicateRepository.twin_profiles.push({ ...structuredClone(cfg.twin_profiles[0]), id: 'second_profile', mode: 'personal' });
  assert.match(validate(duplicateRepository).join('; '), /cannot share one local GitHub repository path/);
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
  assert.match(html, /data-sess-profile/);
  assert.match(html, /data-sess-assign/);
  assert.match(html, /sessions\.twinPrivate/);
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
  const clientPath = path.join(root, 'client');
  await mkdir(clientPath);
  cfg.vaults.push({ name: 'Fictional Personal', path: privatePath, private: true, schema: 'standard', writes: 'on' }, { name: 'Fictional Client', path: clientPath, private: true, schema: 'standard', writes: 'on' });
  const profile = cfg.twin_profiles[0];
  profile.vaults[0].access = 'propose';
  profile.allowed_actions.push('read_session', 'propose_note');
  profile.agent_access[0].vaults[0] = { name: 'Fictional Org', access: 'propose', operations: ['search', 'read_note', 'read_session', 'propose_note'] };
  const addScopedProfile = ({ id, name, mode, owner, vault, agentId, token }) => {
    cfg.ai_agents.push({ id: agentId, name: `${name} agent`, kind: 'local', tokenHash: hashToken(token), connected: true });
    cfg.twin_profiles.push({
      id, name, mode, owner, vaults: [{ name: vault, access: 'read' }],
      source_policy: { private_default: true, provenance_required: true, session_capture: 'summary-proposal' },
      memory_policy: { working: true, semantic: true, procedural: true, episodic: true },
      allowed_actions: ['search', 'read_note', 'read_session'],
      agent_access: [{ agent_id: agentId, vaults: [{ name: vault, access: 'read', operations: ['search', 'read_note', 'read_session'] }] }],
    });
  };
  addScopedProfile({ id: 'personal_twin_2', name: 'Fictional Personal Twin', mode: 'personal', owner: 'fictional-person', vault: 'Fictional Personal', agentId: 'agent_personal', token: 'fictional-personal-token' });
  addScopedProfile({ id: 'client_twin_3', name: 'Fictional Client Twin', mode: 'client', owner: 'fictional-client-owner', vault: 'Fictional Client', agentId: 'agent_client', token: 'fictional-client-token' });
  const env = { BRAINLINK_HOME: path.join(root, 'app'), HOME: root, BRAINLINK_AGENT_TOKEN: 'fictional-agent-token' };
  assert.deepEqual(validate(cfg), []);
  const mcp = createMcp(createContext(cfg, { env }));
  const store = await openSessionStore(env);
  const own = await store.putSession({ client: 'fictional-org-ai', source_id: 'own-1', profile_id: 'org_twin_1', vault: 'Sessions', project: 'Example', title: 'Own session', summary: 'ORG_SESSION_CANARY_77', started_at: new Date().toISOString(), private: true, messages: [{ role: 'assistant', at: new Date().toISOString(), text: 'ORG_MESSAGE_CANARY_77' }] });
  const foreign = await store.putSession({ client: 'fictional-person-ai', source_id: 'private-1', profile_id: 'personal_twin_2', vault: 'Sessions', project: 'Private', title: 'Private session', summary: 'PERSONAL_SESSION_CANARY_88', started_at: new Date().toISOString(), private: true, messages: [{ role: 'assistant', at: new Date().toISOString(), text: 'PERSONAL_MESSAGE_CANARY_88' }] });
  const clientSession = await store.putSession({ client: 'fictional-client-ai', source_id: 'client-1', profile_id: 'client_twin_3', vault: 'Sessions', project: 'Client', title: 'Client session', summary: 'CLIENT_SESSION_CANARY_98', started_at: new Date().toISOString(), private: true, messages: [{ role: 'assistant', at: new Date().toISOString(), text: 'CLIENT_MESSAGE_CANARY_98' }] });
  const unassigned = await store.putSession({ client: 'fictional-import', source_id: 'legacy-1', vault: 'Sessions', project: 'Legacy', title: 'Unassigned import', summary: 'UNASSIGNED_SESSION_CANARY_99', started_at: new Date().toISOString(), private: true, messages: [{ role: 'assistant', at: new Date().toISOString(), text: 'UNASSIGNED_MESSAGE_CANARY_99' }] });

  const listedTools = (await mcp.handle({ jsonrpc: '2.0', id: 20, method: 'tools/list' })).result.tools.map((tool) => tool.name);
  assert.ok(listedTools.includes('session_list'));
  assert.ok(listedTools.includes('session_read'));
  assert.ok(listedTools.includes('session_close'));
  const listed = await mcp.handle({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'session_list', arguments: { q: 'SESSION_CANARY' } } });
  assert.deepEqual(listed.result.structuredContent.sessions.map((session) => session.id), [own.id]);
  assert.doesNotMatch(JSON.stringify(listed), /PERSONAL_SESSION_CANARY_88|CLIENT_SESSION_CANARY_98|UNASSIGNED_SESSION_CANARY_99/);
  const readOwn = await mcp.handle({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'session_read', arguments: { id: own.id, full: true } } });
  assert.match(JSON.stringify(readOwn), /ORG_MESSAGE_CANARY_77/);
  const scopedClients = [
    { id: 'organisation', mcp, own, foreign: [foreign, clientSession, unassigned], token: 'fictional-agent-token' },
    { id: 'personal', mcp: createMcp(createContext(cfg, { env: { ...env, BRAINLINK_AGENT_TOKEN: 'fictional-personal-token' } })), own: foreign, foreign: [own, clientSession, unassigned], token: 'fictional-personal-token' },
    { id: 'client', mcp: createMcp(createContext(cfg, { env: { ...env, BRAINLINK_AGENT_TOKEN: 'fictional-client-token' } })), own: clientSession, foreign: [own, foreign, unassigned], token: 'fictional-client-token' },
  ];
  for (const scoped of scopedClients) {
    const scopedList = await scoped.mcp.handle({ jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'session_list', arguments: { q: 'SESSION_CANARY' } } });
    assert.deepEqual(scopedList.result.structuredContent.sessions.map((session) => session.id), [scoped.own.id], `${scoped.id} Twin sees its assigned session only`);
    const listJson = JSON.stringify(scopedList);
    for (const record of scoped.foreign) assert.equal(listJson.includes(record.summary), false, `${scoped.id} list excludes foreign summary`);
    for (const record of scoped.foreign) {
      const denied = await scoped.mcp.handle({ jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: 'session_read', arguments: { id: record.id, full: true } } });
      assert.equal(denied.result.isError, true, `${scoped.id} Twin cannot read ${record.profile_id || 'unassigned'} session`);
      assert.doesNotMatch(JSON.stringify(denied), /ORG_MESSAGE_CANARY_77|PERSONAL_MESSAGE_CANARY_88|CLIENT_MESSAGE_CANARY_98|UNASSIGNED_MESSAGE_CANARY_99/);
    }
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

test('profile-scoped handoffs require explicit grants and filter mailbox bodies by owner', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-twin-handoffs-'));
  const orgPath = path.join(root, 'org');
  const clientPath = path.join(root, 'client');
  await mkdir(path.join(orgPath, 'Handoffs'), { recursive: true });
  await mkdir(clientPath, { recursive: true });
  const cfg = fixture(orgPath);
  cfg.vaults.push({ name: 'Fictional Client', path: clientPath, private: true, schema: 'standard', writes: 'on' });
  cfg.handoff = { vault: 'Fictional Org', folder: 'Handoffs' };
  const profile = cfg.twin_profiles[0];
  profile.allowed_actions.push('handoff_read', 'write_handoff');
  profile.agent_access[0].vaults[0].access = 'propose';
  profile.agent_access[0].vaults[0].operations.push('handoff_read', 'write_handoff');
  cfg.ai_agents.push({ id: 'agent_client', name: 'Fictional Client AI', kind: 'local', tokenHash: hashToken('fictional-client-handoff-token'), connected: true });
  cfg.twin_profiles.push({
    id: 'client_twin_3', name: 'Fictional Client Twin', mode: 'client', owner: 'fictional-client-owner',
    vaults: [{ name: 'Fictional Client', access: 'read' }, { name: 'Fictional Org', access: 'propose' }],
    source_policy: { private_default: true, provenance_required: true, session_capture: 'summary-proposal' },
    memory_policy: { working: true, semantic: true, procedural: true, episodic: true },
    allowed_actions: ['search', 'read_note', 'handoff_read', 'write_handoff'],
    agent_access: [{ agent_id: 'agent_client', vaults: [
      { name: 'Fictional Client', access: 'read', operations: ['search', 'read_note'] },
      { name: 'Fictional Org', access: 'propose', operations: ['handoff_read', 'write_handoff'] },
    ] }],
  });
  const env = { BRAINLINK_HOME: path.join(root, 'app'), BRAINLINK_AGENT_TOKEN: 'fictional-agent-token' };
  assert.deepEqual(validate(cfg), []);
  const ungranted = structuredClone(cfg);
  ungranted.twin_profiles[0].allowed_actions = ungranted.twin_profiles[0].allowed_actions.filter((action) => !['handoff_read', 'write_handoff'].includes(action));
  ungranted.twin_profiles[0].agent_access[0].vaults[0].operations = ungranted.twin_profiles[0].agent_access[0].vaults[0].operations.filter((action) => !['handoff_read', 'write_handoff'].includes(action));
  const deniedMcp = createMcp(createContext(ungranted, { env }));
  const deniedNames = (await deniedMcp.handle({ jsonrpc: '2.0', id: 29, method: 'tools/list' })).result.tools.map((tool) => tool.name);
  assert.ok(!deniedNames.includes('list_handoffs') && !deniedNames.includes('send_handoff'));
  const deniedList = await deniedMcp.handle({ jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'list_handoffs', arguments: {} } });
  assert.equal(deniedList.result.isError, true);
  const mcp = createMcp(createContext(cfg, { env }));
  const clientMcp = createMcp(createContext(cfg, { env: { ...env, BRAINLINK_AGENT_TOKEN: 'fictional-client-handoff-token' } }));
  const names = (await mcp.handle({ jsonrpc: '2.0', id: 30, method: 'tools/list' })).result.tools.map((tool) => tool.name);
  assert.ok(names.includes('list_handoffs'));
  assert.ok(names.includes('send_handoff'));
  const sent = await mcp.handle({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'send_handoff', arguments: {
    to: 'all', subject: 'Fictional org handoff', body: 'ORG_HANDOFF_CANARY_71', session_or_task_id: 'org-handoff-1', confirm: true,
  } } });
  assert.equal(sent.result.structuredContent.written, true);
  const clientSent = await clientMcp.handle({ jsonrpc: '2.0', id: 34, method: 'tools/call', params: { name: 'send_handoff', arguments: {
    to: 'all', subject: 'Fictional client-only handoff', body: 'CLIENT_HANDOFF_CANARY_84', session_or_task_id: 'client-handoff-1', confirm: true,
  } } });
  assert.equal(clientSent.result.structuredContent.written, true);
  const clientList = await clientMcp.handle({ jsonrpc: '2.0', id: 35, method: 'tools/call', params: { name: 'list_handoffs', arguments: { to: 'all' } } });
  assert.equal(clientList.result.structuredContent.items.length, 1);
  assert.match(JSON.stringify(clientList), /CLIENT_HANDOFF_CANARY_84/);
  assert.doesNotMatch(JSON.stringify(clientList), /ORG_HANDOFF_CANARY_71|PERSONAL_HANDOFF_CANARY_82|UNASSIGNED_HANDOFF_CANARY_93/);
  const clientForeignAck = await clientMcp.handle({ jsonrpc: '2.0', id: 36, method: 'tools/call', params: { name: 'send_handoff', arguments: {
    to: 'all', subject: 'Client cannot update company item', body: 'Should be rejected.', ack_of: sent.result.structuredContent.path, session_or_task_id: 'client-foreign-ack-1', confirm: true,
  } } });
  assert.equal(clientForeignAck.result.isError, true);
  assert.doesNotMatch(JSON.stringify(clientForeignAck), /ORG_HANDOFF_CANARY_71/);
  const foreignPath = path.join(orgPath, 'Handoffs', '2026-10-24-2358-from-personal-to-all-personal-secret.md');
  await writeFile(foreignPath, '---\ntype: handoff\nhandoff_schema: 1\nstatus: REQUEST\nwritten_at: 2026-10-24T23:58:00+08:00\nto: all\nsubject: Private personal handoff\ntwin_profile_id: personal_twin_2\n---\n\n# Private personal handoff\n\nPERSONAL_HANDOFF_CANARY_82\n');
  const deniedAck = await mcp.handle({ jsonrpc: '2.0', id: 32, method: 'tools/call', params: { name: 'send_handoff', arguments: {
    to: 'all', subject: 'Attempt foreign acknowledgement', body: 'Must not acknowledge another Twin.', ack_of: 'Fictional Org/Handoffs/2026-10-24-2358-from-personal-to-all-personal-secret.md', session_or_task_id: 'org-foreign-ack-1', confirm: true,
  } } });
  assert.equal(deniedAck.result.isError, true);
  assert.match(deniedAck.result.content[0].text, /available handoff within this Twin profile/);
  assert.doesNotMatch(JSON.stringify(deniedAck), /PERSONAL_HANDOFF_CANARY_82/);
  const ownAck = await mcp.handle({ jsonrpc: '2.0', id: 33, method: 'tools/call', params: { name: 'send_handoff', arguments: {
    to: 'Codex', subject: 'Acknowledged fictional company handoff', body: 'Reviewed within the same profile.', ack_of: sent.result.structuredContent.path, session_or_task_id: 'org-own-ack-1', confirm: true,
  } } });
  assert.equal(ownAck.result.structuredContent.written, true);
  const unassignedPath = path.join(orgPath, 'Handoffs', '2026-10-24-2359-from-legacy-to-all-unassigned.md');
  await writeFile(unassignedPath, '---\ntype: handoff\nhandoff_schema: 1\nstatus: REQUEST\nwritten_at: 2026-10-24T23:59:00+08:00\nto: all\nsubject: Unassigned handoff\n---\n\n# Unassigned handoff\n\nUNASSIGNED_HANDOFF_CANARY_93\n');
  const list = await mcp.handle({ jsonrpc: '2.0', id: 32, method: 'tools/call', params: { name: 'list_handoffs', arguments: { to: 'all' } } });
  assert.equal(list.result.structuredContent.items.length, 1, 'acknowledgements addressed directly to Codex are not in the all inbox');
  assert.match(JSON.stringify(list), /ORG_HANDOFF_CANARY_71/);
  assert.doesNotMatch(JSON.stringify(list), /PERSONAL_HANDOFF_CANARY_82|UNASSIGNED_HANDOFF_CANARY_93/);
  const stored = await readFile(path.join(orgPath, 'Handoffs', path.basename(sent.result.structuredContent.path)), 'utf8');
  assert.match(stored, /twin_profile_id: "org_twin_1"/);
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

test('local Setup assigns an unowned session only to a session-authorized Twin and keeps it private', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-twin-session-assignment-'));
  const home = path.join(root, 'home');
  const vaultPath = path.join(root, 'vault');
  await mkdir(vaultPath);
  const env = { BRAINLINK_HOME: path.join(home, 'app') };
  const cfg = fixture(vaultPath);
  cfg.twin_profiles[0].allowed_actions.push('read_session');
  cfg.twin_profiles[0].agent_access[0].vaults[0].operations.push('read_session');
  await saveConfig(cfg, path.join(env.BRAINLINK_HOME, 'config.json'));
  const store = await openSessionStore(env);
  const source = await store.putSession({ client: 'codex', source_id: 'fictional/assignment', project: '/fictional', title: 'Synthetic handoff', summary: 'Synthetic-only test session.', started_at: '2026-10-24T00:00:00Z', note_refs: [], private: true, messages: [{ role: 'user', at: '2026-10-24T00:00:00Z', text: 'Synthetic private content.' }] });
  const setup = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${setup.port}`;
  const api = async (route, body) => {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'X-BrainLink-Token': setup.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const invalid = await api('/api/sessions/assign-twin', { id: source.id, profile_id: 'missing_profile' });
    assert.equal(invalid.status, 400);
    const assigned = await api('/api/sessions/assign-twin', { id: source.id, profile_id: 'org_twin_1' });
    assert.equal(assigned.status, 200);
    assert.equal(assigned.body.session.profile_id, 'org_twin_1');
    assert.equal(assigned.body.session.private, true);
    const visible = await api('/api/sessions', { include_private: true });
    assert.equal(visible.body.sessions[0].profile_id, 'org_twin_1');
    const repeat = await api('/api/sessions/assign-twin', { id: source.id, profile_id: 'org_twin_1' });
    assert.equal(repeat.status, 400);
    assert.match(repeat.body.error, /already belongs/);
    const owned = await (await openSessionStore(env)).readSession(source.id, { profile_id: 'org_twin_1', limit: 10 });
    assert.equal(owned.messages[0].text, 'Synthetic private content.');
    await assert.rejects((await openSessionStore(env)).readSession(source.id, { profile_id: 'another_twin' }), (error) => error.code === 'E_NOT_FOUND');
  } finally { setup.server.close(); }
});
