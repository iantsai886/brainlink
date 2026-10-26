import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOrReadBackupRecoveryKey, parseBackupKey, readBackupKey } from '../src/backup-key.mjs';

test('recovery key is generated once, stored locally with private mode, and can be restored from its displayed text', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'brainlink-backup-key-'));
  const env = { BRAINLINK_HOME: home };
  const first = await createOrReadBackupRecoveryKey(env);
  const second = await createOrReadBackupRecoveryKey(env);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.key, second.key);
  assert.equal(parseBackupKey(first.key).length, 32);
  assert.deepEqual(await readBackupKey(env), parseBackupKey(first.key));
  assert.deepEqual(await readFile(path.join(home, 'backup-key.bin')), parseBackupKey(first.key));
  const stat = await lstat(path.join(home, 'backup-key.bin'));
  assert.equal(stat.isFile(), true);
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o077, 0);
});

test('recovery key parser refuses malformed and incorrectly sized keys', () => {
  assert.throws(() => parseBackupKey('short'), /43-character/);
  assert.throws(() => parseBackupKey('A'.repeat(42) + 'B'), /invalid/);
  assert.throws(() => parseBackupKey(Buffer.alloc(31)), /invalid/);
});

test('Windows stores the scheduled-backup key in Local AppData, not roaming AppData', async (t) => {
  if (process.platform !== 'win32') { t.skip('Windows path policy'); return; }
  const home = await mkdtemp(path.join(tmpdir(), 'brainlink-local-key-'));
  const env = { LOCALAPPDATA: path.join(home, 'Local'), APPDATA: path.join(home, 'Roaming') };
  await createOrReadBackupRecoveryKey(env);
  assert.equal((await lstat(path.join(home, 'Local', 'BrainLink', 'backup-key.bin'))).isFile(), true);
  await assert.rejects(lstat(path.join(home, 'Roaming', 'BrainLink', 'backup-key.bin')), { code: 'ENOENT' });
});
