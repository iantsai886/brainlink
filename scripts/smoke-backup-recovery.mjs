#!/usr/bin/env node
// End-to-end encrypted recovery smoke using fictional multi-scope data only.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backupOnce, verifyBackup, restoreBackupToEmpty } from '../src/backup.mjs';
import { createOrReadBackupRecoveryKey } from '../src/backup-key.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'brainlink-recovery-smoke-'));
try {
  const scopes = ['Personal', 'Organisation', 'Client-A'];
  const vaults = [];
  const fixtures = new Map();
  for (const [index, name] of scopes.entries()) {
    const vaultPath = path.join(root, 'source', name);
    await mkdir(vaultPath, { recursive: true });
    const relative = index === 0 ? 'Goals.md' : index === 1 ? 'Workflow.md' : 'Engagement.md';
    const text = index === 0
      ? '---\nprivate: true\n---\nFICTIONAL_PERSONAL_CANARY'
      : index === 1
        ? '---\ntype: workflow\nscope: organisation\nstatus: current\n---\nFICTIONAL_ORGANISATION_CANARY'
        : '---\nprivate: true\n---\nFICTIONAL_CLIENT_CANARY';
    await writeFile(path.join(vaultPath, relative), text, { flag: 'wx' });
    vaults.push({ name, path: vaultPath });
    fixtures.set(`${name}/${relative}`, text);
  }

  const keyHome = path.join(root, 'key-home');
  const destination = path.join(root, 'backups');
  const restoreTarget = path.join(root, 'restored');
  await Promise.all([mkdir(keyHome), mkdir(destination), mkdir(restoreTarget)]);
  const recoveryKey = (await createOrReadBackupRecoveryKey({ BRAINLINK_HOME: keyHome })).key;
  const artifact = JSON.stringify({ schema: 1, fixture: 'fictional', result: 'recovery-smoke' });
  const backup = await backupOnce(vaults, destination, new Date(), [
    { name: 'rsi/observations.json', data: artifact },
  ], { encryptionKey: recoveryKey });

  assert.equal(backup.encrypted, true, 'backup must use encryption');
  const verification = await verifyBackup(backup.folder, recoveryKey);
  assert.equal(verification.ok, true, 'all encrypted objects must pass hash checks');
  assert.equal(verification.file_count, 4);
  assert.deepEqual((await readdir(backup.folder)).sort(), ['manifest.enc', 'objects']);
  const encryptedObjectNames = await readdir(path.join(backup.folder, 'objects'));
  for (const stored of ['manifest.enc', ...encryptedObjectNames.map((name) => `objects/${name}`)]) {
    const bytes = await readFile(path.join(backup.folder, ...stored.split('/')));
    for (const plain of [...fixtures.keys(), ...fixtures.values(), artifact]) {
      assert.equal(bytes.includes(Buffer.from(plain)), false, `encrypted backup must not expose ${stored} contents`);
    }
  }

  const wrongKey = `${recoveryKey[0] === 'A' ? 'B' : 'A'}${recoveryKey.slice(1)}`;
  await assert.rejects(restoreBackupToEmpty(backup.folder, restoreTarget, wrongKey), /recovery key|unlock/i);
  assert.deepEqual(await readdir(restoreTarget), [], 'wrong key must leave the restore target empty');

  const restored = await restoreBackupToEmpty(backup.folder, restoreTarget, recoveryKey);
  assert.equal(restored.file_count, 4);
  for (const [relative, expected] of fixtures) {
    const [scope, ...parts] = relative.split('/');
    const folder = `${scopes.indexOf(scope) + 1}-${scope}`;
    assert.equal(await readFile(path.join(restoreTarget, folder, ...parts), 'utf8'), expected);
    assert.equal(await readFile(path.join(vaults[scopes.indexOf(scope)].path, ...parts), 'utf8'), expected);
  }
  assert.equal(await readFile(path.join(restoreTarget, 'BrainLink', 'rsi', 'observations.json'), 'utf8'), artifact);

  process.stdout.write(JSON.stringify({
    ok: true,
    encrypted: true,
    scopes,
    verified_files: verification.file_count,
    restored_files: restored.file_count,
    wrong_key_refused: true,
    source_unchanged: true,
    artifact_restored: true,
    fixture_contents: 'fictional',
  }) + '\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
