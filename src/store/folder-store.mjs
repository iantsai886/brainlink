// Markdown-folder BrainStore adapter (contract v0.2). Keeps every note as a real .md file on
// disk; frontmatter is byte-stable on disk until the API is asked to change that note's content
// — a plain directory scan never rewrites a file. All CAS/version/session/change-log bookkeeping
// is delegated to brainlink-store's createMemoryStore (the reference implementation the contract
// is defined against); this module only adds the disk mirror and a frontmatter-aware search.
import { createMemoryStore } from 'brainlink-store';
import { mkdirSync } from 'node:fs';
import { readdir, readFile, writeFile, rename as fsRename, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { normalize } from '../config.mjs';
import { createContext, search as coreSearch } from '../core.mjs';

const SKIP_DIRS = new Set(['.git', '.obsidian', '.brainlink', 'node_modules']);

async function walkMarkdown(root) {
  const out = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(full);
    }
  }
  await walk(root);
  return out;
}

// Minimal YAML-lite frontmatter: scalars, flow lists `[a, b]` and block lists, matching the
// shapes BrainLink itself writes. Round-trips BRAIN_STANDARD_KEYS (string | string[]) exactly;
// anything more exotic (nested maps, multiline scalars) survives as a best-effort string.
function parseNoteFile(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]; const val = kv[2].trim();
    if (val === '') {
      const items = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) { items.push(lines[++i].replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, '')); }
      meta[key] = items.length ? items : '';
    } else if (/^\[.*\]$/.test(val)) {
      meta[key] = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else if (/^".*"$|^'.*'$/.test(val)) meta[key] = val.slice(1, -1);
    else if (val === 'true' || val === 'false') meta[key] = val === 'true';
    else if (/^-?\d+(\.\d+)?$/.test(val)) meta[key] = Number(val);
    else meta[key] = val;
  }
  return { meta, body: raw.slice(m[0].length) };
}

