import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { backupOnce, verifyBackup, restoreBackupToEmpty, loadBackupStatus, saveBackupStatus, pruneBackups, listVerifiedBackups } from '../src/backup.mjs';
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

test('backup history lists only recent hash-verified backups without leaking manifest paths', async () => {
  const root = await tmp('history-source'), dest = await tmp('history-destination');
  await writeFile(path.join(root, 'Private Name.md'), 'private history fixture');
  const older = await backupOnce([{ name: 'Private Vault Name', path: root }], dest, new Date('2026-10-20T00:00:00Z'));
  const newer = await backupOnce([{ name: 'Private Vault Name', path: root }], dest, new Date('2026-10-21T00:00:00Z'));
  const manifest = JSON.parse(await readFile(path.join(newer.folder, 'manifest.json'), 'utf8'));
  await writeFile(path.join(newer.folder, ...manifest.files[0].stored.split('/')), 'tampered');
  const listed = await listVerifiedBackups(dest);
  assert.deepEqual(listed.backups.map((item) => item.folder), [older.folder]);
  assert.equal(listed.backups[0].created_at, '2026-10-20T00:00:00.000Z');
  assert.equal(listed.backups[0].file_count, 1);
  assert.equal(listed.invalid_count, 1);
  assert.equal(JSON.stringify(listed).includes('Private Vault Name'), false);
  assert.equal(JSON.stringify(listed).includes('Private Name.md'), false);
  assert.equal((await listVerifiedBackups(dest, null, 1)).truncated, true);
  await assert.rejects(listVerifiedBackups(dest, null, 0), /between 1 and 100/);
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

test('encrypted backup restores through a fresh BrainLink Setup using only the exported recovery key', async () => {
  const source = await tmp('portable-source'), destination = await tmp('portable-backups'), restored = await tmp('portable-restored');
  const sourceHome = await tmp('portable-source-home'), secondHome = await tmp('portable-second-home');
  await writeFile(path.join(source, 'Private.md'), 'PORTABLE_RECOVERY_PRIVATE_FIXTURE');
  const sourceEnv = { BRAINLINK_HOME: sourceHome };
  const recoveryKey = (await createOrReadBackupRecoveryKey(sourceEnv)).key;
  const observationRecord = JSON.stringify({
    settings: { enabled: true, interval_hours: 168 },
    report: { schema: 1, categories: [], findings: [], privacy: { report_saved: true } },
    last_run: { at: '2026-10-27T00:00:00.000Z', trigger: 'schedule', ok: true },
  });
  const backup = await backupOnce([{ name: 'Personal', path: source }], destination, new Date('2026-10-27T00:00:00Z'), [
    { name: 'rsi/observations.json', data: observationRecord },
  ], { encryptionKey: recoveryKey });
  const secondEnv = { BRAINLINK_HOME: secondHome, HOME: secondHome, BRAINLINK_SEMANTIC: '0' };
  const secondApp = await startSetup({ env: secondEnv, home: secondHome, os: 'win32', port: 0, useCli: false, idleMinutes: 0.01 });
  const api = (body) => fetch(`http://127.0.0.1:${secondApp.port}/api/backup/restore`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': secondApp.token }, body: JSON.stringify(body),
  });
  try {
    await assert.rejects(readFile(path.join(secondHome, 'backup-key.bin')), { code: 'ENOENT' }, 'the second install must not have the source device key');
    const wrongKey = `${recoveryKey[0] === 'A' ? 'B' : 'A'}${recoveryKey.slice(1)}`;
    const refused = await api({ backupFolder: backup.folder, destination: restored, confirm: true, recoveryKey: wrongKey });
    assert.equal(refused.status, 400);
    assert.deepEqual(await readdir(restored), [], 'a wrong key leaves the restore target empty');
    const response = await api({ backupFolder: backup.folder, destination: restored, confirm: true, recoveryKey });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).file_count, 2);
    assert.equal(await readFile(path.join(restored, '1-Personal', 'Private.md'), 'utf8'), 'PORTABLE_RECOVERY_PRIVATE_FIXTURE');
    assert.equal(await readFile(path.join(restored, 'BrainLink', 'rsi', 'observations.json'), 'utf8'), observationRecord);
    await assert.rejects(readFile(path.join(secondHome, 'backup-key.bin')), { code: 'ENOENT' }, 'restore does not silently copy the recovery key into local app data');
  } finally { secondApp.server.close(); }
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

test('verification and restore reject distinct vaults mapped to the same recovered folder', async () => {
  const personal = await tmp('duplicate-folder-personal');
  const company = await tmp('duplicate-folder-company');
  const dest = await tmp('duplicate-folder-backup');
  const recovered = await tmp('duplicate-folder-output');
  await writeFile(path.join(personal, 'Personal.md'), 'personal fixture');
  await writeFile(path.join(company, 'Company.md'), 'company fixture');
  const made = await backupOnce([
    { name: 'Personal', path: personal },
    { name: 'Company', path: company },
  ], dest);

  const manifestPath = path.join(made.folder, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const personalFolder = manifest.vaults.find((vault) => vault.name === 'Personal').folder;
  const companyFile = manifest.files.find((file) => file.vault === 'Company');
  const previousStored = path.join(made.folder, ...companyFile.stored.split('/'));
  const mergedStored = `vaults/${personalFolder}/${companyFile.path}`;
  const mergedPath = path.join(made.folder, ...mergedStored.split('/'));
  await mkdir(path.dirname(mergedPath), { recursive: true });
  await writeFile(mergedPath, await readFile(previousStored));
  manifest.vaults.find((vault) => vault.name === 'Company').folder = personalFolder;
  companyFile.stored = mergedStored;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const verification = await verifyBackup(made.folder);
  assert.equal(verification.ok, false, 'a hash-valid copy with an unusable restore mapping is not a verified backup');
  assert.ok(verification.errors.includes('Invalid vault mapping in backup.'));
  const history = await listVerifiedBackups(dest);
  assert.deepEqual(history.backups, [], 'the Restore screen must not offer the unusable copy');
  assert.equal(history.invalid_count, 1);
  await assert.rejects(restoreBackupToEmpty(made.folder, recovered), /Invalid vault mapping/);
  assert.deepEqual(await readdir(recovered), [], 'invalid vault mappings must be rejected before publishing recovered data');
});

test('verification rejects duplicate restore destinations before creating a partial copy', async () => {
  const root = await tmp('restore-failure-source');
  const dest = await tmp('restore-failure-backup');
  const recovered = await tmp('restore-failure-output');
  await writeFile(path.join(root, 'Private.md'), 'private original');
  const made = await backupOnce([{ name: 'Personal', path: root }], dest);
  const manifestPath = path.join(made.folder, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files.push({ ...manifest.files[0] });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const verification = await verifyBackup(made.folder);
  assert.equal(verification.ok, false, 'duplicate targets cannot be restored without data loss');
  assert.ok(verification.errors.includes('Duplicate backup file destination.'));

  await assert.rejects(restoreBackupToEmpty(made.folder, recovered), /Duplicate backup file destination/);
  assert.deepEqual(await readdir(recovered), [], 'a rejected restore must not leave a partial-looking result');
  const parentEntries = await readdir(path.dirname(recovered));
  const restorePrefix = `.${path.basename(recovered)}.brainlink-restore-`;
  const placeholderPrefix = `.${path.basename(recovered)}.brainlink-empty-`;
  assert.equal(parentEntries.some((entry) => entry.startsWith(restorePrefix) || entry.startsWith(placeholderPrefix)), false, 'temporary restore folders are cleaned up');
});

test('restore returns the empty destination and removes staging when publishing the recovered copy fails', async () => {
  const root = await tmp('publish-failure-source');
  const dest = await tmp('publish-failure-backup');
  const recovered = await tmp('publish-failure-output');
  await writeFile(path.join(root, 'Note.md'), 'fictional recovery fixture');
  const made = await backupOnce([{ name: 'Personal', path: root }], dest);
  let calls = 0;
  const failPublishOnce = async (from, to) => {
    calls += 1;
    if (calls === 2) throw new Error('injected publish rename failure');
    return rename(from, to);
  };

  await assert.rejects(
    restoreBackupToEmpty(made.folder, recovered, null, { renameFolder: failPublishOnce }),
    /injected publish rename failure/,
  );
  assert.deepEqual(await readdir(recovered), [], 'the original empty destination is restored');
  const siblings = await readdir(path.dirname(recovered));
  assert.equal(siblings.some((entry) => entry.startsWith(`.${path.basename(recovered)}.brainlink-restore-`)), false, 'the verified staging copy is removed');
  assert.equal(siblings.some((entry) => entry.startsWith(`.${path.basename(recovered)}.brainlink-empty-`)), false, 'the empty placeholder is returned to its original path');
});

test('restore reports the recovery path if publication and returning the original destination both fail', async () => {
  const root = await tmp('rollback-failure-source');
  const dest = await tmp('rollback-failure-backup');
  const recovered = await tmp('rollback-failure-output');
  await writeFile(path.join(root, 'Note.md'), 'fictional recovery fixture');
  const made = await backupOnce([{ name: 'Personal', path: root }], dest);
  let calls = 0;
  const failPublishAndRollback = async (from, to) => {
    calls += 1;
    if (calls === 2) throw new Error('injected publish rename failure');
    if (calls === 3) throw new Error('injected rollback rename failure');
    return rename(from, to);
  };

  let failure;
  await assert.rejects(
    restoreBackupToEmpty(made.folder, recovered, null, { renameFolder: failPublishAndRollback }),
    (error) => { failure = error; return /original empty destination folder could not be returned/.test(error.message); },
  );
  const siblings = await readdir(path.dirname(recovered));
  const prefix = `.${path.basename(recovered)}.brainlink-empty-`;
  const preservedName = siblings.find((entry) => entry.startsWith(prefix));
  assert.ok(preservedName, 'the original empty directory remains beside the destination');
  const preservedPath = path.join(path.dirname(recovered), preservedName);
  assert.ok(failure.message.includes(preservedPath), 'the error tells the user where the original directory was preserved');
  assert.deepEqual(await readdir(preservedPath), [], 'the preserved original directory is intact and empty');
  assert.equal(siblings.some((entry) => entry.startsWith(`.${path.basename(recovered)}.brainlink-restore-`)), false, 'the recovered copy staging area is removed');
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
  // This integration test covers backup setup, not the short-idle lifecycle; keep enough
  // time for initial API setup on a loaded CI/Windows host before scheduling is enabled.
  const app = await startSetup({ env, home, os: 'win32', port: 0, useCli: false, backupIntervalMs: 50, idleMinutes: 10,
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
    assert.equal((await api('/api/backup/history', {}, 'wrong')).status, 401);
    assert.deepEqual(await api('/api/backup/restore/pick-source').then((r) => r.json()), { path: 'C:\\Fictional\\BrainLink-Backup' });
    assert.deepEqual(await api('/api/backup/restore/pick-destination').then((r) => r.json()), { path: 'D:\\Fictional\\Recovery' });
    await fetch(`http://127.0.0.1:${app.port}/api/rsi/discovery/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': app.token },
      body: JSON.stringify({ topics: ['agent memory'], signals: ['Agents lose context after handoff and repeat retrieval searches.'] }),
    });
    const observationSettings = await fetch(`http://127.0.0.1:${app.port}/api/rsi/observations/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': app.token },
      body: JSON.stringify({ enabled: true, interval_hours: 24 }),
    }).then((r) => r.json());
    assert.equal(observationSettings.observations.last_run.trigger, 'schedule');
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
    const history = await api('/api/backup/history');
    assert.equal(history.status, 200);
    const historyBody = await history.json();
    assert.ok(historyBody.backups.some((item) => item.folder === result.backup.status.folder && item.encrypted && item.file_count === 3));
    const state = await fetch(`http://127.0.0.1:${app.port}/api/state`, { headers: { 'X-BrainLink-Token': app.token } }).then((r) => r.json());
    assert.equal(state.backup.enabled, true);
    assert.equal(state.backup.keepCount, 30);
    assert.equal(state.backup.encrypted, true);
    assert.equal(state.backup.status.file_count, 3, 'backup includes the vault note, discovery settings and observation schedule');
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
    const activity = (await readFile(path.join(home, 'activity.log'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    assert.ok(activity.some((entry) => entry.tool === 'backup' && entry.ok === true));
    assert.ok(activity.some((entry) => entry.tool === 'backup_restore' && entry.ok === true));
    assert.doesNotMatch(JSON.stringify(activity.filter((entry) => ['backup', 'backup_restore'].includes(entry.tool))), /Private\.md|api-destination|api-restore|recoveryKey/);
    const discoveryCopy = JSON.parse(await readFile(path.join(restore, 'BrainLink', 'rsi', 'discovery.json'), 'utf8'));
    assert.deepEqual(discoveryCopy.settings.topics, ['agent memory']);
    const observationsCopy = JSON.parse(await readFile(path.join(restore, 'BrainLink', 'rsi', 'observations.json'), 'utf8'));
    assert.equal(observationsCopy.settings.enabled, true);
    assert.equal(observationsCopy.report.privacy.report_saved, true);
    const off = await api('/api/backup', { enabled: false, folder: dest, intervalHours: 24 });
    const offBody = await off.json();
    assert.equal(offBody.backup?.enabled, false, JSON.stringify(offBody));
  } finally { app.server.close(); }
});

test('restore UI provides verified history, localized pickers and explicit restore confirmation', async () => {
  const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  assert.match(html, /const backupWhen = Number\.isFinite\(backupAt\)/, 'backup receipt handles old records without a valid timestamp');
  assert.match(html, /backup\.trigger\.' \+ backupTrigger/, 'backup receipt explains whether it was manual or scheduled');
  for (const id of ['backup-schedule-mode', 'backup-interval-wrap', 'backup-hours', 'backup-time-wrap', 'backup-time', 'backup-history-refresh', 'backup-history', 'backup-history-status', 'backup-restore-source', 'backup-restore-destination', 'backup-restore-pick-source', 'backup-restore-pick-destination', 'backup-restore']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
  }
  assert.match(html, /\/api\/backup\/history/);
  assert.match(html, /\/api\/backup\/restore\/pick-source/);
  assert.match(html, /\/api\/backup\/restore\/pick-destination/);
  assert.match(html, /\/api\/backup\/encryption-key/);
  assert.match(html, /recoveryKey: \$\('backup-restore-key'\)\.value/);
  assert.match(html, /encrypted: \$\('backup-encrypted'\)\.checked/);
  assert.match(html, /recoveryKeyConfirmation: \$\('backup-key-confirm'\)\.value/);
  assert.match(html, /scheduleMode: \$\('backup-schedule-mode'\)\.value, time: \$\('backup-time'\)\.value/);
  assert.match(html, /id="backup-key-confirm-wrap" hidden/);
  assert.match(html, /if \(!confirm\(t\('backup\.restoreConfirm'\)\)\) return/);
  for (const locale of ['en', 'zh-TW', 'pt']) {
    const catalog = JSON.parse(await readFile(new URL(`../ui/locales/${locale}.json`, import.meta.url), 'utf8'));
    assert.ok(catalog['backup.historyLabel'], `${locale} verified backup selector label`);
    assert.ok(catalog['backup.restorePickSource'], `${locale} source picker label`);
    assert.ok(catalog['backup.restorePickDestination'], `${locale} destination picker label`);
    assert.ok(catalog['backup.retentionHint'], `${locale} retention policy explanation`);
    assert.ok(catalog['backup.encryptHint'], `${locale} encryption key warning`);
    assert.ok(catalog['backup.keyCreated'], `${locale} recovery key receipt`);
    assert.ok(catalog['backup.confirmRecoveryKey'], `${locale} recovery key confirmation label`);
    assert.ok(catalog['backup.confirmRecoveryKeyPlaceholder'], `${locale} recovery key confirmation placeholder`);
    assert.ok(catalog['backup.scheduleMode'], `${locale} schedule type label`);
    assert.ok(catalog['backup.scheduleInterval'], `${locale} interval option`);
    assert.ok(catalog['backup.scheduleDaily'], `${locale} daily option`);
    assert.ok(catalog['backup.time'], `${locale} daily local time label`);
    assert.ok(catalog['backup.lastVerified'].includes('{when}') && catalog['backup.lastVerified'].includes('{trigger}'), `${locale} verified receipt includes time and trigger`);
    assert.ok(catalog['backup.failed'].includes('{when}') && catalog['backup.failed'].includes('{trigger}'), `${locale} failure receipt includes time and trigger`);
    assert.ok(catalog['backup.unknownTime']);
    for (const trigger of ['manual', 'schedule', 'setup', 'unknown']) assert.ok(catalog[`backup.trigger.${trigger}`], `${locale} ${trigger} trigger`);
    for (const key of ['backup.historyRefresh', 'backup.historyEmpty', 'backup.historyFiles', 'backup.historyEncrypted', 'backup.historyFound', 'backup.historyMore', 'backup.historyNone']) assert.ok(catalog[key], `${locale} ${key}`);
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
