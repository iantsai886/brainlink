import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { backupOnce, verifyBackup, restoreBackupToEmpty, loadBackupStatus, saveBackupStatus } from '../src/backup.mjs';
import { normalize, saveConfig } from '../src/config.mjs';
import { startSetup } from '../src/setup.mjs';

const tmp = (name) => mkdtemp(path.join(tmpdir(), `bl-backup-${name}-`));

test('backup preserves private and public files and verifies their hashes', async () => {
  const root = await tmp('source');
  const dest = await tmp('destination');
  await mkdir(path.join(root, '.obsidian'));
  await writeFile(path.join(root, 'Private.md'), '---\nprivate: true\n---\nfictional-private-note');
  await writeFile(path.join(root, '.obsidian', 'app.json'), '{}');
  const result = await backupOnce([{ name: 'Personal', path: root }], dest, new Date('2026-10-23T00:00:00Z'));
  assert.equal(result.file_count, 2);
  assert.equal((await verifyBackup(result.folder)).ok, true);
  const manifest = JSON.parse(await readFile(path.join(result.folder, 'manifest.json'), 'utf8'));
  const privateFile = manifest.files.find((f) => f.path === 'Private.md');
  assert.match(await readFile(path.join(result.folder, ...privateFile.stored.split('/')), 'utf8'), /fictional-private-note/);
  await writeFile(path.join(result.folder, ...privateFile.stored.split('/')), 'corrupted');
  assert.deepEqual((await verifyBackup(result.folder)).errors, [`Hash mismatch: ${privateFile.stored}`]);
});

test('backup rejects a destination within a vault', async () => {
  const root = await tmp('nested');
  const nested = path.join(root, 'Backups');
  await mkdir(nested);
  await assert.rejects(backupOnce([{ name: 'Personal', path: root }], nested), /outside every vault/);
});

test('verified backup restores to an empty folder without touching the original', async () => {
  const root = await tmp('restore-source');
  const dest = await tmp('restore-backup');
  const recovered = await tmp('restore-output');
  await writeFile(path.join(root, 'Private.md'), 'private original');
  const made = await backupOnce([{ name: 'Personal', path: root }], dest);
  await writeFile(path.join(root, 'Private.md'), 'changed original');
  const result = await restoreBackupToEmpty(made.folder, recovered);
  assert.equal(result.file_count, 1);
  assert.equal(await readFile(path.join(recovered, '1-Personal', 'Private.md'), 'utf8'), 'private original');
  assert.equal(await readFile(path.join(root, 'Private.md'), 'utf8'), 'changed original');
  await assert.rejects(restoreBackupToEmpty(made.folder, recovered), /must be empty/);
});

test('verified backup includes and restores the BrainLink RSI ledger artifact', async () => {
  const root = await tmp('artifact-source'), dest = await tmp('artifact-backup'), recovered = await tmp('artifact-restore');
  await writeFile(path.join(root, 'Note.md'), 'fictional note');
  const result = await backupOnce([{ name: 'Workspace', path: root }], dest, new Date('2026-10-25T00:00:00Z'), [
    { name: 'rsi/ledger.jsonl', data: Buffer.from('fictional ledger receipt\n') },
  ]);
  assert.equal(result.file_count, 2);
  assert.equal((await verifyBackup(result.folder)).ok, true);
  const restored = await restoreBackupToEmpty(result.folder, recovered);
  assert.equal(restored.file_count, 2);
  assert.equal(await readFile(path.join(recovered, 'BrainLink', 'rsi', 'ledger.jsonl'), 'utf8'), 'fictional ledger receipt\n');
});

test('backup rejects traversal in extra artifact paths', async () => {
  const root = await tmp('artifact-traversal-source'), dest = await tmp('artifact-traversal-dest');
  await assert.rejects(backupOnce([{ name: 'Workspace', path: root }], dest, new Date(), [{ name: '../outside.txt', data: 'blocked' }]), /artifact path/);
});

test('backup rejects symlinked files when the host permits symlinks', async (t) => {
  const root = await tmp('symlink');
  const dest = await tmp('symlink-destination');
  const outside = path.join(dest, 'outside.md');
  await writeFile(outside, 'outside');
  try { await symlink(outside, path.join(root, 'link.md')); }
  catch (error) {
    if (error.code === 'EPERM' && process.platform === 'win32') { t.skip('Windows symlink privilege unavailable'); return; }
    throw error;
  }
  await assert.rejects(backupOnce([{ name: 'Personal', path: root }], dest), /symbolic link/);
});

test('overlapping config saves use distinct atomic temp files', async () => {
  const home = await tmp('config-concurrent');
  const file = path.join(home, 'config.json');
  await Promise.all(Array.from({ length: 12 }, (_, i) => saveConfig(normalize({
    locale: i % 2 ? 'en' : 'zh-TW', vaults: [{ name: `Vault ${i}`, path: path.join(home, `vault-${i}`) }],
  }), file)));
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.match(saved.vaults[0].name, /^Vault \d+$/);
  assert.deepEqual((await readdir(home)).filter((name) => name.includes('.tmp-')), []);
});

