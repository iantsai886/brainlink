import test from 'node:test';
import { readSetupHtml } from './helpers/setup-html.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize, validate, saveConfig } from '../src/config.mjs';
import { twinProfileStatus, profileScopeEditable, resolveTwinAgentScope, twinMemoryAllowed } from '../src/twin-profiles.mjs';
import { startSetup } from '../src/setup.mjs';
import { createContext, loadVault, readNote, search } from '../src/core.mjs';
import { createMcp } from '../src/server.mjs';
import { presetGrantActions, presetActionAllowed, twinActionAllowed, formatPresetPermissionSummary } from '../ui/permissions.js';
import { hashToken } from '../src/mcp-agents.mjs';
import { openSessionStore } from '../src/sessions/index.mjs';
import { parse as parseYaml } from 'yaml';

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

// Runtime policy is enforced per vault grant; keep synthetic contexts internally consistent
// when a test changes a permission after token resolution.
function setRuntimeMemoryPolicy(ctx, type, allowed) {
  for (const profile of ctx.twinScope.profiles || []) {
    for (const grant of profile.grants || []) grant.memory_policy[type] = allowed;
  }
  for (const grant of ctx.twinScope.grants || []) grant.memory_policy[type] = allowed;
}

function addTestRole(cfg, name = 'Fictional Operations', vault = 'Fictional Org') {
  cfg.agents ||= [];
  cfg.agents.push({ name, vault, role: 'Synthetic role for authorization tests.', activation: [`Connect to ${name}`], close: [`${name} close loop`], connect_notes: [], tail_notes: [], close_target: { mode: 'proposal-only', path: 'BrainLink/Review.md' } });
  return cfg;
}

async function activateTestRole(mcp, name = 'Fictional Operations') {
  const tools = (await mcp.handle({ jsonrpc: '2.0', id: 'activation-list', method: 'tools/list' })).result.tools;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const tool = tools.find((item) => item.name === 'agent_connect')
    || tools.find((item) => item.name === `agent_connect_${slug}` || String(item.title || '').includes(name));
  assert.ok(tool, `an activation tool for ${name} is available`);
  const args = tool.name === 'agent_connect' ? { agent: name } : {};
  const result = await mcp.handle({ jsonrpc: '2.0', id: 'activation', method: 'tools/call', params: { name: tool.name, arguments: args } });
  assert.equal(result.result?.isError, false, JSON.stringify(result));
  return result;
}

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
  assert.match(validate(duplicateAgent).join('; '), /cannot grant note access to multiple Twin profiles/);
  const sharedNotes = structuredClone(cfg);
  sharedNotes.ai_agents.push({ id: 'agent_personal', name: 'Fictional Personal agent', kind: 'local', tokenHash: hashToken('fictional-personal-token'), connected: true });
  sharedNotes.twin_profiles.push({
    ...structuredClone(cfg.twin_profiles[0]), id: 'personal_profile', name: 'Fictional Personal Twin', mode: 'personal', owner: 'fictional-person',
    agent_access: [{ agent_id: 'agent_personal', vaults: [{ name: 'Fictional Org', access: 'read', operations: ['search', 'read_note'] }] }],
  });
  assert.match(validate(sharedNotes).join('; '), /cannot grant note access to multiple Twin profiles/);
  const revoked = structuredClone(cfg);
  revoked.ai_agents[0].revoked = true;
  assert.match(validate(revoked).join('; '), /unknown or revoked/);
  const invalidMemoryGrant = structuredClone(cfg);
  invalidMemoryGrant.twin_profiles[0].agent_access[0].memory_policy = { working: false, semantic: true, procedural: false };
  assert.match(validate(invalidMemoryGrant).join('; '), /must declare all four memory types/);
  const escalatedMemory = structuredClone(cfg);
  escalatedMemory.twin_profiles[0].agent_access[0].memory_policy = { working: false, semantic: true, procedural: true, episodic: false };
  escalatedMemory.twin_profiles[0].memory_policy.procedural = false;
  assert.match(validate(escalatedMemory).join('; '), /cannot exceed the Twin profile policy/);
});

test('a scoped connection with no grant arrays fails closed instead of crashing tool listing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-twin-malformed-scope-'));
  const vaultPath = path.join(root, 'vault');
  await mkdir(vaultPath);
  const ctx = createContext(fixture(vaultPath), { env: { HOME: root, BRAINLINK_HOME: path.join(root, 'app') } });
  ctx.twinScope = { mode: 'scoped', profile_id: 'malformed-scope', grants: [{ name: 'Fictional Org', operations: ['search', 'read_note'] }] };
  const mcp = createMcp(ctx);
  const listed = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(listed.error, undefined);
  assert.equal(listed.result.tools.some((tool) => ['vault_search', 'vault_read_note', 'propose_note'].includes(tool.name)), false);
  assert.deepEqual(ctx.enabled, [], 'a top-level grant without a nested profile grant is removed from the scoped connection');
  ctx.twinScope = { mode: 'scoped', profiles: [{ profile_id: 'malformed-grant-profile', grants: [{ name: 'Fictional Org' }] }] };
  const malformedGrantMcp = createMcp(ctx);
  const malformedGrantList = await malformedGrantMcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(malformedGrantList.error, undefined, 'a nested grant without operations also fails closed without crashing');
  assert.equal(malformedGrantList.result.tools.some((tool) => ['vault_search', 'vault_read_note', 'propose_note'].includes(tool.name)), false);
});

test('scoped retrieval automatically records only a content-free, profile-owned RSI observation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-twin-rsi-observation-'));
  const vaultPath = path.join(root, 'vault');
  await mkdir(vaultPath);
  const appHome = path.join(root, 'app');
  const cfg = addTestRole(fixture(vaultPath));
  const env = { BRAINLINK_HOME: appHome, HOME: root, BRAINLINK_AGENT_TOKEN: 'fictional-agent-token', BRAINLINK_AI_PLATFORM: 'Fictional Codex', BRAINLINK_SEMANTIC: '0' };
  const mcp = createMcp(createContext(cfg, { env }));
  await activateTestRole(mcp);
  const response = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vault_search', arguments: { vault: 'Fictional Org', query: 'QUESTION_CANARY fictional missing roadmap' } } });
  assert.equal(response.result.structuredContent.status, 'not_in_brain');
  const { createRsiLedger } = await import('../src/rsi-ledger.mjs');
  const ledger = await readFile(createRsiLedger({ home: appHome }).file, 'utf8');
  assert.match(ledger, /retrieval_observation/);
  assert.match(ledger, /org_twin_1/);
  assert.match(ledger, /not_in_brain/);
  assert.doesNotMatch(ledger, /QUESTION_CANARY|fictional missing roadmap|Fictional Org|path|excerpt|answer/i);
});

test('Twin source policy follows vault visibility and requires source confidence and a stable task id', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-twin-source-policy-'));
  const vaultPath = path.join(root, 'vault');
  await mkdir(path.join(vaultPath, 'Inbox'), { recursive: true });
  const cfg = fixture(vaultPath);
  cfg.twin_profiles[0].allowed_actions.push('propose_note');
  cfg.twin_profiles[0].agent_access[0].vaults[0].operations.push('propose_note');
  addTestRole(cfg);
  const env = { BRAINLINK_HOME: path.join(root, 'app'), HOME: root, BRAINLINK_AGENT_TOKEN: 'fictional-agent-token', BRAINLINK_AI_PLATFORM: 'Fictional Codex' };
  const mcp = createMcp(createContext(cfg, { env }));
  await activateTestRole(mcp);
  const tool = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.find((item) => item.name === 'propose_note');
  assert.ok(tool.inputSchema.required.includes('confidence'));
  assert.ok(tool.inputSchema.required.includes('session_or_task_id'));
  assert.match(tool.description, /Visibility follows the selected vault/);
  const guide = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brainlink_guide', arguments: {} } });
  assert.equal(guide.result.structuredContent.twin_profile_scope.profiles[0].source_policy.private_default, true);
  assert.match(guide.result.structuredContent.write_rules.join(' '), /stable session_or_task_id/);
  const missing = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'propose_note', arguments: {
    vault: 'Fictional Org', folder: 'Inbox', title: 'Policy check', body: 'A fictional finding.', source: 'fictional test',
  } } });
  assert.match(missing.result.structuredContent.errors.join(' '), /stable session_or_task_id/);
  assert.match(missing.result.structuredContent.errors.join(' '), /confidence/);
  const preview = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'propose_note', arguments: {
    vault: 'Fictional Org', folder: 'Inbox', title: 'Shared by default', body: 'A fictional finding.', source: 'fictional test',
    confidence: 'reported', session_or_task_id: 'fixture-task-01',
  } } });
  assert.equal(preview.result.structuredContent.written, false);
  assert.doesNotMatch(preview.result.structuredContent.preview, /private:\s*true/i, 'a shared vault proposal must not become private from profile defaults');
  assert.match(preview.result.structuredContent.preview, /session_or_task_id: "fixture-task-01"/);
  const saved = await mcp.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'propose_note', arguments: {
    vault: 'Fictional Org', folder: 'Inbox', title: 'Shared by default', body: 'A fictional finding.', source: 'fictional test',
    confidence: 'reported', session_or_task_id: 'fixture-task-01', confirm: true,
  } } });
  assert.equal(saved.result.structuredContent.written, true);
  const savedNames = await readdir(path.join(vaultPath, 'Inbox'));
  assert.equal(savedNames.length, 1);
  assert.match(savedNames[0], / — Shared by default\.md$/);
  const savedText = await readFile(path.join(vaultPath, 'Inbox', savedNames[0]), 'utf8');
  assert.doesNotMatch(savedText, /private:\s*true/i);
  assert.match(savedText, /twin_profile_id: "org_twin_1"/);
});

