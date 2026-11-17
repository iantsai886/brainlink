// RB7 item 2: the 3D notes graph API. Excluded folders and private notes/vaults must never
// appear in the graph, the side panel, or backlinks/outlinks — same promise as search/answers.
import { readSetupHtml } from './helpers/setup-html.mjs';
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
  assert.equal(g.total, 2, 'the total count must not disclose the private note');
  const alpha = g.nodes.find((n) => n.title === 'Alpha');
  const beta = g.nodes.find((n) => n.title === 'Beta');
  // No link can target a node that was never added to the node list.
  for (const l of g.links) { assert.notEqual(l.target, undefined); assert.ok(g.nodes[l.target]); }
  assert.ok(alpha && beta);
});

test('graph cache immediately drops notes newly marked private or excluded', async () => {
  const dir = await buildVault(await tmp('graph3d-privacy-refresh'));
  const ctx = await ctxFor(dir);
  assert.ok((await buildGraph3D(ctx, 'Main')).nodes.some((node) => node.title === 'Alpha'));
  await writeFile(path.join(dir, 'Alpha.md'), '---\nprivate: true\n---\n# Alpha\n');
  assert.ok(!(await buildGraph3D(ctx, 'Main')).nodes.some((node) => node.title === 'Alpha'));
  await writeFile(path.join(dir, '.brainlinkignore'), 'Secret Stuff/\nBeta.md\n');
  assert.ok(!(await buildGraph3D(ctx, 'Main')).nodes.some((node) => node.title === 'Beta'));
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
  assert.equal(g.total, 2, 'the total count must not disclose notes in the private vault');
});