test('authenticated Setup enables scheduled backup only after a verified first copy', async () => {
  const root = await tmp('api-source');
  const dest = await tmp('api-destination');
  const restore = await tmp('api-restore');
  const home = await tmp('api-home');
  await writeFile(path.join(root, 'Private.md'), '---\nprivate: true\n---\nprivate fixture');
  const env = { BRAINLINK_HOME: home, HOME: home, BRAINLINK_SEMANTIC: '0' };
  await saveConfig(normalize({ vaults: [{ name: 'Personal', path: root, private: true }] }), path.join(home, 'config.json'));
  const app = await startSetup({ env, home, os: 'win32', port: 0, useCli: false, backupIntervalMs: 50, idleMinutes: 0.01 });
  const api = (route, body, token = app.token) => fetch(`http://127.0.0.1:${app.port}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': token }, body: JSON.stringify(body || {}),
  });
  try {
    assert.equal((await api('/api/backup', { enabled: true, folder: dest, intervalHours: 24 }, 'wrong')).status, 401);
    await fetch(`http://127.0.0.1:${app.port}/api/rsi/discovery/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': app.token },
      body: JSON.stringify({ topics: ['agent memory'], signals: ['Agents lose context after handoff and repeat retrieval searches.'] }),
    });
    const response = await api('/api/backup', { enabled: true, folder: dest, intervalHours: 24 });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.backup.status.ok, true);
    assert.equal((await verifyBackup(result.backup.status.folder)).ok, true);
    const state = await fetch(`http://127.0.0.1:${app.port}/api/state`, { headers: { 'X-BrainLink-Token': app.token } }).then((r) => r.json());
    assert.equal(state.backup.enabled, true);
    assert.equal(state.backup.status.file_count, 2, 'backup includes the vault note and RSI discovery settings');
    let secondVerified = false;
    for (let i = 0; i < 120 && !secondVerified; i++) {
      for (const folder of await readdir(dest)) {
        const full = path.join(dest, folder);
        if (full === result.backup.status.folder) continue;
        secondVerified = await verifyBackup(full).then((r) => r.ok, () => false);
        if (secondVerified) break;
      }
      if (!secondVerified) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(secondVerified, 'scheduled backup creates another verified copy');
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal((await fetch(`http://127.0.0.1:${app.port}/health`)).status, 200, 'scheduled backup keeps the app running while idle');
    assert.equal((await api('/api/backup/restore', { backupFolder: result.backup.status.folder, destination: restore })).status, 400);
    const restored = await api('/api/backup/restore', { backupFolder: result.backup.status.folder, destination: restore, confirm: true });
    assert.equal(restored.status, 200);
    assert.match(await readFile(path.join(restore, '1-Personal', 'Private.md'), 'utf8'), /private fixture/);
    const discoveryCopy = JSON.parse(await readFile(path.join(restore, 'BrainLink', 'rsi', 'discovery.json'), 'utf8'));
    assert.deepEqual(discoveryCopy.settings.topics, ['agent memory']);
    const off = await api('/api/backup', { enabled: false, folder: dest, intervalHours: 24 });
    const offBody = await off.json();
    assert.equal(offBody.backup?.enabled, false, JSON.stringify(offBody));
  } finally { app.server.close(); }
});

test('restart retains backup result and catches up when the last run is overdue', async () => {
  const root = await tmp('restart-source');
  const dest = await tmp('restart-destination');
  const home = await tmp('restart-home');
  const env = { BRAINLINK_HOME: home, HOME: home, BRAINLINK_SEMANTIC: '0' };
  await writeFile(path.join(root, 'note.md'), 'fictional');
  await saveConfig(normalize({ vaults: [{ name: 'Company', path: root }], backup: { enabled: true, folder: dest, intervalHours: 24 } }), path.join(home, 'config.json'));
  const statusFile = path.join(home, 'backup-state.json');
  await saveBackupStatus(statusFile, { ok: true, at: '2020-01-01T00:00:00.000Z', folder: 'old' });
  const app = await startSetup({ env, home, os: 'win32', port: 0, useCli: false, backupIntervalMs: 5000 });
  try {
    let persisted;
    for (let i = 0; i < 80; i++) {
      persisted = await loadBackupStatus(statusFile);
      if (persisted?.ok && persisted.folder !== 'old') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal((await readdir(dest)).length, 1, 'overdue schedule runs on restart');
    assert.equal(persisted.ok, true, JSON.stringify(persisted));
    assert.equal((await verifyBackup(persisted.folder)).ok, true);
    const state = await fetch(`http://127.0.0.1:${app.port}/api/state`, { headers: { 'X-BrainLink-Token': app.token } }).then((r) => r.json());
    assert.equal(state.backup.status.folder, persisted.folder);
  } finally { app.server.close(); }
});