test('Twin session capture policy blocks content capture and full text until opted in', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-twin-session-policy-'));
  const vaultPath = path.join(root, 'vault');
  await mkdir(vaultPath);
  const cfg = fixture(vaultPath);
  cfg.twin_profiles[0].allowed_actions.push('read_session', 'log_session', 'propose_note');
  cfg.twin_profiles[0].agent_access[0].vaults[0].operations.push('read_session', 'log_session', 'propose_note');
  addTestRole(cfg);
  const env = { BRAINLINK_HOME: path.join(root, 'app'), HOME: root, BRAINLINK_AGENT_TOKEN: 'fictional-agent-token', BRAINLINK_AI_PLATFORM: 'Fictional Codex' };
  const call = (mcp, name, args, id = 1) => mcp.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

  cfg.twin_profiles[0].source_policy.session_capture = 'metadata-only';
  let mcp = createMcp(createContext(cfg, { env }));
  await activateTestRole(mcp);
  let names = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((item) => item.name);
  assert.ok(!names.includes('session_log'));
  assert.ok(!names.includes('session_close'));
  let denied = await call(mcp, 'session_log', { text: 'FICTIONAL_METADATA_ONLY_CANARY' });
  assert.equal(denied.result.isError, true);
  assert.doesNotMatch(JSON.stringify(denied), /FICTIONAL_METADATA_ONLY_CANARY/);
  denied = await call(mcp, 'session_close', { title: 'Denied close', goal: 'fixture', outcome: 'fixture', session_or_task_id: 'fixture-metadata-only-close' }, 5);
  assert.equal(denied.result.isError, true);

  cfg.twin_profiles[0].source_policy.session_capture = 'summary-proposal';
  mcp = createMcp(createContext(cfg, { env }));
  await activateTestRole(mcp);
  names = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((item) => item.name);
  assert.ok(names.includes('session_log'));
  const store = await openSessionStore(env);
  const own = await store.putSession({ client: 'fictional-capture', source_id: 'own-summary', profile_id: 'org_twin_1', vault: 'Sessions', project: 'Fictional', title: 'Fictional summary', summary: 'Approved fictional summary.', started_at: new Date().toISOString(), private: true, messages: [{ role: 'assistant', at: new Date().toISOString(), text: 'FICTIONAL_FULL_TEXT_CANARY' }] });
  denied = await call(mcp, 'session_read', { id: own.id, full: true }, 2);
  assert.equal(denied.result.isError, true);
  assert.doesNotMatch(JSON.stringify(denied), /FICTIONAL_FULL_TEXT_CANARY/);

  cfg.twin_profiles[0].source_policy.session_capture = 'full-text-opt-in';
  mcp = createMcp(createContext(cfg, { env }));
  await activateTestRole(mcp);
  const full = await call(mcp, 'session_read', { id: own.id, full: true }, 3);
  assert.match(JSON.stringify(full), /FICTIONAL_FULL_TEXT_CANARY/, 'the owning Twin can read full text only after full-text opt-in');
  const imported = await store.putSession({ client: 'codex', source_id: 'imported-full', profile_id: 'org_twin_1', vault: 'Sessions', project: 'Fictional', title: 'Assigned imported session', summary: 'Imported summary.', started_at: new Date().toISOString(), private: true, messages: [{ role: 'assistant', at: new Date().toISOString(), text: 'FICTIONAL_IMPORTED_FULL_CANARY' }] });
  const importedFull = await call(mcp, 'session_read', { id: imported.id, full: true }, 4);
  assert.doesNotMatch(JSON.stringify(importedFull), /FICTIONAL_IMPORTED_FULL_CANARY/);
  assert.match(JSON.stringify(importedFull), /Full message text for this session is private/);
});

test('Twin status shows limited runtime scope and never exposes agent credentials', async () => {
  const status = twinProfileStatus(fixture('C:\\fictional-vault'));
  const cfg = fixture('C:\\fictional-vault');
  assert.equal(status.enforcement, 'scoped_agent_profile_grants');
  assert.equal(status.profiles[0].declaration_status, 'agent_profile_scope_active');
  assert.equal(status.profiles[0].memory_policy_enforcement, 'tools_prompts_resources');
  assert.match(status.next_gate, /Named AI-agent tokens may be assigned to multiple Twin profiles/);
  assert.equal(status.profiles[0].editable_scope, true);
  const scoped = fixture('C:\\fictional-vault');
  scoped.vaults.push({ name: 'Fictional Other', path: 'C:\\fictional-other' });
  scoped.twin_profiles[0].vaults.push({ name: 'Fictional Other', access: 'read' });
  assert.equal(profileScopeEditable(scoped.twin_profiles[0]), true, 'the matrix editor supports an agent scoped to only one of several profile vaults');
  assert.equal(status.profiles[0].agents[0].name, 'Fictional Codex');
  assert.equal(status.profiles[0].agents[0].memory_policy_inherited, true);
  assert.deepEqual(status.profiles[0].agents[0].memory_policy, cfg.twin_profiles[0].memory_policy);
  assert.equal(status.profiles[0].agents[0].vaults[0].operations.includes('write_note'), false);
  assert.doesNotMatch(JSON.stringify(status), /tokenHash|f{64}/);
  const scopedCfg = structuredClone(cfg);
  scopedCfg.twin_profiles[0].agent_access[0].memory_policy = { working: false, semantic: true, procedural: true, episodic: false };
  const resolvedScope = resolveTwinAgentScope(scopedCfg, scopedCfg.ai_agents[0], true);
  assert.deepEqual(resolvedScope.memory_policy, scopedCfg.twin_profiles[0].agent_access[0].memory_policy);
  resolvedScope.grants[0].memory_policy.semantic = false;
  resolvedScope.memory_policy.semantic = true;
  assert.equal(twinMemoryAllowed({ twinScope: resolvedScope }, 'semantic'), false, 'a compatibility summary cannot widen a denied grant');
  scopedCfg.twin_profiles[0].agent_access[0].memory_policy.procedural = false;
  const noProcedural = createMcp(createContext(scopedCfg, { env: { BRAINLINK_AGENT_TOKEN: 'fictional-agent-token' } }));
  const noProceduralTools = await noProcedural.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.equal(noProceduralTools.result.tools.some((tool) => tool.name === 'brainlink_guide'), false);
});

test('preset Twin connection choices expose only granted, memory-enabled operations', async () => {
  const grant = { name: 'Shared', access: 'propose' };
  assert.deepEqual(presetGrantActions(grant), ['search', 'read_note', 'read_session', 'propose_note']);
  assert.deepEqual(presetGrantActions({ name: 'Shared', access: 'read' }), ['search', 'read_note', 'read_session']);
  assert.deepEqual(presetGrantActions({ name: 'Shared', access: 'write' }, { mailboxVault: 'Shared' }), ['search', 'read_note', 'write_note', 'read_session', 'log_session', 'propose_note', 'handoff_read', 'write_handoff']);
  assert.equal(presetActionAllowed({ action: 'propose_note', access: 'propose', memoryPolicy: { semantic: true }, selectedMemory: { semantic: true } }), true);
  assert.equal(presetActionAllowed({ action: 'write_note', access: 'propose', memoryPolicy: { semantic: true }, selectedMemory: { semantic: true } }), false);
  assert.equal(presetActionAllowed({ action: 'search', access: 'write', memoryPolicy: { semantic: true }, selectedMemory: { semantic: false } }), false);
});

test('connection review summarizes only selected profiles and checked per-vault actions', async () => {
  const summary = formatPresetPermissionSummary([
    { profile: 'Organisation', vaults: [{ name: 'Brain', actions: ['search', 'read_note'] }] },
    { profile: 'Unselected', vaults: [] },
  ]);
  assert.equal(summary, 'Organisation: Brain (search, read_note)');
  assert.equal(formatPresetPermissionSummary([]), '');
});

