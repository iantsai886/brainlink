import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize } from '../src/config.mjs';
import { createContext, loadVault } from '../src/core.mjs';
import { buildGraph3D, noteDetail3D } from '../src/graph3d.mjs';
import { deriveTypedRelations, deriveRejectedTypedRelations, discoverTypedRelationshipCandidates, appendTypedRelationProposal, approveTypedRelation, rejectTypedRelation, reopenTypedRelation } from '../src/typed-graph.mjs';
import { proposeNote } from '../src/writes.mjs';
import { createMcp } from '../src/server.mjs';

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
  const toolSchema = createMcp(ctx).tools.find((tool) => tool.name === 'propose_note').inputSchema.properties;
  assert.ok(toolSchema.relations.items.properties.predicate.enum.includes('owned_by'));
  assert.match(toolSchema.relations.description, /review=proposed/);
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

test('rejecting a proposed relationship preserves source evidence and does not verify the edge', () => {
  const raw = `---\ntype: workflow\nid: workflow.collect\nscope: organisation\nstatus: proposed\nrelations:\n  - predicate: runs\n    target: team.product\n    review: proposed\n    source: "Operations handbook section 2"\n    confidence: 0.8\n---\n# Collect questions\n`;
  const rejected = rejectTypedRelation(raw, 0);
  assert.match(rejected, /^status: proposed$/m, 'rejecting a link does not promote its record');
  assert.match(rejected, /^    review: rejected$/m);
  assert.match(rejected, /^    source: "Operations handbook section 2"$/m);
  assert.deepEqual(deriveTypedRelations([{ rel: 'Workflow.md', raw: rejected }]), []);
  const notes = [{ rel: 'Workflow.md', raw: rejected }, { rel: 'Team.md', raw: entity({ type: 'team', id: 'team.product' }) }];
  assert.equal(deriveRejectedTypedRelations(notes).length, 1);
  assert.match(reopenTypedRelation(rejected, 0, 'rejected'), /^    review: proposed$/m);
  assert.throws(() => rejectTypedRelation(rejected, 0), /no longer awaiting review/i);
});

test('reopening an approved relationship returns it to proposal state and preserves evidence', () => {
  const raw = `---\ntype: workflow\nid: workflow.collect\nscope: organisation\nstatus: proposed\nrelations:\n  - predicate: runs\n    target: team.product\n    review: proposed\n    source: "Operations handbook section 2"\n    confidence: 0.8\n---\n# Collect questions\n`;
  const approved = approveTypedRelation(raw, 0);
  const reopened = reopenTypedRelation(approved, 0);
  assert.match(reopened, /^status: current$/m, 'undoing an edge does not demote the already approved record');
  assert.match(reopened, /^    review: proposed$/m);
  assert.match(reopened, /^    source: "Operations handbook section 2"$/m);
  assert.deepEqual(deriveTypedRelations([{ rel: 'Workflow.md', raw: reopened }]), []);
  assert.throws(() => reopenTypedRelation(reopened, 0), /no longer awaiting review/i);
});

test('reopening a rejected relation explicitly changes only its review marker', () => {
  const raw = `---\ntype: workflow\nid: workflow.collect\nscope: organisation\nstatus: current\nrelations:\n  - predicate: runs\n    target: team.product\n    review: rejected\n    source: "Operations handbook section 2"\n    confidence: 0.8\n---\n# Collect questions\n`;
  const reopened = reopenTypedRelation(raw, 0, 'rejected');
  assert.match(reopened, /^status: current$/m);
  assert.match(reopened, /^    review: proposed$/m);
  assert.match(reopened, /^    source: "Operations handbook section 2"$/m);
});

