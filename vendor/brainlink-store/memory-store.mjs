// BrainLink store contract v0.1 — in-memory reference implementation (Made by Claude 886, 2026-10-19).
// Behaviour here IS the contract; the SQLite store must pass the same contract-tests.mjs.
import { createHash } from 'node:crypto';
import { NotFound, Conflict, Invalid, PrivacyDenied, Superseded, ReadOnly, SnapshotNotFound, CursorExpired } from './errors.mjs';

export const STORE_CONTRACT_VERSION = '0.2';
export const BRAIN_STANDARD_KEYS = Object.freeze(['type', 'status', 'owner', 'ai_platform', 'agent_or_role',
  'session_or_task_id', 'written_at', 'source', 'confidence', 'tags', 'aliases']);

const SECRET_PATTERNS = [ // same set as BrainLink v1.1 core findSecrets(); kinds only, never the text
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'], [/\bsk-[A-Za-z0-9_-]{20,}/, 'API key (sk-)'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'], [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/, 'Slack token'], [/\bBL1\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, 'BrainLink licence key'],
  [/\b(?:\d[ -]?){13,19}\b/, 'card/account-like number'], [/\b[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/, 'long token-like string'],
];
export const findSecretKinds = (text) => SECRET_PATTERNS.filter(([re]) => re.test(String(text))).map(([, k]) => k);

const sha = (s) => createHash('sha256').update(s).digest('hex');
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
export const etagOf = (n) => sha(JSON.stringify(canon({ path: n.path, frontmatter: n.frontmatter || {}, body: n.body, deleted: !!n.deleted,
  superseded_by: n.superseded_by || null, superseded_at: n.superseded_at || null })));