test('Twin permission controls apply both profile-vault and agent-memory ceilings', async () => {
  assert.equal(twinActionAllowed({ action: 'search', access: 'write', memoryPolicy: { semantic: true }, selected: true, profileVaultSelected: true }), true);
  assert.equal(twinActionAllowed({ action: 'search', access: 'write', memoryPolicy: { semantic: false }, selected: true, profileVaultSelected: true }), false);
  assert.equal(twinActionAllowed({ action: 'read_session', access: 'write', memoryPolicy: { episodic: false }, selected: true, profileVaultSelected: true }), false);
  assert.equal(twinActionAllowed({ action: 'propose_note', access: 'read', memoryPolicy: { semantic: true }, selected: true, profileVaultSelected: true }), false);
  assert.equal(twinActionAllowed({ action: 'search', access: 'write', memoryPolicy: { semantic: true }, selected: true, profileVaultSelected: false }), false);
});
test('Twin memory shortcut copies its ceiling only to selected agents and waits for normal review/save', async () => {
  const html = await readSetupHtml();
  const start = html.indexOf('function twinActionMemoryAllowed(action, policy) {');
  const end = html.indexOf("$('twin-apply-memory-to-agents').addEventListener", start);
  assert.ok(start >= 0 && end > start, 'memory copy helper is in the setup permission flow');
  const ceilings = ['working', 'semantic', 'procedural', 'episodic'].map((key) => ({
    dataset: { twinMemory: key }, checked: ['semantic', 'procedural'].includes(key),
  }));
  const agents = ['agent-a', 'agent-b'].map((id) => ({ dataset: { twinAgent: id } }));
  const agentMemory = ['agent-a', 'agent-b', 'not-selected'].flatMap((agent) => ['working', 'semantic', 'procedural', 'episodic'].map((type) => ({
    dataset: { twinAgentMemory: agent, memoryType: type }, checked: false, disabled: false,
  })));
  const operations = [];
  const document = { querySelectorAll(selector) {
    if (selector === '[data-twin-agent]:checked') return agents;
    if (selector === '[data-twin-memory]') return ceilings;
    if (selector === '[data-twin-agent-memory]') return agentMemory;
    if (selector === '[data-twin-operation]') return operations;
    throw new Error(`Unexpected selector: ${selector}`);
  } };
  const notices = [];
  const helpers = new Function('document', 'toast', 't', `${html.slice(start, end)}; return { updateTwinPermissionControls, copyTwinMemoryToSelectedAgents };`)(
    document, (message, bad) => notices.push({ message, bad }), (key) => key,
  );

  assert.equal(helpers.copyTwinMemoryToSelectedAgents(), true);
  for (const id of ['agent-a', 'agent-b']) {
    const selected = agentMemory.filter((item) => item.dataset.twinAgentMemory === id);
    assert.deepEqual(selected.map((item) => item.checked), [false, true, true, false]);
    assert.deepEqual(selected.map((item) => item.disabled), [true, false, false, true]);
  }
  assert.deepEqual(agentMemory.filter((item) => item.dataset.twinAgentMemory === 'not-selected').map((item) => item.checked), [false, false, false, false]);
  assert.equal(notices.at(-1).message, 'twinProfiles.applyMemoryToAgentsDone');
  assert.equal(notices.at(-1).bad, undefined);
  assert.match(html, /id="twin-apply-memory-to-agents"[^>]*data-i18n="twinProfiles\.applyMemoryToAgents"/);
  assert.match(html, /twin-apply-memory-to-agents'\)\.addEventListener\('click', copyTwinMemoryToSelectedAgents\)/);
  agents.length = 0;
  assert.equal(helpers.copyTwinMemoryToSelectedAgents(), false);
  assert.deepEqual(notices.at(-1), { message: 'twinProfiles.applyMemoryToAgentsSelect', bad: true });
});

test('Twin setup explains all four memory switches in every supported language', async () => {
  const html = await readSetupHtml();
  assert.match(html, /twinProfiles\.memoryDescription\.' \+ key/, 'each checkbox renders its matching short explanation');
  const catalogs = {};
  for (const locale of ['en', 'pt', 'zh-TW']) {
    catalogs[locale] = JSON.parse(await readFile(new URL(`../ui/locales/${locale}.json`, import.meta.url), 'utf8'));
    for (const type of ['working', 'semantic', 'procedural', 'episodic']) {
      assert.ok(catalogs[locale][`twinProfiles.memoryDescription.${type}`], `${locale} ${type} description`);
    }
    for (const key of ['applyMemoryToAgents', 'applyMemoryToAgentsHint', 'applyMemoryToAgentsSelect', 'applyMemoryToAgentsDone']) {
      assert.ok(catalogs[locale][`twinProfiles.${key}`], `${locale} ${key} text`);
    }
  }
  assert.match(catalogs.en['twinProfiles.memoryDescription.procedural'], /role instructions.*Skills/i);
  assert.match(catalogs.en['twinProfiles.memoryDescription.procedural'], /requires procedural access/i);
  assert.match(catalogs.pt['twinProfiles.memoryDescription.procedural'], /instruções de função.*Skills/i);
  assert.match(catalogs.pt['twinProfiles.memoryDescription.procedural'], /exigem acesso procedural/i);
  assert.match(catalogs['zh-TW']['twinProfiles.memoryDescription.procedural'], /角色指示.*Skills/);
  assert.match(catalogs['zh-TW']['twinProfiles.memoryDescription.procedural'], /需要程序記憶權限/);
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
  addTestRole(cfg, 'Fictional Operations', 'Fictional Org');
  cfg.vaults.push({ name: 'Fictional Personal', path: personalPath, private: true });
  const ctx = createContext(cfg, { env: { BRAINLINK_AGENT_TOKEN: 'fictional-agent-token' } });
  assert.deepEqual(ctx.enabled, ['Fictional Org']);
  assert.equal(ctx.twinScope.mode, 'scoped');
  const mcp = createMcp(ctx);
  await activateTestRole(mcp);
  assert.match(mcp.instructions, /if brainlink_guide is listed and permitted/i);
  assert.match(mcp.instructions, /do not retry or ask to widen access/);
  const listed = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = listed.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('vault_search'));
  assert.ok(names.includes('context_packet'), 'context packets follow the same semantic search grant');
  assert.ok(names.includes('vault_read_note'));
  assert.ok(names.includes('ingestion_queue'), 'source scanning follows the profile search grant');
  assert.ok(names.includes('ingestion_read_source'), 'source reading is available when the profile grants read_note');
  assert.ok(!names.includes('ingestion_record'), 'filing receipts require a separate propose_note grant');
  assert.deepEqual(names.includes('vault_search') && listed.result.tools.find((tool) => tool.name === 'vault_search').inputSchema.properties.vault.enum, ['Fictional Org']);
  assert.ok(!names.includes('propose_note'));
  assert.ok(!names.includes('session_list'));
  assert.ok(!names.includes('session_log'), 'session logging is hidden without its separate grant');
  assert.ok(!names.includes('send_handoff'));
  const noReadCfg = structuredClone(cfg);
  noReadCfg.twin_profiles[0].agent_access[0].vaults[0].operations = noReadCfg.twin_profiles[0].agent_access[0].vaults[0].operations.filter((operation) => operation !== 'read_note');
  const noReadMcp = createMcp(createContext(noReadCfg, { env: { BRAINLINK_AGENT_TOKEN: 'fictional-agent-token' } }));
  const noReadTools = (await noReadMcp.handle({ jsonrpc: '2.0', id: 13, method: 'tools/list' })).result.tools.map((tool) => tool.name);
  assert.ok(!noReadTools.includes('ingestion_read_source'), 'source reading is hidden when read_note is not granted');
  const promptList = await mcp.handle({ jsonrpc: '2.0', id: 5, method: 'prompts/list' });
  assert.deepEqual(promptList.result.prompts.map((prompt) => prompt.name), ['connect-fictional-operations', 'brief']);
  const resources = await mcp.handle({ jsonrpc: '2.0', id: 7, method: 'resources/list' });
  assert.ok(resources.result.resources.some((resource) => resource.uri === 'brainlink://guide'));
  assert.ok(resources.result.resources.every((resource) => !resource.uri.includes('Fictional%20Personal')));
  const guideResource = await mcp.handle({ jsonrpc: '2.0', id: 8, method: 'resources/read', params: { uri: 'brainlink://guide' } });
  const scopedGuide = JSON.parse(guideResource.result.contents[0].text);
  assert.deepEqual(scopedGuide.server.enabled_vaults, ['Fictional Org']);
  assert.equal(scopedGuide.twin_profile_scope.writes_available, false);
  assert.equal(scopedGuide.twin_profile_scope.note_proposals_available, false);
  assert.deepEqual(scopedGuide.twin_profile_scope.proposal_vaults, []);
  assert.match(scopedGuide.write_rules.join(' '), /Note saves are proposal-only/);
  assert.doesNotMatch(guideResource.result.contents[0].text, /Fictional Personal|TWIN_PERSONAL_CANARY_77/);
  const guide = await mcp.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'brainlink_guide', arguments: {} } });
  assert.equal(guide.result.structuredContent.twin_profile_scope.profiles[0].id, 'org_twin_1');
  assert.equal(guide.result.structuredContent.twin_profile_scope.writes_available, false);
  assert.deepEqual(guide.result.structuredContent.twin_profile_scope.profiles[0].memory_policy, cfg.twin_profiles[0].memory_policy);
  const deniedSessionPrompt = await mcp.handle({ jsonrpc: '2.0', id: 9, method: 'prompts/get', params: { name: 'close-session' } });
  assert.ok(deniedSessionPrompt.error);
  const deniedRawPrompt = await mcp.handle({ jsonrpc: '2.0', id: 10, method: 'prompts/get', params: { name: 'organize-sources', arguments: { vault: 'Fictional Org', folder: 'Raw' } } });
  assert.ok(deniedRawPrompt.error, 'read-only scoped clients cannot get a prompt that prepares knowledge writes');
  const deniedVault = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'vault_search', arguments: { vault: 'Fictional Personal', query: 'TWIN_PERSONAL_CANARY_77' } } });
  assert.equal(deniedVault.result.isError, true);
  assert.doesNotMatch(JSON.stringify(deniedVault), /TWIN_PERSONAL_CANARY_77|Private\.md/);
  const deniedWrite = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'propose_note', arguments: { vault: 'Fictional Org', title: 'No write', body: 'Should stay blocked', source: 'test' } } });
  assert.equal(deniedWrite.result.isError, true);
  assert.match(deniedWrite.result.content[0].text, /does not allow propose_note/);
  const deniedSession = await mcp.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'session_list', arguments: {} } });
  assert.equal(deniedSession.result.isError, true);
  assert.match(deniedSession.result.content[0].text, /No Twin profile grants session history access/);
  const deniedLog = await mcp.handle({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'session_log', arguments: { text: 'must stay blocked' } } });
  assert.equal(deniedLog.result.isError, true);
  assert.match(deniedLog.result.content[0].text, /does not allow log_session/);
  const filingCfg = structuredClone(cfg);
  filingCfg.twin_profiles[0].agent_access[0].vaults[0].access = 'propose';
  filingCfg.twin_profiles[0].agent_access[0].vaults[0].operations.push('propose_note');
  filingCfg.twin_profiles[0].agent_access[0].vaults[0].operations.push('read_note');
  const filingMcp = createMcp(createContext(filingCfg, { env: { BRAINLINK_AGENT_TOKEN: 'fictional-agent-token' } }));
  const filingTools = filingMcp.tools.map((tool) => tool.name);
  assert.ok(filingTools.includes('ingestion_read_source'), 'source reading follows an explicit read_note grant');
  assert.ok(filingTools.includes('ingestion_record'), 'filing receipts appear only after an explicit propose_note grant');
  assert.ok(filingTools.includes('propose_note'));
  const filingGuide = await filingMcp.handle({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'brainlink_guide', arguments: {} } });
  assert.equal(filingGuide.result.structuredContent.twin_profile_scope.writes_available, false);
  assert.equal(filingGuide.result.structuredContent.twin_profile_scope.note_proposals_available, true);
  assert.deepEqual(filingGuide.result.structuredContent.twin_profile_scope.proposal_vaults, ['Fictional Org']);
  assert.match(filingGuide.result.structuredContent.write_rules.join(' '), /each note requires separate user approval/);
  const unassigned = createContext(cfg, { env: { BRAINLINK_AGENT_TOKEN: 'unknown-token' } });
  assert.deepEqual(unassigned.enabled, []);
  assert.equal(unassigned.twinScope.mode, 'unassigned');
});

test('active Anna and John scopes route search and fetch without caller-carried scope IDs', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-active-role-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const orgPath = path.join(root, 'brain');
  const personalPath = path.join(root, 'personal');
  await mkdir(orgPath);
  await mkdir(personalPath);
  await writeFile(path.join(orgPath, 'Company note.md'), '# Brain note\n\nShared organisation information.\n');
  await writeFile(path.join(personalPath, 'Personal note.md'), '# Private note\n\nJOHN_PRIVATE_SCOPE_CANARY.\n');
  const cfg = fixture(orgPath);
  cfg.vaults.push({ name: 'Ian Personal', path: personalPath, private: true, writes: 'proposal-only' });
  cfg.twin_profiles.push({
    id: 'personal_twin_2', name: 'Ian Personal Twin', mode: 'personal', owner: 'fictional-person',
    vaults: [{ name: 'Ian Personal', access: 'read' }],
    source_policy: { private_default: true, provenance_required: true, session_capture: 'metadata-only' },
    memory_policy: { working: true, semantic: true, procedural: true, episodic: true },
    allowed_actions: ['search', 'read_note'],
    agent_access: [{ agent_id: 'agent_codex', vaults: [{ name: 'Ian Personal', access: 'read', operations: ['search', 'read_note'] }] }],
  });
  cfg.agents = [
    { name: 'Anna', vault: 'Fictional Org', role: 'Company role', activation: ['Connect to Anna'], close: ['Anna close loop'], connect_notes: [], tail_notes: [], close_target: { mode: 'new-note', dir: 'Inbox' } },
    { name: 'John', vault: 'Ian Personal', role: 'Private finance role', activation: ['Connect to John'], close: ['John close loop'], connect_notes: [], tail_notes: [], close_target: { mode: 'new-note', dir: 'Inbox' } },
  ];
  const env = { HOME: root, BRAINLINK_HOME: path.join(root, 'app'), BRAINLINK_AGENT_TOKEN: 'fictional-agent-token', BRAINLINK_AI_PLATFORM: 'Fictional Claude', BRAINLINK_SEMANTIC: '0' };
  const mcp = createMcp(createContext(cfg, { env }));
  const call = async (name, args = {}) => mcp.handle({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } });
  const listed = (await mcp.handle({ jsonrpc: '2.0', id: 0, method: 'tools/list' })).result.tools;
  for (const name of ['vault_search', 'vault_read_note', 'search', 'fetch']) {
    assert.ok(!listed.find((tool) => tool.name === name).inputSchema.required?.includes('role_scope_id'), `${name} does not force a brittle scope-ID argument`);
  }

  const anna = await call('agent_connect_anna');
  assert.equal(anna.result.structuredContent.active_role_scope.vault, 'Fictional Org');
  const annaSearch = await call('vault_search', { vault: 'Fictional Org', query: 'organisation information' });
  assert.match(JSON.stringify(annaSearch), /Shared organisation information/);
  const compatSearch = await call('search', { query: 'Shared organisation information' });
  const results = compatSearch.result.structuredContent.results;
  assert.equal(results.length, 1);
  assert.match(results[0].id, /^Fictional Org::/);
  const compatFetch = await call('fetch', { id: results[0].id });
  assert.match(JSON.stringify(compatFetch), /Shared organisation information/);
  assert.doesNotMatch(JSON.stringify(compatSearch), /JOHN_PRIVATE_SCOPE_CANARY/);

  const john = await call('agent_connect_john');
  assert.equal(john.result.structuredContent.active_role_scope.vault, 'Ian Personal');
  const johnSearch = await call('search', { query: 'JOHN_PRIVATE_SCOPE_CANARY' });
  assert.equal(johnSearch.result.structuredContent.results.length, 1, 'the explicitly granted active role can use connector-compatible search in its private vault');
  assert.match(johnSearch.result.structuredContent.results[0].id, /^Ian Personal::/);
  const staleAnnaScope = await call('vault_search', { vault: 'Fictional Org', query: 'Shared organisation information', role_scope_id: anna.result.structuredContent.role_scope_id });
  assert.equal(staleAnnaScope.result.isError, true, 'switching roles revokes the previous role scope');
  assert.doesNotMatch(JSON.stringify(staleAnnaScope), /Shared organisation information/);
});

