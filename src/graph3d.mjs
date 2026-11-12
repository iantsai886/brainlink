// 3D notes graph for the local Setup UI. Private vaults can be selected one at a time in this
// local view, but are never combined with public vaults. Frontmatter-private notes and excluded
// folders stay hidden in every view.
import { createHash } from 'node:crypto';
import { loadVault, loadVaultGraph, summarize } from './core.mjs';
import { deriveTypedRelations, typedEntityMetadataMap, typedEntityFields, deriveProposedTypedRelations, deriveRejectedTypedRelations, deriveWithdrawnTypedRelations, discoverTypedRelationshipCandidates, discoverTypedRelationshipCandidatesForSources } from './typed-graph.mjs';

const GRAPH3D_LINK_LIMIT = 10_000;

// n.private is already computed once, at index-build time, by core.mjs's isPrivateMeta — reusing
// it here (rather than re-deriving private-ness from n.meta.private with a second, independent
// regex) is what keeps this module in lockstep with every other private check in the codebase.
const isPrivateNote = (n) => n.private;

// Public vaults can be combined. A private vault is visible only when the local caller explicitly
// selects that one vault; it never joins the combined graph.
async function visibleVaults(ctx, only, { includePrivateVault = false } = {}) {
  const names = (only ? [only] : ctx.enabled).filter((name) => ctx.enabled.includes(name)
    && (!ctx.byName.get(name)?.private || (includePrivateVault && only === name)));
  const out = [];
  for (const name of names) out.push({ name, index: await loadVaultGraph(ctx, name) });
  return out;
}

export async function listGraphVaults(ctx, { includePrivateVaults = false } = {}) {
  const names = ctx.enabled.filter((name) => includePrivateVaults || !ctx.byName.get(name)?.private);
  const vaults = [];
  for (const name of names) {
    const isPrivateVault = Boolean(ctx.byName.get(name)?.private);
    // Listing the picker must not read/index a private vault before the user selects it.
    if (isPrivateVault) { vaults.push({ name, private: true, notes: null }); continue; }
    const index = await loadVaultGraph(ctx, name);
    vaults.push({ name, private: false, notes: index.notes.filter((note) => !note.generated && !isPrivateNote(note)).length });
  }
  return { vaults };
}