const LINK_RE = /(!?)\[\[([^\]|#]+)(?:#([^\]|]*))?(?:\|[^\]]*)?\]\]/g;
export function parseLinks(body) {
  const out = []; const noCode = String(body).replace(/```[\s\S]*?```|`[^`\n]*`/g, '');
  for (const m of noCode.matchAll(LINK_RE)) out.push({ target_text: m[2].trim() + (m[3] ? '#' + m[3] : ''), kind: m[1] ? 'embed' : 'link', heading: (m[3] || '').trim() });
  return out;
}
const titleOf = (path) => path.split('/').pop().replace(/\.md$/i, '');
const norm = (s) => s.normalize('NFKC').toLowerCase().trim();

export const toSessionRecord = (s) => ({ id: s.id, client: s.client, project: s.project, started_at: s.started_at, turns: s.message_count, summary: s.summary, private: s.private });

function checkPath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || /(^|\/)\.\.(\/|$)|\\|\0/.test(path)) throw new Invalid('bad path', { path });
  if (/(^|\/)\.obsidian(\/|$)/.test(path)) throw new Invalid('.obsidian is not note content', { path });
}
function checkFrontmatter(fm) {
  if (fm == null) return {};
  if (typeof fm !== 'object' || Array.isArray(fm)) throw new Invalid('frontmatter must be a map');
  for (const k of BRAIN_STANDARD_KEYS) if (k in fm) {
    const v = fm[k]; const ok = typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
    if (!ok) throw new Invalid(`frontmatter.${k} must be string or string[]`, { key: k });
  }
  return structuredClone(fm);
}

export function createMemoryStore({ vaults, readOnly = false, clock = () => new Date().toISOString(), logRetention = Infinity } = {}) {
  if (!Array.isArray(vaults) || !vaults.length) throw new Invalid('vaults required');
  const V = new Map(vaults.map((v) => [v.name, { name: v.name, private: !!v.private }]));
  const notes = new Map();      // id -> [versions...] (each a full Note)
  const blobs = new Map();      // sha -> {data, meta}
  const sessions = new Map();   // id -> {s, msgs}
  const log = []; let pruned = 0; let idn = 0;
  const snaps = []; const subs = new Set();

  const allowed = (vault, o = {}) => {
    const v = V.get(vault); if (!v) return false;
    if (o.remote && v.private) return false;
    return !o.vaults || o.vaults.includes(vault);
  };
  const guard = (vault, o) => { if (!V.has(vault)) throw new Invalid('unknown vault', { vault }); if (!allowed(vault, o)) throw new PrivacyDenied('vault not available to this caller', { vault }); };
  const writable = () => { if (readOnly) throw new ReadOnly('store is read-only'); };
  const newId = (p) => `${p}_${Date.now().toString(32)}${(++idn).toString(32).padStart(6, '0')}`;
  const cur = (id) => notes.get(id)?.at(-1);
  const byPath = (vault, path) => { for (const vs of notes.values()) { const n = vs.at(-1); if (n.vault === vault && n.path === path && !n.deleted) return n; } return null; };
  const resolve = (ref) => { if (notes.has(ref)) return ref; const i = ref.indexOf(':'); if (i > 0) { const n = byPath(ref.slice(0, i), ref.slice(i + 1)); if (n) return n.id; } return null; };
  const emit = (e) => {
    const ev = { seq: pruned + log.length + 1, at: clock(), ...e }; log.push(ev);
    while (log.length > logRetention) { log.shift(); pruned++; }
    for (const s of subs) if (allowed(ev.vault, s.o)) s.fn(ev);
    return ev.seq;
  };
  const commit = (prev, next, kind, extra = {}) => {
    const n = { ...next, version: (prev?.version || 0) + 1, updated_at: clock() };
    n.title = typeof n.frontmatter?.title === 'string' ? n.frontmatter.title : titleOf(n.path);
    n.etag = etagOf(n);
    n.attachments = parseLinks(n.body).filter((l) => l.kind === 'embed').map((l) => l.target_text).filter((t) => /^[a-f0-9]{64}$/.test(t));
    if (!notes.has(n.id)) notes.set(n.id, []);
    notes.get(n.id).push(n);
    const seq = emit({ kind, vault: n.vault, id: n.id, version: n.version, etag: n.etag, path: n.path, ...extra });
    return { id: n.id, version: n.version, etag: n.etag, path: n.path, seq };
  };
  const cas = (id, expected, o) => {
    const n = cur(id); if (!n) throw new NotFound('note', { id }); guard(n.vault, o); writable();
    if (expected !== n.etag) throw new Conflict('etag mismatch', { id, current_etag: n.etag });
    return n;
  };
  const resolveTarget = (src, text) => {
    const t = norm(text.split('#')[0]);
    if (/^[a-f0-9]{64}$/.test(t)) return null; // blob embed
    let hit = null;
    for (const vs of notes.values()) {
      const n = vs.at(-1); if (n.vault !== src.vault || n.deleted) continue;
      const p = norm(n.path.replace(/\.md$/i, ''));
      if (p === t || norm(n.title) === t || p.endsWith('/' + t)) { hit = n; if (!n.superseded_by) break; }
      else if ([].concat(n.frontmatter?.aliases || []).some((a) => norm(String(a)) === t)) hit ||= n;
    }
    return hit?.id || null;
  };
  const sessionOut = (x) => structuredClone(x.s);
  const pub = ({ _kind, ...n }) => structuredClone(n);

  const api = {
    vaults: () => [...V.values()].map((v) => ({ ...v })),

    async read(ref, o = {}) {
      const id = resolve(ref); if (!id) throw new NotFound('note', { ref });
      const vs = notes.get(id); guard(vs[0].vault, o);
      if (o.version == null) return pub(vs.at(-1));
      const v = vs[o.version - 1]; if (!v) throw new NotFound('version', { id, version: o.version });
      return pub(v);
    },
    async list(o = {}) {
      const folder = o.folder ? o.folder.replace(/\/?$/, '/') : '';
      return [...notes.values()].map((vs) => vs.at(-1))
        .filter((n) => allowed(n.vault, o) && (!o.vault || n.vault === o.vault) && n.path.startsWith(folder)
          && (o.include_superseded || !n.superseded_by) && (o.include_deleted || !n.deleted) && (!o.after || n.path > o.after))
        .sort((a, b) => a.vault.localeCompare(b.vault) || a.path.localeCompare(b.path)).slice(0, o.limit || 100)
        .map((n) => ({ id: n.id, vault: n.vault, path: n.path, title: n.title, version: n.version, etag: n.etag, updated_at: n.updated_at, superseded: !!n.superseded_by, deleted: n.deleted }));
    },
    async history(id, o = {}) {
      const vs = notes.get(id); if (!vs) throw new NotFound('note', { id }); guard(vs[0].vault, o);
      return vs.map((n) => ({ note_id: id, version: n.version, etag: n.etag, kind: n._kind, at: n.updated_at, author: n.author, path: n.path }));
    },
    async write(input, o = {}) {
      const { vault, path, body } = input; guard(vault, o); writable(); checkPath(path);
      if (typeof body !== 'string') throw new Invalid('body must be a string');
      const frontmatter = checkFrontmatter(input.frontmatter);
      if (typeof o.expected_etag !== 'string') throw new Invalid('expected_etag required ("" for create)');
      if (o.expected_etag === '') {
        if (input.id && notes.has(input.id)) throw new Conflict('id exists', { id: input.id, current_etag: cur(input.id).etag });
        const taken = byPath(vault, path); if (taken) throw new Conflict('path exists', { id: taken.id, current_etag: taken.etag });
        return commit(null, { id: input.id || newId('n'), vault, path, frontmatter, body, author: input.author || '', superseded_by: null, superseded_at: null, deleted: false, _kind: 'create' }, 'create');
      }
      const id = input.id || byPath(vault, path)?.id; if (!id) throw new NotFound('note', { vault, path });
      const n = cas(id, o.expected_etag, o);
      if (n.superseded_by && !o.allow_superseded) throw new Superseded('note is superseded', { id, superseded_by: n.superseded_by });
      if (path !== n.path) { const t = byPath(vault, path); if (t && t.id !== id) throw new Invalid('path taken', { path }); }
      return commit(n, { ...n, path, frontmatter, body, author: input.author || n.author, _kind: 'update' }, 'update', path !== n.path ? { old_path: n.path } : {});
    },
    async rename(id, new_path, o = {}) {
      checkPath(new_path); const n = cas(id, o.expected_etag, o);
      const t = byPath(n.vault, new_path); if (t && t.id !== id) throw new Invalid('path taken', { path: new_path });
      return commit(n, { ...n, path: new_path, _kind: 'rename' }, 'rename', { old_path: n.path });
    },
    async supersede(old_id, new_id, o = {}) {
      const n = cas(old_id, o.expected_etag, o);
      const r = cur(new_id); if (!r) throw new NotFound('replacement', { id: new_id });
      if (new_id === old_id) throw new Invalid('cannot supersede with itself');
      const at = o.at || clock();
      if (!/^\d{4}-\d{2}-\d{2}/.test(at)) throw new Invalid('at must be ISO date');
      return commit(n, { ...n, superseded_by: new_id, superseded_at: at, _kind: 'supersede' }, 'supersede');
    },
    async delete(id, o = {}) { const n = cas(id, o.expected_etag, o); return commit(n, { ...n, deleted: true, _kind: 'delete' }, 'delete'); },
    async revert(id, o = {}) {
      const n = cas(id, o.expected_etag, o); const vs = notes.get(id); let target;
      if (o.to_version != null) target = vs[o.to_version - 1];
      else if (o.to_snapshot) {
        const s = snaps.find((x) => x.id === o.to_snapshot); if (!s) throw new SnapshotNotFound('snapshot', { id: o.to_snapshot });
        const v = s.versions.get(id);
        target = v ? vs[v - 1] : { ...n, deleted: true }; // note did not exist at snapshot time -> tombstone
      } else throw new Invalid('to_version or to_snapshot required');
      if (!target) throw new NotFound('version', { id, version: o.to_version });
      if (target.path !== n.path) { const t = byPath(n.vault, target.path); if (t && t.id !== id) throw new Conflict('path now used by another note', { id: t.id, current_etag: t.etag }); }
      const { path, frontmatter, body, deleted, superseded_by, superseded_at } = target;
      return commit(n, { ...n, path, frontmatter: structuredClone(frontmatter), body, deleted, superseded_by, superseded_at, _kind: 'revert' }, 'revert');
    },

    async links(id, o = {}) {
      const n = cur(id); if (!n) throw new NotFound('note', { id }); guard(n.vault, o);
      return parseLinks(n.body).map((l) => ({ src_id: id, target_id: resolveTarget(n, l.target_text), ...l }));
    },
    async backlinks(id, o = {}) {
      const t = cur(id); if (!t) throw new NotFound('note', { id }); guard(t.vault, o);
      const out = [];
      for (const vs of notes.values()) {
        const n = vs.at(-1); if (n.deleted || n.id === id || n.vault !== t.vault) continue;
        for (const l of parseLinks(n.body)) if (resolveTarget(n, l.target_text) === id) out.push({ src_id: n.id, target_id: id, ...l });
      }
      return out;
    },

    async putBlob(data, meta = {}) {
      writable(); if (!(data instanceof Uint8Array)) throw new Invalid('data must be Uint8Array');
      if (!meta.name) throw new Invalid('name required');
      const h = createHash('sha256').update(data).digest('hex');
      if (!blobs.has(h)) blobs.set(h, { data: new Uint8Array(data), meta: { name: meta.name, mime: meta.mime || 'application/octet-stream' } });
      const b = blobs.get(h); return { sha256: h, name: b.meta.name, mime: b.meta.mime, size: b.data.length };
    },
    async getBlob(h) { const b = blobs.get(h); if (!b) throw new NotFound('blob', { sha256: h }); return new Uint8Array(b.data); },

    async changes(cursor = '', o = {}) {
      const from = cursor === '' ? 0 : Number(cursor);
      if (!Number.isInteger(from) || from < 0) throw new Invalid('bad cursor');
      if (from < pruned) throw new CursorExpired('cursor pruned; full resync', { oldest_seq: pruned + 1 });
      const limit = o.limit || 200; const out = []; let last = from;
      for (const e of log) { if (e.seq <= from) continue; if (out.length >= limit) break; last = e.seq; if (allowed(e.vault, o)) out.push({ ...e }); }
      return { events: out, cursor: String(last), has_more: last < pruned + log.length };
    },
    subscribe(fn, o = {}) { const s = { fn, o }; subs.add(s); return () => subs.delete(s); },

    async snapshot(label = '') {
      const s = { id: newId('snap'), label, at: clock(), seq: pruned + log.length, note_count: notes.size,
        versions: new Map([...notes].map(([k, vs]) => [k, vs.length])) };
      snaps.push(s); const { versions, ...p } = s; return p;
    },
    async snapshots() { return snaps.map(({ versions, ...s }) => s); },

    async putSession(input, o = {}) {
      guard(input.vault, o); writable();
      for (const k of ['client', 'source_id', 'vault', 'started_at']) if (!input[k]) throw new Invalid(`${k} required`);
      const msgs = input.messages || [];
      const kinds = findSecretKinds([input.title, input.summary, ...msgs.map((m) => m.text)].join('\n'));
      if (kinds.length) throw new Invalid('secret found; redact before import', { kinds });
      const id = 's_' + sha(`${input.client}:${input.source_id}`).slice(0, 16);
      const m = msgs.map((x, i) => ({ seq: i + 1, role: x.role, at: x.at, text: x.text }));
      const s = { id, client: input.client, source_id: input.source_id, vault: input.vault, project: input.project || '', title: input.title || '', summary: input.summary || '',
        started_at: input.started_at, updated_at: m.at(-1)?.at || input.started_at, message_count: m.length, note_refs: [...(input.note_refs || [])], private: !!input.private };
      s.etag = sha(JSON.stringify(canon({ s: { ...s }, m })));
      const prev = sessions.get(id);
      if (prev?.s.etag === s.etag) return sessionOut(prev);   // idempotent re-import: no event
      sessions.set(id, { s, msgs: m });
      emit({ kind: 'session_upsert', vault: s.vault, id, version: m.length, etag: s.etag, path: `sessions/${s.client}/${id}` });
      return sessionOut(sessions.get(id));
    },
    async appendSession(ref, messages, o = {}) {
      writable();
      let x = typeof ref === 'string' ? sessions.get(ref) : sessions.get('s_' + sha(`${ref.client}:${ref.source_id}`).slice(0, 16));
      if (!x && typeof ref === 'string') throw new NotFound('session', { id: ref });
      if (!x) { await api.putSession({ ...ref, title: ref.title || '', summary: '', started_at: messages[0]?.at || clock(), messages: [] }, o); return api.appendSession({ ...ref }, messages, o); }
      guard(x.s.vault, o);
      const kinds = findSecretKinds(messages.map((m) => m.text).join('\n'));
      if (kinds.length) throw new Invalid('secret found; redact before logging', { kinds });
      for (const mm of messages) x.msgs.push({ seq: x.msgs.length + 1, role: mm.role, at: mm.at || clock(), text: mm.text });
      x.s.message_count = x.msgs.length; x.s.updated_at = x.msgs.at(-1).at;
      x.s.etag = sha(JSON.stringify(canon({ s: { ...x.s, etag: '' }, m: x.msgs })));
      emit({ kind: 'session_append', vault: x.s.vault, id: x.s.id, version: x.msgs.length, etag: x.s.etag, path: `sessions/${x.s.client}/${x.s.id}` });
      return sessionOut(x);
    },
    async listSessions(o = {}) {
      const q = o.q ? norm(o.q) : '';
      return [...sessions.values()].map((x) => x.s)
        .filter((s) => allowed(s.vault, o) && !(o.remote && s.private) && (!o.client || s.client === o.client) && (!o.vault || s.vault === o.vault)
          && (!o.since || s.updated_at >= o.since) && (!q || norm(`${s.title} ${s.summary}`).includes(q)))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, o.limit || 20).map((s) => structuredClone(s));
    },
    async readSession(id, o = {}) {
      const x = sessions.get(id); if (!x) throw new NotFound('session', { id }); guard(x.s.vault, o);
      if (o.remote && x.s.private) throw new PrivacyDenied('session is private', { id });
      const off = o.offset || 0; const lim = o.limit || 0;
      const messages = lim ? x.msgs.slice(off, off + lim).map((m) => ({ ...m })) : [];
      const next = lim && off + lim < x.msgs.length ? off + lim : null;
      return { session: sessionOut(x), messages, next_offset: next };
    },
    async setSessionPrivate(id, isPrivate, o = {}) {
      const x = sessions.get(id); if (!x) throw new NotFound('session', { id }); guard(x.s.vault, o); writable();
      x.s.private = !!isPrivate;
      x.s.etag = sha(JSON.stringify(canon({ s: { ...x.s, etag: '' }, m: x.msgs })));
      emit({ kind: 'session_upsert', vault: x.s.vault, id: x.s.id, version: x.msgs.length, etag: x.s.etag, path: `sessions/${x.s.client}/${x.s.id}` });
      return sessionOut(x);
    },
    async search(query, o = {}) {
      const terms = norm(String(query || '')).split(/\s+/).filter(Boolean);
      const limit = o.limit || 5;
      const score = (hay) => terms.length ? terms.filter((t) => norm(hay).includes(t)).length / terms.length : 0;
      const hits = [];
      for (const vs of notes.values()) {
        const n = vs.at(-1); if (n.deleted || n.superseded_by || !allowed(n.vault, o) || (o.scope && n.vault !== o.scope)) continue;
        const sc = score(`${n.title} ${n.body}`); if (sc > 0) hits.push({ id: n.id, title: n.title, snippet: n.body.slice(0, 160), score: sc, sha12: n.etag.slice(0, 12) });
      }
      if (o.includeSessions) for (const x of sessions.values()) {
        const s = x.s; if (!allowed(s.vault, o) || (o.remote && s.private) || (o.scope && s.vault !== o.scope)) continue;
        const sc = score(`${s.title} ${s.summary}`); if (sc > 0) hits.push({ id: s.id, title: s.title, snippet: s.summary.slice(0, 160), score: sc, sha12: s.etag.slice(0, 12) });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, limit);
    },
  };
  return api;
}
