import { createHook } from './lib/state.mjs';
import { useConnect, useSessions, useSearch } from './lib/hooks.mjs';
import { shell, connectView, sessionsView, searchView } from './views/screens.mjs';
// Host injects createApi({store, services, access}); no direct store access in UI.
export async function startApp(root, api) {
  const ui = createHook({ route: globalThis.location?.hash.slice(1) || 'connect' });
  const conn = useConnect(api), sess = useSessions(api), srch = useSearch(api);
  const render = () => { const route = ui.get().route; root.innerHTML = shell(route, route === 'sessions' ? sessionsView(sess.get()) : route === 'search' ? searchView(srch.get()) : connectView(conn.get())); };
  for (const hook of [ui, conn, sess, srch]) hook.sub(render);
  const actions = { connect: id => conn.connect(id), retry: id => conn.retry(id), disconnect: id => conn.disconnect(id), connectAll: () => conn.connectAll(), refresh: () => conn.refresh(), openSession: id => sess.open(id), closeSession: () => sess.close(), openNote: id => srch.open(id), closeNote: () => srch.close() };
  root.addEventListener('click', e => { const target = e.target.closest('button[data-action]'); if (target) actions[target.dataset.action]?.(target.dataset.arg); });
  root.addEventListener('change', e => { const x = e.target; if (x.dataset.action === 'private') sess.setPrivate(x.dataset.arg, x.checked); if (x.dataset.action === 'includePrivate') sess.togglePrivateListing(x.checked); });
  let timer;
  root.addEventListener('input', e => { const x = e.target; const key = x.dataset.input; if (!key) return; const caret = x.selectionStart; clearTimeout(timer); timer = setTimeout(async () => { if (key === 'sessionQ') await sess.search(x.value); else await srch.run(x.value); const next = root.querySelector(`[data-input="${key}"]`); if (next) { next.focus(); next.setSelectionRange(caret, caret); } }, 160); });
  const onHash = () => ui.set({ route: ['connect','sessions','search'].includes(globalThis.location?.hash.slice(1)) ? globalThis.location.hash.slice(1) : 'connect' });
  globalThis.addEventListener?.('hashchange', onHash);
  await Promise.all([conn.refresh(), sess.load()]); render();
  return { api, ui, hooks: { conn, sess, srch }, actions, render, dispose: () => globalThis.removeEventListener?.('hashchange', onHash) };
}