const dumpScalar = (v) => (typeof v === 'string' ? (/[:#[\]{}",\n]|^\s|\s$|^$/.test(v) ? JSON.stringify(v) : v) : String(v));
function renderNoteFile(frontmatter, body) {
  const keys = Object.keys(frontmatter || {});
  if (!keys.length) return body;
  const lines = ['---'];
  for (const k of keys) { const v = frontmatter[k]; lines.push(Array.isArray(v) ? `${k}: [${v.map(dumpScalar).join(', ')}]` : `${k}: ${dumpScalar(v)}`); }
  lines.push('---', '');
  return lines.join('\n') + body;
}

// Synchronous factory (the contract tests call it without awaiting, matching createMemoryStore's
// signature): directories are created synchronously up front, and every method awaits the
// background disk scan before touching inner state, so callers never need to know scanning
// happens at all.
export function createFolderStore(opts = {}) {
  const { vaults, clock, readOnly, logRetention, root } = opts;
  if (!Array.isArray(vaults) || !vaults.length) throw new Error('createFolderStore needs vaults');
  const vaultPaths = { ...opts.vaultPaths };
  for (const v of vaults) if (!vaultPaths[v.name]) vaultPaths[v.name] = path.join(root || process.cwd(), v.name);
  for (const dir of Object.values(vaultPaths)) mkdirSync(dir, { recursive: true });

  const inner = createMemoryStore({ vaults, clock, readOnly, logRetention });
  const diskPath = new Map(); // note id -> absolute file path on disk
  const blobDir = async (vaultName) => { const d = path.join(vaultPaths[vaultName], '.brainlink', 'blobs'); await mkdir(d, { recursive: true }); return d; };

  // Initial scan: read-only ingest of whatever is already on disk. Never writes back, so an
  // untouched note's bytes are never reformatted by just opening the store.
  const ready = (async () => {
    for (const v of vaults) {
      for (const full of await walkMarkdown(vaultPaths[v.name])) {
        const rel = path.relative(vaultPaths[v.name], full).split(path.sep).join('/');
        const raw = await readFile(full, 'utf8');
        const { meta, body } = parseNoteFile(raw);
        try {
          const w = await inner.write({ vault: v.name, path: rel, body, frontmatter: meta }, { expected_etag: '' });
          diskPath.set(w.id, full);
        } catch { /* unreadable/duplicate on disk: skip, keep the folder untouched */ }
      }
    }
  })();

  async function writeNoteToDisk(vaultName, relPath, frontmatter, body, noteId) {
    const target = path.join(vaultPaths[vaultName], relPath);
    const prev = diskPath.get(noteId);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, renderNoteFile(frontmatter, body));
    if (prev && prev !== target) await unlink(prev).catch(() => {}); // path changed: drop the stale file, new content is already at target
    diskPath.set(noteId, target);
  }

  // Lazy, cached search context over the same directories (src/core.mjs reads disk directly, so
  // it always reflects whatever the disk-sync above last wrote).
  let searchCtx = null;
  function getSearchCtx() {
    if (!searchCtx) {
      const cfg = normalize({ vaults: vaults.map((v) => ({ name: v.name, path: vaultPaths[v.name], private: v.private })) });
      // Unrestricted: a free-plan vault cap is a licensing concern for the MCP server, not this store adapter.
      searchCtx = createContext(cfg, { env: {}, license: { valid: true, plan: 'personal' } });
    }
    return searchCtx;
  }
  const allowed = (vaultName, o = {}) => {
    const v = vaults.find((x) => x.name === vaultName); if (!v) return false;
    if (o.remote && v.private) return false;
    return !o.vaults || o.vaults.includes(vaultName);
  };

  // Every async method waits for the background scan first, so a caller never has to know
  // ingesting the folder takes a tick; vaults()/subscribe() are synchronous in the contract and
  // pass straight through (scanning never changes the vault list or needs to precede a subscribe).
  const GATED = ['read', 'list', 'history', 'supersede', 'delete', 'links', 'backlinks', 'changes',
    'snapshot', 'snapshots', 'putSession', 'appendSession', 'listSessions', 'readSession', 'setSessionPrivate'];
  const passthrough = {};
  for (const name of GATED) passthrough[name] = async (...args) => { await ready; return inner[name](...args); };

  const store = {
    vaults: inner.vaults,
    subscribe: inner.subscribe,
    ...passthrough,

    async write(input, o = {}) {
      await ready;
      const r = await inner.write(input, o);
      const n = await inner.read(r.id);
      await writeNoteToDisk(n.vault, n.path, n.frontmatter, n.body, n.id);
      return r;
    },
    async rename(id, newPath, o = {}) {
      await ready;
      const before = await inner.read(id);
      const r = await inner.rename(id, newPath, o);
      const prev = diskPath.get(id);
      const target = path.join(vaultPaths[before.vault], newPath);
      await mkdir(path.dirname(target), { recursive: true });
      if (prev) await fsRename(prev, target).catch(async () => writeFile(target, renderNoteFile(before.frontmatter, before.body)));
      else await writeFile(target, renderNoteFile(before.frontmatter, before.body));
      diskPath.set(id, target);
      return r;
    },
    async revert(id, o = {}) {
      await ready;
      const r = await inner.revert(id, o);
      const n = await inner.read(id);
      await writeNoteToDisk(n.vault, n.path, n.frontmatter, n.body, n.id);
      return r;
    },
    // supersede/delete only change metadata (superseded_by/at, deleted) — content and path are
    // untouched, so the file on disk is left exactly as it was.

    async putBlob(data, meta = {}) {
      await ready;
      const a = await inner.putBlob(data, meta);
      const vaultName = vaults[0]?.name;
      if (vaultName) { const dir = await blobDir(vaultName); await writeFile(path.join(dir, a.sha256), data).catch(() => {}); }
      return a;
    },
    async getBlob(sha256) {
      await ready;
      try { return await inner.getBlob(sha256); }
      catch (e) {
        for (const v of vaults) {
          try { return await readFile(path.join(vaultPaths[v.name], '.brainlink', 'blobs', sha256)); } catch {}
        }
        throw e;
      }
    },

    async search(query, o = {}) {
      await ready;
      const limit = o.limit || 5;
      const scopeVaults = (o.scope ? [o.scope] : vaults.map((v) => v.name)).filter((name) => allowed(name, o));
      const hits = [];
      for (const name of scopeVaults) {
        const results = await coreSearch(getSearchCtx(), name, query, { limit, semantic: false });
        for (const r of results) {
          try { const note = await inner.read(`${name}:${r.path}`); hits.push({ id: note.id, title: r.title, snippet: (r.snippet || '').slice(0, 160), score: r.score, sha12: note.etag.slice(0, 12) }); }
          catch { /* file matched on disk but not yet reflected in the index: skip this hit */ }
        }
      }
      if (o.includeSessions) {
        const all = await inner.search(query, { ...o, limit: 200 });
        hits.push(...all.filter((h) => h.id.startsWith('s_')));
      }
      hits.sort((a, b) => b.score - a.score);
      return hits.slice(0, limit);
    },
  };
  return store;
}
