// Local vault backup, deliberately separate from the filtered cloud-sharing snapshot.
// Never follows symlinks, overwrites an earlier backup, or writes inside a source vault.
import { createHash, randomBytes } from 'node:crypto';
import { lstat, realpath, readdir, readFile, writeFile, mkdir, rename, unlink, rm } from 'node:fs/promises';
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

export async function backupOnce(vaults, destination, now = new Date(), artifacts = []) {
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
  const backupName = `BrainLink-Backup-${stamp}-${randomBytes(4).toString('hex')}`;
  const backupDir = path.join(dest, backupName);
  const stagingDir = path.join(dest, `.${backupName}.partial`);
  if (path.dirname(stagingDir) !== dest || !within(dest, stagingDir)) throw new Error('Invalid temporary backup location.');
  if (!Array.isArray(artifacts) || artifacts.length > 50) throw new Error('Backup artifacts must be a list of at most 50 files.');
  for (const artifact of artifacts) {
    const name = String(artifact?.name || '');
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(name) || name.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid backup artifact path.');
  }
  const manifest = { format: 'brainlink-backup-v1', created_at: now.toISOString(), vaults: [], files: [], artifacts: [] };
  await mkdir(stagingDir);
  try {
    for (const [index, v] of roots.entries()) {
      const folder = `${index + 1}-${safeName(v.name)}`;
      manifest.vaults.push({ name: v.name, folder });
      for (const file of await filesUnder(v.root)) {
        const data = await readFile(file.full);
        const target = path.join(stagingDir, 'vaults', folder, ...file.rel.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, data, { flag: 'wx' });
        manifest.files.push({ vault: v.name, path: file.rel, bytes: data.length, sha256: hash(data), stored: `vaults/${folder}/${file.rel}` });
      }
    }
    for (const artifact of artifacts) {
      const name = String(artifact?.name || '');
      const data = Buffer.isBuffer(artifact.data) ? artifact.data : Buffer.from(String(artifact.data ?? ''));
      const stored = 'artifacts/' + name;
      const target = path.resolve(stagingDir, ...stored.split('/'));
      if (!within(stagingDir, target)) throw new Error('Invalid backup artifact path.');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data, { flag: 'wx' });
      manifest.artifacts.push({ path: name, bytes: data.length, sha256: hash(data), stored });
    }
    await writeFile(path.join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    await rename(stagingDir, backupDir);
  } catch (error) {
    // The staging path is a random, direct child of the already-verified destination.
    // Remove only this invocation's incomplete copy; a completed backup is never touched.
    if (path.dirname(stagingDir) === dest && within(dest, stagingDir)) await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { folder: backupDir, vault_count: manifest.vaults.length, file_count: manifest.files.length + manifest.artifacts.length };
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
  for (const artifact of manifest.artifacts || []) {
    if (typeof artifact.path !== 'string' || artifact.path.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\')) || artifact.stored !== 'artifacts/' + artifact.path) { errors.push('Invalid backup artifact path'); continue; }
    const full = path.resolve(root, ...artifact.stored.split('/'));
    if (!within(root, full)) { errors.push('Invalid backup artifact path'); continue; }
    try {
      const st = await lstat(full);
      if (!st.isFile() || st.isSymbolicLink() || !within(root, await realpath(full))) { errors.push('Unsafe backup artifact'); continue; }
      const data = await readFile(full);
      if (data.length !== artifact.bytes || hash(data) !== artifact.sha256) errors.push('Backup artifact hash mismatch: ' + artifact.path);
    } catch { errors.push('Missing backup artifact: ' + artifact.path); }
  }
  return { ok: errors.length === 0, vault_count: manifest.vaults.length, file_count: manifest.files.length + (manifest.artifacts || []).length, errors };
}

async function containsOnlyManifestFiles(root, manifest) {
  const files = new Set(['manifest.json', ...manifest.files.map((file) => file.stored), ...(manifest.artifacts || []).map((file) => file.stored)]);
  const directories = new Set();
  for (const file of files) {
    let parent = path.posix.dirname(file);
    while (parent !== '.') { directories.add(parent); parent = path.posix.dirname(parent); }
  }
  async function walk(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) {
        if (!directories.has(relative) || !await walk(full, relative)) return false;
      } else if (!stat.isFile() || !files.has(relative)) return false;
    }
    return true;
  }
  return walk(root);
}

