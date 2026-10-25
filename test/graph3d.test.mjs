// RB7 item 2: the 3D notes graph API. Excluded folders and private notes/vaults must never
// appear in the graph, the side panel, or backlinks/outlinks — same promise as search/answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { normalize } from '../src/config.mjs';
import { createContext } from '../src/core.mjs';
import { buildGraph3D, noteDetail3D } from '../src/graph3d.mjs';
import { startSetup } from '../src/setup.mjs';

const tmp = (p) => mkdtemp(path.join(tmpdir(), `brainlink-${p}-`));

async function buildVault(dir) {
  await mkdir(path.join(dir, 'Secret Stuff'), { recursive: true });
  await writeFile(path.join(dir, '.brainlinkignore'), 'Secret Stuff/\n');
  await writeFile(path.join(dir, 'Alpha.md'), '# Alpha\n\nLinks to [[Beta]] and [[Hidden Note]]. #planning\n');
  await writeFile(path.join(dir, 'Beta.md'), '# Beta\n\nBacklinked from Alpha. Also see [[Secret Stuff/Buried]].\n');
  await writeFile(path.join(dir, 'Hidden Note.md'), '---\nprivate: true\n---\n# Hidden Note\n\nShould never surface in the graph.\n');
  await writeFile(path.join(dir, 'Secret Stuff', 'Buried.md'), '# Buried\n\nIn an excluded folder; must never load at all.\n');
  return dir;
}

async function ctxFor(vaultPath, extraVaults = []) {
  const cfg = normalize({ vaults: [{ name: 'Main', path: vaultPath }, ...extraVaults] });
  return createContext(cfg, { env: { BRAINLINK_SEMANTIC: '0' } });
}

test('buildGraph3D: excluded-folder notes never appear as nodes or edges', async () => {
  const dir = await buildVault(await tmp('graph3d-excl'));
  const ctx = await ctxFor(dir);
  const g = await buildGraph3D(ctx, 'Main');
  const titles = g.nodes.map((n) => n.title);
  assert.ok(!titles.includes('Buried'), JSON.stringify(titles));
  assert.ok(titles.includes('Alpha') && titles.includes('Beta'));
});

test('buildGraph3D: a note with frontmatter "private: true" never appears as a node or edge target', async () => {
  const dir = await buildVault(await tmp('graph3d-privnote'));
  const ctx = await ctxFor(dir);
  const g = await buildGraph3D(ctx, 'Main');
  const titles = g.nodes.map((n) => n.title);
  assert.ok(!titles.includes('Hidden Note'), JSON.stringify(titles));
  const alpha = g.nodes.find((n) => n.title === 'Alpha');
  const beta = g.nodes.find((n) => n.title === 'Beta');
  // No link can target a node that was never added to the node list.
  for (const l of g.links) { assert.notEqual(l.target, undefined); assert.ok(g.nodes[l.target]); }
  assert.ok(alpha && beta);
});

test('buildGraph3D: a whole private vault is omitted even when another vault is enabled', async () => {
  const mainDir = await buildVault(await tmp('graph3d-mixed-main'));
  const privDir = await tmp('graph3d-mixed-priv');
  await writeFile(path.join(privDir, 'Journal Entry.md'), '# Journal Entry\n\nPersonal.\n');
  const cfg = normalize({ vaults: [{ name: 'Main', path: mainDir }, { name: 'Diary', path: privDir, private: true }] });
  const ctx = createContext(cfg, { env: { BRAINLINK_SEMANTIC: '0' } });
  const g = await buildGraph3D(ctx); // no vault filter: every enabled vault
  assert.ok(!g.nodes.some((n) => n.vault === 'Diary'), JSON.stringify(g.nodes));
  assert.ok(g.nodes.some((n) => n.vault === 'Main'));
});

test('noteDetail3D: refuses a private note, an excluded-folder note, and a private vault', async () => {
  const dir = await buildVault(await tmp('graph3d-detail-refuse'));
  const privDir = await tmp('graph3d-detail-privvault');
  await writeFile(path.join(privDir, 'Diary Entry.md'), '# Diary Entry\nPersonal.\n');
  const cfg = normalize({ vaults: [{ name: 'Main', path: dir }, { name: 'Diary', path: privDir, private: true }] });
  const ctx = createContext(cfg, { env: { BRAINLINK_SEMANTIC: '0' } });

  await assert.rejects(() => noteDetail3D(ctx, 'Main', 'Hidden Note.md'), /not found/i);
  await assert.rejects(() => noteDetail3D(ctx, 'Main', 'Secret Stuff/Buried.md'), /not found/i);
  await assert.rejects(() => noteDetail3D(ctx, 'Diary', 'Diary Entry.md'), /private/i);
});

