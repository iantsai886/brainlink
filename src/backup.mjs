// Local vault backup, deliberately separate from the filtered cloud-sharing snapshot.
// Never follows symlinks, overwrites an earlier backup, or writes inside a source vault.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lstat, realpath, readdir, readFile, writeFile, mkdir, rename, unlink, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { parseBackupKey } from './backup-key.mjs';

const hash = (data) => createHash('sha256').update(data).digest('hex');
const within = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const safeName = (name) => String(name).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'vault';

function encryptBackupData(data, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', parseBackupKey(key), iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([Buffer.from('BLG1'), iv, cipher.getAuthTag(), encrypted]);
}

function decryptBackupData(data, key) {
  if (data.length < 32 || data.subarray(0, 4).toString('ascii') !== 'BLG1') throw new Error('Encrypted backup data is incomplete or uses an unsupported format.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', parseBackupKey(key), data.subarray(4, 16));
    decipher.setAuthTag(data.subarray(16, 32));
    return Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]);
  } catch { throw new Error('Could not unlock the encrypted backup. Check the recovery key or backup file.'); }
}

async function isEncryptedBackup(root) {
  try { const stat = await lstat(path.join(root, 'manifest.enc')); return stat.isFile() && !stat.isSymbolicLink(); }
  catch { return false; }
}

async function readBackupManifest(root, encryptionKey) {
  if (await isEncryptedBackup(root)) return JSON.parse(decryptBackupData(await readFile(path.join(root, 'manifest.enc')), encryptionKey).toString('utf8'));
  return JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
}

function relativeManifestPath(value) {
  return typeof value === 'string' && value.length > 0 && !path.isAbsolute(value)
    && !value.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\\'));
}

function validateBackupMappings(manifest, encrypted) {
  if (manifest.format !== 'brainlink-backup-v1' || !Array.isArray(manifest.vaults) || !manifest.vaults.length
      || !Array.isArray(manifest.files) || (manifest.artifacts !== undefined && !Array.isArray(manifest.artifacts))) {
    throw new Error('Unrecognized backup manifest.');
  }
  const errors = [];
  const vaultFolders = new Map();
  const folderIds = new Set();
  for (const vault of manifest.vaults) {
    if (!vault || typeof vault.name !== 'string' || !vault.name || typeof vault.folder !== 'string'
        || !/^\d+-[a-zA-Z0-9_-]+$/.test(vault.folder) || vaultFolders.has(vault.name) || folderIds.has(vault.folder)) {
      errors.push('Invalid vault mapping in backup.');
      continue;
    }
    vaultFolders.set(vault.name, vault.folder);
    folderIds.add(vault.folder);
  }
  const targets = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object' || !vaultFolders.has(file.vault) || !relativeManifestPath(file.path)) {
      errors.push('Invalid backup file mapping.');
      continue;
    }
    const folder = vaultFolders.get(file.vault);
    const expected = `vaults/${folder}/${file.path}`;
    if (encrypted ? !/^objects\/[a-f0-9]{32}\.bin$/.test(file.stored || '') : file.stored !== expected) {
      errors.push('Invalid backup file mapping.');
      continue;
    }
    const target = `${file.vault}\0${file.path}`;
    if (targets.has(target)) errors.push('Duplicate backup file destination.');
    targets.add(target);
  }
  for (const artifact of manifest.artifacts || []) {
    if (!artifact || typeof artifact !== 'object' || !relativeManifestPath(artifact.path)
        || (encrypted ? !/^objects\/[a-f0-9]{32}\.bin$/.test(artifact.stored || '') : artifact.stored !== `artifacts/${artifact.path}`)) {
      errors.push('Invalid backup artifact mapping.');
      continue;
    }
    const target = `BrainLink\0${artifact.path}`;
    if (targets.has(target)) errors.push('Duplicate backup artifact destination.');
    targets.add(target);
  }
  return errors;
}

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

export async function backupOnce(vaults, destination, now = new Date(), artifacts = [], options = {}) {
  const encryptionKey = options.encryptionKey ? parseBackupKey(options.encryptionKey) : null;
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
        const stored = encryptionKey ? `objects/${randomBytes(16).toString('hex')}.bin` : `vaults/${folder}/${file.rel}`;
        const target = path.join(stagingDir, ...stored.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, encryptionKey ? encryptBackupData(data, encryptionKey) : data, { flag: 'wx' });
        manifest.files.push({ vault: v.name, path: file.rel, bytes: data.length, sha256: hash(data), stored });
      }
    }
    for (const artifact of artifacts) {
      const name = String(artifact?.name || '');
      const data = Buffer.isBuffer(artifact.data) ? artifact.data : Buffer.from(String(artifact.data ?? ''));
      const stored = encryptionKey ? `objects/${randomBytes(16).toString('hex')}.bin` : 'artifacts/' + name;
      const target = path.resolve(stagingDir, ...stored.split('/'));
      if (!within(stagingDir, target)) throw new Error('Invalid backup artifact path.');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, encryptionKey ? encryptBackupData(data, encryptionKey) : data, { flag: 'wx' });
      manifest.artifacts.push({ path: name, bytes: data.length, sha256: hash(data), stored });
    }
    const manifestData = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(path.join(stagingDir, encryptionKey ? 'manifest.enc' : 'manifest.json'), encryptionKey ? encryptBackupData(manifestData, encryptionKey) : manifestData, { flag: 'wx' });
    await rename(stagingDir, backupDir);
  } catch (error) {
    // The staging path is a random, direct child of the already-verified destination.
    // Remove only this invocation's incomplete copy; a completed backup is never touched.
    if (path.dirname(stagingDir) === dest && within(dest, stagingDir)) await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { folder: backupDir, vault_count: manifest.vaults.length, file_count: manifest.files.length + manifest.artifacts.length, encrypted: Boolean(encryptionKey) };
}