test('buildGraph3D: keeps typed relationships separate and derives graph metadata only from visible notes', async () => {
  const dir = await tmp('graph3d-parallel-relations');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'Workflow.md'), `---
type: workflow
id: workflow.collect
scope: organisation
status: current
relations:
  - predicate: owned_by
    target: team.product
    review: verified
    source: "The Product team owns this intake workflow."
    confidence: 0.98
  - predicate: communicates_with
    target: team.product
    review: verified
    source: "The intake workflow hands off reviewed questions to the Product team."
    confidence: 0.91
---
# Collect questions

Related team: [[Product Team]]
`);
  await writeFile(path.join(dir, 'Product Team.md'), '---\ntype: team\nid: team.product\nscope: organisation\nstatus: current\n---\n# Product team\n');
  await writeFile(path.join(dir, 'Private Duplicate.md'), '---\nprivate: true\ntype: team\nid: team.product\nscope: organisation\nstatus: current\n---\n# Private duplicate\nPRIVATE_DUPLICATE_CANARY\n');
  await writeFile(path.join(dir, 'Private source.md'), `---
private: true
type: workflow
id: workflow.secret
scope: organisation
status: current
relations:
  - predicate: runs
    target: team.product
    review: verified
    source: "PRIVATE_RELATION_CANARY"
    confidence: 1
---
# Private source
`);

  const graph = await buildGraph3D(await ctxFor(dir), 'Main');
  const workflow = graph.nodes.find((node) => node.title === 'Workflow');
  const team = graph.nodes.find((node) => node.title === 'Product Team');
  assert.ok(workflow && team);
  assert.equal(team.entity_id, 'team.product', 'a hidden duplicate must not alter visible entity metadata');
  const edges = graph.links.filter((edge) => edge.source === workflow.id && edge.target === team.id);
  assert.equal(edges.length, 3, 'two typed edges and one ordinary note link must stay distinct');
  assert.equal(edges.filter((edge) => edge.kind === 'typed').length, 2);
  assert.equal(edges.filter((edge) => edge.kind === 'note_link').length, 1);
  assert.deepEqual(edges.filter((edge) => edge.kind === 'typed').map((edge) => edge.predicate).sort(), ['communicates_with', 'owned_by']);
  assert.ok(edges.every((edge) => edge.parallel_count === 3));
  assert.match(edges.find((edge) => edge.predicate === 'owned_by').evidence, /Product team owns/);
  assert.equal(graph.total, 2, 'private source and duplicate do not affect the graph total');
  assert.doesNotMatch(JSON.stringify(graph), /PRIVATE_DUPLICATE_CANARY|PRIVATE_RELATION_CANARY|Private source/);
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
  const s = await startSetup({ env, home, os: 'linux', port: 0, useCli: false, vaultWatchPollMs: 25 });
  const base = `http://127.0.0.1:${s.port}`;
  const api = (p, body) => fetch(base + p, { method: 'POST', headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
  try {
    const added = await api('/api/vault', { path: vaultPath, name: 'Main', pack: 'simple', scaffold: false });
    assert.equal(added.ok, true, JSON.stringify(added));
    await new Promise((resolve) => setTimeout(resolve, 350)); // let the newly-added vault's initial Home map write settle

    const denied = await fetch(`${base}/api/events?t=wrong-token`);
    assert.equal(denied.status, 401);
    const events = await fetch(`${base}/api/events?t=${encodeURIComponent(s.token)}`);
    const reader = events.body.getReader();
    await reader.read(); // connected comment
    const fs = await import('node:fs/promises');
    const publicText = 'public live refresh marker';
    const privateText = 'ZQX_PRIVATE_WATCH_CANARY';
    await fs.writeFile(path.join(vaultPath, 'External.md'), `# External\n\n${publicText}\n`);
    await fs.writeFile(path.join(vaultPath, 'External Private.md'), `---\nprivate: true\n---\n# External Private\n\n${privateText}\n`);
    const change = await Promise.race([
      reader.read().then(({ value }) => new TextDecoder().decode(value)),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000)),
    ]);
    assert.match(change, /event: vault-changed/);
    assert.doesNotMatch(change, /External|public live|ZQX_PRIVATE/);
    await reader.cancel();

    const g = await api('/api/graph3d', {});
    const titles = g.nodes.map((n) => n.title);
    assert.equal(g.total, 3, 'the HTTP graph total counts only public, non-generated notes');
    assert.ok(!titles.includes('Hidden Note') && !titles.includes('Buried'), JSON.stringify(titles));
    assert.ok(titles.includes('External') && !titles.includes('External Private'), JSON.stringify(titles));
    const available = await api('/api/graph3d/vaults', {});
    assert.deepEqual(available.vaults.map((v) => v.name), ['Main']);
    assert.equal(available.vaults[0].notes, null, 'the picker avoids scanning vault files before the graph is requested');
    const filtered = await api('/api/graph3d', { vault: 'Main' });
    assert.deepEqual(filtered.nodes.map((n) => n.title), titles);
    assert.equal(filtered.total, g.total);

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

    const concurrentNote = await api('/api/graph3d/note', { vault: 'Main', path: 'Beta.md' });
    const concurrentSaves = await Promise.all([
      api('/api/graph3d/note/save', { vault: 'Main', path: 'Beta.md', etag: concurrentNote.etag, body: '# Beta\n\nFirst concurrent edit.\n' }),
      api('/api/graph3d/note/save', { vault: 'Main', path: 'Beta.md', etag: concurrentNote.etag, body: '# Beta\n\nSecond concurrent edit.\n' }),
    ]);
    assert.equal(concurrentSaves.filter((result) => result.ok).length, 1, JSON.stringify(concurrentSaves));
    assert.equal(concurrentSaves.filter((result) => /changed since it was opened/i.test(result.error || '')).length, 1, JSON.stringify(concurrentSaves));
    const concurrentRaw = await (await import('node:fs/promises')).readFile(path.join(vaultPath, 'Beta.md'), 'utf8');
    assert.match(concurrentRaw, /First concurrent edit|Second concurrent edit/);
    assert.doesNotMatch(concurrentRaw, /stale overwrite/);

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

test('/api/graph3d/note builds an Obsidian URI for a BrainLink subfolder inside a registered vault', async () => {
  const home = await tmp('graph3d-obsidian-home');
  const obsidianRoot = path.join(home, 'Obsidian Vault');
  const brainlinkRoot = path.join(obsidianRoot, '20 Iango');
  await mkdir(path.join(obsidianRoot, '.obsidian'), { recursive: true });
  await mkdir(brainlinkRoot, { recursive: true });
  await writeFile(path.join(brainlinkRoot, 'Target Note.md'), '# Target\n');
  const obsidianConfig = path.join(home, '.config', 'obsidian', 'obsidian.json');
  await mkdir(path.dirname(obsidianConfig), { recursive: true });
  await writeFile(obsidianConfig, JSON.stringify({ vaults: { 'stable-vault-id': { path: obsidianRoot, open: true } } }));
  const env = { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' };
  const s = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const api = (p, body) => fetch(`http://127.0.0.1:${s.port}${p}`, { method: 'POST', headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
  try {
    const added = await api('/api/vault', { path: brainlinkRoot, name: 'Company', pack: 'simple', scaffold: false });
    assert.equal(added.ok, true, JSON.stringify(added));
    const detail = await api('/api/graph3d/note', { vault: 'Company', path: 'Target Note.md' });
    assert.equal(detail.obsidian_registered, true);
    assert.equal(detail.obsidian_url, 'obsidian://open?vault=stable-vault-id&file=20%20Iango%2FTarget%20Note');
  } finally { await s.server.close(); }
});

test('/api/graph3d/entity/save edits only the selected public note, checks unique IDs, and preserves its body', async () => {
  const home = await tmp('graph3d-entity-home');
  const vaultPath = await buildVault(path.join(home, 'vault'));
  await writeFile(path.join(vaultPath, 'Team.md'), '---\ntype: team\nid: team.product\nscope: organisation\nstatus: current\n---\n# Product team\n');
  const s = await startSetup({ env: { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' }, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${s.port}`;
  const api = (p, body) => fetch(base + p, { method: 'POST', headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
  try {
    await api('/api/vault', { path: vaultPath, name: 'Main', pack: 'simple', scaffold: false });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const note = await api('/api/graph3d/note', { vault: 'Main', path: 'Beta.md' });
    assert.deepEqual(note.graph_record, {});
    const fields = { type: 'concept', id: 'concept.beta', scope: 'organisation', status: 'proposed' };
    const saved = await api('/api/graph3d/entity/save', { vault: 'Main', path: 'Beta.md', etag: note.etag, graph_record: fields });
    assert.equal(saved.ok, true, JSON.stringify(saved)); assert.deepEqual(saved.graph_record, fields);
    const savedNote = await api('/api/graph3d/note', { vault: 'Main', path: 'Beta.md' });
    assert.deepEqual(savedNote.graph_record, fields); assert.match(savedNote.body, /Backlinked from Alpha/);
    const stale = await api('/api/graph3d/entity/save', { vault: 'Main', path: 'Beta.md', etag: note.etag, graph_record: { ...fields, id: 'concept.changed' } });
    assert.match(stale.error || '', /changed since it was opened/);
    const duplicate = await api('/api/graph3d/entity/save', { vault: 'Main', path: 'Beta.md', etag: savedNote.etag, graph_record: { ...fields, id: 'team.product' } });
    assert.match(duplicate.error || '', /already used/);
    const privateEdit = await api('/api/graph3d/entity/save', { vault: 'Main', path: 'Hidden Note.md', etag: 'x', graph_record: fields });
    assert.ok(privateEdit.error || privateEdit.message);
  } finally { s.server.close(); }
});

test('/api/graph3d/entity/save stores structured workflow details in the selected writable public note', async () => {
  const home = await tmp('graph3d-workflow-edit');
  const vaultPath = await buildVault(path.join(home, 'vault'));
  await writeFile(path.join(vaultPath, 'Workflow.md'), '---\ntype: workflow\nid: workflow.demo\nscope: organisation\nstatus: current\n---\n# Demo workflow\n\nKeep body and [[Beta]].\n');
  const s = await startSetup({ env: { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' }, home, os: 'linux', port: 0, useCli: false });
  const api = (p, body) => fetch(`http://127.0.0.1:${s.port}${p}`, { method: 'POST', headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
  try {
    await api('/api/vault', { path: vaultPath, name: 'Main', pack: 'simple', scaffold: false });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const note = await api('/api/graph3d/note', { vault: 'Main', path: 'Workflow.md' });
    const record = { ...note.graph_record, triggers: ['New ticket'], inputs: ['Ticket data'], steps: ['Review, classify', 'Assign owner'], outputs: ['Draft response'], exception_handling: ['Escalate to team'] };
    const saved = await api('/api/graph3d/entity/save', { vault: 'Main', path: 'Workflow.md', etag: note.etag, graph_record: record });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.deepEqual(saved.graph_record, record);
    const reopened = await api('/api/graph3d/note', { vault: 'Main', path: 'Workflow.md' });
    assert.deepEqual(reopened.graph_record, record);
    assert.match(reopened.body, /Keep body and \[\[Beta\]\]/);
  } finally { s.server.close(); }
});

test('vault graph discovery is paged, scope-safe, excludes private records, and only saves review proposals', async () => {
  const home = await tmp('graph3d-discovery');
  const vaultPath = path.join(home, 'vault');
  const privatePath = path.join(home, 'private');
  await mkdir(vaultPath, { recursive: true });
  await mkdir(privatePath, { recursive: true });
  await writeFile(path.join(vaultPath, 'A Product Team.md'), '---\ntype: team\nid: team.product\nscope: organisation\nstatus: current\n---\n# Product Team\n\nProduct Team coordinates with Data Team every day. Ava coordinates ownership of the product team intake workflow.\n');
  await writeFile(path.join(vaultPath, 'Ava.md'), '---\ntype: person\nid: person.ava\nscope: organisation\nstatus: current\n---\n# Ava\n');
  await writeFile(path.join(vaultPath, 'Z Client Project.md'), '---\ntype: project\nid: project.client\nscope: client\nstatus: current\n---\n# Client Project\n');
  await writeFile(path.join(vaultPath, 'Private Workflow.md'), '---\ntype: workflow\nid: workflow.hidden\nscope: organisation\nstatus: current\nprivate: true\n---\n# Private Workflow\nPRIVATE_TARGET_CANARY\n');
  await writeFile(path.join(vaultPath, 'Data Team.md'), '---\ntype: team\nid: team.data\nscope: organisation\nstatus: current\n---\n# Data Team\n');
  for (let i = 0; i < 22; i++) await writeFile(path.join(vaultPath, `Generic ${String(i).padStart(2, '0')}.md`), `# Generic ${i}\n\nOrdinary note ${i}.\n`);
  await writeFile(path.join(vaultPath, 'Private Source.md'), '---\ntype: workflow\nid: workflow.private\nscope: organisation\nstatus: current\nprivate: true\n---\n# Private\n\nThis workflow runs PRIVATE_CANARY.\n');
  await writeFile(path.join(privatePath, 'Client Team.md'), '---\ntype: team\nid: team.client\nscope: client\nstatus: current\n---\n# Client Team\n');
  await writeFile(path.join(privatePath, 'Client Workflow.md'), '---\ntype: workflow\nid: workflow.client\nscope: client\nstatus: current\n---\n# Client work\n\nThis workflow runs Client Team.\n');
  const env = { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' };
  const s = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${s.port}`;
  const api = (p, body) => fetch(base + p, { method: 'POST', headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
  try {
    assert.equal((await api('/api/vault', { path: vaultPath, name: 'Main', pack: 'simple', scaffold: false })).ok, true);
    assert.equal((await api('/api/vault', { path: privatePath, name: 'Client', private: true, pack: 'simple', scaffold: false })).ok, true);
    const first = await api('/api/graph3d/discover', { offset: 0 });
    assert.equal(first.scanned, 20);
    assert.equal(first.done, false);
    assert.ok(first.candidates.some((c) => c.path === 'A Product Team.md' && c.target_id === 'team.data'), JSON.stringify(first));
    assert.doesNotMatch(JSON.stringify(first), /PRIVATE_CANARY|workflow\.client|team\.client|Client Team/);
    assert.equal(first.candidates.find((c) => c.path === 'A Product Team.md').can_save, true);
    env.BRAINLINK_READ_ONLY = '1';
    const readOnly = await api('/api/graph3d/discover', { offset: 0 });
    assert.equal(readOnly.candidates.find((c) => c.path === 'A Product Team.md').can_save, false);
    delete env.BRAINLINK_READ_ONLY;
    const second = await api('/api/graph3d/discover', { offset: first.next_offset, scan_id: first.scan_id });
    assert.equal(second.done, true);
    assert.ok(second.next_offset > first.next_offset);
    assert.equal(first.total_sources, second.total_sources);
    await writeFile(path.join(vaultPath, 'Added while scanning.md'), '# New note\n');
    const stalePage = await api('/api/graph3d/discover', { offset: second.next_offset, scan_id: first.scan_id });
    assert.match(stalePage.error, /vault changed during this scan/i);
    const badOffset = await api('/api/graph3d/discover', { offset: -1 });
    assert.match(badOffset.error, /offset is invalid/i);
    const candidate = first.candidates.find((c) => c.path === 'A Product Team.md');
    const detail = await api('/api/graph3d/note', { vault: 'Main', path: candidate.path });
    const saved = await api('/api/graph3d/relationship/propose', { vault: 'Main', path: candidate.path, etag: detail.etag,
      target_id: candidate.target_id, predicate: candidate.predicate, evidence: candidate.evidence });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const afterPatternSave = await api('/api/graph3d/note', { vault: 'Main', path: 'A Product Team.md' });
    const badEvidence = await api('/api/graph3d/relationship/propose-manual', { vault: 'Main', path: 'A Product Team.md', etag: afterPatternSave.etag,
      target_id: 'person.ava', predicate: 'assigned_to', evidence: 'This text is not in the note.' });
    assert.match(badEvidence.error, /exact excerpt/i);
    const crossScope = await api('/api/graph3d/relationship/propose-manual', { vault: 'Main', path: 'A Product Team.md', etag: afterPatternSave.etag,
      target_id: 'project.client', predicate: 'part_of', evidence: 'Ava coordinates ownership of the product team intake workflow.' });
    assert.match(crossScope.error, /same Twin scope/i);
    const privateTarget = await api('/api/graph3d/relationship/propose-manual', { vault: 'Main', path: 'A Product Team.md', etag: afterPatternSave.etag,
      target_id: 'workflow.hidden', predicate: 'depends_on', evidence: 'Ava coordinates ownership of the product team intake workflow.' });
    assert.match(privateTarget.error, /same Twin scope/i);
    assert.doesNotMatch(JSON.stringify(privateTarget), /PRIVATE_TARGET_CANARY|Private Workflow/);
    const manual = await api('/api/graph3d/relationship/propose-manual', { vault: 'Main', path: 'A Product Team.md', etag: afterPatternSave.etag,
      target_id: 'person.ava', predicate: 'communicates_with', evidence: 'Ava coordinates ownership of the product team intake workflow.' });
    assert.equal(manual.ok, true, JSON.stringify(manual));
    const graph = await api('/api/graph3d', {});
    assert.equal(graph.links.some((edge) => edge.predicate === candidate.predicate || edge.predicate === 'assigned_to'), false, 'a proposal must not become a live graph edge');
    assert.equal((await api('/api/graph3d/reviews', {})).total, 2);
  } finally { s.server.close(); }
});

test('typed relationship review requires a current note revision and adds only the explicitly approved edge', async () => {
  const home = await tmp('graph3d-review-home');
  const vaultPath = path.join(home, 'vault');
  await mkdir(vaultPath, { recursive: true });
  const env = { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' };
  const s = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${s.port}`;
  const api = (p, body) => fetch(base + p, { method: 'POST', headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
  try {
    const added = await api('/api/vault', { path: vaultPath, name: 'Main', pack: 'simple', scaffold: false });
    assert.equal(added.ok, true, JSON.stringify(added));
    await new Promise((resolve) => setTimeout(resolve, 350));
    const fs = await import('node:fs/promises');
    await fs.writeFile(path.join(vaultPath, 'Workflow.md'), '---\ntype: workflow\nid: workflow.collect\nscope: organisation\nstatus: current\n---\n# Collect questions\n');
    const proposal = '---\ntype: team\nid: team.product\nscope: organisation\nstatus: proposed\nrelations:\n  - predicate: runs\n    target: workflow.collect\n    review: proposed\n    source: "Operations handbook section 2"\n    confidence: 0.9\n---\n# Product team\n';
    await fs.writeFile(path.join(vaultPath, 'Team.md'), proposal);
    const detail = await api('/api/graph3d/note', { vault: 'Main', path: 'Team.md' });
    assert.equal(detail.proposed_relationships.length, 1);
    assert.equal(detail.proposed_relationships[0].note.title, 'Workflow');
    assert.equal((await api('/api/graph3d', {})).links.some((link) => link.predicate === 'runs'), false);

    const stale = await api('/api/graph3d/relationship/approve', { vault: 'Main', path: 'Team.md', etag: 'stale', relation_index: 0 });
    assert.match(stale.error, /changed since it was opened/i);
    const approved = await api('/api/graph3d/relationship/approve', { vault: 'Main', path: 'Team.md', etag: detail.etag, relation_index: 0 });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    const saved = await fs.readFile(path.join(vaultPath, 'Team.md'), 'utf8');
    assert.match(saved, /^status: current$/m);
    assert.match(saved, /^    review: verified$/m);
    const graph = await api('/api/graph3d', {});
    assert.ok(graph.links.some((link) => link.predicate === 'runs'));

    const repeated = await api('/api/graph3d/relationship/approve', { vault: 'Main', path: 'Team.md', etag: approved.etag, relation_index: 0 });
    assert.match(repeated.error, /no longer an eligible suggestion/i);

    const staleRollback = await api('/api/graph3d/relationship/reopen', { vault: 'Main', path: 'Team.md', etag: detail.etag, relation_index: 0 });
    assert.match(staleRollback.error, /changed since it was opened/i);
    const reopened = await api('/api/graph3d/relationship/reopen', { vault: 'Main', path: 'Team.md', etag: approved.etag, relation_index: 0 });
    assert.equal(reopened.ok, true, JSON.stringify(reopened));
    const reopenedRaw = await fs.readFile(path.join(vaultPath, 'Team.md'), 'utf8');
    assert.match(reopenedRaw, /^    review: proposed$/m);
    assert.match(reopenedRaw, /^    source: "Operations handbook section 2"$/m);
    assert.ok(!(await api('/api/graph3d', {})).links.some((link) => link.predicate === 'runs'));
    assert.equal((await api('/api/graph3d/reviews', {})).total, 1, 'undo returns the link to review');
    const activity = (await fs.readFile(path.join(home, 'app', 'activity.log'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse)
      .filter((entry) => entry.tool === 'graph_relationship_review');
    assert.deepEqual(activity.map((entry) => entry.action), ['approved', 'reopened']);
    assert.ok(activity.every((entry) => entry.ok === true));
    assert.doesNotMatch(JSON.stringify(activity), /Team\.md|Operations handbook section 2|team\.product/);
  } finally { s.server.close(); }
});

test('typed relationship rejection is revision-checked, keeps evidence, and removes the item from review', async () => {
  const home = await tmp('graph3d-reject-home');
  const vaultPath = path.join(home, 'vault');
  await mkdir(vaultPath, { recursive: true });
  const env = { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' };
  const s = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${s.port}`;
  const api = (p, body) => fetch(base + p, { method: 'POST', headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
  try {
    assert.equal((await api('/api/vault', { path: vaultPath, name: 'Main', pack: 'simple', scaffold: false })).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const fs = await import('node:fs/promises');
    await fs.writeFile(path.join(vaultPath, 'Workflow.md'), '---\ntype: workflow\nid: workflow.collect\nscope: organisation\nstatus: current\n---\n# Collect questions\n');
    const source = '---\ntype: team\nid: team.product\nscope: organisation\nstatus: proposed\nrelations:\n  - predicate: runs\n    target: workflow.collect\n    review: proposed\n    source: "Operations handbook section 2"\n    confidence: 0.9\n---\n# Product team\n';
    await fs.writeFile(path.join(vaultPath, 'Team.md'), source);
    const detail = await api('/api/graph3d/note', { vault: 'Main', path: 'Team.md' });
    const baseRequest = { vault: 'Main', path: 'Team.md', relation_index: 0 };
    const stale = await api('/api/graph3d/relationship/reject', { ...baseRequest, etag: 'stale' });
    assert.match(stale.error, /changed since it was opened/i);
    const rejected = await api('/api/graph3d/relationship/reject', { ...baseRequest, etag: detail.etag });
    assert.equal(rejected.ok, true, JSON.stringify(rejected));
    const saved = await fs.readFile(path.join(vaultPath, 'Team.md'), 'utf8');
    assert.match(saved, /^    review: rejected$/m);
    assert.match(saved, /^    source: "Operations handbook section 2"$/m);
    assert.match(saved, /^status: proposed$/m, 'rejecting one edge does not promote the record');
    assert.equal((await api('/api/graph3d/reviews', {})).total, 0);
    assert.equal((await api('/api/graph3d', {})).links.some((link) => link.predicate === 'runs'), false);
    const repeated = await api('/api/graph3d/relationship/reject', { ...baseRequest, etag: rejected.etag });
    assert.match(repeated.error, /no longer an eligible suggestion/i);
    const noteAfterReject = await api('/api/graph3d/note', { vault: 'Main', path: 'Team.md' });
    assert.equal(noteAfterReject.rejected_relationships.length, 1);
    const reopened = await api('/api/graph3d/relationship/reopen', { ...baseRequest, etag: rejected.etag });
    assert.equal(reopened.ok, true, JSON.stringify(reopened));
    const restored = await fs.readFile(path.join(vaultPath, 'Team.md'), 'utf8');
    assert.match(restored, /^    review: proposed$/m);
    assert.match(restored, /^    source: "Operations handbook section 2"$/m);
    assert.equal((await api('/api/graph3d/reviews', {})).total, 1);
  } finally { s.server.close(); }
});

test('typed relationship archive is revision-checked, hidden from the graph, and reversible from note detail', async () => {
  const home = await tmp('graph3d-archive-home');
  const vaultPath = path.join(home, 'vault');
  await mkdir(vaultPath, { recursive: true });
  const env = { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' };
  const s = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${s.port}`;
  const api = (p, body) => fetch(base + p, { method: 'POST', headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
  try {
    assert.equal((await api('/api/vault', { path: vaultPath, name: 'Main', pack: 'simple', scaffold: false })).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const fs = await import('node:fs/promises');
    await fs.writeFile(path.join(vaultPath, 'Workflow.md'), '---\ntype: workflow\nid: workflow.collect\nscope: organisation\nstatus: current\n---\n# Collect questions\n');
    const original = '---\ntype: team\nid: team.product\nscope: organisation\nstatus: current\nrelations:\n  - predicate: runs\n    target: workflow.collect\n    review: verified\n    source: "Operations handbook section 2"\n    confidence: 0.9\n---\n# Product team\n\nOperations handbook section 2\n';
    await fs.writeFile(path.join(vaultPath, 'Team.md'), original);
    const detail = await api('/api/graph3d/note', { vault: 'Main', path: 'Team.md' });
    assert.equal(detail.relationships.length, 1);
    assert.equal((await api('/api/graph3d', {})).links.some((link) => link.predicate === 'runs'), true);
    const stale = await api('/api/graph3d/relationship/edit', { vault: 'Main', path: 'Team.md', etag: 'stale', relation_index: 0, predicate: 'runs', target_id: 'workflow.collect', evidence: 'Operations handbook section 2', confidence: 0.9 });
    assert.match(stale.error, /changed since it was opened/i);
    const edited = await api('/api/graph3d/relationship/edit', { vault: 'Main', path: 'Team.md', etag: detail.etag, relation_index: 0, predicate: 'runs', target_id: 'workflow.collect', evidence: 'Operations handbook section 2', confidence: 0.85 });
    assert.equal(edited.ok, true, JSON.stringify(edited));
    assert.equal((await api('/api/graph3d', {})).links.some((link) => link.predicate === 'runs'), false, 'a changed verified edge must leave graph retrieval pending review');
    const editedDetail = await api('/api/graph3d/note', { vault: 'Main', path: 'Team.md' });
    assert.equal(editedDetail.proposed_relationships.length, 1);
    assert.equal(editedDetail.proposed_relationships[0].confidence, 0.85);
    const approved = await api('/api/graph3d/relationship/approve', { vault: 'Main', path: 'Team.md', etag: editedDetail.etag, relation_index: 0 });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    const archiveDetail = await api('/api/graph3d/note', { vault: 'Main', path: 'Team.md' });
    const staleArchive = await api('/api/graph3d/relationship/archive', { vault: 'Main', path: 'Team.md', etag: detail.etag, relation_index: 0 });
    assert.match(staleArchive.error, /changed since it was opened/i);
    const archived = await api('/api/graph3d/relationship/archive', { vault: 'Main', path: 'Team.md', etag: archiveDetail.etag, relation_index: 0 });
    assert.equal(archived.ok, true, JSON.stringify(archived));
    const graph = await api('/api/graph3d', {});
    assert.equal(graph.links.some((link) => link.predicate === 'runs'), false);
    const archivedDetail = await api('/api/graph3d/note', { vault: 'Main', path: 'Team.md' });
    assert.equal(archivedDetail.relationships.length, 0);
    assert.equal(archivedDetail.withdrawn_relationships.length, 1);
    const archivedRaw = await fs.readFile(path.join(vaultPath, 'Team.md'), 'utf8');
    assert.match(archivedRaw, /^    review: withdrawn$/m);
    assert.match(archivedRaw, /^    source: "Operations handbook section 2"$/m);
    const restored = await api('/api/graph3d/relationship/reopen', { vault: 'Main', path: 'Team.md', etag: archivedDetail.etag, relation_index: 0 });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    const restoredDetail = await api('/api/graph3d/note', { vault: 'Main', path: 'Team.md' });
    assert.equal(restoredDetail.withdrawn_relationships.length, 0);
    assert.equal(restoredDetail.proposed_relationships.length, 1);
    assert.equal((await api('/api/graph3d', {})).links.some((link) => link.predicate === 'runs'), false, 'restoring returns the relation to review, not straight to the graph');
    const activity = (await fs.readFile(path.join(home, 'app', 'activity.log'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse)
      .filter((entry) => entry.tool === 'graph_relationship_review');
    assert.deepEqual(activity.map((entry) => entry.action), ['edited', 'approved', 'archived', 'reopened']);
    assert.doesNotMatch(JSON.stringify(activity), /Team\.md|Operations handbook section 2|team\.product/);
  } finally { s.server.close(); }
});

test('graph review queue returns bounded public proposals and excludes private notes and vaults', async () => {
  const home = await tmp('graph3d-review-queue');
  const main = path.join(home, 'main');
  const diary = path.join(home, 'diary');
  await mkdir(main, { recursive: true }); await mkdir(diary, { recursive: true });
  const env = { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' };
  const s = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${s.port}`;
  const api = (p, body) => fetch(base + p, { method: 'POST', headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
  try {
    assert.equal((await api('/api/vault', { path: main, name: 'Main', pack: 'simple', scaffold: false })).ok, true);
    assert.equal((await api('/api/vault', { path: diary, name: 'Diary', pack: 'simple', scaffold: false, private: true })).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const fs = await import('node:fs/promises');
    await fs.writeFile(path.join(main, 'Dataset.md'), '---\ntype: dataset\nid: dataset.tickets\nscope: organisation\nstatus: current\n---\n# Dataset\n');
    await fs.writeFile(path.join(main, 'Workflow.md'), '---\ntype: workflow\nid: workflow.collect\nscope: organisation\nstatus: proposed\nrelations:\n  - predicate: consumes\n    target: dataset.tickets\n    review: proposed\n    source: "Public workflow evidence"\n    confidence: 0.8\n---\n# Collect questions\n');
    await fs.writeFile(path.join(main, 'Workflow two.md'), '---\ntype: workflow\nid: workflow.collect-two\nscope: organisation\nstatus: proposed\nrelations:\n  - predicate: consumes\n    target: dataset.tickets\n    review: proposed\n    source: "Second public workflow evidence"\n    confidence: 0.7\n---\n# Collect follow-ups\n');
    await fs.writeFile(path.join(main, 'Private source.md'), '---\nprivate: true\ntype: workflow\nid: workflow.secret\nscope: organisation\nstatus: proposed\nrelations:\n  - predicate: consumes\n    target: dataset.tickets\n    review: proposed\n    source: "PRIVATE_QUEUE_CANARY"\n    confidence: 0.8\n---\n# Private source\n');
    await fs.writeFile(path.join(diary, 'Personal routine.md'), '---\ntype: workflow\nid: workflow.diary\nscope: personal\nstatus: proposed\nrelations:\n  - predicate: consumes\n    target: routine.personal\n    review: proposed\n    source: "PRIVATE_VAULT_CANARY"\n    confidence: 0.8\n---\n# Personal routine\n');
    await fs.writeFile(path.join(diary, 'Personal task.md'), '---\ntype: dataset\nid: routine.personal\nscope: personal\nstatus: current\n---\n# Personal task\n');
    const result = await api('/api/graph3d/reviews', {});
    assert.equal(result.total, 2, JSON.stringify(result));
    assert.equal(result.proposals.length, 2);
    assert.deepEqual(new Set(result.proposals.map((item) => item.path)), new Set(['Workflow.md', 'Workflow two.md']));
    assert.equal(result.proposals[0].target.title, 'Dataset');
    assert.equal(result.proposals[0].can_review, true);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_QUEUE_CANARY|PRIVATE_VAULT_CANARY|Private source|Diary workflow/);
    const nextPage = await api('/api/graph3d/reviews', { offset: 1 });
    assert.equal(nextPage.offset, 1);
    assert.equal(nextPage.proposals.length, 1);
    assert.notEqual(nextPage.proposals[0].path, result.proposals[0].path);
    assert.equal((await api('/api/graph3d/reviews', { offset: -1 })).error?.includes('offset'), true);
    const privateQueue = await api('/api/graph3d/reviews', { vault: 'Diary' });
    assert.deepEqual(privateQueue, { proposals: [], total: 0, offset: 0, limited: false });
  } finally { s.server.close(); }
});

test('graph finds text-backed relationship candidates, saves them unapproved, then requires separate approval', async () => {
  const home = await tmp('graph3d-discovery-home');
  const vaultPath = path.join(home, 'vault');
  await mkdir(vaultPath, { recursive: true });
  const env = { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' };
  const s = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${s.port}`;
  const api = (p, body) => fetch(base + p, { method: 'POST', headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
  try {
    const added = await api('/api/vault', { path: vaultPath, name: 'Main', pack: 'simple', scaffold: false });
    assert.equal(added.ok, true, JSON.stringify(added));
    await new Promise((resolve) => setTimeout(resolve, 350));
    const fs = await import('node:fs/promises');
    await fs.writeFile(path.join(vaultPath, 'Workflow.md'), '---\ntype: workflow\nid: workflow.questions\nscope: organisation\nstatus: current\n---\n# Question workflow\n\nConsumes [[Question data]] every morning.\n');
    await fs.writeFile(path.join(vaultPath, 'Question data.md'), '---\ntype: dataset\nid: dataset.questions\nscope: organisation\nstatus: current\n---\n# Question data\n');
    await fs.writeFile(path.join(vaultPath, 'Private data.md'), '---\nprivate: true\ntype: dataset\nid: dataset.private\nscope: organisation\nstatus: current\n---\n# Private data\nPrivate canary.\n');
    const detail = await api('/api/graph3d/note', { vault: 'Main', path: 'Workflow.md' });
    assert.equal(detail.discovered_relationships.length, 1);
    assert.equal(detail.discovered_relationships[0].target_id, 'dataset.questions');
    assert.equal(JSON.stringify(detail), JSON.stringify(detail).replace(/dataset\.private|Private canary/, ''));
    const candidate = detail.discovered_relationships[0];
    const body = { vault: 'Main', path: 'Workflow.md', etag: detail.etag, target_id: candidate.target_id, predicate: candidate.predicate, evidence: candidate.evidence };
    const stale = await api('/api/graph3d/relationship/propose', { ...body, etag: 'stale' });
    assert.match(stale.error, /changed since it was opened/i);
    const saved = await api('/api/graph3d/relationship/propose', body);
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal((await api('/api/graph3d', {})).links.some((link) => link.predicate === 'consumes'), false, 'saving a suggestion must not create a verified edge');
    const pending = await api('/api/graph3d/note', { vault: 'Main', path: 'Workflow.md' });
    assert.equal(pending.proposed_relationships.length, 1);
    assert.equal(pending.discovered_relationships.length, 0);
    const approved = await api('/api/graph3d/relationship/approve', { vault: 'Main', path: 'Workflow.md', etag: pending.etag, relation_index: 0 });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assert.ok((await api('/api/graph3d', {})).links.some((link) => link.predicate === 'consumes'));
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

test('active Setup UI reloads the graph on vault events and keeps an open editor intact', async () => {
  const { readFile } = await import('node:fs/promises');
  const page = await readSetupHtml();
  const graph = await readFile(new URL('../ui/notes3d.js', import.meta.url), 'utf8');
  assert.match(page, /new EventSource\('\/api\/events\?t=' \+ encodeURIComponent\(T\)\)/);
  assert.match(page, /dispatchEvent\(new Event\('brainlink:vault-changed'\)\)/);
  assert.match(graph, /addEventListener\('brainlink:vault-changed',[\s\S]*?refreshGraph\(\)/);
  assert.match(graph, /if \(editor && !editor\.hidden\) \{ pendingVaultRefresh = true; return; \}/);
});

test('installed Setup graph panel exposes structured record fields and saves only its selected note', async () => {
  const { readFile } = await import('node:fs/promises');
  const page = await readSetupHtml();
  const graph = await readFile(new URL('../ui/notes3d.js', import.meta.url), 'utf8');
  assert.match(page, /notes3d\.js/, 'the installed Setup page loads this graph panel');
  for (const field of ['type','scope','status']) assert.ok(graph.includes(`graphChoices('${field}',`), `form includes ${field}`);
  assert.match(graph, /data-graph-record-field="id"/);
  assert.match(graph, /data-graph-record-field="\$\{field\}"/);
  assert.match(graph, /workflowKeys\.map\(\(key\) =>/);
  assert.match(graph, /data-graph-workflow-field="\$\{key\}"/);
  for (const field of ['triggers','inputs','steps','outputs','exception_handling']) assert.ok(graph.includes(`'${field}'`), `workflow form supports ${field}`);
  assert.match(graph, /api\('\/api\/graph3d\/entity\/save'/);
  assert.match(graph, /notes3d-links'\)\.querySelectorAll\('\[data-graph-record-field\]'\)/, 'save reads only fields inside the selected note detail');
  assert.match(graph, /etag: currentDetail\.etag/, 'save is tied to the note revision currently shown');
});

test('graph UI exposes a confirmation-gated action for reviewing a suggested relationship', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../ui/notes3d.js', import.meta.url), 'utf8');
  assert.match(src, /data-review-relation/);
  assert.match(src, /window\.confirm\(tr\('notes3d\.approveConfirm'\)\)/);
  assert.match(src, /window\.confirm\(tr\('notes3d\.rejectConfirm'\)\)/);
  assert.match(src, /api\('\/api\/graph3d\/relationship\/approve'/);
  assert.match(src, /api\('\/api\/graph3d\/relationship\/reject'/);
  assert.match(src, /api\('\/api\/graph3d\/relationship\/reopen'/);
  assert.match(src, /data-reopen-relation/);
  assert.match(src, /data-reopen-rejected/);
  assert.match(src, /data-archive-relation/);
  assert.match(src, /api\('\/api\/graph3d\/relationship\/archive'/);
  assert.match(src, /data-save-relation/);
  assert.match(src, /api\('\/api\/graph3d\/relationship\/edit'/);
  assert.match(src, /data-edit-evidence/);
  assert.match(src, /withdrawn_relationships/);
  assert.match(src, /data-restore-withdrawn/);
  assert.match(src, /rejected_relationships/);
  assert.match(src, /data-reject-queued/);
  assert.match(src, /api\('\/api\/graph3d\/relationship\/propose'/);
  assert.match(src, /data-propose-manual/);
  assert.match(src, /api\('\/api\/graph3d\/relationship\/propose-manual'/);
  assert.match(src, /updateManualTargetOptions/);
  assert.match(src, /maxlength="320"/i);
  assert.match(src, /notes3d\.saveSuggestionConfirm/);
  assert.match(src, /api\('\/api\/graph3d\/reviews'/, 'the graph loads a central review queue');
  assert.match(src, /data-approve-queued/, 'queued proposals can be approved from the central review list');
  assert.match(src, /data-reject-queued/, 'queued proposals can be rejected from the central review list');
  assert.match(src, /data-review-load-more/, 'the bounded review queue can load its next page');
  assert.match(src, /api\('\/api\/graph3d\/note',[\s\S]*?api\('\/api\/graph3d\/relationship\/approve'/, 'approval fetches a fresh note revision before writing');
});

test('ui/notes3d.js: hover label is escaped, and the selected node is visibly highlighted', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../ui/notes3d.js', import.meta.url), 'utf8');
  assert.match(src, /\.nodeLabel\(\(n\) => `\$\{esc\(n\.title\)\}.*esc\(n\.type\)/, 'node labels show typed entity kind while escaping note-derived title and type text');
  assert.match(src, /\.linkLabel\(\(l\) => l\.predicate \? `\$\{esc\(l\.predicate\)\}.*esc\(l\.evidence\).*esc\(l\.confidence\)/, 'typed relationship labels, evidence, and confidence are escaped before graph rendering');
  assert.match(src, /\.linkCurvature\(\(l\) => l\.parallel_count > 1/, 'parallel relationship edges are visually separated instead of drawn on top of each other');
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
  const viewer = await readFile(new URL('../ui/vendor/3d-force-graph/3d-force-graph.min.js', import.meta.url), 'utf8');
  assert.match(src, /id="notes3d-search" type="search"/);
  assert.match(src, /id="notes3d-reset-view"[^>]*data-i18n="notes3d\.resetView"[^>]*disabled/, 'the shipped Setup graph must expose a localized, initially disabled reset control');
  assert.match(src, /zoomToFit\(700, 50\)/, 'reset restores a full-map camera view');
  assert.match(viewer, /zoomToFit/, 'the packaged viewer supports the reset action');
  assert.match(src, /resetView\.disabled = false/, 'reset becomes available only after a graph with notes has loaded');
  assert.match(css, /\.notes3d-controls\s*\{[^}]*position:\s*absolute[^}]*right:\s*10px/, 'reset control remains reachable at the graph edge');
  assert.match(src, /role="status" aria-live="polite"/);
  assert.match(src, /matches\.slice\(0, 50\)/, 'large vaults must not render every note into the accessibility list at once');
  assert.match(src, /data-graph-note-id=.*aria-pressed=/);
  assert.match(src, /if \(graphNote\) \{ openById\(graphNote\.dataset\.graphNoteId\); return; \}/, 'keyboard activation of a note button must open the same detail panel as a graph click');
  assert.match(src, /brainlink:locale-changed/);
  assert.match(src, /api\('\/api\/graph3d\/discover'/, 'vault-wide discovery must call its authenticated local API');
  assert.match(src, /data-discover-save/, 'each discovered link must be saved through the review flow');
  assert.match(src, /id="notes3d-vault-select"/, 'graph must let the user focus on one vault');
  assert.match(src, /api\('\/api\/graph3d\/vaults'/, 'vault choices must come from the privacy-filtered API');
  assert.match(src, /brainlink:locale-changed[\s\S]*?renderVaultOptions\(\);/, 'vault filter choices must update when the app language changes');
  assert.match(css, /\.notes3d-node:focus-visible/);
  const keys = ['notes3d.browseNotes', 'notes3d.browseSearch', 'notes3d.browsePlaceholder', 'notes3d.browseEmpty', 'notes3d.browseCount', 'notes3d.browseMore', 'notes3d.vaultFilter', 'notes3d.allVaults', 'notes3d.resetView', 'notes3d.discoverVault', 'notes3d.discoverHint', 'notes3d.discoverRun', 'notes3d.discoverMore', 'notes3d.discoverDone', 'notes3d.discoverProgress', 'notes3d.discoverFailed', 'notes3d.discoverChanged', 'notes3d.discoverReadOnly'];
  for (const locale of ['en', 'zh-TW', 'pt']) {
    const localeText = await readFile(new URL(`../ui/locales/${locale}.json`, import.meta.url), 'utf8');
    const catalog = JSON.parse(localeText);
    assert.equal((localeText.match(/"notes3d\.resetView"/g) || []).length, 1, `${locale} reset label is defined once`);
    for (const key of keys) assert.ok(catalog[key], `${locale} ${key}`);
  }
});
