// Tiny state hook: every use*() returns { get, sub, ...actions }. Views re-render on sub().
export function createHook(initial) {
  let s = initial; const subs = new Set();
  return {
    get: () => s,
    set(patch) { s = { ...s, ...(typeof patch === 'function' ? patch(s) : patch) }; subs.forEach((f) => f(s)); },
    sub(f) { subs.add(f); return () => subs.delete(f); },
  };
}
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const errText = (e) => (e && (e.code || e.error) ? `${e.code || e.error}: ${e.message || ''}` : String(e?.message || e));
