// 3D notes graph (Ian's RB7 feature 2): nodes/edges across every enabled, non-private vault, and
// one note's detail (Markdown body, tags, backlinks, outlinks) for the side panel. Excluded
// folders never reach the index at all (loadVault walks past .brainlinkignore, see src/core.mjs);
// this module adds the one rule loadVault doesn't already enforce: private vaults and
// frontmatter-flagged private notes are dropped before a single node is built.
import { readFile, writeFile, rename, mkdir, lstat, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { loadVault, summarize, vault, vaultRoot, safeJoin, readNote } from './core.mjs';
import { resolveNoteWikilinks } from './links.mjs';
import { appHome } from './config.mjs';

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
// ids matching the same vault's buildGraph3D() so a backlink click can focus that node). Also
// carries what A3's Edit button needs: the raw file (frontmatter included, so saving an edit
// never drops it), its wikilinks resolved by the one shared, privacy-filtered resolver P1b already
// uses (src/links.mjs's resolveNoteWikilinks -- never a second, independent resolver here), and
// the file's current mtime, echoed back on save so a change made elsewhere since this note was
// opened is never silently overwritten (see editNote3D below).
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
  const full = safeJoin(vaultRoot(ctx, vaultName), rel);
  const [raw, st] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
  return {
    vault: vaultName, path: n.rel, title: n.title, body: n.body, tags: [...n.tags],
    raw, mtime: st.mtimeMs, wikilinks: resolveNoteWikilinks(index, n.body),
    backlinks: [...index.backlinks[i]].filter(visible).map((j) => summarize(index, j)),
    outlinks: [...index.outlinks[i]].filter(visible).map((j) => summarize(index, j)),
  };
}

// ---- A3: edit-in-place from the 3D graph panel ----
//
// Same write discipline as src/snapshot.mjs's own guards, applied to an in-vault edit instead of
// a shared-snapshot copy: realpath containment with no symlink escape, a backup of the previous
// version kept under appHome (never inside the vault, where a sync/cloud peer could read or
// restore it), an atomic write (temp file in the same directory, then rename -- a crash never
// leaves a half-written note), and a refusal if the file changed on disk since it was opened
// (last-write-wins would otherwise silently discard someone else's edit). readNote() re-derives
// the private/excluded refusal from the raw file, fail-closed -- the same check every other read
// path in this codebase uses -- so a note that only *looks* editable because of a stale cached
// index entry is still refused here.
function backupDir(env, vaultName) {
  return path.join(appHome(env), 'note-edit-backups', String(vaultName).replace(/[^\w.-]+/g, '_'));
}

export async function editNote3D(ctx, vaultName, rel, { content, mtime } = {}) {
  const v = vault(ctx, vaultName); // unknown or disconnected vault -> throws
  if (v.private) throw new Error('This vault is private and cannot be edited here.');
  if (typeof content !== 'string' || !content.trim()) throw new Error('Note content cannot be empty.');
  await readNote(ctx, vaultName, rel); // private / excluded / not-indexed (incl. reached via a symlink) -> throws, fail-closed
  const root = vaultRoot(ctx, vaultName);
  const full = safeJoin(root, rel);
  const before = await lstat(full);
  if (before.isSymbolicLink()) throw new Error('Refusing to edit: this note is a symlink.');
  const realRoot = await realpath(root);
  const realFull = await realpath(full);
  if (realFull !== realRoot && !realFull.startsWith(realRoot + path.sep)) throw new Error('Refusing to edit: this note is outside the vault.');
  if (typeof mtime !== 'number' || before.mtimeMs !== mtime) throw new Error('This note changed on disk since you opened it. Reopen it and try again.');
  const previous = await readFile(full, 'utf8');
  const dir = backupDir(ctx.env, vaultName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${rel.replace(/[\\/]/g, '__')}.${Date.now()}.bak.md`), previous);
  const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content);
  await rename(tmp, full);
  return { ok: true, path: `${vaultName}/${rel}` };
}
