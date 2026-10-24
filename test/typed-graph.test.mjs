import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize } from '../src/config.mjs';
import { createContext, loadVault } from '../src/core.mjs';
import { buildGraph3D, noteDetail3D } from '../src/graph3d.mjs';
import { deriveTypedRelations } from '../src/typed-graph.mjs';

const temp = (name) => mkdtemp(path.join(tmpdir(), `brainlink-typed-graph-${name}-`));
const entity = ({ type, id, scope = 'organisation', body = '', relations = '', extra = '' }) => `---\ntype: ${type}\nid: ${id}\nscope: ${scope}\nstatus: current\n${extra}${relations ? `relations:\n${relations}` : ''}---\n# ${id}\n${body}`;

async function context(vaults) {
  const config = normalize({ vaults: await Promise.all(vaults.map(async ({ name, path: p, private: isPrivate = false }) => {
    await mkdir(p, { recursive: true });
    return { name, path: p, private: isPrivate };
  })) });
  return createContext(config, { env: { BRAINLINK_SEMANTIC: '0' } });
}

test('typed relationships resolve by stable ID and appear in graph links and note details', async () => {
  const dir = await temp('valid');
  await writeFile(path.join(dir, 'Product Team.md'), entity({ type: 'team', id: 'team.product', body: 'Product group.' }));
  await writeFile(path.join(dir, 'Collect Questions.md'), entity({
    type: 'workflow', id: 'workflow.collect-questions',
    relations: '  - predicate: owned_by\n    target: team.product\n    review: verified\n    source: "Operations handbook, section 2"\n    confidence: 0.96\n',
    body: 'A workflow that collects questions.'
  }));
  const ctx = await context([{ name: 'Company', path: dir }]);
  const graph = await buildGraph3D(ctx, 'Company');
  const workflow = graph.nodes.find((n) => n.entity_id === 'workflow.collect-questions');
  const team = graph.nodes.find((n) => n.entity_id === 'team.product');
  assert.equal(workflow.type, 'workflow');
  assert.ok(graph.links.some((l) => l.source === workflow.id && l.target === team.id && l.predicate === 'owned_by'));
  const index = await loadVault(ctx, 'Company');
  assert.ok(index.outlinks[index.byRel.get('Collect Questions.md')].has(index.byRel.get('Product Team.md')), 'typed relationships feed existing graph-aware retrieval');
  const detail = await noteDetail3D(ctx, 'Company', 'Collect Questions.md');
  assert.deepEqual(detail.relationships.map((r) => ({ direction: r.direction, predicate: r.predicate, target: r.note.title })), [
    { direction: 'outgoing', predicate: 'owned_by', target: 'Product Team' },
  ]);
  assert.equal(detail.relationships[0].evidence, 'Operations handbook, section 2');
});

test('only verified, allowlisted predicates with evidence, confidence and same-scope targets become edges', async () => {
  const notes = [
    { rel: 'A.md', raw: entity({ type: 'team', id: 'team.a', body: '' }) },
    { rel: 'B.md', raw: entity({ type: 'workflow', id: 'workflow.b', relations: [
      '  - predicate: runs\n    target: workflow.c\n    review: verified\n    source: evidence\n    confidence: 0.9\n',
      '  - predicate: consumes\n    target: dataset.d\n    review: proposed\n    source: evidence\n    confidence: 0.9\n',
      '  - predicate: invents\n    target: dataset.d\n    review: verified\n    source: evidence\n    confidence: 0.9\n',
      '  - predicate: produces\n    target: dataset.d\n    review: verified\n    source: evidence\n    confidence: 2\n',
      '  - predicate: owned_by\n    target: team.a\n    review: verified\n    source: evidence\n    confidence: 0.9\n',
    ].join(''), scope: 'organisation' }) },
    { rel: 'C.md', raw: entity({ type: 'workflow', id: 'workflow.c' }) },
    { rel: 'D.md', raw: entity({ type: 'dataset', id: 'dataset.d', scope: 'client' }) },
  ];
  const relations = deriveTypedRelations(notes);
  assert.deepEqual(relations.map((r) => [r.source, r.target, r.predicate]), [[1, 2, 'runs'], [1, 0, 'owned_by']]);
});

test('private, generated, duplicate-ID and cross-vault records cannot become typed endpoints', async () => {
  const dir = await temp('privacy');
  const privateSecretId = 'dataset.private-canary';
  await writeFile(path.join(dir, 'Public.md'), entity({
    type: 'team', id: 'team.public',
    relations: `  - predicate: consumes\n    target: ${privateSecretId}\n    review: verified\n    source: public reference\n    confidence: 0.9\n`,
    body: 'Visible team.'
  }));
  await writeFile(path.join(dir, 'Private.md'), `---\nprivate: true\ntype: dataset\nid: ${privateSecretId}\nscope: organisation\n---\nPRIVATE_TYPED_EDGE_CANARY_9921\n`);
  await writeFile(path.join(dir, 'Duplicate.md'), entity({
    type: 'team', id: 'team.public',
    relations: '  - predicate: consumes\n    target: dataset.open\n    review: verified\n    source: duplicate ID should abstain\n    confidence: 0.9\n',
  }));
  await writeFile(path.join(dir, 'Open Dataset.md'), entity({ type: 'dataset', id: 'dataset.open' }));
  await writeFile(path.join(dir, 'Generated.md'), entity({ type: 'dataset', id: 'dataset.generated', extra: 'generated_by: brainlink\n' }));
  await writeFile(path.join(dir, 'Current Workflow.md'), entity({
    type: 'workflow', id: 'workflow.public',
    relations: '  - predicate: produces\n    target: dataset.generated\n    review: verified\n    source: generated record should not resolve\n    confidence: 0.9\n',
  }));
  const clientDir = await temp('separate-client');
  await writeFile(path.join(clientDir, 'Client Workflow.md'), entity({
    type: 'workflow', id: 'workflow.client',
    relations: '  - predicate: owned_by\n    target: team.public\n    review: verified\n    source: client record\n    confidence: 0.9\n',
  }));
  const ctx = await context([{ name: 'Company', path: dir }, { name: 'Client', path: clientDir }]);
  const graph = await buildGraph3D(ctx);
  const detail = await noteDetail3D(ctx, 'Company', 'Public.md');
  const generatedDetail = await noteDetail3D(ctx, 'Company', 'Current Workflow.md');
  const clientDetail = await noteDetail3D(ctx, 'Client', 'Client Workflow.md');
  assert.deepEqual(detail.relationships, []);
  assert.deepEqual(generatedDetail.relationships, [], 'generated records cannot be relationship endpoints');
  assert.deepEqual(clientDetail.relationships, [], 'a same-ID record in another vault cannot resolve as a cross-vault edge');
  assert.ok(!graph.nodes.some((n) => n.entity_id === privateSecretId));
  assert.ok(!graph.nodes.some((n) => n.entity_id === 'team.public'), 'duplicate entity IDs are not exposed as typed nodes');
  assert.doesNotMatch(JSON.stringify({ graph, detail }), /PRIVATE_TYPED_EDGE_CANARY_9921|dataset\.private-canary/);
});
