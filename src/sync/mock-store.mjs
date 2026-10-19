// MOCK — replace with brainlink-store's createMemoryStore (memory-store.mjs) once it lands.
// Implements only the BrainStore methods sync uses: read, list, write (CAS on etag), changes, snapshot, snapshots, revert.
import { createHash } from 'node:crypto';

export class Conflict extends Error { static code = 'E_CONFLICT'; constructor(m, d) { super(m); this.code = 'E_CONFLICT'; this.detail = d; } }
export class NotFound extends Error { static code = 'E_NOT_FOUND'; constructor(m) { super(m); this.code = 'E_NOT_FOUND'; } }

export function createMockStore({ clock = () => new Date().toISOString() } = {}) {
  const notes = new Map(); const log = []; const snaps = []; let n = 0;
  const etag = (fm, body, p) => createHash('sha256').update(JSON.stringify([fm, body, p])).digest('hex');
  const cur = (ref) => notes.get(ref) || [...notes.values()].find((v) => v.at(-1).path === ref);
  const vis = (s, o) => (o?.scopes || ['brain']).includes(s);
  const put = (vs, kind, author) => { const v = vs.at(-1); log.push({ seq: log.length + 1, kind, note_id: v.id, version: v.version, etag: v.etag, path: v.path, scope: v.scope, at: v.updated_at }); return { note_id: v.id, version: v.version, etag: v.etag, path: v.path, seq: log.length }; };
  return {
    async read(ref, o) { const vs = cur(ref); if (!vs || !vis(vs.at(-1).scope, o)) throw new NotFound(ref); return { ...(o?.version ? vs[o.version - 1] : vs.at(-1)) }; },
    async list(o = {}) { return [...notes.values()].map((vs) => vs.at(-1)).filter((v) => vis(v.scope, o) && !v.deleted && v.path.startsWith(o.folder || '')).sort((a, b) => a.path.localeCompare(b.path)).map(({ body, frontmatter, ...s }) => s); },
    async write(i, { expected_etag }) {
      const vs = i.id ? notes.get(i.id) : cur(i.path);
      const now = vs?.at(-1).etag ?? '';
      if (expected_etag !== now) throw new Conflict('etag mismatch', { current_etag: now });
      const fm = i.frontmatter || {}; const id = vs?.at(-1).id || `n_${String(++n).padStart(26, '0')}`;
      const v = { id, path: i.path, title: i.path.split('/').pop().replace(/\.md$/, ''), scope: i.scope || vs?.at(-1).scope || 'brain', frontmatter: fm, body: i.body, version: (vs?.length || 0) + 1, etag: etag(fm, i.body, i.path), updated_at: clock(), superseded_by: null, superseded_at: null, deleted: false };
      if (vs) vs.push(v); else notes.set(id, [v]);
      return put(notes.get(id), vs ? 'update' : 'create', i.author);
    },
    async changes(cursor = '', o) { const ev = log.slice(Number(cursor) || 0).filter((e) => vis(e.scope, o)); return { events: ev, cursor: String(log.length), has_more: false }; },
    async snapshot(label = '') { const s = { id: `s_${snaps.length + 1}`, label, at: clock(), seq: log.length, note_count: notes.size, versions: new Map([...notes].map(([k, vs]) => [k, vs.length])) }; snaps.push(s); const { versions, ...pub } = s; return pub; },
    async snapshots() { return snaps.map(({ versions, ...s }) => s); },
    async revert(id, { expected_etag, to_version, to_snapshot }) {
      const vs = notes.get(id); if (!vs) throw new NotFound(id);
      if (vs.at(-1).etag !== expected_etag) throw new Conflict('etag mismatch', { current_etag: vs.at(-1).etag });
      const sv = to_snapshot ? snaps.find((s) => s.id === to_snapshot)?.versions.get(id) : to_version;
      const t = sv ? vs[sv - 1] : { ...vs.at(-1), deleted: true };
      vs.push({ ...t, version: vs.length + 1, updated_at: clock() });
      return put(vs, 'revert');
    },
  };
}
