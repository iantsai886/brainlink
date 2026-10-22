// Smart linking. Every note BrainLink writes gets a "Related" section: existing notes it
// mentions by name first, then the most similar notes by distinctive shared terms. A Home map
// that links every note is kept up to date, so a vault never turns into unconnected islands,
// even for people who never open Obsidian. Only new text is written: old notes are not edited.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { findMentions, suggestRelated, terms, collection } from './graph.mjs';
import { loadVault, noteTerms, eligibleFor, vault, vaultRoot, safeJoin, parseFrontmatter, zonedNow } from './core.mjs';

// How to write a link to note i: by title when the title is unique, else by path.
export const linkTarget = (index, i) => (index.byTitle.get(index.notes[i].title)?.length === 1 ? index.notes[i].title : index.notes[i].rel.replace(/\.md$/i, ''));

// [{target, title, why, shared?}] for a piece of text about to be written.
export async function suggestLinks(ctx, vaultName, text, { limit = 5, excludeRel = [] } = {}) {
  const index = await loadVault(ctx, vaultName);
  const eligible = eligibleFor(index);
  const skip = new Set(excludeRel.map((r) => index.byRel.get(r)).filter((i) => i !== undefined));
  const titleToIdx = new Map();
  index.notes.forEach((n, i) => { if (eligible(i) && !skip.has(i) && !titleToIdx.has(n.title)) titleToIdx.set(n.title, i); });
  const out = [];
  for (const t of findMentions(text, [...titleToIdx.keys()], { limit })) {
    const i = titleToIdx.get(t);
    skip.add(i);
    out.push({ target: linkTarget(index, i), title: t, why: 'mentioned' });
  }
  if (out.length < limit) {
    const { termSets, df } = noteTerms(index);
    for (const s of suggestRelated(terms(text), termSets, df, { exclude: skip, eligible, limit: limit - out.length })) {
      if (s.score < 0.05) continue;
      out.push({ target: linkTarget(index, s.j), title: index.notes[s.j].title, why: 'similar', shared: s.shared.slice(0, 3) });
    }
  }
  return out;
}

export function relatedSection(links) {
  if (!links.length) return '';
  return `## Related\n\n${links.map((l) => `- [[${l.target}]]${l.why === 'mentioned' ? ' — mentioned here' : l.shared?.length ? ` — also about ${l.shared.join(', ')}` : ''}`).join('\n')}\n\n`;
}

// ---- Home map ----

export const mapPath = (v) => (v.map_note === null ? null : v.map_note || 'BrainLink/Home.md');

export async function buildHomeMap(ctx, vaultName, now = new Date()) {
  const index = await loadVault(ctx, vaultName);
  // A private note must never appear in the Home map — not as an entry, a recently-changed row,
  // a folder-group member or a "not linked yet" orphan — since the map itself is a regular,
  // readable note once written to the vault.
  const visible = (i) => !index.notes[i].generated && !index.notes[i].private;
  const real = index.notes.map((n, i) => i).filter(visible);
  // Orphans ignore links from generated/private notes (like this map), which would hide them.
  const linkedReal = (i) => [...index.backlinks[i], ...index.outlinks[i]].some(visible);
  const orphans = real.filter((i) => !linkedReal(i));
  const links = index.edges.filter(([a, b]) => visible(a) && visible(b)).length;
  const recent = real.slice().sort((a, b) => index.notes[b].mtime - index.notes[a].mtime).slice(0, 12);
  const groups = new Map();
  for (const i of real) { const g = collection(index.notes[i].rel); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(i); }
  const li = (i) => `- [[${linkTarget(index, i)}]]`;
  const ts = zonedNow(ctx.tz, now);
  let md = `---\ngenerated_by: brainlink\nupdated: ${ts}\n---\n# Home\n\nMade by BrainLink. This map is rebuilt automatically, so edits here are replaced. Every note is linked from here.\n\n`;
  md += `**${real.length} notes · ${links} links · ${orphans.length} not linked to anything yet**\n\n`;
  md += `## Recently changed\n\n${recent.map((i) => `${li(i)} · ${index.notes[i].date}`).join('\n')}\n\n`;
  md += '## By folder\n\n';
  for (const [g, items] of [...groups.entries()].sort((a, b) => (a[0] === 'Home' ? -1 : b[0] === 'Home' ? 1 : a[0].localeCompare(b[0])))) {
    const sorted = items.sort((a, b) => index.notes[a].title.localeCompare(index.notes[b].title));
    md += `### ${g === 'Home' ? 'Top level' : g} (${items.length})\n\n${sorted.slice(0, 60).map(li).join('\n')}${items.length > 60 ? `\n- …and ${items.length - 60} more` : ''}\n\n`;
  }
  if (orphans.length) md += `## Not linked yet\n\nThese notes have no links. Ask your AI to "link my unlinked notes".\n\n${orphans.slice(0, 25).map(li).join('\n')}\n`;
  return md;
}

// Rewrites the map only if BrainLink generated it (never a user's own note of the same name).
export async function updateHomeMap(ctx, vaultName, now = new Date()) {
  const v = vault(ctx, vaultName);
  const rel = mapPath(v);
  if (!rel || v.writes !== 'on') return null;
  const full = safeJoin(vaultRoot(ctx, vaultName), rel);
  try {
    const existing = await readFile(full, 'utf8');
    if (parseFrontmatter(existing).meta.generated_by !== 'brainlink') return null;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const md = await buildHomeMap(ctx, vaultName, now);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, md);
  return rel;
}

export async function safeUpdateMap(ctx, vaultName) {
  try { return await updateHomeMap(ctx, vaultName); } catch { return null; }
}

export const exists = (p) => stat(p).then(() => true, () => false);
