import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isHistorical, loadVaultGraph, ROUTING_NOTE, summarize } from './core.mjs';
import { linkGraph, suggestRelated, terms } from './graph.mjs';
import { listConflictCandidates } from './conflict-review.mjs';

const digest = (value) => createHash('sha256').update(String(value)).digest('hex');
const visible = (note) => note && !note.private && !note.generated && !note.historical && !ROUTING_NOTE.test(note.title);
const normalizedTitle = (value) => String(value || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');

export async function buildTidyBatch(ctx, vaultName, { dismissed = [], limit = 50, offset = 0 } = {}) {
  const graph = await loadVaultGraph(ctx, vaultName), cap = Math.max(1, Math.min(50, limit));
  const notes = graph.notes.map((note) => ({ ...note, historical: isHistorical(note.rel, note.meta) }));
  const linkIndex = linkGraph(notes);
  const edges = graph.noteEdges;
  const outlinks = notes.map(() => new Set()), backlinks = notes.map(() => new Set());
  for (const [from, to] of edges) { outlinks[from].add(to); backlinks[to].add(from); }
  const index = { notes, edges, outlinks, backlinks, broken: linkIndex.broken, byRel: graph.byRel };
  // Reuse the one vault snapshot and term index for every source note. Calling relatedText
  // here would reload and re-index all 3,000 notes once per orphan, turning one batch into
  // quadratic disk and tokenization work.
  const termSets = notes.map((note) => terms(`${note.title} ${note.body}`)), df = new Map();
  for (const set of termSets) for (const term of set) df.set(term, (df.get(term) || 0) + 1);
  const visibleIds = new Set(index.notes.map((note, i) => visible(note) ? i : -1).filter((i) => i >= 0));
  const linked = new Set();
  for (const [from, to] of index.edges) if (visibleIds.has(from) && visibleIds.has(to)) { linked.add(from); linked.add(to); }
  const orphanIds = [...visibleIds].filter((i) => !linked.has(i)).sort((a, b) => index.notes[a].rel.localeCompare(index.notes[b].rel));
  const start = Math.max(0, Math.min(orphanIds.length, offset));
  const page = orphanIds.slice(start, start + 50);
  const items = [];
  const push = (item) => { if (items.length < cap && !dismissed.includes(item.id)) items.push(item); };
  let inspectedOrphans = 0;
  for (const i of page) {
    if (items.length >= cap) break;
    inspectedOrphans++;
    const note = index.notes[i];
    if (note.body.trim().length < 120) continue;
    const sourceIndex = index.byRel.get(note.rel);
    const exclude = new Set([sourceIndex, ...(index.outlinks[sourceIndex] || []), ...(index.backlinks[sourceIndex] || [])]);
    const suggestions = suggestRelated(terms(note.body), termSets, df, {
      exclude,
      eligible: (j) => { const target = notes[j]; return !target.private && !target.historical && !target.generated && !ROUTING_NOTE.test(target.title) && target.body.trim().length >= 120; },
      limit: 8,
    }).map((s) => ({ ...summarize(index, s.j), score: +s.score.toFixed(3), shared_terms: s.shared }));
    for (const target of suggestions.slice(0, 3)) {
      const id = digest(`${vaultName}\0link\0${note.rel}\0${target.path}`);
      push({ id, kind: 'link', vault: vaultName, source: { path: note.rel, title: note.title }, target: { path: target.path, title: target.title }, shared_terms: target.shared_terms || [], reason: `Shared terms: ${(target.shared_terms || []).slice(0, 8).join(', ')}` });
      if (items.length >= cap) break;
    }
  }
  const brokenItems = [];
  for (const broken of index.broken) {
    const source = index.notes[broken.from];
    if (!visible(source)) continue;
    const token = String(broken.target || '').split('|')[0].replace(/\\/g, '/').split('#')[0].replace(/^\/+|\/+$/g, '').replace(/\.md$/i, '');
    const base = token.split('/').at(-1).toLocaleLowerCase();
    const matches = [...visibleIds].map((i) => index.notes[i]).filter((note) => note.rel.replace(/\.md$/i, '').toLocaleLowerCase() === token.toLocaleLowerCase()
      || normalizedTitle(note.title) === normalizedTitle(base) || (note.aliases || []).some((alias) => normalizedTitle(alias) === normalizedTitle(base)));
    if (matches.length !== 1) continue;
    const target = matches[0];
    const id = digest(`${vaultName}\0broken\0${source.rel}\0${broken.target}\0${target.rel}`);
    brokenItems.push({ id, kind: 'broken', vault: vaultName, source: { path: source.rel, title: source.title }, target: { path: target.rel, title: target.title }, broken_target: broken.target, shared_terms: [], reason: `Exactly one visible note matches the unresolved link [[${broken.target}]] after title normalization.` });
  }
  for (const item of brokenItems) push(item);
  const shownBroken = items.filter((item) => item.kind === 'broken').length;
  const conflicts = await listConflictCandidates(ctx, vaultName, { limit: 50, index });
  for (const candidate of conflicts.candidates) {
    const id = digest(`${vaultName}\0conflict\0${candidate.id}`);
    push({ id, kind: 'conflict', vault: vaultName, a: candidate.a, b: candidate.b, reasons: candidate.reasons, reason: candidate.reasons.join('; ') });
  }
  const shownConflicts = items.filter((item) => item.kind === 'conflict').length;
  const next_offset = Math.min(orphanIds.length, start + inspectedOrphans);
  const more = Math.max(0, orphanIds.length - next_offset) + Math.max(0, brokenItems.length - shownBroken) + Math.max(0, conflicts.total - shownConflicts);
  return { vault: vaultName, items, total_shown: items.length, more, offset: start, next_offset, archive_candidates: false };
}

export function tidyAppendBlock(items) {
  const rows = items.filter((item) => ['link', 'broken'].includes(item.kind));
  if (!rows.length) return '';
  const unique = new Map(rows.map((item) => [`${item.target.title}\0${item.target.path}`, item]));
  return `\n\n## Related\n\n${[...unique.values()].map((item) => `- [[${item.target.path.replace(/\.md$/i, '')}]] (${item.kind === 'broken' ? `suggested target for [[${item.broken_target}]]` : `shared terms: ${item.shared_terms.slice(0, 8).join(', ')}`})`).join('\n')}\n`;
}

export function createTidyState(home) {
  const file = path.join(home, 'tidy', 'resolved.json');
  async function read() { try { const value = JSON.parse(await readFile(file, 'utf8')); return Array.isArray(value.resolved) ? value.resolved.filter((id) => /^[a-f0-9]{64}$/.test(id)) : []; } catch { return []; } }
  return {
    async resolved() { return read(); },
    async resolve(ids) {
      const current = await read(), next = [...new Set([...current, ...ids.filter((id) => /^[a-f0-9]{64}$/.test(id))])];
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${digest(`${Date.now()}-${Math.random()}`).slice(0, 12)}.tmp`;
      await writeFile(temp, `${JSON.stringify({ resolved: next }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temp, file);
    },
  };
}
