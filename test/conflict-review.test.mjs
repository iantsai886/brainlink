import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createContext } from '../src/core.mjs';
import { normalize } from '../src/config.mjs';
import { createConflictReviewStore, listConflictCandidates } from '../src/conflict-review.mjs';
import { startSetup } from '../src/setup.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-conflicts-'));
  const vault = path.join(root, 'Vault');
  for (const folder of ['A', 'B', 'C', 'D']) await mkdir(path.join(vault, folder), { recursive: true });
  await writeFile(path.join(vault, 'A', 'Policy.md'), '# Policy\nPublic record A.');
  await writeFile(path.join(vault, 'B', 'Policy.md'), '# Policy\nPublic record B.');
  await writeFile(path.join(vault, 'C', 'Rate 2024-01.md'), '# Rate 2024-01\nOlder dated record.');
  await writeFile(path.join(vault, 'C', 'Rate 2025-01.md'), '# Rate 2025-01\nNewer dated record.');
  await writeFile(path.join(vault, 'C', 'One.md'), '---\ntype: project\nid: proj-123\n---\n# One\nTyped record one.');
  await writeFile(path.join(vault, 'D', 'Two.md'), '---\ntype: project\nid: proj-123\n---\n# Two\nTyped record two.');
  await writeFile(path.join(vault, 'A', 'Private policy.md'), '---\nprivate: true\n---\n# Policy\nCONFLICT_PRIVATE_CANARY');
  await writeFile(path.join(vault, 'A', 'README.md'), '# README\nRouting note.');
  await writeFile(path.join(vault, 'A', 'Generated.md'), '---\ngenerated_by: brainlink\n---\n# Generated\nGenerated result.');
  const ctx = createContext(normalize({ vaults: [{ name: 'Shared', path: vault }] }), { env: { BRAINLINK_HOME: path.join(root, 'home') } });
  return { root, vault, ctx };
}

test('conflict candidates find duplicate, dated-stem and typed-ID pairs while excluding private/routing/generated notes', async () => {
  const { root, ctx } = await fixture();
  const found = await listConflictCandidates(ctx, 'Shared');
  const paths = found.candidates.map((item) => [item.a.path, item.b.path].sort().join(' | '));
  assert.ok(paths.includes('A/Policy.md | B/Policy.md'));
  assert.ok(paths.includes('C/Rate 2024-01.md | C/Rate 2025-01.md'));
  assert.ok(paths.includes('C/One.md | D/Two.md'));
  assert.doesNotMatch(JSON.stringify(found), /CONFLICT_PRIVATE_CANARY|Private policy\.md|README\.md|Generated\.md/);
  const store = createConflictReviewStore(root);
  const id = found.candidates[0].id;
  await store.dismiss(id);
  assert.ok(!(await listConflictCandidates(ctx, 'Shared', { dismissed: await store.dismissed() })).candidates.some((item) => item.id === id));
});

test('Setup previews conflict resolution, queues an append proposal, and does not edit the note', async () => {
  const { root, vault } = await fixture();
  const before = await readFile(path.join(vault, 'B', 'Policy.md'), 'utf8');
  const app = await startSetup({ env: { BRAINLINK_HOME: path.join(root, 'home'), BRAINLINK_SEMANTIC: '0' }, home: root, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${app.port}`;
  const api = (route, body = {}) => fetch(base + route, { method: 'POST', headers: { 'X-BrainLink-Token': app.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((response) => response.json());
  const get = (route) => fetch(base + route, { headers: { 'X-BrainLink-Token': app.token } }).then((response) => response.json());
  try {
    await api('/api/vault', { path: vault, name: 'Shared', pack: 'simple', scaffold: false });
    const { candidates } = await api('/api/conflicts/list', { vault: 'Shared' });
    const candidate = candidates.find((item) => item.a.path === 'A/Policy.md' && item.b.path === 'B/Policy.md');
    assert.ok(candidate);
    const preview = await api('/api/conflicts/preview', { vault: 'Shared', candidate_id: candidate.id, choice: 'a_stands' });
    assert.match(preview.proposal_preview, /superseded_by: \[\[Policy\]\]/);
    assert.equal(await readFile(path.join(vault, 'B', 'Policy.md'), 'utf8'), before);
    const queued = await api('/api/conflicts/confirm', { id: preview.id, confirm: true });
    assert.equal(queued.ok, true, JSON.stringify(queued));
    assert.ok(queued.proposal_id);
    assert.equal(await readFile(path.join(vault, 'B', 'Policy.md'), 'utf8'), before, 'review choice only queues a proposal; owner approval is still required to append');
    const pending = await get('/api/proposals');
    assert.ok(pending.proposals.some((item) => item.id === queued.proposal_id && item.path === 'B/Policy.md'));
    assert.equal((await api('/api/conflicts/list', { vault: 'Shared' })).candidates.some((item) => item.id === candidate.id), false);
  } finally { app.server.close(); }
});