test('typed graph relationship suggestions are saved as proposed and become edges only after explicit review', async () => {
  const dir = await temp('relationship-proposal');
  await mkdir(path.join(dir, 'Inbox'), { recursive: true });
  await writeFile(path.join(dir, 'Product Team.md'), entity({ type: 'team', id: 'team.product', body: 'The product team.' }));
  const ctx = await context([{ name: 'Company', path: dir }]);
  const result = await proposeNote(ctx, {
    vault: 'Company', folder: 'Inbox', title: 'Collect questions', type: 'workflow',
    status: 'current', entity_id: 'workflow.collect-questions', entity_scope: 'organisation',
    body: 'Collects incoming support questions.', source: 'Operations handbook', confirm: true,
    ai_platform: 'ChatGPT', agent_or_role: 'test', session_or_task_id: 'typed-graph-test',
    relations: [{ predicate: 'owned_by', target: 'team.product', source: '"The product team owns question collection"', confidence: 0.92 }],
  }, new Date('2026-10-26T12:00:00Z'));
  assert.equal(result.written, true, JSON.stringify(result));
  const notePath = path.join(dir, 'Inbox/2026-10-26 — Collect questions.md');
  let saved = await readFile(notePath, 'utf8');
  assert.match(saved, /^status: proposed$/m, 'caller cannot make a generated entity current at creation');
  assert.match(saved, /^id: workflow\.collect-questions$/m);
  assert.match(saved, /^scope: organisation$/m);
  assert.match(saved, /^    review: proposed$/m, 'suggested edges are never marked verified by the AI');
  assert.match(saved, /^    source: "\\"The product team owns question collection\\""$/m);
  const unreviewed = await buildGraph3D(ctx, 'Company');
  assert.ok(!unreviewed.links.some((link) => link.predicate === 'owned_by'));

  saved = saved.replace(/^status: proposed$/m, 'status: current').replace(/^    review: proposed$/m, '    review: verified');
  await writeFile(notePath, saved);
  const reviewedCtx = await context([{ name: 'Company', path: dir }]);
  const reviewed = await buildGraph3D(reviewedCtx, 'Company');
  assert.ok(reviewed.links.some((link) => link.predicate === 'owned_by'), 'explicitly reviewed relation enters the typed graph');
});

test('proposed relationship list shows only valid same-scope candidates targeting current visible entities', async () => {
  const notes = [
    { rel: 'Target.md', raw: entity({ type: 'team', id: 'team.target' }) },
    { rel: 'Proposal.md', raw: `---\ntype: workflow\nid: workflow.proposal\nscope: organisation\nstatus: proposed\nrelations:\n  - predicate: runs\n    target: team.target\n    review: proposed\n    source: "Team workflow map"\n    confidence: 0.8\n---\n# Proposal\n` },
    { rel: 'Private.md', private: true, raw: entity({ type: 'team', id: 'team.private' }) },
    { rel: 'BadTarget.md', raw: entity({ type: 'workflow', id: 'workflow.bad', relations: '  - predicate: runs\n    target: team.private\n    review: proposed\n    source: private\n    confidence: 0.9\n' }) },
  ];
  const { deriveProposedTypedRelations } = await import('../src/typed-graph.mjs');
  assert.deepEqual(deriveProposedTypedRelations(notes).map(({ source, target, relation_index, predicate }) => [source, target, relation_index, predicate]), [[1, 0, 0, 'runs']]);
});

test('deterministic relationship discovery proposes only explicit same-scope text patterns', () => {
  const notes = [
    { rel: 'Workflow.md', title: 'Question workflow', body: 'Consumes [[Question data]] every morning. May mention Client secret dataset.', raw: '---\ntype: workflow\nid: workflow.questions\nscope: organisation\nstatus: current\n---\n' },
    { rel: 'Question data.md', title: 'Question data', body: 'Approved sample.', raw: '---\ntype: dataset\nid: dataset.questions\nscope: organisation\nstatus: current\n---\n' },
    { rel: 'Client secret dataset.md', title: 'Client secret dataset', body: 'private fixture', private: true, raw: '---\ntype: dataset\nid: dataset.secret\nscope: organisation\nstatus: current\n---\n' },
    { rel: 'Other dataset.md', title: 'Other dataset', body: '', raw: '---\ntype: dataset\nid: dataset.other\nscope: client\nstatus: current\n---\n' },
  ];
  const candidates = discoverTypedRelationshipCandidates(notes, 0);
  assert.deepEqual(candidates.map(({ predicate, target_id, evidence }) => [predicate, target_id, evidence]), [['consumes', 'dataset.questions', 'Consumes [[Question data]] every morning.']]);
});

