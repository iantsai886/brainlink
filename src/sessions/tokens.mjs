// Token estimate used for every budget here (same rule as the eval): CJK chars x1 + other chars / 4.
const CJK = /[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;
export function estTokens(s) {
  const t = String(s ?? '');
  const cjk = (t.match(CJK) || []).length;
  return Math.ceil(cjk + (t.length - cjk) / 4);
}
// Cut text to roughly `budget` tokens, on a word boundary when possible.
export function clip(s, budget) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (estTokens(t) <= budget) return t;
  let lo = 0, hi = t.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (estTokens(t.slice(0, mid)) <= budget - 1) lo = mid; else hi = mid - 1; }
  const cut = t.slice(0, lo);
  const sp = cut.lastIndexOf(' ');
  return (sp > lo * 0.7 ? cut.slice(0, sp) : cut) + '…';
}
