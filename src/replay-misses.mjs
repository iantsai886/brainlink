// Replayable misses: an opt-in, local-only list of questions that a search could not answer
// well (weak or not_in_brain), so the owner can re-run them after fixing notes and see which
// ones now succeed. Off by default. Unlike the RSI ledger, which never stores a question,
// this file keeps the question text; it therefore lives only under BRAINLINK_HOME, is written
// owner-only, skips private vaults, and can be cleared by the owner at any time.
import { appendFile, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { searchWithVerdict } from './core.mjs';

const MAX_ENTRIES = 500;
const MAX_QUERY = 400;
const keyOf = (vault, query) => `${vault}\n${String(query).trim().toLowerCase().replace(/\s+/g, ' ')}`;

export function createReplayMisses({ home }) {
  const file = path.join(home, 'rsi', 'replay-misses.jsonl');
  async function list() {
    let raw;
    try { raw = await readFile(file, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { const item = JSON.parse(line); if (item && typeof item.vault === 'string' && typeof item.query === 'string') out.push(item); } catch { /* skip a damaged line */ }
    }
    return out;
  }
  return {
    file,
    list,
    // Records one miss. Returns false when nothing was stored (disabled by the caller's own
    // check, a good result, a private vault, a duplicate, or the cap was reached).
    async record({ vault, query, status, source = 'unknown', isPrivate = false, now = new Date() }) {
      const text = String(query || '').trim();
      if (!vault || !text || isPrivate || !['weak', 'not_in_brain'].includes(status)) return false;
      const existing = await list();
      if (existing.length >= MAX_ENTRIES || existing.some((item) => keyOf(item.vault, item.query) === keyOf(vault, text))) return false;
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify({ date: now.toISOString(), vault, query: text.slice(0, MAX_QUERY), status, source })}\n`, { mode: 0o600 });
      await chmod(file, 0o600).catch(() => {});
      return true;
    },
    // Re-runs every stored question against the current notes. Nothing is changed.
    async replay(ctx) {
      const items = await list();
      const results = [];
      for (const item of items) {
        if (!ctx.enabled.includes(item.vault) || ctx.byName.get(item.vault)?.private) { results.push({ ...item, now: 'vault_unavailable' }); continue; }
        const r = await searchWithVerdict(ctx, item.vault, item.query, { limit: 3 });
        results.push({ ...item, now: r.status, top: r.results[0] ? { path: r.results[0].path, title: r.results[0].title } : null });
      }
      const count = (status) => results.filter((item) => item.now === status).length;
      return { total: results.length, fixed: count('hits'), still_weak: count('weak'), still_missing: count('not_in_brain'), unavailable: count('vault_unavailable'), results };
    },
    async clear() {
      const n = (await list()).length;
      if (n) await writeFile(file, '', { mode: 0o600 });
      return { cleared: n };
    },
  };
}
