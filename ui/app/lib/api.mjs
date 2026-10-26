// Only boundary between UI and BrainStore v0.1 plus host-provided services.
// connectors.detect/connect/test/disconnect are host services, not BrainStore.
// sessions.setPrivate is optional; otherwise reimport into another vault.
// search.query is optional; fallback ranks notes from list/read.
export function createApi({ store, services = {}, access = {} }) {
  if (!store) throw new Error('createApi needs a BrainStore');
  const opts = (extra = {}) => ({ ...access, ...extra });
  const vaults = () => store.vaults().filter(v => !access.vaults || access.vaults.includes(v.name)).filter(v => !access.remote || !v.private);
  const privateVault = () => vaults().find(v => v.private)?.name;
  const publicVault = () => vaults().find(v => !v.private)?.name;
  const connectors = services.connectors || {};
  async function call(method, ...args) {
    if (typeof connectors[method] !== 'function') throw new Error(`connectors.${method} requires a host service`);
    return connectors[method](...args);
  }
  async function sessions({ q = '', client, include_private = true, limit = 100 } = {}) {
    const visible = await store.listSessions(opts({ q, client, limit }));
    return visible.filter(s => include_private || !(s.private ?? store.vaults().find(v => v.name === s.vault)?.private)).map(s => ({ ...s, private: s.private ?? !!store.vaults().find(v => v.name === s.vault)?.private }));
  }
  async function setPrivate(id, value) {
    if (typeof store.setSessionPrivate === 'function') return store.setSessionPrivate(id, !!value, opts());
    const page = await store.readSession(id, opts({ limit: 100000 }));
    const old = page.session;
    const target = value ? privateVault() : publicVault();
    if (!target) throw new Error('No accessible destination vault for privacy change');
    if (old.vault === target) return old;
    if (services.sessions?.setPrivate) return services.sessions.setPrivate(id, value);
    // v0.1 has no moveSession or per-session privacy field.
    // Upsert same client + source_id preserving stable ID, reusing messages from store.
    // Fails closed if message history is incomplete: never silently drop messages.
    const messages = page.messages;
    if (page.next_offset !== null || messages.length !== old.message_count) throw new Error('Cannot move session: incomplete message history');
    return store.putSession({ client: old.client, source_id: old.source_id, vault: target, title: old.title, summary: old.summary, started_at: old.started_at, note_refs: old.note_refs, messages: messages.map(({ role, at, text }) => ({ role, at, text })) }, opts());
  }
  return {
    store, services, access, vaults,
    onVaultChange: (fn) => typeof access.onVaultChange === 'function' ? access.onVaultChange(fn) : () => {},
    detect: () => call('detect'), connect: id => call('connect', id), test: id => call('test', id), disconnect: id => call('disconnect', id),
    listSessions: sessions, readSession: id => store.readSession(id, opts({ limit: 100 })), setPrivate,
    search: async (q, filters = {}) => {
      if (typeof store.search === 'function') {
        const hits = String(q).trim() ? await store.search(q, opts({ limit: filters.limit ?? 5, ...(filters.scope ? { scope: filters.scope } : {}), includeSessions: false })) : [];
        return { verdict: hits.length ? 'hits' : 'not_in_brain', hits, tokens_est: hits.reduce((n,h) => n + Math.ceil((h.snippet || '').length / 4), 0) };
      }
      return storeSearch(store, q, { ...filters, access, vaults: vaults().map(v => v.name) });
    },
    readNote: id => store.read(id, opts()),
    listNotes: async () => { const all = []; for (const v of vaults()) { let after; for (let i = 0; i < 100; i++) { const page = await store.list(opts({ vault: v.name, limit: 100, ...(after ? {after} : {}) })); all.push(...page); if (page.length < 100) break; after = page.at(-1).path; } } return all; },
    writeNote: (input, expected_etag) => store.write(input, opts({ expected_etag })),
    renameNote: typeof store.rename === 'function' ? (id, path, etag) => store.rename(id, path, opts({expected_etag:etag})) : null,
    backlinks: id => typeof store.backlinks === 'function' ? store.backlinks(id, opts()) : Promise.resolve([]),
  };
}
export async function storeSearch(store, q, f = {}) {
  const terms = String(q).trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { verdict: 'not_in_brain', hits: [], tokens_est: 0 };
  const access = f.access || {};
  const summaries = [];
  for (const vault of (f.vaults || store.vaults().filter(v => !access.remote || !v.private).map(v => v.name))) {
    if (f.folder && !String(f.folder).trim()) continue;
    let after;
    for (let page = 0; page < 100; page++) {
      const items = await store.list({ ...access, vault, folder: f.folder || undefined, limit: 100, ...(after ? { after } : {}) });
      summaries.push(...items);
      if (items.length < 100) break;
      after = items.at(-1).path;
    }
  }
  const hits = [];
  for (const summary of summaries) {
    const n = await store.read(summary.id, access);
    const fm = n.frontmatter || {};
    if (f.type && fm.type !== f.type) continue;
    if (f.tags?.length && !f.tags.every(t => [].concat(fm.tags || []).includes(t))) continue;
    if (f.from && n.updated_at.slice(0, 10) < f.from) continue;
    if (f.to && n.updated_at.slice(0, 10) > f.to) continue;
    const title = n.title.toLowerCase(), path = n.path.toLowerCase(), body = n.body.toLowerCase();
    const score = (title === terms.join(' ') ? 100 : 0) + terms.reduce((s, t) => s + (title.includes(t) ? 12 : 0) + (path.includes(t) ? 3 : 0) + (body.includes(t) ? 1 : 0), 0);
    if (!score) continue;
    const i = Math.max(0, body.indexOf(terms[0]));
    hits.push({ id: n.id, vault: n.vault, path: n.path, title: n.title, heading: '', snippet: n.body.slice(Math.max(0, i - 50), i + 135).replace(/\s+/g, ' '), score });
  }
  hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  const top = hits.slice(0, f.limit || 20);
  return { verdict: top.length ? 'hits' : 'not_in_brain', hits: top, tokens_est: top.reduce((s, h) => s + Math.ceil(h.snippet.length / 4), 0) };
}
