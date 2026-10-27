// 3D notes graph (Ian's RB7 feature 2): nodes/edges across every enabled, non-private vault, and
// one note's detail (Markdown body, tags, backlinks, outlinks) for the side panel. Excluded
// folders never reach the index at all (loadVault walks past .brainlinkignore, see src/core.mjs);
// this module adds the one rule loadVault doesn't already enforce: private vaults and
// frontmatter-flagged private notes are dropped before a single node is built.
import { loadVault, summarize } from './core.mjs';
import { typedEntityMetadataMap, deriveProposedTypedRelations, deriveRejectedTypedRelations, discoverTypedRelationshipCandidates } from './typed-graph.mjs';

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
  const entityMetadata = new Map(vaults.flatMap(({ index }) => [...typedEntityMetadataMap(index.notes)]));
  const typedByIndex = new Map(vaults.map(({ index }) => [index, new Map()]));
  for (const { index } of vaults) for (const edge of index.typedRelations) {
    if (!typedByIndex.get(index).has(edge.source)) typedByIndex.get(index).set(edge.source, new Map());
    const byTarget = typedByIndex.get(index).get(edge.source);
    if (!byTarget.has(edge.target)) byTarget.set(edge.target, []);
    byTarget.get(edge.target).push(edge.predicate);
  }
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
    nodes.push({ id: pos.get(`${k.name}::${k.i}`), title: n.title, path: n.rel, vault: k.name, group: n.rel.includes('/') ? n.rel.split('/')[0] : '', tags: [...n.tags], degree: degreeOf(k), ...(entityMetadata.get(n) || {}) });
  }
  const links = [];
  for (const k of shown) {
    const from = pos.get(`${k.name}::${k.i}`);
    const typedByTarget = typedByIndex.get(k.index).get(k.i) || new Map();
    for (const j of k.index.outlinks[k.i]) {
      const to = pos.get(`${k.name}::${j}`);
      if (to === undefined || isPrivateNote(k.index.notes[j])) continue;
      const predicates = typedByTarget.get(j) || [];
      links.push({ source: from, target: to, kind: predicates.length ? 'typed' : 'note_link', ...(predicates.length ? { predicate: [...new Set(predicates)].join(' · ') } : {}) });
    }
  }
  return { vault: vaultName || null, nodes, links, shown: nodes.length, total };
}

// A bounded, review-only queue for the local Setup UI. visibleVaults() applies the same enabled
// vault and whole-private-vault boundary as the graph before any proposal is counted or returned.
export async function listProposedTypedRelations(ctx, { limit = 100, vault, offset = 0 } = {}) {
  const vaults = (await visibleVaults(ctx, vault)).sort((a, b) => a.name.localeCompare(b.name));
  const max = Math.max(1, Math.min(500, Number(limit) || 100));
  const start = Math.max(0, Math.min(100_000, Number.isSafeInteger(offset) ? offset : 0));
  const proposals = [];
  let total = 0;
  for (const { name, index } of vaults) {
    const pending = deriveProposedTypedRelations(index.notes).sort((a, b) =>
      index.notes[a.source].rel.localeCompare(index.notes[b.source].rel) || a.relation_index - b.relation_index);
    for (const edge of pending) {
      total++;
      if (total <= start || proposals.length >= max) continue;
      const source = index.notes[edge.source];
      proposals.push({ vault: name, path: source.rel, title: source.title, relation_index: edge.relation_index,
        predicate: edge.predicate, target: summarize(index, edge.target), evidence: edge.evidence, confidence: edge.confidence,
        can_review: !ctx.readOnly && ctx.byName.get(name)?.writes === 'on' });
    }
  }
  return { proposals, total, offset: start, limited: start + proposals.length < total };
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
  const relationships = index.typedRelations.flatMap((edge) => {
    if (edge.source === i && visible(edge.target)) return [{ direction: 'outgoing', relation_index: edge.relation_index, predicate: edge.predicate, evidence: edge.evidence, confidence: edge.confidence, note: summarize(index, edge.target) }];
    if (edge.target === i && visible(edge.source)) return [{ direction: 'incoming', predicate: edge.predicate, evidence: edge.evidence, confidence: edge.confidence, note: summarize(index, edge.source) }];
    return [];
  });
  const proposedRelationships = deriveProposedTypedRelations(index.notes).flatMap((edge) => {
    if (edge.source !== i || !visible(edge.target)) return [];
    return [{ relation_index: edge.relation_index, predicate: edge.predicate, evidence: edge.evidence, confidence: edge.confidence, note: summarize(index, edge.target) }];
  });
  const rejectedRelationships = deriveRejectedTypedRelations(index.notes).flatMap((edge) => {
    if (edge.source !== i || !visible(edge.target)) return [];
    return [{ relation_index: edge.relation_index, predicate: edge.predicate, evidence: edge.evidence, confidence: edge.confidence, note: summarize(index, edge.target) }];
  });
  const discoveredRelationships = discoverTypedRelationshipCandidates(index.notes, i).map(({ target_index, ...candidate }) => ({ ...candidate, note: summarize(index, target_index) }));
  return {
    vault: vaultName, path: n.rel, title: n.title, body: n.body, tags: [...n.tags],
    backlinks: [...index.backlinks[i]].filter(visible).map((j) => summarize(index, j)),
    outlinks: [...index.outlinks[i]].filter(visible).map((j) => summarize(index, j)),
    relationships, proposed_relationships: proposedRelationships, rejected_relationships: rejectedRelationships, discovered_relationships: discoveredRelationships,
  };
}