test('profile-scoped agents can save only private session notes owned by their Twin', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-twin-session-log-'));
  const vaultPath = path.join(root, 'org');
  const brainHome = path.join(root, 'brainlink-home');
  await mkdir(vaultPath);
  const cfg = fixture(vaultPath);
  cfg.twin_profiles[0].allowed_actions.push('log_session');
  cfg.twin_profiles[0].agent_access[0].vaults[0].operations.push('log_session');
  addTestRole(cfg);
  const env = { BRAINLINK_HOME: brainHome, HOME: root, BRAINLINK_AGENT_TOKEN: 'fictional-agent-token', BRAINLINK_AI_PLATFORM: 'Codex' };
  const mcp = createMcp(createContext(cfg, { env }));
  await activateTestRole(mcp);
  const listed = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.ok(listed.result.tools.some((tool) => tool.name === 'session_log'));
  const scope = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'brainlink_guide', arguments: {} } });
  assert.equal(scope.result.structuredContent.twin_profile_scope.session_logging_available, true);
  const logged = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_log', arguments: { title: 'Fictional private work', text: 'Finished a fictional project.', private: false } } });
  assert.notEqual(logged.result.isError, true);
  const record = JSON.parse(logged.result.content[0].text);
  const store = await openSessionStore(env);
  const listedSessions = await store.listSessions({ profile_id: 'org_twin_1', limit: 20 });
  assert.equal(listedSessions.length, 1);
  assert.equal(listedSessions[0].id, record.id);
  assert.equal(listedSessions[0].profile_id, 'org_twin_1');
  assert.equal(listedSessions[0].private, true, 'the agent cannot override the forced private flag');

  const foreign = await store.appendSession({ client: 'other-agent', source_id: 'foreign-profile-session', vault: 'Sessions', profile_id: 'different_twin', private: true }, [{ role: 'note', text: 'Foreign private content.' }], { profile_id: 'different_twin' });
  const deniedAppend = await mcp.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'session_log', arguments: { session_id: foreign.id, text: 'attempted cross-profile append' } } });
  assert.equal(deniedAppend.result.isError, true);
  assert.doesNotMatch(JSON.stringify(deniedAppend), /Foreign private content/);
  const after = await store.readSession(foreign.id, { profile_id: 'different_twin', offset: 0, limit: 5 });
  assert.equal(after.session.message_count, 1, 'the denied append did not alter the foreign session');
});

test('scoped source organization prompt requires every read, search, write, and receipt grant', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-twin-raw-prompt-'));
  const vaultPath = path.join(root, 'org');
  await mkdir(path.join(vaultPath, 'Raw'), { recursive: true });
  const cfg = fixture(vaultPath);
  cfg.twin_profiles[0].vaults[0].access = 'propose';
  const grant = cfg.twin_profiles[0].agent_access[0].vaults[0];
  grant.access = 'propose';
  grant.operations.push('propose_note');
  const context = () => createContext(cfg, { env: { BRAINLINK_AGENT_TOKEN: 'fictional-agent-token' } });
  const mcp = createMcp(context());
  const list = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'prompts/list' });
  assert.ok(list.result.prompts.some((prompt) => prompt.name === 'organize-sources'));
  const got = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'organize-sources', arguments: { vault: 'Fictional Org', folder: 'Raw' } } });
  assert.match(got.result.messages[0].content.text, /exact requested vault is "Fictional Org" and folder is "Raw"/);
  assert.doesNotMatch(got.result.messages[0].content.text, /Fictional Personal/);

  const readOnly = structuredClone(cfg);
  readOnly.twin_profiles[0].agent_access[0].vaults[0].operations = readOnly.twin_profiles[0].agent_access[0].vaults[0].operations.filter((operation) => operation !== 'propose_note');
  const readOnlyMcp = createMcp(createContext(readOnly, { env: { BRAINLINK_AGENT_TOKEN: 'fictional-agent-token' } }));
  const hidden = await readOnlyMcp.handle({ jsonrpc: '2.0', id: 3, method: 'prompts/list' });
  assert.ok(!hidden.result.prompts.some((prompt) => prompt.name === 'organize-sources'));
  const denied = await readOnlyMcp.handle({ jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: 'organize-sources', arguments: { vault: 'Fictional Org', folder: 'Raw' } } });
  assert.ok(denied.error);

  const noGuide = structuredClone(cfg);
  noGuide.twin_profiles[0].memory_policy.procedural = false;
  const noGuideMcp = createMcp(createContext(noGuide, { env: { BRAINLINK_AGENT_TOKEN: 'fictional-agent-token' } }));
  const noGuidePrompts = await noGuideMcp.handle({ jsonrpc: '2.0', id: 5, method: 'prompts/list' });
  assert.ok(!noGuidePrompts.result.prompts.some((prompt) => prompt.name === 'organize-sources'), 'a prompt that requires the guide is hidden when procedural memory is disabled');
});

test('configured Twin profiles fail closed for preset and anonymous MCP connections', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-twin-anonymous-'));
  const orgPath = path.join(root, 'org');
  const privatePath = path.join(root, 'private');
  await mkdir(orgPath);
  await mkdir(privatePath);
  await writeFile(path.join(orgPath, 'Public.md'), 'Fictional organisation information.');
  await writeFile(path.join(privatePath, 'Private.md'), 'TWIN_UNASSIGNED_PRIVATE_CANARY');
  const cfg = fixture(orgPath);
  cfg.vaults.push({ name: 'Fictional Private', path: privatePath, private: true });

  const ctx = createContext(cfg, { env: { BRAINLINK_AI_PLATFORM: 'Claude Desktop' } });
  assert.equal(ctx.twinScope.mode, 'unassigned');
  assert.deepEqual(ctx.enabled, []);
  const mcp = createMcp(ctx);
  const listed = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(listed.result.tools, []);
  const denied = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'vault_search', arguments: { vault: 'Fictional Private', query: 'canary' } } });
  assert.ok(denied.error || denied.result?.isError);
  assert.doesNotMatch(JSON.stringify(denied), /TWIN_UNASSIGNED_PRIVATE_CANARY/);

  const local = createContext(cfg, { env: {}, trustedLocal: true });
  assert.equal(local.twinScope.mode, 'legacy');
  assert.deepEqual(local.enabled, ['Fictional Org', 'Fictional Private']);
});

test('Twin memory policy blocks disabled types at tool, prompt and resource boundaries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-twin-memory-policy-'));
  const vaultPath = path.join(root, 'org');
  await mkdir(vaultPath, { recursive: true });
  await writeFile(path.join(vaultPath, 'Public.md'), 'Fictional semantic content.');
  await writeFile(path.join(vaultPath, 'Policy.md'), 'PROCEDURAL_POLICY_CANARY_61');

  const cases = [
    { type: 'working', tool: 'send_handoff' },
    { type: 'semantic', tool: 'vault_search', prompt: 'brief', args: { vault: 'Fictional Org', query: 'Fictional semantic content' } },
    { type: 'procedural', tool: 'brainlink_guide', resource: 'brainlink://vault/Fictional%20Org/Policy.md' },
    { type: 'episodic', tool: 'session_list', prompt: 'close-session' },
  ];
  for (const item of cases) {
    const cfg = fixture(vaultPath);
    cfg.vaults[0].read_first = ['Policy.md'];
    cfg.twin_profiles[0].memory_policy[item.type] = false;
    addTestRole(cfg, 'Chief of Staff', 'Fictional Org');
    if (item.type === 'working') {
      cfg.handoff = { vault: 'Fictional Org', folder: 'Handoffs' };
      cfg.twin_profiles[0].allowed_actions.push('write_handoff');
      cfg.twin_profiles[0].agent_access[0].vaults[0].access = 'propose';
      cfg.twin_profiles[0].agent_access[0].vaults[0].operations.push('write_handoff');
    }
    if (item.type === 'episodic') {
      cfg.twin_profiles[0].allowed_actions.push('read_session');
      cfg.twin_profiles[0].agent_access[0].vaults[0].operations.push('read_session');
    }
    assert.deepEqual(validate(cfg), [], `${item.type} policy fixture remains valid`);
    const ctx = createContext(cfg, { env: { BRAINLINK_HOME: path.join(root, `app-${item.type}`), BRAINLINK_AGENT_TOKEN: 'fictional-agent-token', BRAINLINK_SEMANTIC: '0' } });
    const mcp = createMcp(ctx);
    await activateTestRole(mcp, 'Chief of Staff');
    const init = await mcp.handle({ jsonrpc: '2.0', id: 5, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    const enabledTypes = ['working', 'semantic', 'procedural', 'episodic'].filter((type) => type !== item.type).join(', ');
    assert.ok(init.result.instructions.includes(`MEMORY TYPES ENABLED FOR THIS CONNECTION: ${enabledTypes}.`), `${item.type} stays out of this connection's memory guidance`);
    const listed = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.ok(!listed.result.tools.some((tool) => tool.name === item.tool), `${item.type} tool is not advertised`);
    const denied = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: item.tool, arguments: item.args || {} } });
    assert.equal(denied.result.isError, true, `${item.type} call is denied even if sent directly`);
    assert.match(denied.result.content[0].text, item.type === 'working'
      ? /does not allow working memory/
      : new RegExp(`does not allow ${item.type} memory`));
    assert.doesNotMatch(JSON.stringify(denied), /Fictional semantic content|PROCEDURAL_POLICY_CANARY_61/);

    if (item.prompt) {
      const prompts = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'prompts/list' });
      assert.ok(!prompts.result.prompts.some((prompt) => prompt.name === item.prompt), `${item.type} prompt is hidden`);
      assert.ok(!prompts.result.prompts.some((prompt) => prompt.name === 'review-session'), 'session review prompt is hidden when episodic memory is disabled');
    }

    if (item.type === 'procedural') {
      const resources = await mcp.handle({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
      assert.deepEqual(resources.result.resources, []);
      const read = await mcp.handle({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: item.resource } });
      assert.match(read.error.message, /does not allow procedural memory/);
      assert.doesNotMatch(JSON.stringify(read), /PROCEDURAL_POLICY_CANARY_61/);
      const prompts = await mcp.handle({ jsonrpc: '2.0', id: 6, method: 'prompts/list' });
      assert.ok(prompts.result.prompts.some((prompt) => prompt.name.startsWith('connect-')), 'role activation instructions remain available without procedural note access');
    }
  }
});

test('review-session prompt requires scoped session read and approved closeout tools', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-review-session-prompt-'));
  const vaultPath = path.join(root, 'org');
  await mkdir(vaultPath, { recursive: true });
  const cfg = fixture(vaultPath);
  const env = { BRAINLINK_HOME: path.join(root, 'app'), BRAINLINK_AGENT_TOKEN: 'fictional-agent-token', BRAINLINK_SEMANTIC: '0' };
  const hidden = createMcp(createContext(cfg, { env }));
  let prompts = await hidden.handle({ jsonrpc: '2.0', id: 1, method: 'prompts/list' });
  assert.ok(!prompts.result.prompts.some((prompt) => prompt.name === 'review-session'));
  const denied = await hidden.handle({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'review-session' } });
  assert.ok(denied.error);

  cfg.twin_profiles[0].allowed_actions.push('read_session', 'propose_note');
  const grant = cfg.twin_profiles[0].agent_access[0].vaults[0];
  grant.access = 'propose';
  grant.operations.push('read_session', 'propose_note');
  assert.deepEqual(validate(cfg), [], 'explicit read and close permissions remain a valid profile');
  const scoped = createMcp(createContext(cfg, { env }));
  const tools = (await scoped.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).result.tools.map((tool) => tool.name);
  assert.ok(tools.includes('session_list'));
  assert.ok(tools.includes('session_read'));
  assert.ok(tools.includes('session_close'));
  prompts = await scoped.handle({ jsonrpc: '2.0', id: 4, method: 'prompts/list' });
  assert.ok(prompts.result.prompts.some((prompt) => prompt.name === 'review-session'));
  const allowed = await scoped.handle({ jsonrpc: '2.0', id: 5, method: 'prompts/get', params: { name: 'review-session', arguments: { session_id: 'fictional-session-1' } } });
  assert.match(allowed.result.messages[0].content.text, /fictional-session-1/);
  assert.match(allowed.result.messages[0].content.text, /never try to bypass the setting/);
});

