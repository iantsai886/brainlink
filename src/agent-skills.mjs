import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, lstat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseDocument } from 'yaml';

const RECEIPT_VERSION = 1;
const supported = new Set(['claude-code', 'codex', 'gemini', 'antigravity', 'antigravity-cli', 'hermes', 'deepseek-harness']);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const inside = (root, target) => {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};

export function skillClientRoot(client, { home = os.homedir(), env = process.env } = {}) {
  if (String(client).startsWith('deepseek-harness@')) client = 'deepseek-harness';
  if (client === 'claude-code') return path.join(home, '.claude', 'skills');
  if (client === 'codex') return path.join(env.CODEX_HOME || path.join(home, '.codex'), 'skills');
  if (client === 'gemini') return path.join(home, '.gemini', 'skills');
  if (client === 'antigravity') return path.join(home, '.gemini', 'config', 'skills');
  if (client === 'antigravity-cli') return path.join(home, '.gemini', 'antigravity-cli', 'skills');
  if (client === 'hermes') {
    const configDir = env.HERMES_HOME || path.join(home, '.hermes');
    return path.join(configDir, 'skills');
  }
  if (client === 'deepseek-harness') return path.join(env.DSH_HOME || path.join(home, '.dsh'), 'skills');
  throw new Error('BrainLink skills are not supported for this AI client yet.');
}

async function loadCatalog(sourceRoot) {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const skills = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) continue;
    const file = path.join(sourceRoot, entry.name, 'SKILL.md');
    const info = await lstat(file).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`The bundled skill ${entry.name} is not a regular file.`);
    const body = await readFile(file);
    const text = body.toString('utf8');
    // Windows checkouts can use CRLF. Normalize only for parsing; preserve the source bytes.
    const normalizedText = text.replace(/\r\n/g, '\n');
    if (normalizedText.startsWith('\uFEFF') || !normalizedText.startsWith('---\n')) throw new Error(`The bundled skill ${entry.name} has invalid Agent Skills metadata.`);
    const end = normalizedText.indexOf('\n---', 4);
    if (end < 0) throw new Error(`The bundled skill ${entry.name} has invalid Agent Skills metadata.`);
    const doc = parseDocument(normalizedText.slice(4, end), { uniqueKeys: true });
    if (doc.errors.length) throw new Error(`The bundled skill ${entry.name} has invalid Agent Skills metadata.`);
    const metadata = doc.toJS();
    if (metadata?.name !== entry.name || typeof metadata.description !== 'string' || !metadata.description.trim()) {
      throw new Error(`The bundled skill ${entry.name} does not match its Agent Skills metadata.`);
    }
    skills.push({ name: entry.name, body, hash: digest(body) });
  }
  return skills;
}

async function loadReceipt(file) {
  const raw = await readFile(file, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (raw === null) return { version: RECEIPT_VERSION, clients: {} };
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('BrainLink skill install record is damaged; no skill files were changed.'); }
  if (value?.version !== RECEIPT_VERSION || !value.clients || typeof value.clients !== 'object' || Array.isArray(value.clients)) {
    throw new Error('BrainLink skill install record is not supported; no skill files were changed.');
  }
  return value;
}

async function writeAtomic(file, data, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, data, { flag: 'wx', mode });
    if (process.platform !== 'win32') await import('node:fs/promises').then(({ chmod }) => chmod(temp, mode));
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function assertSafeRoot(root) {
  const absolute = path.resolve(root);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (info?.isSymbolicLink()) throw new Error('The AI skill folder contains a symbolic link; BrainLink left it unchanged.');
    if (info && !info.isDirectory()) throw new Error('The AI skill folder path contains a non-folder item; BrainLink left it unchanged.');
  }
  return absolute;
}

