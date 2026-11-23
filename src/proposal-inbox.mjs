// Local owner-review inbox for AI-created note proposals. Draft content stays in BrainLink's
// per-user data folder until the owner explicitly approves or discards it in authenticated Setup.
import { mkdir, readdir, readFile, writeFile, rename, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { findSecrets } from './core.mjs';

const MAX_PENDING = 100;
const MAX_CONTENT = 100_000;
const SAFE_ID = /^[a-f0-9-]{36}$/i;
const digest = (value) => createHash('sha256').update(value).digest('hex');

export function createProposalInbox({ home, now = () => new Date() }) {
  const pendingDir = path.join(home, 'proposals', 'pending');
  const resolvedDir = path.join(home, 'proposals', 'resolved');
  async function ensureDir(dir) {
    await mkdir(dir, { recursive: true });
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Proposal inbox is not a regular local folder.');
  }
  async function files(dir) {
    await ensureDir(dir);
    const names = await readdir(dir);
    const result = [];
    for (const name of names) {
      if (!SAFE_ID.test(name.replace(/\.json$/, '')) || !name.endsWith('.json')) continue;
      const full = path.join(dir, name);
      const info = await lstat(full).catch(() => null);
      if (info?.isFile() && !info.isSymbolicLink()) result.push(full);
    }
    return result;
  }
  async function readFileRecord(full) {
    const stat = await lstat(full);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONTENT + 8192) return null;
    try {
      const value = JSON.parse(await readFile(full, 'utf8'));
      if (!SAFE_ID.test(value.id) || typeof value.content !== 'string' || value.content.length > MAX_CONTENT) return null;
      return value;
    } catch { return null; }
  }
  return {
    async add({ vault, vaultPath, path: targetPath, content, tool, agent, agentVerified = false, action = 'create', expectedHash = null, header = '' }) {
      if (typeof vault !== 'string' || !vault.trim() || typeof vaultPath !== 'string' || typeof targetPath !== 'string' || typeof content !== 'string') return null;
      if (content.length > MAX_CONTENT || !content.trim() || findSecrets(content).length) return null;
      const rel = targetPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!rel.endsWith('.md') || rel.split('/').some((part) => !part || part === '.' || part === '..')) return null;
      if (!['create', 'append'].includes(action) || (action === 'append' && expectedHash !== null && !/^[a-f0-9]{64}$/i.test(expectedHash))
        || typeof header !== 'string' || header.length > 2000) return null;
      const root = await realpath(vaultPath).catch(() => null);
      if (!root) return null;
      const existing = await this.listPending();
      const key = digest(`${vault}\0${root}\0${action}\0${expectedHash || ''}\0${rel}\0${content}`);
      if (existing.some((item) => item.dedupe_key === key)) return existing.find((item) => item.dedupe_key === key);
      if (existing.length >= MAX_PENDING) throw new Error('Proposal inbox is full; review or discard existing proposals first.');
      await ensureDir(pendingDir);
      const item = { id: randomUUID(), vault, vault_ref: digest(root.toLocaleLowerCase()), path: rel, content, action,
        ...(action === 'append' ? { expected_hash: expectedHash, header } : {}),
        tool: String(tool || '').slice(0, 60), agent: String(agent || '').slice(0, 80), agent_verified: agentVerified === true,
        created_at: now().toISOString(), dedupe_key: key };
      const full = path.join(pendingDir, `${item.id}.json`);
      await writeFile(full, `${JSON.stringify(item)}\n`, { flag: 'wx', mode: 0o600 });
      return item;
    },
    async listPending() {
      const rows = [];
      for (const full of await files(pendingDir)) {
        const item = await readFileRecord(full);
        if (item) rows.push(item);
      }
      return rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
    },
    async getPending(id) {
      if (!SAFE_ID.test(String(id || ''))) return null;
      return readFileRecord(path.join(pendingDir, `${id}.json`));
    },
    async updatePending({ id, expected, path: nextPath, content: nextContent }) {
      if (!SAFE_ID.test(String(id || '')) || typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Reload the proposal before editing it.');
      const full = path.join(pendingDir, `${id}.json`), item = await readFileRecord(full);
      if (!item) throw new Error('This proposal is no longer pending. Refresh the review list.');
      const current = digest(`${item.path}\0${item.content}`);
      if (current !== expected) throw new Error('This proposal changed while you were editing it. Reload it before saving your draft.');
      const rel = String(nextPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!rel.endsWith('.md') || rel.split('/').some(part => !part || part === '.' || part === '..') || typeof nextContent !== 'string' || !nextContent.trim() || nextContent.length > MAX_CONTENT || findSecrets(nextContent).length) throw new Error('Enter a safe Markdown destination and non-empty draft without secrets.');
      if (item.action === 'append' && rel !== item.path) throw new Error('An append proposal must keep its original destination.');
      const updated = { ...item, path: rel, content: nextContent, updated_at: now().toISOString(), dedupe_key: digest(`${item.vault}\0${item.vault_ref}\0${item.action}\0${item.expected_hash || ''}\0${rel}\0${nextContent}`) };
      const temp = `${full}.${randomUUID()}.tmp`;
      await writeFile(temp, `${JSON.stringify(updated)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temp, full);
      return updated;
    },
    async resolve(id, outcome) {
      if (!SAFE_ID.test(String(id || '')) || !['approved', 'rejected'].includes(outcome)) throw new Error('Invalid proposal review action.');
      const source = path.join(pendingDir, `${id}.json`);
      const item = await readFileRecord(source);
      if (!item) throw new Error('This proposal is missing or no longer pending.');
      await ensureDir(resolvedDir);
      const destination = path.join(resolvedDir, `${id}-${outcome}.json`);
      await rename(source, destination);
      return item;
    },
  };
}