export async function verifyBackup(backupDir, encryptionKey = null) {
  const root = await realpath(backupDir);
  const encrypted = await isEncryptedBackup(root);
  const manifest = await readBackupManifest(root, encryptionKey);
  const errors = validateBackupMappings(manifest, encrypted);
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object') { errors.push('Invalid backup file mapping.'); continue; }
    if (typeof file.stored !== 'string' || !file.stored || path.isAbsolute(file.stored) || file.stored.split('/').some((part) => !part || part === '.' || part === '..') || (encrypted ? !/^objects\/[a-f0-9]{32}\.bin$/.test(file.stored) : !file.stored.startsWith('vaults/'))) {
      errors.push('Invalid backup file path'); continue;
    }
    const full = path.resolve(root, ...file.stored.split('/'));
    if (!within(root, full)) { errors.push('Invalid backup file path'); continue; }
    try {
      const st = await lstat(full);
      if (!st.isFile() || st.isSymbolicLink()) { errors.push(`Unsafe file: ${file.stored}`); continue; }
      if (!within(root, await realpath(full))) { errors.push(`Unsafe file: ${file.stored}`); continue; }
      const raw = await readFile(full);
      const data = encrypted ? decryptBackupData(raw, encryptionKey) : raw;
      if (data.length !== file.bytes || hash(data) !== file.sha256) errors.push(`Hash mismatch: ${file.stored}`);
    } catch { errors.push(`Missing file: ${file.stored}`); }
  }
  for (const artifact of manifest.artifacts || []) {
    if (!artifact || typeof artifact !== 'object') { errors.push('Invalid backup artifact mapping.'); continue; }
    if (typeof artifact.path !== 'string' || artifact.path.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\')) || (encrypted ? !/^objects\/[a-f0-9]{32}\.bin$/.test(artifact.stored) : artifact.stored !== 'artifacts/' + artifact.path)) { errors.push('Invalid backup artifact path'); continue; }
    const full = path.resolve(root, ...artifact.stored.split('/'));
    if (!within(root, full)) { errors.push('Invalid backup artifact path'); continue; }
    try {
      const st = await lstat(full);
      if (!st.isFile() || st.isSymbolicLink() || !within(root, await realpath(full))) { errors.push('Unsafe backup artifact'); continue; }
      const raw = await readFile(full);
      const data = encrypted ? decryptBackupData(raw, encryptionKey) : raw;
      if (data.length !== artifact.bytes || hash(data) !== artifact.sha256) errors.push('Backup artifact hash mismatch: ' + artifact.path);
    } catch { errors.push('Missing backup artifact: ' + artifact.path); }
  }
  return { ok: errors.length === 0, vault_count: manifest.vaults.length, file_count: manifest.files.length + (manifest.artifacts || []).length, errors };
}

// Show only recent, complete backups after checking every file hash. The returned records
// contain no vault names or file paths from the manifest, which may reveal private structure.
export async function listVerifiedBackups(destination, encryptionKey = null, limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Backup history limit must be between 1 and 100.');
  const stat = await lstat(destination);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Backup destination must be a real directory.');
  const root = await realpath(destination);
  const names = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.name.startsWith('BrainLink-Backup-'))
    .sort((a, b) => b.name.localeCompare(a.name));
  const candidates = names.slice(0, limit);
  const backups = [];
  let invalid_count = 0;
  for (const entry of candidates) {
    const folder = path.join(root, entry.name);
    try {
      const candidate = await lstat(folder);
      if (!candidate.isDirectory() || candidate.isSymbolicLink() || !within(root, await realpath(folder))) { invalid_count++; continue; }
      const checked = await verifyBackup(folder, encryptionKey);
      if (!checked.ok) { invalid_count++; continue; }
      const manifest = await readBackupManifest(folder, encryptionKey);
      if (manifest.format !== 'brainlink-backup-v1' || !Number.isFinite(Date.parse(manifest.created_at))) { invalid_count++; continue; }
      backups.push({ folder, created_at: manifest.created_at, file_count: checked.file_count, vault_count: checked.vault_count, encrypted: await isEncryptedBackup(folder) });
    } catch { invalid_count++; }
  }
  backups.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.folder.localeCompare(a.folder));
  return { backups, invalid_count, truncated: names.length > limit, checked_count: candidates.length };
}