test('noteDetail3D: a visible note returns its Markdown body, tags, backlinks and outlinks, all private-filtered', async () => {
  const dir = await buildVault(await tmp('graph3d-detail-ok'));
  const ctx = await ctxFor(dir);
  const beta = await noteDetail3D(ctx, 'Main', 'Beta.md');
  assert.match(beta.body, /Backlinked from Alpha/);
  assert.ok(beta.backlinks.some((b) => b.title === 'Alpha'));
  assert.ok(!beta.outlinks.some((b) => b.title === 'Buried'), 'the link into the excluded folder must be dropped');

  const alpha = await noteDetail3D(ctx, 'Main', 'Alpha.md');
  assert.deepEqual(alpha.tags, ['planning']);
  assert.ok(!alpha.outlinks.some((o) => o.title === 'Hidden Note'), 'the link to the private note must be dropped');
  assert.ok(alpha.outlinks.some((o) => o.title === 'Beta'));
});

test('buildGraph3D: stays bounded for a large vault (smoothness for ~2,000 nodes)', async () => {
  const dir = await tmp('graph3d-big');
  for (let i = 0; i < 300; i++) await writeFile(path.join(dir, `Note ${i}.md`), `# Note ${i}\n\nSee [[Note ${(i + 1) % 300}]].\n`);
  const ctx = await ctxFor(dir);
  const g = await buildGraph3D(ctx, 'Main', { limit: 150 });
  assert.equal(g.nodes.length, 150);
  assert.equal(g.total, 300);
  for (const l of g.links) { assert.ok(g.nodes[l.source] && g.nodes[l.target]); }
});

// ---- Setup UI wiring: /api/graph3d and /api/graph3d/note ----

