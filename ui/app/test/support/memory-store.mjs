// Test-only stand-in for the absent external reference implementation.
// Do not ship as a production BrainStore; real harness prefers BRAINLINK_STORE_DIR.
export function createMemoryStore({ vaults, clock = () => new Date().toISOString() }) {
  const notes = new Map(), sessions = new Map(); let counter = 0;
  const allowed = (vault, o = {}) => (!o.vaults || o.vaults.includes(vault)) && !(o.remote && vaults.find(v => v.name === vault)?.private);
  const guard = (v, o) => { if (!allowed(v, o)) throw Object.assign(new Error('private'), { code: 'E_PRIVACY' }); };
  return {
    vaults: () => vaults,
    async write(input, o) { guard(input.vault,o); const id = `n_${++counter}`; const note = { ...input, id, title: input.path.split('/').at(-1).replace(/\.md$/, ''), etag: `etag${counter}`, version: 1, updated_at: clock(), deleted: false, superseded_by: null, attachments: [] }; notes.set(id,note); return note; },
    async list(o = {}) { return [...notes.values()].filter(n => allowed(n.vault,o) && (!o.vault || n.vault === o.vault) && (!o.folder || n.path.startsWith(o.folder)) && (!o.after || n.path > o.after)).sort((a,b) => a.path.localeCompare(b.path)).slice(0,o.limit || 100); },
    async read(id,o = {}) { const n = notes.get(id); if (!n) throw new Error('not found'); guard(n.vault,o); return n; },
    async links(id) { const n = notes.get(id); return [...n.body.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => ({ src_id: id, target_text: m[1], target_id: [...notes.values()].find(x => x.title === m[1] || x.path.replace(/\.md$/,'') === m[1])?.id || null })); },
    async putSession(input,o={}) { guard(input.vault,o); const id = `s_${input.client}_${input.source_id}`; const old = sessions.get(id); const msgs = input.messages.map((m,i) => ({...m,seq:i+1})); const session = { ...input, id, message_count: msgs.length, updated_at: clock(), etag: `ses${++counter}` }; delete session.messages; sessions.set(id,{session,messages:msgs}); return session; },
    async listSessions(o={}) { return [...sessions.values()].map(x => x.session).filter(s => allowed(s.vault,o) && (!o.client || s.client === o.client) && (!o.vault || s.vault === o.vault) && (!o.q || `${s.title} ${s.summary}`.toLowerCase().includes(o.q.toLowerCase()))).sort((a,b) => b.started_at.localeCompare(a.started_at)).slice(0,o.limit || 100); },
    async readSession(id,o={}) { const x = sessions.get(id); if (!x) throw new Error('not found'); guard(x.session.vault,o); const offset = o.offset || 0; const messages = x.messages.slice(offset, offset + (o.limit || 0)); return { session:x.session, messages, next_offset: offset + messages.length < x.messages.length ? offset + messages.length : null }; }
  };
}
