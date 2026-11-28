import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize, saveConfig } from '../src/config.mjs';
import {
  runDoctor,
  declineCapability,
  undeclineCapability,
  loadDoctorPreferences,
  formatDoctorReport,
} from '../src/doctor.mjs';

test('doctor reports live, broken (with fix_command), declined (persisted, never broken), and honest MISSING/UNMEASURED states', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'brainlink-doctor-home-'));
  const vaultDir = await mkdtemp(path.join(tmpdir(), 'brainlink-doctor-vault-'));
  const env = { ...process.env, BRAINLINK_HOME: home };

  // 1. No config yet -> MISSING (never fake green) and network UNMEASURED
  const emptyReport = await runDoctor({ env });
  assert.equal(emptyReport.checks.find((c) => c.id === 'config').state, 'MISSING');
  assert.equal(emptyReport.checks.find((c) => c.id === 'vaults').state, 'MISSING');
  assert.equal(emptyReport.checks.find((c) => c.id === 'network').state, 'UNMEASURED');
  assert.equal(emptyReport.ok, false);

  // 2. Valid config + missing semantic embedder -> vaults live, semantic broken with exact fix command
  const cfg = normalize({ vaults: [{ name: 'Brain', path: vaultDir }] });
  await saveConfig(cfg, path.join(home, 'config.json'));

  const brokenSem = await runDoctor({
    env,
    semanticProbe: async () => ({ available: false, reason: 'Ollama not running', setup_hint: 'ollama pull nomic-embed-text' }),
  });
  assert.equal(brokenSem.checks.find((c) => c.id === 'config').state, 'live');
  assert.equal(brokenSem.checks.find((c) => c.id === 'vaults').state, 'live');
  const semCheck = brokenSem.checks.find((c) => c.id === 'semantic');
  assert.equal(semCheck.state, 'broken');
  assert.equal(semCheck.label, 'broken ❌');
  assert.equal(semCheck.fix_command, 'ollama pull nomic-embed-text');
  assert.equal(brokenSem.counts.broken, 1);

  // 3. Decline semantic capability -> persisted in doctor-preferences.json, never shown as broken
  const dec = await declineCapability('semantic', { reason: 'CPU-only laptop', env });
  assert.equal(dec.state, 'declined');
  assert.equal(dec.label, 'declined ⏸');

  const prefs = await loadDoctorPreferences({ env });
  assert.ok(prefs.declined.semantic);

  const afterDecline = await runDoctor({
    env,
    network: true,
    networkProbe: async () => ({ ok: true, detail: 'Loopback healthy' }),
    semanticProbe: async () => ({ available: false, reason: 'still off' }),
  });
  assert.equal(afterDecline.checks.find((c) => c.id === 'semantic').state, 'declined');
  assert.equal(afterDecline.checks.find((c) => c.id === 'network').state, 'live');
  assert.equal(afterDecline.counts.broken, 0);
  assert.equal(afterDecline.overall, 'HEALTHY');
  const text = formatDoctorReport(afterDecline);
  assert.match(text, /declined ⏸/);
  assert.match(text, /live ✅/);

  // 4. Undecline restores active check
  const und = await undeclineCapability('semantic', { env });
  assert.equal(und.removed, true);
  const afterUndecline = await runDoctor({
    env,
    semanticProbe: async () => ({ available: true, model: 'nomic-embed-text:latest' }),
  });
  assert.equal(afterUndecline.checks.find((c) => c.id === 'semantic').state, 'live');
});

test('doctor --reconcile detects missing vaults and unmeasured git state honestly', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'brainlink-doctor-rec-'));
  const env = { ...process.env, BRAINLINK_HOME: home };
  const cfg = normalize({ vaults: [{ name: 'MissingVault', path: path.join(home, 'does-not-exist') }] });
  await saveConfig(cfg, path.join(home, 'config.json'));

  const rep = await runDoctor({
    env,
    reconcile: true,
    repoRoot: home, // not a git repo -> must report UNMEASURED, never live
    semanticProbe: async () => ({ available: true, model: 'nomic-embed-text:latest' }),
  });
  assert.equal(rep.checks.find((c) => c.id === 'vaults').state, 'broken');
  assert.equal(rep.checks.find((c) => c.id === 'reconcile:git').state, 'UNMEASURED');
});