test('semantic vault tools exclude documents assigned to disabled memory types', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-twin-memory-index-'));
  const vaultPath = path.join(root, 'org');
  await mkdir(path.join(vaultPath, 'Office'), { recursive: true });
  await mkdir(path.join(vaultPath, 'Handoffs'), { recursive: true });
  await writeFile(path.join(vaultPath, 'Knowledge.md'), '# Knowledge\n\nSEMANTIC_CANARY stays visible.');
  await writeFile(path.join(vaultPath, 'Policy.md'), '# Policy\n\nPROCEDURAL_CANARY must be hidden when procedural is off.');
  await writeFile(path.join(vaultPath, 'Working.md'), '# Working\n\nWORKING_CANARY must be hidden when working is off.');
  await writeFile(path.join(vaultPath, 'Handoffs', 'Request.md'), '---\ntype: handoff\nstatus: REQUEST\n---\n# Request\n\nHANDOFF_CANARY must be hidden when working is off.');
  await writeFile(path.join(vaultPath, 'Office', 'Captures.md'), '# Captures\n\nEPISODIC_CAPTURE_CANARY must be hidden when episodic is off.');
  await writeFile(path.join(vaultPath, 'Episode.md'), '---\ntype: episode\nstatus: proposed\n---\n# Episode\n\nEPISODE_CANARY must be hidden when episodic is off.');

  const cfg = fixture(vaultPath);
  cfg.vaults[0].read_first = ['Policy.md'];
  cfg.handoff = { vault: 'Fictional Org', folder: 'Handoffs' };
  const canaries = {
    procedural: ['PROCEDURAL_CANARY'],
    working: ['WORKING_CANARY', 'HANDOFF_CANARY'],
    episodic: ['EPISODIC_CAPTURE_CANARY', 'EPISODE_CANARY'],
  };
  cfg.agents = [{ name: 'Fictional Operations', vault: 'Fictional Org', role: 'Synthetic role', activation: ['Connect to Operations'], close: ['Operations close loop'], connect_notes: ['Policy.md'], tail_notes: ['Working.md'], close_target: { mode: 'append-section', path: 'Office/Captures.md' }, stale_days: 30 }];
  for (const disabled of Object.keys(canaries)) {
    const ctx = createContext(cfg, { env: { BRAINLINK_AGENT_TOKEN: 'fictional-agent-token', BRAINLINK_SEMANTIC: '0' } });
    setRuntimeMemoryPolicy(ctx, disabled, false);
    const mcp = createMcp(ctx);
    await activateTestRole(mcp);
    const call = (name, args) => mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const search = await call('vault_search', { vault: 'Fictional Org', query: canaries[disabled].join(' ') });
    assert.equal(search.result.isError, false, JSON.stringify(search));
    const searchText = JSON.stringify(search.result.structuredContent);
    for (const marker of canaries[disabled]) assert.doesNotMatch(searchText, new RegExp(marker), `${marker} must not enter the semantic search index`);
    const packet = await call('context_packet', { vault: 'Fictional Org', query: canaries[disabled].join(' ') });
    assert.equal(packet.result.isError, false, JSON.stringify(packet));
    for (const marker of canaries[disabled]) assert.doesNotMatch(JSON.stringify(packet.result.structuredContent), new RegExp(marker), `${marker} must not enter a context packet`);
    const semantic = await call('vault_search', { vault: 'Fictional Org', query: 'SEMANTIC_CANARY' });
    assert.match(JSON.stringify(semantic.result.structuredContent), /Knowledge\.md|SEMANTIC_CANARY/, 'semantic knowledge remains searchable');

    const hiddenPaths = {
      procedural: ['Policy.md'],
      working: ['Working.md', 'Handoffs/Request.md'],
      episodic: ['Office/Captures.md', 'Episode.md'],
    }[disabled];
    for (const notePath of hiddenPaths) {
      const read = await call('vault_read_note', { vault: 'Fictional Org', path: notePath });
      assert.equal(read.result.isError, true, `${notePath} is not directly readable through semantic tools`);
      assert.doesNotMatch(JSON.stringify(read), /PROCEDURAL_CANARY|WORKING_CANARY|HANDOFF_CANARY|EPISODIC_CAPTURE_CANARY|EPISODE_CANARY/);
    }

    for (const [tool, args] of [
      ['vault_recent', { vault: 'Fictional Org', days: 365 }],
      ['open_loops', { vault: 'Fictional Org', days: 365 }],
      ['brain_brief', { vault: 'Fictional Org', days: 90 }],
      ['vault_health', { vault: 'Fictional Org' }],
      ['vault_related', { vault: 'Fictional Org', path: 'Knowledge.md' }],
    ]) {
      const result = await call(tool, args);
      assert.equal(result.result.isError, false, `${tool} remains available for enabled semantic memory`);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(canaries[disabled].join('|')), `${tool} must not expose disabled memory content`);
    }
  }
});

test('semantic-only agents cannot search or directly read typed operating manuals or Skills', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-twin-procedural-types-'));
  const vaultPath = path.join(root, 'org');
  await mkdir(vaultPath, { recursive: true });
  await writeFile(path.join(vaultPath, 'Knowledge.md'), '# Knowledge\n\nSEMANTIC_TYPE_CANARY is ordinary shared knowledge.');
  await writeFile(path.join(vaultPath, 'Malformed memory.md'), '---\nmemory_type: unrestricted\n---\n# Malformed\n\nMALFORMED_MEMORY_CANARY must fail closed.');
  await writeFile(path.join(vaultPath, 'Untyped memory.md'), '# Untyped\n\nUNTYPED_MEMORY_CANARY defaults to semantic knowledge.');
  await writeFile(path.join(vaultPath, 'Anna Manual.md'), '---\ntype: operating-manual\ntags:\n  - company-role\n---\n# Anna\n\nPROCEDURAL_MANUAL_CANARY is private to agents with procedural permission.');
  await writeFile(path.join(vaultPath, 'Handoff Skill.md'), '---\ntags: [agent-skill]\n---\n# Handoff Skill\n\nPROCEDURAL_SKILL_CANARY is private to agents with procedural permission.');
  await writeFile(path.join(vaultPath, 'Session Summary Type.md'), '---\ntype: session_summary\n---\n# Session Summary\n\nEPISODIC_TYPE_CANARY is private to agents with episodic permission.');
  await writeFile(path.join(vaultPath, 'Session Summary Tag.md'), '---\ntags: [session_summary]\n---\n# Session Summary Tag\n\nEPISODIC_TAG_CANARY is private to agents with episodic permission.');
  const cfg = fixture(vaultPath);
  addTestRole(cfg);
  const ctx = createContext(cfg, { env: { BRAINLINK_AGENT_TOKEN: 'fictional-agent-token' } });
  setRuntimeMemoryPolicy(ctx, 'procedural', false);
  setRuntimeMemoryPolicy(ctx, 'episodic', false);
  let mcp = createMcp(ctx);
  await activateTestRole(mcp);
  const call = (name, args) => mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const query = 'SEMANTIC_TYPE_CANARY PROCEDURAL_MANUAL_CANARY PROCEDURAL_SKILL_CANARY EPISODIC_TYPE_CANARY EPISODIC_TAG_CANARY MALFORMED_MEMORY_CANARY UNTYPED_MEMORY_CANARY';
  const search = await call('vault_search', { vault: 'Fictional Org', query });
  assert.equal(search.result.isError, false);
  assert.match(JSON.stringify(search.result.structuredContent), /Knowledge\.md|SEMANTIC_TYPE_CANARY/);
  assert.doesNotMatch(JSON.stringify(search.result.structuredContent), /PROCEDURAL_MANUAL_CANARY|PROCEDURAL_SKILL_CANARY|EPISODIC_TYPE_CANARY|EPISODIC_TAG_CANARY|MALFORMED_MEMORY_CANARY/);
  const packet = await call('context_packet', { vault: 'Fictional Org', query });
  assert.equal(packet.result.isError, false);
  assert.match(JSON.stringify(packet.result.structuredContent), /Knowledge\.md|SEMANTIC_TYPE_CANARY/);
  assert.doesNotMatch(JSON.stringify(packet.result.structuredContent), /PROCEDURAL_MANUAL_CANARY|PROCEDURAL_SKILL_CANARY|EPISODIC_TYPE_CANARY|EPISODIC_TAG_CANARY|MALFORMED_MEMORY_CANARY/);
  for (const note of ['Anna Manual.md', 'Handoff Skill.md', 'Session Summary Type.md', 'Session Summary Tag.md', 'Malformed memory.md']) {
    const read = await call('vault_read_note', { vault: 'Fictional Org', path: note });
    assert.equal(read.result.isError, true, `${note} must be blocked by its required memory grant`);
    assert.doesNotMatch(JSON.stringify(read), /PROCEDURAL_MANUAL_CANARY|PROCEDURAL_SKILL_CANARY|EPISODIC_TYPE_CANARY|EPISODIC_TAG_CANARY|MALFORMED_MEMORY_CANARY/);
  }
  setRuntimeMemoryPolicy(ctx, 'semantic', false);
  mcp = createMcp(ctx);
  await activateTestRole(mcp);
  const genericDenied = await call('vault_read_note', { vault: 'Fictional Org', path: 'Untyped memory.md' });
  assert.equal(genericDenied.result.isError, true, 'unclassified notes require semantic memory');
  assert.doesNotMatch(JSON.stringify(genericDenied), /UNTYPED_MEMORY_CANARY/);
  setRuntimeMemoryPolicy(ctx, 'semantic', true);
  mcp = createMcp(ctx);
  await activateTestRole(mcp);
  const genericAllowed = await call('vault_read_note', { vault: 'Fictional Org', path: 'Untyped memory.md' });
  assert.equal(genericAllowed.result.isError, false);
  assert.match(JSON.stringify(genericAllowed.result.structuredContent), /UNTYPED_MEMORY_CANARY/);
  setRuntimeMemoryPolicy(ctx, 'procedural', true);
  setRuntimeMemoryPolicy(ctx, 'episodic', true);
  mcp = createMcp(ctx);
  await activateTestRole(mcp);
  const allowed = await call('vault_read_note', { vault: 'Fictional Org', path: 'Anna Manual.md' });
  assert.equal(allowed.result.isError, false, 'the existing Harness grant can still read the operating manual');
  assert.match(JSON.stringify(allowed.result.structuredContent), /PROCEDURAL_MANUAL_CANARY/);
  const allowedEpisode = await call('vault_read_note', { vault: 'Fictional Org', path: 'Session Summary Type.md' });
  assert.equal(allowedEpisode.result.isError, false, 'session summaries require episodic memory, not semantic memory');
  assert.match(JSON.stringify(allowedEpisode.result.structuredContent), /EPISODIC_TYPE_CANARY/);
});

