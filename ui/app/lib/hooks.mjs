import { createHook, errText } from './state.mjs';
export function useConnect(api) {
  const h = createHook({ apps: [], busy: {}, error: null });
  const put = app => h.set(s => ({ apps: s.apps.map(a => a.id === app.id ? { ...a, ...app } : a) }));
  const busy = (id, status) => h.set(s => ({ busy: { ...s.busy, [id]: status } }));
  async function refresh() { try { h.set({ apps: await api.detect(), error: null }); } catch (e) { h.set({ error: errText(e) }); } }
  async function connect(id) {
    busy(id, 'Connecting');
    try { put(await api.connect(id)); busy(id, 'Testing'); const result = await api.test(id); put({ id, last_test: result, connected: !!result.ok }); }
    catch (e) { put({ id, connected: false, last_test: { ok: false, error: errText(e) } }); }
    finally { busy(id, null); }
  }
  async function connectAll() { for (const a of h.get().apps.filter(a => a.installed && !a.last_test?.ok)) await connect(a.id); }
  async function disconnect(id) { busy(id, 'Disconnecting'); try { put({ ...await api.disconnect(id), last_test: null }); } catch (e) { h.set({ error: errText(e) }); } finally { busy(id, null); } }
  return { ...h, refresh, connect, retry: connect, connectAll, disconnect };
}
export function useSessions(api) {
  const h = createHook({ items: [], q: '', include_private: true, error: null, open: null });
  let version = 0;
  async function load(patch = {}) {
    h.set({ ...patch, error: null }); const n = ++version;
    try { const { q, include_private } = h.get(); const items = await api.listSessions({ q, include_private }); if (n === version) h.set({ items }); }
    catch (e) { if (n === version) h.set({ error: errText(e) }); }
  }
  async function setPrivate(id, checked) { try { await api.setPrivate(id, checked); await load(); } catch (e) { h.set({ error: errText(e) }); await load(); h.set({ error: errText(e) }); } }
  async function open(id) { try { h.set({ open: await api.readSession(id) }); } catch (e) { h.set({ error: errText(e) }); } }
  return { ...h, load, search: q => load({ q }), togglePrivateListing: checked => load({ include_private: checked }), setPrivate, open, close: () => h.set({ open: null }) };
}
export function useSearch(api) {
  const h = createHook({ q: '', result: null, open: null, error: null }); let version = 0;
  async function run(q) { h.set({ q, error: null }); const n = ++version; try { const result = await api.search(q); if (n === version) h.set({ result }); } catch (e) { if (n === version) h.set({ error: errText(e) }); } }
  async function open(id) { try { h.set({ open: await api.readNote(id) }); } catch (e) { h.set({ error: errText(e) }); } }
  return { ...h, run, open, close: () => h.set({ open: null }) };
}