test('/api/graph3d and /api/graph3d/note: same exclusion guarantee over HTTP', async () => {
  const home = await tmp('graph3d-api-home');
  const vaultPath = await buildVault(path.join(home, 'vault'));
  const env = { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' };
  const s = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${s.port}`;
  const api = (p, body) => fetch(base + p, { method: 'POST', headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
  try {
    const added = await api('/api/vault', { path: vaultPath, name: 'Main', pack: 'simple', scaffold: false });
    assert.equal(added.ok, true, JSON.stringify(added));

    const g = await api('/api/graph3d', {});
    const titles = g.nodes.map((n) => n.title);
    assert.ok(!titles.includes('Hidden Note') && !titles.includes('Buried'), JSON.stringify(titles));

    const note = await api('/api/graph3d/note', { vault: 'Main', path: 'Beta.md' });
    assert.match(note.body, /Backlinked from Alpha/);
    assert.ok(note.backlinks.some((b) => b.title === 'Alpha'));
    assert.equal(note.writable, true);
    const savedBody = '# Beta\n\nEdited from the graph.\n';
    const saved = await api('/api/graph3d/note/save', { vault: 'Main', path: 'Beta.md', etag: note.etag, body: savedBody });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const savedRaw = await (await import('node:fs/promises')).readFile(path.join(vaultPath, 'Beta.md'), 'utf8');
    assert.equal(savedRaw, savedBody, 'saving a note without frontmatter writes the edited Markdown body');
    const stale = await api('/api/graph3d/note/save', { vault: 'Main', path: 'Beta.md', etag: note.etag, body: 'stale overwrite' });
    assert.match(stale.error || stale.message || '', /changed since it was opened/i);

    const refused = await api('/api/graph3d/note', { vault: 'Main', path: 'Hidden Note.md' });
    assert.ok(refused.error || refused.message, 'a private note must error, not return its content');
    const privateSave = await api('/api/graph3d/note/save', { vault: 'Main', path: 'Hidden Note.md', etag: 'x', body: 'must not write' });
    assert.ok(privateSave.error || privateSave.message, 'private notes must not be editable');
    await (await import('node:fs/promises')).writeFile(path.join(vaultPath, 'Frontmatter.md'), '---\ntitle: Kept title\ntags: [one, two]\n---\nOld body\n');
    const withHeader = await api('/api/graph3d/note', { vault: 'Main', path: 'Frontmatter.md' });
    const headerSave = await api('/api/graph3d/note/save', { vault: 'Main', path: 'Frontmatter.md', etag: withHeader.etag, body: 'New body\n' });
    assert.equal(headerSave.ok, true, JSON.stringify(headerSave));
    const headerRaw = await (await import('node:fs/promises')).readFile(path.join(vaultPath, 'Frontmatter.md'), 'utf8');
    assert.equal(headerRaw, '---\ntitle: Kept title\ntags: [one, two]\n---\nNew body\n', 'editing the body preserves exact frontmatter bytes');
  } finally { s.server.close(); }
});

// ---- Frontend (ui/notes3d.js, ui/notes3d.css): click-to-open, readable labels, sizing ----
// No browser is available in this suite, so these are structural checks on the actual shipped
// code (not a DOM/visual test) guarding the specific regressions this item fixed: clicking a node
// must open its note (same as any other entry point into the detail panel), the hover label must
// be escaped (nodeLabel is rendered as the tooltip's innerHTML — unescaped note titles would be
// an HTML-injection hole), the selected node must be visibly distinguished, and the canvas must
// never be sized just once from a possibly-stale clientWidth read at construction time.

test('ui/notes3d.js: clicking a node opens its note via the same path as a wikilink/backlink chip', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../ui/notes3d.js', import.meta.url), 'utf8');
  assert.match(src, /\.onNodeClick\(\(n\) => openById\(n\.id\)\)/, 'node click must call openById, the same function wikilinks/chips use');
  assert.match(src, /function openById\(id\) \{[\s\S]*?openPanel\(node\);/, 'openById must open the detail panel (title, body, backlinks/outlinks)');
});

test('ui/notes3d.js: hover label is escaped, and the selected node is visibly highlighted', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../ui/notes3d.js', import.meta.url), 'utf8');
  assert.match(src, /\.nodeLabel\(\(n\) => `\$\{esc\(n\.title\)\}.*esc\(n\.type\)/, 'node labels show typed entity kind while escaping note-derived title and type text');
  assert.match(src, /\.linkLabel\(\(l\) => l\.predicate \? esc\(l\.predicate\) : ''\)/, 'typed relationship labels are escaped before graph rendering');
  assert.match(src, /selectedId/, 'the currently-open node must be tracked so it can be highlighted');
  assert.match(src, /\.nodeColor\(\(n\) => \(n\.id === selectedId/, 'the selected node must render in a distinct color');
  assert.match(src, /\.nodeVal\(\(n\) => \(n\.id === selectedId/, 'the selected node must render larger, reinforcing which note is open');
  assert.doesNotMatch(src, /\bTHREE\b|nodeThreeObject/, 'the graph bundle does not expose THREE globally; custom sprites must not break graph rendering');
});

test('ui/notes3d.js + ui/notes3d.css: the canvas is resized from the real container size more than once (construction races a 0/stale clientWidth), and CSS caps it from overflowing', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../ui/notes3d.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../ui/notes3d.css', import.meta.url), 'utf8');
  assert.match(src, /function resizeToContainer\(\)/);
  assert.match(src, /new ResizeObserver\(resizeToContainer\)/, 'every container resize must re-apply the real size');
  assert.match(src, /requestAnimationFrame\(resizeToContainer\)/, 'the initial size must be re-applied a frame later too, after layout has definitely settled');
  assert.match(css, /\.notes3d-canvas\s*>\s*div,\s*\.notes3d-canvas canvas\s*\{[^}]*max-width:\s*100%[^}]*max-height:\s*100%/, 'a hard CSS cap so a stale/0 clientWidth read can never visibly overflow the container');
});

// ---- P1c: larger default graph size ----

test('ui/notes3d.css: the map is larger by default than the old 4:3 box', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../ui/notes3d.css', import.meta.url), 'utf8');
  const block = css.match(/\.notes3d-wrap\s*\{[^}]*\}/)[0];
  assert.doesNotMatch(block, /aspect-ratio:\s*4\s*\/\s*3/, 'must no longer be the old, smaller 4:3 box');
  assert.match(block, /min-height:\s*\d+px/, 'needs a height floor so it is never cramped, independent of aspect-ratio');
});

test('3D graph has a searchable, keyboard-accessible note list in every supported language', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../ui/notes3d.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../ui/notes3d.css', import.meta.url), 'utf8');
  assert.match(src, /id="notes3d-search" type="search"/);
  assert.match(src, /role="status" aria-live="polite"/);
  assert.match(src, /matches\.slice\(0, 50\)/, 'large vaults must not render every note into the accessibility list at once');
  assert.match(src, /data-graph-note-id=.*aria-pressed=/);
  assert.match(src, /if \(graphNote\) \{ openById\(graphNote\.dataset\.graphNoteId\); return; \}/, 'keyboard activation of a note button must open the same detail panel as a graph click');
  assert.match(src, /brainlink:locale-changed/);
  assert.match(css, /\.notes3d-node:focus-visible/);
  const keys = ['notes3d.browseNotes', 'notes3d.browseSearch', 'notes3d.browsePlaceholder', 'notes3d.browseEmpty', 'notes3d.browseCount', 'notes3d.browseMore'];
  for (const locale of ['en', 'zh-TW', 'pt']) {
    const catalog = JSON.parse(await readFile(new URL(`../ui/locales/${locale}.json`, import.meta.url), 'utf8'));
    for (const key of keys) assert.ok(catalog[key], `${locale} ${key}`);
  }
});