test('search and direct reads check current memory type before reusing a stale-index body', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-twin-memory-read-race-'));
  const vaultPath = path.join(root, 'org');
  await mkdir(vaultPath, { recursive: true });
  const notePath = path.join(vaultPath, 'Mutable.md');
  const canary = 'FRESH_EPISODIC_RACE_CANARY';
  await writeFile(notePath, `---\nmemory_type: semantic\n---\n# Mutable\n\n${canary}`);
  const cfg = fixture(vaultPath);
  const ctx = createContext(cfg, { env: { BRAINLINK_AGENT_TOKEN: 'fictional-agent-token' } });
  const searchCtx = createContext(cfg, { env: { BRAINLINK_AGENT_TOKEN: 'fictional-agent-token' } });
  setRuntimeMemoryPolicy(ctx, 'episodic', false);
  setRuntimeMemoryPolicy(searchCtx, 'episodic', false);
  await loadVault(ctx, 'Fictional Org');
  await loadVault(searchCtx, 'Fictional Org');
  const cachedFiles = [ctx, searchCtx].map((item) => item.cache.get('Fictional Org').files.get('Mutable.md'));

  await writeFile(notePath, `---\nmemory_type: episodic\n---\n# Mutable\n\n${canary}`);
  const changed = await stat(notePath, { bigint: true });
  assert.equal(Number(changed.size), cachedFiles[0].bytes, 'the fixture preserves file size so the index cache can be stale');
  // Model a filesystem stat collision by updating every cached stat field while leaving the
  // old semantic body in each index. Search and direct-read paths must still inspect frontmatter.
  for (const cachedFile of cachedFiles) {
    cachedFile.mtime = Number(changed.mtimeNs) / 1e6;
    cachedFile.bytes = Number(changed.size);
    cachedFile.ctime = String(changed.ctimeNs);
  }

  assert.deepEqual(await search(searchCtx, 'Fictional Org', canary, { semantic: false }), [], 'search must remove the stale body before ranking');

  let bodyReads = 0;
  await assert.rejects(readNote(ctx, 'Fictional Org', 'Mutable.md', {
    readBody: async (...args) => { bodyReads++; return readFile(...args); },
  }), /private/i);
  assert.equal(bodyReads, 0, 'the current episodic type is denied from frontmatter before the note body is read');
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
  cfg.session_filing = { projectVaults: { 'fictional-org-project': 'Fictional Org', 'fictional-personal-project': 'Fictional Personal' } };
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
  addTestRole(cfg, 'Fictional Org Role', 'Fictional Org');
  addTestRole(cfg, 'Fictional Personal Role', 'Fictional Personal');
  addTestRole(cfg, 'Fictional Client Role', 'Fictional Client');
  const env = { BRAINLINK_HOME: path.join(root, 'app'), HOME: root, BRAINLINK_AGENT_TOKEN: 'fictional-agent-token' };
  assert.deepEqual(validate(cfg), []);
  const mcp = createMcp(createContext(cfg, { env }));
  await activateTestRole(mcp, 'Fictional Org Role');
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
  assert.equal(readOwn.result.isError, true, 'summary-proposal policy does not expose full session text, even for the owning Twin');
  assert.doesNotMatch(JSON.stringify(readOwn), /ORG_MESSAGE_CANARY_77/);
  const fullOptInCfg = structuredClone(cfg);
  fullOptInCfg.twin_profiles[0].source_policy.session_capture = 'full-text-opt-in';
  const fullOptInMcp = createMcp(createContext(fullOptInCfg, { env }));
  await activateTestRole(fullOptInMcp, 'Fictional Org Role');
  const allowedFull = await fullOptInMcp.handle({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'session_read', arguments: { id: own.id, full: true } } });
  assert.match(JSON.stringify(allowedFull), /ORG_MESSAGE_CANARY_77/);
  const scopedClients = [
    { id: 'organisation', role: 'Fictional Org Role', mcp, own, foreign: [foreign, clientSession, unassigned], token: 'fictional-agent-token' },
    { id: 'personal', role: 'Fictional Personal Role', mcp: createMcp(createContext(cfg, { env: { ...env, BRAINLINK_AGENT_TOKEN: 'fictional-personal-token' } })), own: foreign, foreign: [own, clientSession, unassigned], token: 'fictional-personal-token' },
    { id: 'client', role: 'Fictional Client Role', mcp: createMcp(createContext(cfg, { env: { ...env, BRAINLINK_AGENT_TOKEN: 'fictional-client-token' } })), own: clientSession, foreign: [own, foreign, unassigned], token: 'fictional-client-token' },
  ];
  for (const scoped of scopedClients) {
    await activateTestRole(scoped.mcp, scoped.role);
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
  const closeArgs = { title: 'Fictional scoped close', project: 'fictional-org-project', goal: 'Verify scoped closure', outcome: 'Stored only as a profile-owned private summary.', session_or_task_id: 'scoped-close-1' };
  const preview = await mcp.handle({ jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: 'session_close', arguments: closeArgs } });
  assert.equal(preview.result.isError, false, JSON.stringify(preview));
  assert.equal(preview.result.structuredContent.session_saved, false);
  assert.equal(preview.result.structuredContent.written, false);
  assert.deepEqual(preview.result.structuredContent.vault_suggestion, { vault: 'Fictional Org', reason: 'Suggested from your saved choice for this exact project.' });
  const foreignRoute = await mcp.handle({ jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: 'session_close', arguments: { ...closeArgs, project: 'fictional-personal-project', session_or_task_id: 'foreign-saved-route' } } });
  assert.equal(foreignRoute.result.isError, true);
  assert.doesNotMatch(JSON.stringify(foreignRoute), /Fictional Personal|PERSONAL_SESSION_CANARY_88/);
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
  addTestRole(cfg, 'Fictional Org Role', 'Fictional Org');
  addTestRole(cfg, 'Fictional Client Role', 'Fictional Client');
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
  await activateTestRole(mcp, 'Fictional Org Role');
  await activateTestRole(clientMcp, 'Fictional Client Role');
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
    assert.equal(state.twin_profiles.enforcement, 'scoped_agent_profile_grants');
    assert.equal(state.twin_profiles.profiles[0].mode, 'organisation');
    assert.equal(state.twin_profiles.profiles[0].vaults[0].access, 'propose');
    assert.equal(state.twin_profiles.profiles[0].agents[0].vaults[0].access, 'read');
    assert.doesNotMatch(JSON.stringify(state.twin_profiles), /tokenHash|f{64}|Fictional company content/);
    const presetHealth = await fetch(`${base}/api/client-health`, {
      method: 'POST', headers: { 'X-BrainLink-Token': setup.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ client: 'claude-desktop' }),
    }).then((response) => response.json());
    assert.equal(presetHealth.ok, false);
    assert.match(presetHealth.message, /no Twin profile permission/);
  } finally { setup.server.close(); }
});

test('preset AI apps receive only the selected Twin permissions and disconnect revokes their token', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-preset-twin-'));
  const home = path.join(root, 'home');
  const vaultPath = path.join(root, 'org-vault');
  const privatePath = path.join(root, 'private-vault');
  await mkdir(vaultPath, { recursive: true });
  await mkdir(privatePath, { recursive: true });
  await mkdir(path.join(home, '.cursor'), { recursive: true });
  await writeFile(path.join(vaultPath, 'Public.md'), 'Synthetic public team note.');
  await writeFile(path.join(privatePath, 'Private.md'), 'PRESET_PRIVATE_CANARY_839');
  const env = { BRAINLINK_HOME: path.join(home, 'app'), HOME: home, USERPROFILE: home };
  const cfg = normalize({ version: 2, locale: 'en', vaults: [
    { name: 'Example Org', path: vaultPath },
    { name: 'Ian Private', path: privatePath, private: true },
  ], twin_profiles: [{
    id: 'org_scope', name: 'Example Org', mode: 'organisation', owner: 'synthetic-owner',
    vaults: [{ name: 'Example Org', access: 'propose' }],
    source_policy: { private_default: true, provenance_required: true, session_capture: 'metadata-only' },
    memory_policy: { working: false, semantic: true, procedural: false, episodic: false },
    allowed_actions: [], agent_access: [],
  }] });
  await saveConfig(cfg, path.join(env.BRAINLINK_HOME, 'config.json'));
  const setup = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${setup.port}`;
  const api = async (route, body) => {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'X-BrainLink-Token': setup.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const connected = await api('/api/connect', { client: 'cursor', profile_id: 'org_scope', vaults: [{ name: 'Example Org', operations: ['search', 'read_note'] }] });
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
    assert.equal(connected.body.health.ok, true, JSON.stringify(connected.body));
    assert.equal(connected.body.health.tool, 'tools/list');
    assert.match(connected.body.health.message, /no vault notes were read/);
    const clientConfig = JSON.parse(await readFile(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
    const secret = clientConfig.mcpServers.brainlink.env.BRAINLINK_AGENT_TOKEN;
    assert.match(secret, /^bla_/);
    const saved = JSON.parse(await readFile(path.join(env.BRAINLINK_HOME, 'config.json'), 'utf8'));
    const managed = saved.ai_agents.find((agent) => agent.preset_client_id === 'cursor');
    assert.equal(managed.tokenHash, hashToken(secret));
    assert.equal(saved.twin_profiles[0].agent_access[0].vaults[0].name, 'Example Org');
    assert.doesNotMatch(JSON.stringify(connected.body), new RegExp(secret));
    const stateResponse = await fetch(`${base}/api/state`, { headers: { 'X-BrainLink-Token': setup.token } });
    const state = await stateResponse.json();
    assert.doesNotMatch(JSON.stringify(state), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(state), /tokenHash/);

    const invalid = await api('/api/connect', { client: 'cursor', profile_id: 'org_scope', vaults: [{ name: 'Ian Private', operations: ['search'] }] });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /available vaults only once/);

    const disconnected = await api('/api/disconnect', { client: 'cursor' });
    assert.equal(disconnected.status, 200);
    const after = JSON.parse(await readFile(path.join(env.BRAINLINK_HOME, 'config.json'), 'utf8'));
    assert.equal(after.ai_agents.find((agent) => agent.preset_client_id === 'cursor').tokenHash, null);
    assert.equal(after.twin_profiles[0].agent_access.length, 0);

    const proposalConnected = await api('/api/connect', { client: 'cursor', profile_id: 'org_scope', vaults: [{ name: 'Example Org', operations: ['propose_note'] }] });
    assert.equal(proposalConnected.status, 200, JSON.stringify(proposalConnected.body));
    assert.equal(proposalConnected.body.health.ok, true, JSON.stringify(proposalConnected.body));
    assert.equal(proposalConnected.body.health.tool, 'tools/list');
    assert.deepEqual(await readdir(vaultPath), ['Public.md'], 'the permission health check previews but never saves a note');
    const finalDisconnect = await api('/api/disconnect', { client: 'cursor' });
    assert.equal(finalDisconnect.status, 200);
    const final = JSON.parse(await readFile(path.join(env.BRAINLINK_HOME, 'config.json'), 'utf8'));
    assert.equal(final.ai_agents.find((agent) => agent.preset_client_id === 'cursor').tokenHash, null);
    assert.equal(final.twin_profiles[0].agent_access.length, 0);
  } finally { setup.server.close(); }
});

test('DeepSeek Harness named profile connects through Setup with its own Twin-scoped token', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-dsh-twin-'));
  const home = path.join(root, 'home');
  const vaultPath = path.join(root, 'org-vault');
  const dshHome = path.join(home, '.dsh');
  const dshProfile = path.join(dshHome, 'profiles', 'web');
  await mkdir(vaultPath, { recursive: true });
  await mkdir(dshProfile, { recursive: true });
  await writeFile(path.join(vaultPath, 'Public.md'), 'Synthetic public organisation note.');
  await writeFile(path.join(dshProfile, 'cordis.patch.yml'), '[]\n');
  const env = { BRAINLINK_HOME: path.join(home, 'app'), HOME: home, USERPROFILE: home, DSH_HOME: dshHome };
  const cfg = fixture(vaultPath);
  addTestRole(cfg, 'DeepSeek Role', 'Fictional Org');
  cfg.twin_profiles[0].agent_access = [];
  await saveConfig(cfg, path.join(env.BRAINLINK_HOME, 'config.json'));
  const setup = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${setup.port}`;
  const api = async (route, body) => {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'X-BrainLink-Token': setup.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const state = await (await fetch(`${base}/api/state`, { headers: { 'X-BrainLink-Token': setup.token } })).json();
    assert.equal(state.clients['deepseek-harness@web'].title, 'DeepSeek Harness · web');
  const connected = await api('/api/connect', { client: 'deepseek-harness@web', profile_id: 'org_twin_1', vaults: [{ name: 'Fictional Org', operations: ['search', 'read_note', 'log_session'] }], memory_policy: { working: false, semantic: true, procedural: false, episodic: true } });
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
    assert.equal(connected.body.health.ok, true, JSON.stringify(connected.body));
    const patch = parseYaml(await readFile(path.join(dshProfile, 'cordis.patch.yml'), 'utf8'));
    const row = patch.flatMap((item) => item.insert || []).find((item) => item.name === '@deepseek-ai/dsh-mcp-client');
    const token = row.config.env.BRAINLINK_AGENT_TOKEN;
    assert.match(token, /^bla_/);
    assert.match(row.config.serverName, /^brainlink-web-[a-f0-9]{8}$/);
    assert.ok(row.config.serverName.length <= 32);
    const saved = JSON.parse(await readFile(path.join(env.BRAINLINK_HOME, 'config.json'), 'utf8'));
    const managed = saved.ai_agents.find((agent) => agent.preset_client_id === 'deepseek-harness@web');
    assert.equal(managed.tokenHash, hashToken(token));
    assert.equal(saved.twin_profiles[0].agent_access[0].agent_id, managed.id);
    assert.ok(saved.twin_profiles[0].agent_access[0].vaults[0].operations.includes('log_session'));
    assert.deepEqual(saved.twin_profiles[0].agent_access[0].memory_policy, { working: false, semantic: true, procedural: false, episodic: true });
    const dshMcp = createMcp(createContext(saved, { env: { ...env, BRAINLINK_AGENT_TOKEN: token, BRAINLINK_AI_PLATFORM: 'DeepSeek Harness' } }));
    await activateTestRole(dshMcp, 'DeepSeek Role');
    const logResult = await dshMcp.handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'session_log', arguments: { title: 'Fictional Harness session', text: 'Saved by synthetic test.', private: false } } });
    assert.equal(logResult.result.isError, false);
    const loggedSession = JSON.parse(logResult.result.content[0].text);
    const storedSessions = await (await openSessionStore(env)).listSessions({ profile_id: 'org_twin_1', limit: 10 });
    assert.equal(storedSessions.length, 1);
    assert.equal(storedSessions[0].id, loggedSession.id);
    assert.equal(storedSessions[0].private, true);
    assert.equal(storedSessions[0].profile_id, 'org_twin_1');
    assert.doesNotMatch(JSON.stringify(connected.body), new RegExp(token));
    assert.doesNotMatch(JSON.stringify(state), /tokenHash/);
    const disconnected = await api('/api/disconnect', { client: 'deepseek-harness@web' });
    assert.equal(disconnected.status, 200, JSON.stringify(disconnected.body));
    const after = JSON.parse(await readFile(path.join(env.BRAINLINK_HOME, 'config.json'), 'utf8'));
    assert.equal(after.ai_agents.find((agent) => agent.preset_client_id === 'deepseek-harness@web').tokenHash, null);
    assert.equal(after.twin_profiles[0].agent_access.length, 0);
  } finally { setup.server.close(); }
});

