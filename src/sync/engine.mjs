// Sync engine over a BrainStore (see brainlink-store interface.d.ts). Target = a folder an OS client syncs.
// Rules: local-only default; only 'brain' scope, non-private notes leave the device; session index is redacted;
// both-sides-changed keeps both copies and flags them; offline = no-op + queued; snapshot before any local apply;
// remote writes are temp-file + rename; nothing is ever deleted.
import { readFile, writeFile, rename, mkdir, readdir, access, constants } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { syncSettings, isPrivateNote } from './settings.mjs';
import { redactDeep } from './redact.mjs';

const ROOT = 'BrainLink';
const sha = (s) => createHash('sha256').update(s).digest('hex');

export function serialize(n) {
  const fm = Object.entries(n.frontmatter || {}).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  return fm ? `---\n${fm}\n---\n${n.body}` : n.body;
}
export function parse(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return { frontmatter: {}, body: text };
  const frontmatter = {};
  for (const l of m[1].split('\n')) { const i = l.indexOf(':'); if (i < 1) continue; const v = l.slice(i + 1).trim(); try { frontmatter[l.slice(0, i).trim()] = JSON.parse(v); } catch { frontmatter[l.slice(0, i).trim()] = v; } }
  return { frontmatter, body: text.slice(m[0].length) };
}

export async function atomicWrite(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export function conflictName(p, device, at) {
  const d = at.slice(0, 10), ext = path.extname(p) || '.md';
  return `${p.slice(0, p.length - ext.length)} (conflict ${device} ${d})${ext}`;
}

async function online(dir) { try { await access(dir, constants.R_OK | constants.W_OK); return true; } catch { return false; } }
async function walk(dir, base = dir) {
  let out = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(await walk(f, base));
    else if (e.name.endsWith('.md') && !e.name.includes('.tmp-')) out.push(path.relative(base, f).split(path.sep).join('/'));
  }
  return out;
}

const emptyState = () => ({ files: {}, conflicts: [], queued: false, last: null });

// One pass. state is the device-local sync state (persist it with saveState). sessions = session index entries.
export async function syncOnce({ store, cfg = {}, state = emptyState(), sessions = [], now = () => new Date().toISOString() }) {
  const s = syncSettings(cfg);
  const r = { status: 'ok', pushed: [], pulled: [], conflicts: [], snapshot: null, sessions: 0 };
  if (s.provider === 'local') return { ...r, status: 'local-only', state };
  if (!(await online(s.folder))) return { ...r, status: 'queued', state: { ...state, queued: true } };
  const notesDir = path.join(s.folder, ROOT, 'notes');
  const st = { ...emptyState(), ...state, files: { ...state.files }, conflicts: [...(state.conflicts || [])] };
  const local = new Map();
  for (const sum of await store.list({ scopes: ['brain'] })) {
    const n = await store.read(sum.id, { scopes: ['brain'] });
    if (!isPrivateNote(n, cfg)) local.set(n.path, n);
  }
  const remote = new Map();
  for (const p of await walk(notesDir)) remote.set(p, await readFile(path.join(notesDir, p), 'utf8'));
  const plan = [];
  for (const p of new Set([...local.keys(), ...remote.keys()])) {
    const n = local.get(p), txt = remote.get(p), prev = st.files[p] || {};
    const lc = n && n.etag !== prev.etag, rh = txt != null ? sha(txt) : null, rc = rh && rh !== prev.rhash;
    if (n && txt != null && serialize(n) === txt) { st.files[p] = { etag: n.etag, rhash: rh }; continue; }
    if (n && (txt == null || (lc && !rc))) plan.push({ op: 'push', p, n });
    else if (txt != null && (!n || (rc && !lc))) plan.push({ op: 'pull', p, n, txt, rh });
    else if (lc && rc) plan.push({ op: 'conflict', p, n, txt, rh });
  }
  if (plan.some((x) => x.op !== 'push')) r.snapshot = await store.snapshot(`pre-sync ${now()}`);
  for (const x of plan) {
    if (x.op === 'push') { const t = serialize(x.n); await atomicWrite(path.join(notesDir, x.p), t); st.files[x.p] = { etag: x.n.etag, rhash: sha(t) }; r.pushed.push(x.p); }
    if (x.op === 'pull') {
      const { frontmatter, body } = parse(x.txt);
      const w = await store.write({ path: x.p, body, frontmatter, scope: 'brain', author: 'sync' }, { expected_etag: x.n?.etag ?? '' });
      st.files[x.p] = { etag: w.etag, rhash: x.rh }; r.pulled.push(x.p);
    }
    if (x.op === 'conflict') {
      // Keep both: local stays at its path; the remote version is saved as a flagged copy on both sides.
      const cp = conflictName(x.p, 'remote', now());
      const { frontmatter, body } = parse(x.txt);
      const w = await store.write({ path: cp, body, frontmatter: { ...frontmatter, sync_conflict: x.p }, scope: 'brain', author: 'sync' }, { expected_etag: '' });
      const mine = conflictName(x.p, s.device, now()), t = serialize(x.n);
      await atomicWrite(path.join(notesDir, mine), t);
      st.files[cp] = { etag: w.etag, rhash: null }; st.files[mine] = { etag: null, rhash: sha(t) };
      st.files[x.p] = { etag: x.n.etag, rhash: x.rh, conflict: true };
      const c = { path: x.p, copies: [cp, mine], at: now() }; r.conflicts.push(c); st.conflicts.push(c);
    }
  }
  // Session index: one file per device so devices never collide; private entries dropped, secrets redacted.
  const pub = sessions.filter((e) => !e.private && (!e.scope || e.scope === 'brain')).map(redactDeep);
  await atomicWrite(path.join(s.folder, ROOT, 'sessions', `${s.device}.json`), JSON.stringify({ device: s.device, at: now(), sessions: pub }, null, 1));
  r.sessions = pub.length;
  st.queued = false; st.last = now();
  return { ...r, state: st };
}

// Merged session index from every device's file in the sync folder.
export async function readSessionIndex(folder) {
  const dir = path.join(folder, ROOT, 'sessions'); const out = [];
  for (const f of await readdir(dir).catch(() => [])) if (f.endsWith('.json')) out.push(...JSON.parse(await readFile(path.join(dir, f), 'utf8')).sessions);
  return out;
}

// Undo a sync pass: every note back to its state in the pre-sync snapshot (as new versions; history kept).
export async function restoreSnapshot(store, snapshotId) {
  const out = [];
  for (const sum of await store.list({ scopes: ['brain'] })) out.push(await store.revert(sum.id, { expected_etag: sum.etag, to_snapshot: snapshotId }));
  return out;
}

export async function loadState(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return emptyState(); } }
export async function saveState(file, st) { await atomicWrite(file, JSON.stringify(st)); }
