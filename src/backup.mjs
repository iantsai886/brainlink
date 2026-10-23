// Local vault backup, deliberately separate from the filtered cloud-sharing snapshot.
// Never follows symlinks, overwrites an earlier backup, or writes inside a source vault.
import { createHash, randomBytes } from 'node:crypto';
import { lstat, realpath, readdir, readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

const hash = (data) => createHash('sha256').update(data).digest('hex');
const within = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const safeName = (name) => String(name).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'vault';

export async function loadBackupStatus(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    return value && typeof value.ok === 'boolean' && typeof value.at === 'string' ? value : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { ok: false, at: new Date().toISOString(), error: 'Saved backup status could not be read.' };
  }
}

export async function saveBackupStatus(file, status) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(status, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    // Windows can briefly lock the destination while Setup reads it (or antivirus scans it).
    // Keep the old valid receipt until one atomic replacement succeeds; never remove it first.
    for (let attempt = 0; ; attempt++) {
      try { await rename(tmp, file); break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 19) throw error;
        await delay(25);
      }
    }
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

async function filesUnder(root, dir = root, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) throw new Error('Backup refused: a vault contains a symbolic link; inspect it before backing up.');
    if (!within(root, await realpath(full))) throw new Error('Backup refused: a vault path escapes its root.');
    if (stat.isDirectory()) await filesUnder(root, full, out);
    else if (stat.isFile()) out.push({ full, rel: path.relative(root, full).split(path.sep).join('/') });
  }
  return out;
}

export async function backupOnce(vaults, destination, now = new Date()) {
  if (!Array.isArray(vaults) || !vaults.length) throw new Error('Choose at least one vault to back up.');
  if (!destination || !path.isAbsolute(destination)) throw new Error('Choose an absolute backup destination.');
  const destStat = await lstat(destination);
  if (!destStat.isDirectory() || destStat.isSymbolicLink()) throw new Error('Backup destination must be a real directory.');
  const dest = await realpath(destination);
  const roots = [];
  for (const v of vaults) {
    if (!v.name || !v.path || !path.isAbsolute(v.path)) throw new Error('Each vault needs a name and absolute path.');
    const sourceStat = await lstat(v.path);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('Vault root must be a real directory.');
    const root = await realpath(v.path);
    if (within(root, dest) || within(dest, root)) throw new Error('Backup destination must be outside every vault.');
    roots.push({ name: v.name, root });
  }
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(dest, `BrainLink-Backup-${stamp}-${randomBytes(4).toString('hex')}`);
  await mkdir(backupDir);
  const manifest = { format: 'brainlink-backup-v1', created_at: now.toISOString(), vaults: [], files: [] };
  for (const [index, v] of roots.entries()) {
    const folder = `${index + 1}-${safeName(v.name)}`;
    manifest.vaults.push({ name: v.name, folder });
    for (const file of await filesUnder(v.root)) {
      const data = await readFile(file.full);
      const target = path.join(backupDir, 'vaults', folder, ...file.rel.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data, { flag: 'wx' });
      manifest.files.push({ vault: v.name, path: file.rel, bytes: data.length, sha256: hash(data), stored: `vaults/${folder}/${file.rel}` });
    }
  }
  await writeFile(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { folder: backupDir, vault_count: manifest.vaults.length, file_count: manifest.files.length };
}

export async function verifyBackup(backupDir) {
  const manifest = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'brainlink-backup-v1' || !Array.isArray(manifest.files)) throw new Error('Unrecognized backup manifest.');
  const root = await realpath(backupDir);
  const errors = [];
  for (const file of manifest.files) {
    if (!file.stored || path.isAbsolute(file.stored) || file.stored.split('/').some((part) => !part || part === '.' || part === '..')) {
      errors.push('Invalid backup file path'); continue;
    }
    const full = path.resolve(root, ...file.stored.split('/'));
    if (!within(root, full)) { errors.push('Invalid backup file path'); continue; }
    try {
      const st = await lstat(full);
      if (!st.isFile() || st.isSymbolicLink()) { errors.push(`Unsafe file: ${file.stored}`); continue; }
      if (!within(root, await realpath(full))) { errors.push(`Unsafe file: ${file.stored}`); continue; }
      const data = await readFile(full);
      if (data.length !== file.bytes || hash(data) !== file.sha256) errors.push(`Hash mismatch: ${file.stored}`);
    } catch { errors.push(`Missing file: ${file.stored}`); }
  }
  return { ok: errors.length === 0, vault_count: manifest.vaults.length, file_count: manifest.files.length, errors };
}

// Recovery is deliberately constrained to a new empty directory. Never restore in place or
// overwrite a live vault; the user can inspect the copy before switching any config paths.
export async function restoreBackupToEmpty(backupDir, destination) {
  const check = await verifyBackup(backupDir);
  if (!check.ok) throw new Error(`Backup failed verification: ${check.errors.join('; ')}`);
  const source = await realpath(backupDir);
  const stat = await lstat(destination);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Restore destination must be a real directory.');
  const targetRoot = await realpath(destination);
  if (within(source, targetRoot) || within(targetRoot, source)) throw new Error('Restore destination must be separate from the backup.');
  if ((await readdir(targetRoot)).length) throw new Error('Restore destination must be empty.');
  const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
  const folders = new Map();
  for (const v of manifest.vaults) {
    if (typeof v.name !== 'string' || typeof v.folder !== 'string' || !/^\d+-[a-zA-Z0-9_-]+$/.test(v.folder) || folders.has(v.name)) throw new Error('Invalid vault mapping in backup.');
    folders.set(v.name, v.folder);
  }
  for (const file of manifest.files) {
    const folder = folders.get(file.vault);
    if (!folder || typeof file.path !== 'string' || path.isAbsolute(file.path) ||
        file.path.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) throw new Error('Invalid file path in backup.');
    const expected = `vaults/${folder}/${file.path}`;
    if (file.stored !== expected) throw new Error('Backup file mapping does not match its vault.');
  }
  for (const file of manifest.files) {
    const data = await readFile(path.join(source, ...file.stored.split('/')));
    const target = path.join(targetRoot, folders.get(file.vault), ...file.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data, { flag: 'wx' });
  }
  return { folder: targetRoot, vault_count: check.vault_count, file_count: check.file_count };
}
