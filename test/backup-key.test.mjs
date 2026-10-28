import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
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

test('Windows recovery key removes broad ACL access and keeps the current user able to read it', async (t) => {
  if (process.platform !== 'win32') { t.skip('Windows ACL policy'); return; }
  const home = await mkdtemp(path.join(tmpdir(), 'brainlink-key-acl-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const keyFile = path.join(home, 'Local', 'BrainLink', 'backup-key.bin');
  const env = { LOCALAPPDATA: path.join(home, 'Local'), APPDATA: path.join(home, 'Roaming') };
  await createOrReadBackupRecoveryKey(env);

  const inspect = () => {
    const acl = execFileSync(icacls, [keyFile], { encoding: 'utf8', windowsHide: true });
    const user = execFileSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true }).trim();
    return {
      user: acl.split(/\r?\n/).some((row) => row.toLowerCase().includes(user.toLowerCase())),
      broad: /(?:\\*S-1-1-0|\\*S-1-5-11|\\*S-1-5-32-545|Everyone|Authenticated Users|BUILTIN\\Users)/i.test(acl),
    };
  };

  const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
  execFileSync(icacls, [keyFile, '/grant', '*S-1-1-0:(R)'], { stdio: 'ignore', windowsHide: true });
  assert.equal(inspect().broad, true, 'fixture successfully adds broad Everyone read access');
  assert.ok(await readBackupKey(env), 'the stored key remains readable after ACL repair');
  const secured = inspect();
  assert.equal(secured.user, true, 'the current user retains key access');
  assert.equal(secured.broad, false, 'broad groups no longer have an allow entry');
});
