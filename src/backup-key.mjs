import { randomBytes } from 'node:crypto';
import { lstat, link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { appHome } from './config.mjs';

const KEY_BYTES = 32;
const keyFile = (env = process.env) => path.join(env.BRAINLINK_HOME || (process.platform === 'win32'
  ? path.join(env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'BrainLink')
  : appHome(env)), 'backup-key.bin');

export function parseBackupKey(value) {
  if (Buffer.isBuffer(value)) {
    if (value.length !== KEY_BYTES) throw new Error('The backup recovery key is invalid.');
    return Buffer.from(value);
  }
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('Enter the 43-character BrainLink backup recovery key.');
  const key = Buffer.from(value, 'base64url');
  if (key.length !== KEY_BYTES || key.toString('base64url') !== value) throw new Error('The backup recovery key is invalid.');
  return key;
}

export async function readBackupKey(env = process.env) {
  const file = keyFile(env);
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The local backup key file is not a regular file.');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('The local backup key file is accessible to other users; restrict its permissions before backing up.');
    return parseBackupKey(await readFile(file));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function createOrReadBackupRecoveryKey(env = process.env) {
  const existing = await readBackupKey(env);
  if (existing) return { key: existing.toString('base64url'), created: false };
  const file = keyFile(env);
  await mkdir(path.dirname(file), { recursive: true });
  const key = randomBytes(KEY_BYTES);
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temp, key, { flag: 'wx', mode: 0o600 });
    try { await link(temp, file); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const winner = await readBackupKey(env);
      if (!winner) throw error;
      return { key: winner.toString('base64url'), created: false };
    }
    return { key: key.toString('base64url'), created: true };
  } finally { await unlink(temp).catch(() => {}); }
}

export async function requireBackupKey(env = process.env) {
  const key = await readBackupKey(env);
  if (!key) throw new Error('Encrypted backup is enabled but this device has no local backup key. Create or restore the key first.');
  return key;
}
