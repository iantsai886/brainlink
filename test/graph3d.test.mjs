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

  await assert.rejects(() => noteDetail3D(ctx, 'Main', 'Hidden Note.md'), /private/i);
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

    const refused = await api('/api/graph3d/note', { vault: 'Main', path: 'Hidden Note.md' });
    assert.ok(refused.error || refused.message, 'a private note must error, not return its content');
  } finally { s.server.close(); }
});
