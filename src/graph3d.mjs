// 3D notes graph (Ian's RB7 feature 2): nodes/edges across every enabled, non-private vault, and
// one note's detail (Markdown body, tags, backlinks, outlinks) for the side panel. Excluded
// folders never reach the index at all (loadVault walks past .brainlinkignore, see src/core.mjs);
// this module adds the one rule loadVault doesn't already enforce: private vaults and
// frontmatter-flagged private notes are dropped before a single node is built.
import { loadVault, summarize } from './core.mjs';

// n.private is already computed once, at index-build time, by core.mjs's isPrivateMeta — reusing
// it here (rather than re-deriving private-ness from n.meta.private with a second, independent
// regex) is what keeps this module in lockstep with every other private check in the codebase.
const isPrivateNote = (n) => n.private;

// Every enabled vault that isn't private, each with its own loaded index.
async function visibleVaults(ctx, only) {
  const names = (only ? [only] : ctx.enabled).filter((name) => ctx.enabled.includes(name) && !ctx.byName.get(name)?.private);
  const out = [];
  for (const name of names) out.push({ name, index: await loadVault(ctx, name) });
  return out;
}

// { nodes: [{id, title, vault, group, tags, degree}], links: [{source, target}], shown, total }
export async function buildGraph3D(ctx, vaultName, { limit = 2000 } = {}) {
  const vaults = await visibleVaults(ctx, vaultName);
  const nodes = [], keep = []; // keep[k] = { vaultName, index, i } for edge lookups
  let total = 0;
  for (const { name, index } of vaults) {
    for (let i = 0; i < index.notes.length; i++) {
      const n = index.notes[i];
      total++;
      if (n.generated || isPrivateNote(n)) continue;
      keep.push({ name, index, i });
    }
  }
  // Big vaults: show the most-connected notes first so the graph stays smooth (~2,000 nodes).
  const degreeOf = ({ index, i }) => index.backlinks[i].size + index.outlinks[i].size;
  keep.sort((a, b) => degreeOf(b) - degreeOf(a));
  const shown = keep.slice(0, limit);
  const pos = new Map(); // `${vault}::${i}` -> node index
  shown.forEach((k, pIdx) => pos.set(`${k.name}::${k.i}`, pIdx));
  for (const k of shown) {
    const n = k.index.notes[k.i];
    nodes.push({ id: pos.get(`${k.name}::${k.i}`), title: n.title, path: n.rel, vault: k.name, group: n.rel.includes('/') ? n.rel.split('/')[0] : '', tags: [...n.tags], degree: degreeOf(k) });
  }
  const links = [];
  for (const k of shown) {
    const from = pos.get(`${k.name}::${k.i}`);
    for (const j of k.index.outlinks[k.i]) {
      const to = pos.get(`${k.name}::${j}`);
      if (to === undefined || isPrivateNote(k.index.notes[j])) continue;
      links.push({ source: from, target: to });
    }
  }
  return { vault: vaultName || null, nodes, links, shown: nodes.length, total };
}

// One note's panel data: rendered-ready Markdown body, tags, backlinks and outlinks (titles +
// ids matching the same vault's buildGraph3D() so a backlink click can focus that node).
export async function noteDetail3D(ctx, vaultName, rel) {
  const v = ctx.byName.get(vaultName);
  if (!v || !ctx.enabled.includes(vaultName)) throw new Error(`Unknown vault "${vaultName}".`);
  if (v.private) throw new Error('This note is in a private vault and cannot be shown in the graph.');
  const index = await loadVault(ctx, vaultName);
  const i = index.byRel.get(rel);
  if (i === undefined) throw new Error(`Note not found: ${rel}`);
  const n = index.notes[i];
  if (isPrivateNote(n)) throw new Error('This note is private and cannot be shown in the graph.');
  const visible = (j) => !index.notes[j].generated && !isPrivateNote(index.notes[j]);
  return {
    vault: vaultName, path: n.rel, title: n.title, body: n.body, tags: [...n.tags],
    backlinks: [...index.backlinks[i]].filter(visible).map((j) => summarize(index, j)),
    outlinks: [...index.outlinks[i]].filter(visible).map((j) => summarize(index, j)),
  };
}
