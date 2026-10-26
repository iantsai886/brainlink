import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { backupOnce, verifyBackup, restoreBackupToEmpty, loadBackupStatus, saveBackupStatus, pruneBackups } from '../src/backup.mjs';
import { loadConfig, normalize, saveConfig } from '../src/config.mjs';
import { createOrReadBackupRecoveryKey } from '../src/backup-key.mjs';
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
  assert.deepEqual(await readdir(dest), [path.basename(result.folder)], 'completed backups appear only after the manifest is ready');
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

test('encrypted backups hide file names and contents, verify the key, and restore with the recovery key', async () => {
  const root = await tmp('encrypted-source'), dest = await tmp('encrypted-destination'), recovered = await tmp('encrypted-restore');
  await writeFile(path.join(root, 'Private Name — secret.md'), 'UNIQUE_PRIVATE_CONTENT_7kL4');
  const key = (await createOrReadBackupRecoveryKey({ BRAINLINK_HOME: await tmp('encrypted-key-home') })).key;
  const result = await backupOnce([{ name: 'Personal Vault', path: root }], dest, new Date('2026-10-24T00:00:00Z'), [], { encryptionKey: key });
  assert.equal(result.encrypted, true);
  assert.deepEqual((await readdir(result.folder)).sort(), ['manifest.enc', 'objects']);
  const serialized = (await readFile(path.join(result.folder, 'manifest.enc'))).toString('utf8') + JSON.stringify(await readdir(path.join(result.folder, 'objects')));
  assert.doesNotMatch(serialized, /Private Name|UNIQUE_PRIVATE_CONTENT|Personal Vault/);
  await assert.rejects(verifyBackup(result.folder), /recovery key/);
  const wrongKey = (await createOrReadBackupRecoveryKey({ BRAINLINK_HOME: await tmp('wrong-backup-key-home') })).key;
  await assert.rejects(verifyBackup(result.folder, wrongKey), /recovery key/);
  assert.equal((await verifyBackup(result.folder, key)).ok, true);
  const restored = await restoreBackupToEmpty(result.folder, recovered, key);
  assert.equal(restored.file_count, 1);
  assert.equal(await readFile(path.join(recovered, '1-Personal-Vault', 'Private Name — secret.md'), 'utf8'), 'UNIQUE_PRIVATE_CONTENT_7kL4');
});