test('preset AI apps can receive scoped session and handoff tools without semantic-note access', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-preset-handoff-'));
  const home = path.join(root, 'home');
  const vaultPath = path.join(root, 'org-vault');
  await mkdir(path.join(vaultPath, 'Handoffs'), { recursive: true });
  await mkdir(path.join(home, '.cursor'), { recursive: true });
  const env = { BRAINLINK_HOME: path.join(home, 'app'), HOME: home, USERPROFILE: home };
  const cfg = fixture(vaultPath);
  cfg.twin_profiles[0].vaults[0].access = 'propose';
  cfg.twin_profiles[0].memory_policy = { working: true, semantic: false, procedural: false, episodic: true };
  cfg.twin_profiles[0].allowed_actions = [];
  cfg.twin_profiles[0].agent_access = [];
  cfg.handoff = { vault: 'Fictional Org', folder: 'Handoffs' };
  addTestRole(cfg, 'Fictional Operations', 'Fictional Org');
  await saveConfig(cfg, path.join(env.BRAINLINK_HOME, 'config.json'));
  const setup = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${setup.port}`;
  const api = async (route, body) => {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'X-BrainLink-Token': setup.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return { status: response.status, body: await response.json() };
  };
  try {
  const connected = await api('/api/connect', { client: 'cursor', profile_id: 'org_twin_1', vaults: [{ name: 'Fictional Org', operations: ['read_session', 'handoff_read', 'write_handoff'] }], memory_policy: { working: true, semantic: false, procedural: false, episodic: true } });
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
    assert.equal(connected.body.health.ok, true, JSON.stringify(connected.body));
    assert.equal(connected.body.health.tool, 'tools/list');
    assert.match(connected.body.health.message, /no vault notes were read/);
    const clientConfig = JSON.parse(await readFile(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
    const token = clientConfig.mcpServers.brainlink.env.BRAINLINK_AGENT_TOKEN;
    const saved = JSON.parse(await readFile(path.join(env.BRAINLINK_HOME, 'config.json'), 'utf8'));
    const agent = saved.ai_agents.find((item) => item.preset_client_id === 'cursor');
    const grant = saved.twin_profiles[0].agent_access.find((item) => item.agent_id === agent.id).vaults[0];
    const memoryPolicy = saved.twin_profiles[0].agent_access.find((item) => item.agent_id === agent.id).memory_policy;
    assert.deepEqual(memoryPolicy, { working: true, semantic: false, procedural: false, episodic: true });
    assert.equal(grant.access, 'propose');
    assert.deepEqual(grant.operations.sort(), ['handoff_read', 'read_session', 'write_handoff']);
    const ctx = createContext(saved, { env: { ...env, BRAINLINK_AGENT_TOKEN: token } });
    const mcp = createMcp(ctx);
    await activateTestRole(mcp, 'Fictional Operations');
    const listed = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const names = listed.result.tools.map((tool) => tool.name);
    assert.ok(names.includes('session_list'));
    assert.ok(names.includes('list_handoffs'));
    assert.ok(names.includes('send_handoff'));
    assert.equal(names.includes('vault_search'), false, 'semantic note access remains off');
    assert.equal(names.includes('context_packet'), false, 'context packets remain off with semantic memory disabled');
    const handoffs = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_handoffs', arguments: { limit: 1 } } });
    assert.equal(handoffs.result.isError, false);
  } finally { setup.server.close(); }
});

test('local Setup assigns an unowned session only to a session-authorized Twin and keeps it private', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-twin-session-assignment-'));
  const home = path.join(root, 'home');
  const vaultPath = path.join(root, 'vault');
  await mkdir(vaultPath);
  const env = { BRAINLINK_HOME: path.join(home, 'app'), HOME: home, USERPROFILE: home };
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

test('Setup creates a validated Twin from explicit vault, agent, action and memory choices', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-twin-create-'));
  const home = path.join(root, 'home');
  const vaultPath = path.join(root, 'vault');
  await mkdir(vaultPath);
  const env = { BRAINLINK_HOME: path.join(home, 'app') };
  const cfg = fixture(vaultPath);
  cfg.ai_agents.push({ id: 'agent_personal', name: 'Fictional Personal Agent', kind: 'local', tokenHash: hashToken('fictional-second-agent-token'), connected: false, revoked: false });
  const personalVault = path.join(root, 'personal-vault');
  const otherVault = path.join(root, 'other-vault');
  await mkdir(personalVault);
  await mkdir(otherVault);
  cfg.vaults.push({ name: 'Fictional Personal', path: personalVault, private: false });
  cfg.vaults.push({ name: 'Fictional Other', path: otherVault, private: false });
  const privateVault = path.join(root, 'private');
  await mkdir(privateVault);
  cfg.vaults.push({ name: 'Fictional Private', path: privateVault, private: true });
  await saveConfig(cfg, path.join(env.BRAINLINK_HOME, 'config.json'));
  const setup = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${setup.port}`;
  const api = async (body, authenticated = true) => {
    const response = await fetch(`${base}/api/twins/create`, { method: 'POST', headers: { ...(authenticated ? { 'X-BrainLink-Token': setup.token } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const request = {
      name: 'Fictional Personal Twin', mode: 'personal', owner: 'fictional-owner',
      vaults: [{ name: 'Fictional Personal', access: 'propose' }, { name: 'Fictional Other', access: 'read' }],
      agent_access: [{ agent_id: 'agent_personal', vaults: [
        { name: 'Fictional Personal', operations: ['search', 'read_note', 'propose_note', 'log_session'] },
        { name: 'Fictional Other', operations: ['search', 'log_session'] },
      ] }],
      memory_policy: { working: true, semantic: true, procedural: false, episodic: true },
    };
    assert.equal((await api(request, false)).status, 401, 'local Setup token is required');
    const created = await api(request);
    assert.equal(created.status, 200, created.body.error);
    assert.equal(created.body.profile.mode, 'personal');
    assert.deepEqual(created.body.profile.vaults, [{ name: 'Fictional Personal', access: 'propose' }, { name: 'Fictional Other', access: 'read' }]);
    assert.deepEqual(created.body.profile.memory_policy, request.memory_policy);
    assert.deepEqual(created.body.profile.allowed_actions.sort(), ['log_session', 'propose_note', 'read_note', 'search']);
    assert.equal(created.body.profile.agents[0].name, 'Fictional Personal Agent');
    assert.deepEqual(created.body.profile.agents[0].vaults, [
      { name: 'Fictional Personal', access: 'propose', operations: ['search', 'read_note', 'propose_note', 'log_session'] },
      { name: 'Fictional Other', access: 'read', operations: ['search', 'log_session'] },
    ]);
    assert.doesNotMatch(JSON.stringify(created.body), /fictional-second-agent-token|tokenHash/);

    const sharedAgentId = 'agent_shared_vault_probe';
    const savedForSharedProbe = JSON.parse(await readFile(path.join(env.BRAINLINK_HOME, 'config.json'), 'utf8'));
    savedForSharedProbe.ai_agents.push({ id: sharedAgentId, name: 'Fictional Shared Vault Probe', kind: 'local', tokenHash: hashToken('fictional-shared-vault-token'), connected: false, revoked: false });
    await saveConfig(savedForSharedProbe, path.join(env.BRAINLINK_HOME, 'config.json'));
    const sharedOrgVault = await api({ ...request, name: 'Should Refuse Shared Notes', vaults: [{ name: 'Fictional Org', access: 'read' }], agent_access: [{ agent_id: sharedAgentId, vaults: [{ name: 'Fictional Org', operations: ['search', 'read_note'] }] }] });
    assert.equal(sharedOrgVault.status, 400);
    assert.match(sharedOrgVault.body.error, /cannot grant note access to multiple Twin profiles/);

    const privateVaultResponse = await api({ ...request, name: 'Should Refuse', vaults: [{ name: 'Unavailable vault', access: 'read' }], agent_access: [] });
    assert.equal(privateVaultResponse.status, 400);
    assert.match(privateVaultResponse.body.error, /available vaults/);
    const unsupported = await api({ ...request, name: 'Should Refuse Too', agent_access: [{ agent_id: 'agent_personal', operations: ['write_note'] }] });
    assert.equal(unsupported.status, 400);
    assert.match(unsupported.body.error, /full read and write access/);
    const disabledMemory = await api({ ...request, name: 'Should Refuse Disabled Memory', memory_policy: { ...request.memory_policy, semantic: false }, agent_access: [{ agent_id: 'agent_personal', vaults: [{ name: 'Fictional Personal', operations: ['search'] }] }] });
    assert.equal(disabledMemory.status, 400);
    assert.match(disabledMemory.body.error, /Enable semantic memory/);
    const proposalWithoutSemantic = await api({ ...request, name: 'Should Refuse Proposal Without Semantic Memory', memory_policy: { ...request.memory_policy, semantic: false }, agent_access: [{ agent_id: 'agent_personal', vaults: [{ name: 'Fictional Personal', operations: ['propose_note'] }] }] });
    assert.equal(proposalWithoutSemantic.status, 400);
    assert.match(proposalWithoutSemantic.body.error, /Enable semantic memory/);
    const sessionLogWithoutEpisodic = await api({ ...request, name: 'Should Refuse Session Log Without Episodic Memory', memory_policy: { ...request.memory_policy, episodic: false }, agent_access: [{ agent_id: 'agent_personal', vaults: [
      { name: 'Fictional Personal', operations: ['log_session'] },
      { name: 'Fictional Other', operations: ['log_session'] },
    ] }] });
    assert.equal(sessionLogWithoutEpisodic.status, 400);
    assert.match(sessionLogWithoutEpisodic.body.error, /Enable episodic memory/);
    const mixedSessionScope = await api({ ...request, name: 'Should Refuse Session Scope', agent_access: [{ agent_id: 'agent_personal', vaults: [
      { name: 'Fictional Personal', operations: ['read_session'] },
      { name: 'Fictional Other', operations: ['search'] },
    ] }] });
    assert.equal(mixedSessionScope.status, 400);
    assert.match(mixedSessionScope.body.error, /Session history access applies across/);
    const mixedLogScope = await api({ ...request, name: 'Should Refuse Mixed Session Log Scope', agent_access: [{ agent_id: 'agent_personal', vaults: [
      { name: 'Fictional Personal', operations: ['log_session'] },
      { name: 'Fictional Other', operations: ['search'] },
    ] }] });
    assert.equal(mixedLogScope.status, 400);
    assert.match(mixedLogScope.body.error, /Private session logging applies across/);
    const saved = JSON.parse(await readFile(path.join(env.BRAINLINK_HOME, 'config.json'), 'utf8'));
    assert.equal(saved.twin_profiles.length, 2, 'rejected requests do not alter the stored profiles');
    assert.deepEqual(validate(saved), []);
  } finally { setup.server.close(); }
});

test('Setup edits a Twin without changing its identity or source policy and refuses unavailable scope', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-twin-update-'));
  const home = path.join(root, 'home');
  const vaultPath = path.join(root, 'vault');
  await mkdir(vaultPath);
  const env = { BRAINLINK_HOME: path.join(home, 'app') };
  const cfg = fixture(vaultPath);
  cfg.ai_agents.push({ id: 'agent_unassigned', name: 'Fictional Unassigned Agent', kind: 'local', tokenHash: hashToken('fictional-unassigned-token'), connected: false, revoked: false });
  cfg.vaults.push({ name: 'Fictional Private', path: path.join(root, 'private'), private: true });
  await mkdir(cfg.vaults[1].path);
  await saveConfig(cfg, path.join(env.BRAINLINK_HOME, 'config.json'));
  const setup = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${setup.port}`;
  const api = async (body, authenticated = true) => {
    const response = await fetch(`${base}/api/twins/update`, { method: 'POST', headers: { ...(authenticated ? { 'X-BrainLink-Token': setup.token } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const request = {
      profile_id: 'org_twin_1', name: 'Fictional Organisation Twin Revised', mode: 'organisation', owner: 'fictional-owner',
      vaults: [{ name: 'Fictional Org', access: 'propose' }],
      agent_access: [{ agent_id: 'agent_unassigned', operations: ['search', 'read_note', 'propose_note'] }],
      memory_policy: { working: false, semantic: true, procedural: true, episodic: false },
    };
    assert.equal((await api(request, false)).status, 401);
    const updated = await api(request);
    assert.equal(updated.status, 200, updated.body.error);
    assert.equal(updated.body.profile.id, 'org_twin_1');
    assert.equal(updated.body.profile.name, request.name);
    assert.deepEqual(updated.body.profile.memory_policy, request.memory_policy);
    assert.equal(updated.body.profile.agents[0].id, 'agent_unassigned');
    const savedBeforeRefusal = await readFile(path.join(env.BRAINLINK_HOME, 'config.json'), 'utf8');
    const changedOwner = await api({ ...request, owner: 'different-owner' });
    assert.equal(changedOwner.status, 400);
    assert.match(changedOwner.body.error, /type and owner cannot be changed/);
    const changedMode = await api({ ...request, mode: 'client' });
    assert.equal(changedMode.status, 400);
    assert.match(changedMode.body.error, /type and owner cannot be changed/);
    const disabledMemory = await api({ ...request, name: 'Invalid memory grant', agent_access: [{ agent_id: 'agent_unassigned', operations: ['read_session'] }], memory_policy: { working: false, semantic: true, procedural: true, episodic: false } });
    assert.equal(disabledMemory.status, 400);
    assert.match(disabledMemory.body.error, /Enable episodic memory/);
    const proposalWithoutSemantic = await api({ ...request, name: 'Invalid note proposal memory grant', agent_access: [{ agent_id: 'agent_unassigned', operations: ['propose_note'] }], memory_policy: { working: false, semantic: false, procedural: true, episodic: true } });
    assert.equal(proposalWithoutSemantic.status, 400);
    assert.match(proposalWithoutSemantic.body.error, /Enable semantic memory/);
    assert.equal(await readFile(path.join(env.BRAINLINK_HOME, 'config.json'), 'utf8'), savedBeforeRefusal);
    const privateVault = await api({ ...request, name: 'Must Not Save', vaults: [{ name: 'Unavailable vault', access: 'read' }] });
    assert.equal(privateVault.status, 400);
    assert.match(privateVault.body.error, /available vaults/);
    assert.equal(await readFile(path.join(env.BRAINLINK_HOME, 'config.json'), 'utf8'), savedBeforeRefusal);
    const saved = JSON.parse(savedBeforeRefusal);
    assert.deepEqual(saved.twin_profiles[0].source_policy, cfg.twin_profiles[0].source_policy);
    assert.deepEqual(validate(saved), []);
  } finally { setup.server.close(); }
});

test('Setup edits each Twin agent vault grant independently without widening access', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-twin-heterogeneous-edit-'));
  const home = path.join(root, 'home');
  const firstVault = path.join(root, 'first-vault');
  const secondVault = path.join(root, 'second-vault');
  await mkdir(firstVault);
  await mkdir(secondVault);
  const env = { BRAINLINK_HOME: path.join(home, 'app') };
  const cfg = fixture(firstVault);
  cfg.vaults.push({ name: 'Fictional Other', path: secondVault });
  cfg.twin_profiles[0].vaults.push({ name: 'Fictional Other', access: 'read' });
  await saveConfig(cfg, path.join(env.BRAINLINK_HOME, 'config.json'));
  const setup = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${setup.port}`;
  const call = async (url, body) => {
    const response = await fetch(`${base}${url}`, { method: body ? 'POST' : 'GET', headers: { 'X-BrainLink-Token': setup.token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  try {
    const status = await call('/api/state');
    assert.equal(status.body.twin_profiles.profiles[0].editable_scope, true);
    const before = await readFile(path.join(env.BRAINLINK_HOME, 'config.json'), 'utf8');
    const updated = await call('/api/twins/update', {
      profile_id: 'org_twin_1', name: 'Vault-scoped Twin', mode: 'organisation', owner: 'fictional-owner',
      vaults: [{ name: 'Fictional Org', access: 'propose' }, { name: 'Fictional Other', access: 'read' }],
      agent_access: [{ agent_id: 'agent_codex', vaults: [
        { name: 'Fictional Org', operations: ['search', 'read_note', 'propose_note'] },
        { name: 'Fictional Other', operations: ['search'] },
      ] }],
      memory_policy: { working: true, semantic: true, procedural: true, episodic: true },
    });
    assert.equal(updated.status, 200, updated.body.error);
    assert.deepEqual(updated.body.profile.agents[0].vaults, [
      { name: 'Fictional Org', access: 'propose', operations: ['search', 'read_note', 'propose_note'] },
      { name: 'Fictional Other', access: 'read', operations: ['search'] },
    ]);
    assert.notEqual(await readFile(path.join(env.BRAINLINK_HOME, 'config.json'), 'utf8'), before);
    const afterValidUpdate = await readFile(path.join(env.BRAINLINK_HOME, 'config.json'), 'utf8');
    const refused = await call('/api/twins/update', {
      profile_id: 'org_twin_1', name: 'Invalid proposal scope', mode: 'organisation', owner: 'fictional-owner',
      vaults: [{ name: 'Fictional Org', access: 'propose' }, { name: 'Fictional Other', access: 'read' }],
      agent_access: [{ agent_id: 'agent_codex', vaults: [
        { name: 'Fictional Org', operations: ['search'] },
        { name: 'Fictional Other', operations: ['search', 'propose_note'] },
      ] }],
      memory_policy: { working: true, semantic: true, procedural: true, episodic: true },
    });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /Choose propose or write access/);
    assert.equal(await readFile(path.join(env.BRAINLINK_HOME, 'config.json'), 'utf8'), afterValidUpdate);
    const mixedSessionScope = await call('/api/twins/update', {
      profile_id: 'org_twin_1', name: 'Invalid session scope', mode: 'organisation', owner: 'fictional-owner',
      vaults: [{ name: 'Fictional Org', access: 'read' }, { name: 'Fictional Other', access: 'read' }],
      agent_access: [{ agent_id: 'agent_codex', vaults: [
        { name: 'Fictional Org', operations: ['read_session'] },
        { name: 'Fictional Other', operations: ['search'] },
      ] }],
      memory_policy: { working: true, semantic: true, procedural: true, episodic: true },
    });
    assert.equal(mixedSessionScope.status, 400);
    assert.match(mixedSessionScope.body.error, /Session history access applies across/);
    assert.equal(await readFile(path.join(env.BRAINLINK_HOME, 'config.json'), 'utf8'), afterValidUpdate);
  } finally { setup.server.close(); }
});