// { nodes: [{id, title, vault, group, tags, degree}], links: [{source, target}], shown, total }
export async function buildGraph3D(ctx, vaultName, { limit = 2000, includePrivateVault = false } = {}) {
  const vaults = await visibleVaults(ctx, vaultName, { includePrivateVault: includePrivateVault && Boolean(vaultName) });
  const nodes = [], keep = [], graphByVault = new Map();
  let linkCount = 0, unlinked = 0;
  for (const { name, index } of vaults) {
    // Build every graph-derived structure from the caller-visible note set. Private and generated
    // notes must not affect entity-ID uniqueness, edge counts, ranking, or graph output.
    const visible = [], visibleIndex = new Map();
    index.notes.forEach((note, originalIndex) => {
      if (note.generated || isPrivateNote(note)) return;
      visibleIndex.set(originalIndex, visible.length);
      visible.push(note);
    });
    // loadVault() already builds and caches these graph structures. Rebuilding the resolver and
    // reparsing every note here duplicated large amounts of work and memory on real vaults.
    const plainEdges = (index.noteEdges || []).flatMap(([source, target]) => {
      const from = visibleIndex.get(source), to = visibleIndex.get(target);
      return from === undefined || to === undefined ? [] : [{ source: from, target: to, kind: 'note_link' }];
    });
    const typedEdges = (index.typedRelations || deriveTypedRelations(index.notes)).flatMap((edge) => {
      const source = visibleIndex.get(edge.source), target = visibleIndex.get(edge.target);
      return source === undefined || target === undefined ? [] : [{ ...edge, source, target, kind: 'typed' }];
    });
    const edges = [...plainEdges, ...typedEdges];
    linkCount += new Set(edges.map((edge) => `${edge.source}>${edge.target}`)).size;
    const degree = new Array(visible.length).fill(0);
    for (const edge of edges) { degree[edge.source]++; degree[edge.target]++; }
    unlinked += degree.filter((value) => value === 0).length;
    const entityMetadata = typedEntityMetadataMap(visible);
    graphByVault.set(name, { visible, edges, degree, entityMetadata });
    for (let i = 0; i < visible.length; i++) keep.push({ name, visibleIndex: i, note: visible[i], degree: degree[i], entityMetadata });
  }
  const total = keep.length;
  // Big vaults: show the most-connected notes first so the graph stays smooth (~2,000 nodes).
  keep.sort((a, b) => b.degree - a.degree || a.name.localeCompare(b.name) || a.note.rel.localeCompare(b.note.rel));
  const shown = keep.slice(0, limit);
  const pos = new Map(); // `${vault}::${visibleIndex}` -> node index
  shown.forEach((k, pIdx) => pos.set(`${k.name}::${k.visibleIndex}`, pIdx));
  for (const k of shown) {
    const n = k.note;
    nodes.push({ id: pos.get(`${k.name}::${k.visibleIndex}`), title: n.title, path: n.rel, vault: k.name, group: n.rel.includes('/') ? n.rel.split('/')[0] : '', tags: [...n.tags], degree: k.degree, ...(k.entityMetadata.get(n) || {}) });
  }
  const links = [];
  const includedPairs = new Map();
  for (const [name, graph] of graphByVault) {
    for (const edge of graph.edges) {
      const source = pos.get(`${name}::${edge.source}`), target = pos.get(`${name}::${edge.target}`);
      if (source === undefined || target === undefined) continue;
      const pair = source < target ? `${source}:${target}` : `${target}:${source}`;
      if (!includedPairs.has(pair)) includedPairs.set(pair, []);
      includedPairs.get(pair).push({ source, target, kind: edge.kind,
        ...(edge.kind === 'typed' ? { predicate: edge.predicate, evidence: edge.evidence, confidence: edge.confidence } : {}) });
    }
  }
  for (const group of includedPairs.values()) {
    group.forEach((edge, parallelIndex) => links.push({ ...edge, parallel_index: parallelIndex, parallel_count: group.length }));
  }
  // The force layout becomes unresponsive when a large vault sends every edge between the top
  // 2,000 nodes to WebGL. Keep the most useful/high-degree links, including typed relations first.
  if (links.length > GRAPH3D_LINK_LIMIT) {
    const degreeById = new Map(nodes.map((node) => [node.id, node.degree]));
    links.sort((a, b) => Number(b.kind === 'typed') - Number(a.kind === 'typed') ||
      Math.max(degreeById.get(b.source) || 0, degreeById.get(b.target) || 0) - Math.max(degreeById.get(a.source) || 0, degreeById.get(a.target) || 0));
    links.length = GRAPH3D_LINK_LIMIT;
  }
  return { vault: vaultName || null, nodes, links, shown: nodes.length, total, linkCount, unlinked };
}

// A bounded, review-only queue for public vaults in the local Setup UI.
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

// A bounded page of deterministic, same-scope graph candidates. Callers receive only public
// vault indexes; candidates remain suggestions until explicitly saved and separately approved.
export async function discoverVaultRelationshipCandidates(ctx, { vault, offset = 0, limit = 20, scanId } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new Error('Discovery offset is invalid.');
  const pageSize = Math.max(1, Math.min(50, Number.isSafeInteger(limit) ? limit : 20));
  const vaults = await visibleVaults(ctx, vault);
  const rows = [];
  for (const { name, index } of vaults) {
    for (let source = 0; source < index.notes.length; source++) {
      const note = index.notes[source];
      if (note.generated || isPrivateNote(note)) continue;
      rows.push({ vault: name, path: note.rel, title: note.title, source, index });
    }
  }
  // Filesystem enumeration order differs across platforms and can change between reads.
  // Sort before paging and fingerprinting so a scan has stable, predictable pages.
  rows.sort((a, b) => a.vault.localeCompare(b.vault, 'en') || a.path.localeCompare(b.path, 'en'));
  const fingerprint = createHash('sha256');
  for (const row of rows) fingerprint.update(`${row.vault}\0${row.path}\0${createHash('sha256').update(row.index.notes[row.source].raw).digest('hex')}\n`);
  const currentScanId = fingerprint.digest('hex');
  if (offset > 0 && (typeof scanId !== 'string' || scanId !== currentScanId)) throw new Error('A vault changed during this scan. Start the scan again.');
  const page = rows.slice(offset, offset + pageSize);
  const candidates = [];
  const byIndex = new Map();
  for (const row of page) {
    if (!byIndex.has(row.index)) byIndex.set(row.index, []);
    byIndex.get(row.index).push(row);
  }
  for (const [index, sources] of byIndex) {
    const detected = discoverTypedRelationshipCandidatesForSources(index.notes, sources.map((row) => row.source), { limit: 30 });
    for (const row of sources) for (const item of detected.get(row.source) || []) {
      const target = row.index.notes[item.target_index];
      if (!target || isPrivateNote(target) || target.generated) continue;
      candidates.push({ vault: row.vault, path: row.path, title: row.title,
        target_id: item.target_id, predicate: item.predicate, evidence: item.evidence,
        confidence: item.confidence, can_save: !ctx.readOnly && ctx.byName.get(row.vault)?.writes === 'on',
        target: { title: target.title, path: target.rel } });
    }
  }
  return { candidates, scan_id: currentScanId, offset, next_offset: offset + page.length, done: offset + page.length >= rows.length,
    scanned: page.length, total_sources: rows.length };
}