test('automatic relationship candidates are saved as proposed YAML and never verified automatically', () => {
  const raw = '---\ntype: workflow\nid: workflow.questions\nscope: organisation\nstatus: current\n---\n# Questions\n';
  const saved = appendTypedRelationProposal(raw, { predicate: 'consumes', target_id: 'dataset.questions', evidence: 'Consumes Question data.', confidence: 0.72 });
  assert.match(saved, /^status: current$/m);
  assert.match(saved, /^    review: proposed$/m);
  assert.match(saved, /^    source: "Consumes Question data\."$/m);
  assert.match(saved, /^    confidence: 0\.72$/m);
  assert.throws(() => appendTypedRelationProposal(saved, { predicate: 'consumes', target_id: 'dataset.questions', evidence: 'Consumes Question data.', confidence: 0.72 }), /already recorded/i);
});

test('relationship review accepts valid quoted YAML status markers without changing unrelated frontmatter', () => {
  const raw = '---\ntype: workflow\nid: workflow.questions\nscope: organisation\nstatus: "proposed"\ncustom: keep\nrelations:\n  - predicate: consumes\n    target: dataset.questions\n    review: "proposed"\n    source: evidence\n    confidence: 0.8\n---\nBody\n';
  const saved = approveTypedRelation(raw, 0);
  assert.match(saved, /^status: current$/m);
  assert.match(saved, /^custom: keep$/m);
  assert.match(saved, /^    review: verified$/m);
});

test('typed relationship proposals reject invalid IDs, predicates, evidence and cross-profile scopes', async () => {
  const dir = await temp('relationship-validation');
  await mkdir(path.join(dir, 'Inbox'), { recursive: true });
  const ctx = await context([{ name: 'Company', path: dir }]);
  const base = { vault: 'Company', folder: 'Inbox', title: 'Workflow', type: 'workflow', entity_id: 'workflow.test', entity_scope: 'organisation', body: 'Do work.', source: 'test', confirm: true };
  const invalid = await proposeNote(ctx, { ...base, relations: [{ predicate: 'invented', target: 'x', source: '', confidence: 2 }] });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.length >= 4);
  ctx.twinScope = { mode: 'scoped', profile_id: 'client-1' , grants: [] };
  const mismatch = await proposeNote(ctx, base);
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.errors.join(' '), /match the active Twin profile/);
});

test('typed relationship proposals cannot reveal private or cross-scope target IDs', async () => {
  const dir = await temp('relationship-private-target');
  await mkdir(path.join(dir, 'Inbox'), { recursive: true });
  const privateId = 'dataset.private-canary';
  await writeFile(path.join(dir, 'Private Dataset.md'), `---\nprivate: true\ntype: dataset\nid: ${privateId}\nscope: organisation\nstatus: current\n---\n# Private Dataset\nsecret\n`);
  const ctx = await context([{ name: 'Company', path: dir }]);
  const result = await proposeNote(ctx, {
    vault: 'Company', folder: 'Inbox', title: 'Public workflow', type: 'workflow', entity_id: 'workflow.public',
    entity_scope: 'organisation', body: 'A public workflow.', source: 'public source',
    ai_platform: 'ChatGPT', agent_or_role: 'test', session_or_task_id: 'privacy-test',
    relations: [{ predicate: 'consumes', target: privateId, source: 'public text', confidence: 0.9 }],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /unique, current, visible typed record/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(privateId));
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