async function acquireLock(file) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  let handle;
  try { handle = await import('node:fs/promises').then(({ open }) => open(lock, 'wx', 0o600)); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another BrainLink skill install is running. Try again when it finishes.');
    throw error;
  }
  return async () => { await handle.close().catch(() => {}); await rm(lock, { force: true }).catch(() => {}); };
}

function receiptHash(record, name) {
  const value = record?.skills?.[name];
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

export async function installAgentSkills({ client, sourceRoot, stateDir, home, env = process.env } = {}) {
  const clientId = String(client || '').startsWith('deepseek-harness@') ? 'deepseek-harness' : String(client || '');
  if (!supported.has(clientId)) throw new Error('Choose Claude Code, Codex, Gemini CLI, Google Antigravity, Hermes Agent, or DeepSeek Harness.');
  const targetRoot = skillClientRoot(client, { home, env });
  if (!path.isAbsolute(targetRoot)) throw new Error('The AI skill folder must resolve to an absolute path.');
  const sourceSkills = await loadCatalog(sourceRoot);
  if (!sourceSkills.length) throw new Error('BrainLink has no installable skills.');
  const receiptFile = path.join(stateDir, 'agent-skills.json');
  const release = await acquireLock(receiptFile);
  try {
    const root = await assertSafeRoot(targetRoot);
    const receipt = await loadReceipt(receiptFile);
    const previous = receipt.clients[clientId];
    if (previous?.root && path.resolve(previous.root) !== root) throw new Error('The saved BrainLink skill location changed; reconcile the previous install before continuing.');
    const actions = [];
    const snapshots = new Map();
    for (const skill of sourceSkills) {
      const dir = path.join(root, skill.name);
      const file = path.join(dir, 'SKILL.md');
      if (!inside(root, file)) throw new Error('The skill path is invalid.');
      const dirInfo = await lstat(dir).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (dirInfo && (!dirInfo.isDirectory() || dirInfo.isSymbolicLink())) throw new Error(`The existing ${skill.name} skill path is not a regular folder; no skills were changed.`);
      const fileInfo = await lstat(file).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (fileInfo && (!fileInfo.isFile() || fileInfo.isSymbolicLink())) throw new Error(`The existing ${skill.name}/SKILL.md is not a regular file; no skills were changed.`);
      const oldBody = fileInfo ? await readFile(file) : null;
      const oldHash = oldBody ? digest(oldBody) : null;
      const managedHash = receiptHash(previous, skill.name);
      if (oldHash && oldHash !== skill.hash && oldHash !== managedHash) throw new Error(`The existing ${skill.name} skill differs from BrainLink's last copy; no skills were changed.`);
      actions.push({ ...skill, dir, file, oldBody, oldHash, action: oldHash === skill.hash ? 'unchanged' : oldHash ? 'updated' : 'installed' });
      snapshots.set(file, oldBody);
    }

    const nextSkills = Object.fromEntries(actions
      .filter((item) => item.action !== 'unchanged' || receiptHash(previous, item.name) === item.hash)
      .map((item) => [item.name, item.hash]));
    const nextRecord = { root, skills: nextSkills };
    const oldRecord = previous;
    try {
      for (const action of actions) {
        if (action.action === 'unchanged') continue;
        await mkdir(action.dir, { recursive: true, mode: 0o700 });
        await writeAtomic(action.file, action.body, 0o600);
      }
      receipt.clients[clientId] = nextRecord;
      await writeAtomic(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
    } catch (error) {
      for (const [file, body] of [...snapshots].reverse()) {
        try { if (body === null) await rm(file, { force: true }); else await writeAtomic(file, body, 0o600); } catch { /* preserve the original failure; receipt remains the recovery source */ }
      }
      if (oldRecord) receipt.clients[clientId] = oldRecord;
      else delete receipt.clients[clientId];
      throw error;
    }
    return { client: clientId, root, installed: actions.filter((item) => item.action === 'installed').map((item) => item.name), updated: actions.filter((item) => item.action === 'updated').map((item) => item.name), unchanged: actions.filter((item) => item.action === 'unchanged').map((item) => item.name) };
  } finally { await release(); }
}

export async function removeAgentSkills({ client, stateDir, home, env = process.env } = {}) {
  const clientId = String(client || '').startsWith('deepseek-harness@') ? 'deepseek-harness' : String(client || '');
  if (!supported.has(clientId)) throw new Error('Choose Claude Code, Codex, Gemini CLI, Google Antigravity, Hermes Agent, or DeepSeek Harness.');
  const receiptFile = path.join(stateDir, 'agent-skills.json');
  const release = await acquireLock(receiptFile);
  try {
    const receipt = await loadReceipt(receiptFile);
    const record = receipt.clients[clientId];
    if (!record) return { client: clientId, removed: [], changed: [] };
    const expectedRoot = path.resolve(skillClientRoot(client, { home, env }));
    if (path.resolve(record.root || '') !== expectedRoot) throw new Error('The saved BrainLink skill location changed; no skill files were removed.');
    const root = await assertSafeRoot(expectedRoot);
    const removed = [], changed = [];
    for (const [name, expectedHash] of Object.entries(record.skills || {})) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !/^[a-f0-9]{64}$/.test(expectedHash)) continue;
      const dir = path.join(root, name), file = path.join(dir, 'SKILL.md');
      const dirInfo = await lstat(dir).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (dirInfo && (!dirInfo.isDirectory() || dirInfo.isSymbolicLink())) { changed.push(name); continue; }
      const info = await lstat(file).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!info) continue;
      if (!info.isFile() || info.isSymbolicLink() || digest(await readFile(file)) !== expectedHash) { changed.push(name); continue; }
      await rm(file);
      const children = await readdir(dir).catch(() => ['unknown']);
      if (!children.length) await rm(dir, { recursive: false }).catch(() => {});
      removed.push(name);
    }
    const remainingSkills = Object.fromEntries(Object.entries(record.skills || {}).filter(([name]) => changed.includes(name)));
    if (Object.keys(remainingSkills).length) receipt.clients[clientId] = { ...record, skills: remainingSkills };
    else delete receipt.clients[clientId];
    if (Object.keys(receipt.clients).length) await writeAtomic(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
    else await rm(receiptFile, { force: true });
    return { client: clientId, removed, changed };
  } finally { await release(); }
}