// One note's panel data: rendered-ready Markdown body, tags, backlinks and outlinks (titles +
// ids matching the same vault's buildGraph3D() so a backlink click can focus that node).
export async function noteDetail3D(ctx, vaultName, rel, { includePrivateVault = false } = {}) {
  const v = ctx.byName.get(vaultName);
  if (!v || !ctx.enabled.includes(vaultName)) throw new Error(`Unknown vault "${vaultName}".`);
  if (v.private && !includePrivateVault) throw new Error('This note is in a private vault and can only be shown in its local vault-only graph.');
  const index = await loadVault(ctx, vaultName);
  const i = index.byRel.get(rel);
  if (i === undefined) throw new Error(`Note not found: ${rel}`);
  const n = index.notes[i];
  if (isPrivateNote(n)) throw new Error('This note is private and cannot be shown in the graph.');
  const visible = (j) => !index.notes[j].generated && !isPrivateNote(index.notes[j]);
  const relationships = index.typedRelations.flatMap((edge) => {
    if (edge.source === i && visible(edge.target)) return [{ direction: 'outgoing', relation_index: edge.relation_index, target_id: index.notes[edge.target].meta.id, predicate: edge.predicate, evidence: edge.evidence, confidence: edge.confidence, note: summarize(index, edge.target) }];
    if (edge.target === i && visible(edge.source)) return [{ direction: 'incoming', predicate: edge.predicate, evidence: edge.evidence, confidence: edge.confidence, note: summarize(index, edge.source) }];
    return [];
  });
  const proposedRelationships = deriveProposedTypedRelations(index.notes).flatMap((edge) => {
    if (edge.source !== i || !visible(edge.target)) return [];
    return [{ relation_index: edge.relation_index, target_id: index.notes[edge.target].meta.id, predicate: edge.predicate, evidence: edge.evidence, confidence: edge.confidence, note: summarize(index, edge.target) }];
  });
  const rejectedRelationships = deriveRejectedTypedRelations(index.notes).flatMap((edge) => {
    if (edge.source !== i || !visible(edge.target)) return [];
    return [{ relation_index: edge.relation_index, target_id: index.notes[edge.target].meta.id, predicate: edge.predicate, evidence: edge.evidence, confidence: edge.confidence, note: summarize(index, edge.target) }];
  });
  const withdrawnRelationships = deriveWithdrawnTypedRelations(index.notes).flatMap((edge) => {
    if (edge.source !== i || !visible(edge.target)) return [];
    return [{ relation_index: edge.relation_index, target_id: index.notes[edge.target].meta.id, predicate: edge.predicate, evidence: edge.evidence, confidence: edge.confidence, note: summarize(index, edge.target) }];
  });
  const discoveredRelationships = discoverTypedRelationshipCandidates(index.notes, i).map(({ target_index, ...candidate }) => ({ ...candidate, note: summarize(index, target_index) }));
  return {
    vault: vaultName, path: n.rel, title: n.title, body: n.body, tags: [...n.tags], graph_record: typedEntityFields(n.raw),
    backlinks: [...index.backlinks[i]].filter(visible).map((j) => summarize(index, j)),
    outlinks: [...index.outlinks[i]].filter(visible).map((j) => summarize(index, j)),
    relationships, proposed_relationships: proposedRelationships, rejected_relationships: rejectedRelationships, withdrawn_relationships: withdrawnRelationships, discovered_relationships: discoveredRelationships,
  };
}