async function containsOnlyManifestFiles(root, manifest) {
  const files = new Set([(await isEncryptedBackup(root)) ? 'manifest.enc' : 'manifest.json', ...manifest.files.map((file) => file.stored), ...(manifest.artifacts || []).map((file) => file.stored)]);
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
export async function pruneBackups(destination, keepCount = 0, newestFolder = null, encryptionKey = null) {
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
      const checked = await verifyBackup(full, encryptionKey);
      if (!checked.ok) continue;
      const manifest = await readBackupManifest(full, encryptionKey);
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
      const checked = await verifyBackup(item.full, encryptionKey);
      if (!checked.ok) continue;
      const manifest = await readBackupManifest(item.full, encryptionKey);
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
export async function restoreBackupToEmpty(backupDir, destination, encryptionKey = null) {
  const check = await verifyBackup(backupDir, encryptionKey);
  if (!check.ok) throw new Error(`Backup failed verification: ${check.errors.join('; ')}`);
  const source = await realpath(backupDir);
  const stat = await lstat(destination);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Restore destination must be a real directory.');
  const targetRoot = await realpath(destination);
  if (within(source, targetRoot) || within(targetRoot, source)) throw new Error('Restore destination must be separate from the backup.');
  if ((await readdir(targetRoot)).length) throw new Error('Restore destination must be empty.');
  const encrypted = await isEncryptedBackup(source);
  const manifest = await readBackupManifest(source, encryptionKey);
  const stagingRoot = path.join(path.dirname(targetRoot), `.${path.basename(targetRoot)}.brainlink-restore-${randomBytes(8).toString('hex')}`);
  const placeholderRoot = path.join(path.dirname(targetRoot), `.${path.basename(targetRoot)}.brainlink-empty-${randomBytes(8).toString('hex')}`);
  const folders = new Map(manifest.vaults.map((vault) => [vault.name, vault.folder]));
  for (const file of manifest.files) {
    const folder = folders.get(file.vault);
    if (!folder || typeof file.path !== 'string' || path.isAbsolute(file.path) ||
        file.path.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) throw new Error('Invalid file path in backup.');
    const expected = `vaults/${folder}/${file.path}`;
    if (encrypted ? !/^objects\/[a-f0-9]{32}\.bin$/.test(file.stored) : file.stored !== expected) throw new Error('Backup file mapping does not match its vault.');
  }
  for (const artifact of manifest.artifacts || []) {
    if (typeof artifact.path !== 'string' || artifact.path.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\')) || (encrypted ? !/^objects\/[a-f0-9]{32}\.bin$/.test(artifact.stored) : artifact.stored !== 'artifacts/' + artifact.path)) throw new Error('Invalid backup artifact mapping.');
  }
  await mkdir(stagingRoot);
  let placeholderMoved = false;
  try {
    const restored = [];
    for (const file of manifest.files) {
      const raw = await readFile(path.join(source, ...file.stored.split('/')));
      const data = encrypted ? decryptBackupData(raw, encryptionKey) : raw;
      const target = path.join(stagingRoot, folders.get(file.vault), ...file.path.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data, { flag: 'wx' });
      restored.push({ target, bytes: file.bytes, sha256: file.sha256 });
    }
    for (const artifact of manifest.artifacts || []) {
      const raw = await readFile(path.join(source, ...artifact.stored.split('/')));
      const data = encrypted ? decryptBackupData(raw, encryptionKey) : raw;
      const target = path.join(stagingRoot, 'BrainLink', ...artifact.path.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data, { flag: 'wx' });
      restored.push({ target, bytes: artifact.bytes, sha256: artifact.sha256 });
    }
    for (const file of restored) {
      const data = await readFile(file.target);
      if (data.length !== file.bytes || hash(data) !== file.sha256) throw new Error('Restored copy failed verification.');
    }

    // Publish only after every recovered file has been read back and hash-checked. Move the
    // user's original empty folder aside first so the final rename is atomic on one volume.
    const current = await lstat(destination);
    if (!current.isDirectory() || current.isSymbolicLink() || await realpath(destination) !== targetRoot) {
      throw new Error('Restore destination changed during recovery.');
    }
    if ((await readdir(targetRoot)).length) throw new Error('Restore destination must stay empty until recovery finishes.');
    await rename(targetRoot, placeholderRoot);
    placeholderMoved = true;
    if ((await readdir(placeholderRoot)).length) throw new Error('Restore destination changed during recovery.');
    try {
      await rename(stagingRoot, targetRoot);
    } catch (error) {
      try {
        await rename(placeholderRoot, targetRoot);
        placeholderMoved = false;
      } catch {
        throw new Error('Could not publish the restored copy or return the original empty folder. The original folder is preserved beside the destination.');
      }
      throw error;
    }
    await rm(placeholderRoot, { recursive: false, force: true }).catch(() => {});
    placeholderMoved = false;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    if (placeholderMoved) {
      // Preserve the original empty folder if a concurrent change interrupted publication.
      await rename(placeholderRoot, targetRoot).catch(() => {});
    }
  }
  return { folder: targetRoot, vault_count: check.vault_count, file_count: check.file_count };
}