// Retention is opt-in (keepCount=0 means unlimited). Delete only older, complete,
// hash-verified BrainLink backups directly inside the chosen destination. Unknown,
// damaged, symlinked, and partial folders are never counted or removed.
export async function pruneBackups(destination, keepCount = 0, newestFolder = null) {
  if (!Number.isInteger(keepCount) || keepCount < 0 || keepCount > 365) throw new Error('Backup retention must be 0 (unlimited) or 1–365.');
  if (keepCount === 0) return { retained_count: null, removed_count: 0, warning: null };
  const destStat = await lstat(destination);
  if (!destStat.isDirectory() || destStat.isSymbolicLink()) throw new Error('Backup destination must be a real directory.');
  const dest = await realpath(destination);
  const valid = [];
  const warnings = [];
  for (const entry of await readdir(dest, { withFileTypes: true })) {
    if (!entry.name.startsWith('BrainLink-Backup-')) continue;
    const full = path.join(dest, entry.name);
    try {
      const stat = await lstat(full);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !within(dest, await realpath(full))) continue;
      const checked = await verifyBackup(full);
      if (!checked.ok) continue;
      const manifest = JSON.parse(await readFile(path.join(full, 'manifest.json'), 'utf8'));
      if (!await containsOnlyManifestFiles(full, manifest)) continue;
      const created = Date.parse(manifest.created_at);
      if (!Number.isFinite(created)) continue;
      valid.push({ full, created, name: entry.name });
    } catch {
      // An unreadable or malformed candidate is preserved and excluded from retention.
    }
  }
  valid.sort((a, b) => b.created - a.created || b.name.localeCompare(a.name));
  const pinned = newestFolder ? path.resolve(newestFolder) : null;
  const keep = new Set(valid.slice(0, keepCount).map((item) => item.full));
  if (pinned && valid.some((item) => item.full === pinned) && !keep.has(pinned)) {
    const oldestKept = [...keep].map((full) => valid.find((item) => item.full === full)).filter(Boolean).sort((a, b) => a.created - b.created)[0];
    if (oldestKept) keep.delete(oldestKept.full);
    keep.add(pinned);
  }
  let removed = 0;
  for (const item of valid) {
    if (keep.has(item.full)) continue;
    try {
      // Re-check immediately before removal. A changed backup is preserved.
      const stat = await lstat(item.full);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !within(dest, await realpath(item.full))) continue;
      const checked = await verifyBackup(item.full);
      if (!checked.ok) continue;
      const manifest = JSON.parse(await readFile(path.join(item.full, 'manifest.json'), 'utf8'));
      if (!await containsOnlyManifestFiles(item.full, manifest)) continue;
      await rm(item.full, { recursive: true, force: false });
      removed++;
    } catch (error) {
      warnings.push(`Could not remove an old verified backup: ${error.message || String(error)}`);
    }
  }
  return { retained_count: valid.length - removed, removed_count: removed, warning: warnings.length ? warnings.join('; ') : null };
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
  for (const artifact of manifest.artifacts || []) {
    if (typeof artifact.path !== 'string' || artifact.path.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\')) || artifact.stored !== 'artifacts/' + artifact.path) throw new Error('Invalid backup artifact mapping.');
  }
  for (const file of manifest.files) {
    const data = await readFile(path.join(source, ...file.stored.split('/')));
    const target = path.join(targetRoot, folders.get(file.vault), ...file.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data, { flag: 'wx' });
  }
  for (const artifact of manifest.artifacts || []) {
    const data = await readFile(path.join(source, ...artifact.stored.split('/')));
    const target = path.join(targetRoot, 'BrainLink', ...artifact.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data, { flag: 'wx' });
  }
  return { folder: targetRoot, vault_count: check.vault_count, file_count: check.file_count };
}
