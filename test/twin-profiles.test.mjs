import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize, validate, saveConfig } from '../src/config.mjs';
import { twinProfileStatus } from '../src/twin-profiles.mjs';
import { startSetup } from '../src/setup.mjs';

const fixture = (vaultPath) => normalize({
  version: 2,
  vaults: [{ name: 'Fictional Org', path: vaultPath }],
  ai_agents: [{ id: 'agent_codex', name: 'Fictional Codex', kind: 'local', tokenHash: 'f'.repeat(64), connected: true }],
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

test('Twin status is explicitly declaration-only and never exposes agent credentials', () => {
  const status = twinProfileStatus(fixture('C:\\fictional-vault'));
  assert.equal(status.enforcement, 'not_active');
  assert.equal(status.profiles[0].declaration_status, 'declared_only');
  assert.equal(status.profiles[0].agents[0].name, 'Fictional Codex');
  assert.equal(status.profiles[0].agents[0].vaults[0].operations.includes('write_note'), false);
  assert.doesNotMatch(JSON.stringify(status), /tokenHash|f{64}/);
});

test('authenticated local status exposes the read-only Twin profile and marks enforcement as pending', async () => {
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
    assert.equal(state.twin_profiles.enforcement, 'not_active');
    assert.equal(state.twin_profiles.profiles[0].mode, 'organisation');
    assert.equal(state.twin_profiles.profiles[0].vaults[0].access, 'propose');
    assert.equal(state.twin_profiles.profiles[0].agents[0].vaults[0].access, 'read');
    assert.doesNotMatch(JSON.stringify(state.twin_profiles), /tokenHash|f{64}|Fictional company content/);
  } finally { setup.server.close(); }
});
