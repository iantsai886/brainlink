// Local, explicit review of the one BrainLink memory note. This is not an MCP tool.
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { vaultRoot } from './core.mjs';

const MAX_BYTES = 90000;
const initial = '# Memories\n\nFacts every connected AI should know.\n\n';
const digest = (text) => createHash('sha256').update(text).digest('hex');

async function locations(ctx, vaultName, createDirectory = false) {
  if (!ctx.enabled.includes(vaultName)) throw new Error('Unknown vault.');
  const root = vaultRoot(ctx, vaultName);
  const dir = path.join(root, 'BrainLink');
  if (createDirectory) await mkdir(dir, { recursive: false }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  const directory = await lstat(dir).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (directory && (directory.isSymbolicLink() || !directory.isDirectory())) throw new Error('The BrainLink folder is not a regular directory.');
  const file = path.join(dir, 'Memories.md');
  const info = directory ? await lstat(file).catch((error) => { if (error.code === 'ENOENT') return null; throw error; }) : null;
  if (info && (info.isSymbolicLink() || !info.isFile())) throw new Error('The memory note is not a regular file.');
  if (info && info.size > MAX_BYTES) throw new Error('The memory note is too large to edit here.');
  return { file, exists: Boolean(info) };
}

export async function readMemoryForReview(ctx, vaultName) {
  const { file, exists } = await locations(ctx, vaultName);
  const text = exists ? await readFile(file, 'utf8') : initial;
  return { text, etag: exists ? digest(text) : null, exists, writable: !ctx.readOnly && ctx.byName.get(vaultName).writes === 'on' };
}

export async function saveMemoryForReview(ctx, vaultName, text, etag) {
  if (ctx.readOnly || ctx.byName.get(vaultName)?.writes !== 'on') throw new Error('This vault does not allow direct edits.');
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('Memory note is missing or too large.');
  const { file, exists } = await locations(ctx, vaultName, true);
  const current = exists ? await readFile(file, 'utf8') : null;
  if ((current === null && etag !== null) || (current !== null && digest(current) !== etag)) throw new Error('The memory note changed. Reload before saving.');
  if (current === null) {
    try { await writeFile(file, text, { flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('The memory note changed. Reload before saving.'); throw error; }
  } else {
    const temp = `${file}.brainlink-${randomBytes(6).toString('hex')}.tmp`;
    try { await writeFile(temp, text, { flag: 'wx' }); await rename(temp, file); }
    catch (error) { await unlink(temp).catch(() => {}); throw error; }
  }
  return { ok: true, etag: digest(text) };
}