test('encrypted retention needs the local key and preserves encrypted copies when the key is wrong', async () => {
  const root = await tmp('encrypted-retention-source'), dest = await tmp('encrypted-retention-dest');
  await writeFile(path.join(root, 'Private.md'), 'fixture');
  const key = (await createOrReadBackupRecoveryKey({ BRAINLINK_HOME: await tmp('encrypted-retention-key') })).key;
  const one = await backupOnce([{ name: 'Personal', path: root }], dest, new Date('2026-10-20T00:00:00Z'), [], { encryptionKey: key });
  const two = await backupOnce([{ name: 'Personal', path: root }], dest, new Date('2026-10-21T00:00:00Z'), [], { encryptionKey: key });
  const wrongKey = (await createOrReadBackupRecoveryKey({ BRAINLINK_HOME: await tmp('wrong-encrypted-retention-key') })).key;
  assert.equal((await pruneBackups(dest, 1, two.folder, wrongKey)).removed_count, 0);
  assert.equal((await readdir(one.folder)).length, 2);
  assert.equal((await pruneBackups(dest, 1, two.folder, key)).removed_count, 1);
  assert.equal((await verifyBackup(two.folder, key)).ok, true);
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

test('a failed backup removes only its partial staging folder and keeps prior backups', async () => {
  const root = await tmp('partial-source'), dest = await tmp('partial-destination');
  await writeFile(path.join(root, 'Note.md'), 'fictional note');
  const first = await backupOnce([{ name: 'Workspace', path: root }], dest, new Date('2026-10-25T00:00:00Z'));
  const brokenArtifact = { name: 'rsi/ledger.jsonl' };
  Object.defineProperty(brokenArtifact, 'data', { get() { throw new Error('fixture write failure'); } });
  await assert.rejects(backupOnce([{ name: 'Workspace', path: root }], dest, new Date('2026-10-26T00:00:00Z'), [brokenArtifact]), /fixture write failure/);
  assert.deepEqual(await readdir(dest), [path.basename(first.folder)], 'the earlier verified backup remains; the partial staging folder is gone');
  assert.equal((await verifyBackup(first.folder)).ok, true);
});

test('retention removes only older verified BrainLink copies and preserves damaged or unknown folders', async () => {
  const root = await tmp('retention-source'), dest = await tmp('retention-destination');
  await writeFile(path.join(root, 'Note.md'), 'fictional note');
  const oldest = await backupOnce([{ name: 'Workspace', path: root }], dest, new Date('2026-10-20T00:00:00Z'));
  const userEdited = await backupOnce([{ name: 'Workspace', path: root }], dest, new Date('2026-10-20T12:00:00Z'));
  const middle = await backupOnce([{ name: 'Workspace', path: root }], dest, new Date('2026-10-21T00:00:00Z'));
  const newest = await backupOnce([{ name: 'Workspace', path: root }], dest, new Date('2026-10-22T00:00:00Z'));
  const damaged = await backupOnce([{ name: 'Workspace', path: root }], dest, new Date('2026-10-23T00:00:00Z'));
  await writeFile(path.join(userEdited.folder, 'user-added.txt'), 'do not delete this');
  await writeFile(path.join(damaged.folder, 'vaults', '1-Workspace', 'Note.md'), 'changed');
  const unknown = path.join(dest, 'BrainLink-Backup-not-a-backup');
  await mkdir(unknown);

  const result = await pruneBackups(dest, 2, newest.folder);
  assert.equal(result.removed_count, 1);
  assert.equal(result.retained_count, 2);
  assert.equal(await readdir(oldest.folder).then(() => true, () => false), false);
  assert.equal(await readFile(path.join(userEdited.folder, 'user-added.txt'), 'utf8'), 'do not delete this', 'a folder with user-added files is preserved');
  assert.equal((await verifyBackup(middle.folder)).ok, true);
  assert.equal((await verifyBackup(newest.folder)).ok, true);
  assert.equal(await readdir(damaged.folder).then(() => true, () => false), true, 'damaged copy is preserved for recovery investigation');
  assert.equal(await readdir(unknown).then(() => true, () => false), true, 'unknown folder is untouched');
  await assert.rejects(pruneBackups(dest, 366), /retention/);
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
  const app = await startSetup({ env, home, os: 'win32', port: 0, useCli: false, backupIntervalMs: 50, idleMinutes: 0.01,
    pickRestoreSourceFolder: async () => 'C:\\Fictional\\BrainLink-Backup',
    pickRestoreDestinationFolder: async () => 'D:\\Fictional\\Recovery' });
  const api = (route, body, token = app.token) => fetch(`http://127.0.0.1:${app.port}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': token }, body: JSON.stringify(body || {}),
  });
  try {
    assert.equal((await api('/api/backup', { enabled: true, folder: dest, intervalHours: 24 }, 'wrong')).status, 401);
    assert.equal((await api('/api/backup/encryption-key', {}, 'wrong')).status, 401);
    assert.equal((await api('/api/backup/restore/pick-source', {}, 'wrong')).status, 401);
    assert.equal((await api('/api/backup/restore/pick-destination', {}, 'wrong')).status, 401);
    assert.deepEqual(await api('/api/backup/restore/pick-source').then((r) => r.json()), { path: 'C:\\Fictional\\BrainLink-Backup' });
    assert.deepEqual(await api('/api/backup/restore/pick-destination').then((r) => r.json()), { path: 'D:\\Fictional\\Recovery' });
    await fetch(`http://127.0.0.1:${app.port}/api/rsi/discovery/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': app.token },
      body: JSON.stringify({ topics: ['agent memory'], signals: ['Agents lose context after handoff and repeat retrieval searches.'] }),
    });
    const missingKey = await api('/api/backup', { enabled: true, folder: dest, intervalHours: 24, encrypted: true });
    assert.equal(missingKey.status, 400, 'encryption cannot be enabled until the recovery key is created');
    const keyResponse = await api('/api/backup/encryption-key');
    assert.equal(keyResponse.status, 200);
    const recoveryKey = (await keyResponse.json()).key;
    assert.equal(recoveryKey.length, 43);
    assert.equal((await api('/api/backup/encryption-key').then((r) => r.json())).created, false, 'the recovery key stays stable for scheduled backups');
    const wrongKey = `${recoveryKey[0] === 'A' ? 'B' : 'A'}${recoveryKey.slice(1)}`;
    const rejectedConfirmation = await api('/api/backup', { enabled: true, folder: dest, intervalHours: 24, encrypted: true, recoveryKeyConfirmation: wrongKey });
    assert.equal(rejectedConfirmation.status, 400, 'a mismatched recovery key cannot enable encryption');
    assert.deepEqual(await readdir(dest), [], 'a mismatched recovery key cannot create a backup');
    assert.equal((await loadConfig(path.join(home, 'config.json'))).backup.encrypted, false, 'a mismatched recovery key leaves settings unchanged');
    const response = await api('/api/backup', { enabled: true, folder: dest, intervalHours: 24, keepCount: 30, encrypted: true });
    assert.equal(response.status, 400, 'the recovery key must be re-entered before encryption is enabled');
    const confirmed = await api('/api/backup', { enabled: true, folder: dest, intervalHours: 24, keepCount: 30, encrypted: true, recoveryKeyConfirmation: recoveryKey });
    assert.equal(confirmed.status, 200);
    const result = await confirmed.json();
    assert.equal(result.backup.status.ok, true);
    assert.equal(result.backup.status.encrypted, true);
    assert.equal((await verifyBackup(result.backup.status.folder, recoveryKey)).ok, true);
    const state = await fetch(`http://127.0.0.1:${app.port}/api/state`, { headers: { 'X-BrainLink-Token': app.token } }).then((r) => r.json());
    assert.equal(state.backup.enabled, true);
    assert.equal(state.backup.keepCount, 30);
    assert.equal(state.backup.encrypted, true);
    assert.equal(state.backup.status.file_count, 2, 'backup includes the vault note and RSI discovery settings');
    let secondVerified = false;
    for (let i = 0; i < 120 && !secondVerified; i++) {
      for (const folder of await readdir(dest)) {
        const full = path.join(dest, folder);
        if (full === result.backup.status.folder) continue;
        secondVerified = await verifyBackup(full, recoveryKey).then((r) => r.ok, () => false);
        if (secondVerified) break;
      }
      if (!secondVerified) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(secondVerified, 'scheduled backup creates another verified copy');
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal((await fetch(`http://127.0.0.1:${app.port}/health`)).status, 200, 'scheduled backup keeps the app running while idle');
    assert.equal((await api('/api/backup/restore', { backupFolder: result.backup.status.folder, destination: restore })).status, 400);
    const restored = await api('/api/backup/restore', { backupFolder: result.backup.status.folder, destination: restore, confirm: true, recoveryKey });
    assert.equal(restored.status, 200);
    assert.match(await readFile(path.join(restore, '1-Personal', 'Private.md'), 'utf8'), /private fixture/);
    const discoveryCopy = JSON.parse(await readFile(path.join(restore, 'BrainLink', 'rsi', 'discovery.json'), 'utf8'));
    assert.deepEqual(discoveryCopy.settings.topics, ['agent memory']);
    const off = await api('/api/backup', { enabled: false, folder: dest, intervalHours: 24 });
    const offBody = await off.json();
    assert.equal(offBody.backup?.enabled, false, JSON.stringify(offBody));
  } finally { app.server.close(); }
});

test('restore UI provides separate localized folder pickers and retains explicit restore confirmation', async () => {
  const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  for (const id of ['backup-restore-source', 'backup-restore-destination', 'backup-restore-pick-source', 'backup-restore-pick-destination', 'backup-restore']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
  }
  assert.match(html, /\/api\/backup\/restore\/pick-source/);
  assert.match(html, /\/api\/backup\/restore\/pick-destination/);
  assert.match(html, /\/api\/backup\/encryption-key/);
  assert.match(html, /recoveryKey: \$\('backup-restore-key'\)\.value/);
  assert.match(html, /encrypted: \$\('backup-encrypted'\)\.checked/);
  assert.match(html, /recoveryKeyConfirmation: \$\('backup-key-confirm'\)\.value/);
  assert.match(html, /id="backup-key-confirm-wrap" hidden/);
  assert.match(html, /if \(!confirm\(t\('backup\.restoreConfirm'\)\)\) return/);
  for (const locale of ['en', 'zh-TW', 'pt']) {
    const catalog = JSON.parse(await readFile(new URL(`../ui/locales/${locale}.json`, import.meta.url), 'utf8'));
    assert.ok(catalog['backup.restorePickSource'], `${locale} source picker label`);
    assert.ok(catalog['backup.restorePickDestination'], `${locale} destination picker label`);
    assert.ok(catalog['backup.retentionHint'], `${locale} retention policy explanation`);
    assert.ok(catalog['backup.encryptHint'], `${locale} encryption key warning`);
    assert.ok(catalog['backup.keyCreated'], `${locale} recovery key receipt`);
    assert.ok(catalog['backup.confirmRecoveryKey'], `${locale} recovery key confirmation label`);
    assert.ok(catalog['backup.confirmRecoveryKeyPlaceholder'], `${locale} recovery key confirmation placeholder`);
  }
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