export async function inspectAgentSkills({ client, sourceRoot, stateDir, home, env = process.env } = {}) {
  const clientId = String(client || '').startsWith('deepseek-harness@') ? 'deepseek-harness' : String(client || '');
  if (!supported.has(clientId)) return { supported: false, skills: [] };
  const root = await assertSafeRoot(skillClientRoot(client, { home, env }));
  const sourceSkills = await loadCatalog(sourceRoot);
  const receipt = await loadReceipt(path.join(stateDir, 'agent-skills.json'));
  const record = receipt.clients[clientId];
  const skills = [];
  for (const skill of sourceSkills) {
    const dir = path.join(root, skill.name), file = path.join(dir, 'SKILL.md');
    const dirInfo = await lstat(dir).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (dirInfo && (!dirInfo.isDirectory() || dirInfo.isSymbolicLink())) { skills.push({ name: skill.name, state: 'conflict' }); continue; }
    const info = await lstat(file).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (info && (!info.isFile() || info.isSymbolicLink())) { skills.push({ name: skill.name, state: 'conflict' }); continue; }
    const current = info ? await readFile(file) : null;
    const currentHash = current && digest(current);
    const owned = path.resolve(record?.root || '') === path.resolve(root) && receiptHash(record, skill.name) === currentHash;
    skills.push({ name: skill.name, state: currentHash === skill.hash ? (owned ? 'managed' : 'current') : currentHash ? (owned ? 'update-available' : 'conflict') : 'missing' });
  }
  return { supported: true, root, skills };
}
