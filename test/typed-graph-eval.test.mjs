import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { evaluateTypedGraphDiscovery, validateTypedGraphFixture, TYPED_GRAPH_MIN_CASES } from '../src/typed-graph-eval.mjs';

function fixture() {
  const notes = [
    { rel: 'Data Pipeline.md', title: 'Data Pipeline', raw: '---\ntype: dataset\nid: dataset.pipeline\nscope: organisation\nstatus: current\n---\n', body: 'Fictional, public input dataset.' },
    { rel: '資料管線.md', title: '資料管線', raw: '---\ntype: dataset\nid: dataset.pipeline-zh\nscope: organisation\nstatus: current\n---\n', body: '虛構的公開資料。' },
    { rel: 'Support Team.md', title: 'Support Team', raw: '---\ntype: team\nid: team.support\nscope: organisation\nstatus: current\n---\n', body: 'Fictional team.' },
    { rel: 'Client Notes.md', title: 'Client Notes', raw: '---\ntype: dataset\nid: dataset.client-notes\nscope: client\nstatus: current\n---\n', body: 'Foreign-scope fixture.' },
  ];
  const cases = [];
  const add = (title, body, expected = []) => {
    const n = cases.length + 1;
    const rel = `Source ${String(n).padStart(2, '0')}.md`;
    notes.push({ rel, title: `Source ${String(n).padStart(2, '0')}`, raw: `---\ntype: workflow\nid: workflow.source-${String(n).padStart(2, '0')}\nscope: organisation\nstatus: current\n---\n`, body: body.replaceAll('{title}', `Source ${String(n).padStart(2, '0')}`) });
    cases.push({ id: `case_${String(n).padStart(2, '0')}`, source: rel, expected });
  };
  for (let i = 0; i < 8; i++) add('', `{title} consumes Data Pipeline for fictional review ${i + 1}.`, [{ predicate: 'consumes', target_id: 'dataset.pipeline' }]);
  add('', '{title} not only consumes Data Pipeline but also checks the fictional result.', [{ predicate: 'consumes', target_id: 'dataset.pipeline' }]);
  for (let i = 0; i < 4; i++) add('', `{title} coordinates with Support Team on fictional requests ${i + 1}.`, [{ predicate: 'communicates_with', target_id: 'team.support' }]);
  add('', '{title} uses Data Pipeline for fictional reports.', [{ predicate: 'consumes', target_id: 'dataset.pipeline' }]);
  add('', 'A Equipe de Suporte coordena com Support Team durante a triagem.', [{ predicate: 'communicates_with', target_id: 'team.support' }]);
  add('', 'Source details are documented in Data Pipeline.', []);
  add('', 'Data Pipeline is mentioned before the workflow consumes other input.', []);
  for (let i = 0; i < 4; i++) add('', `{title} does not consume Data Pipeline in fictional case ${i + 1}.`, []);
  add('', '工作流程使用資料管線來整理虛構回覆。', [{ predicate: 'consumes', target_id: 'dataset.pipeline-zh' }]);
  add('', '工作流程不使用資料管線；這只是虛構案例。', []);
  return {
    schema: 1,
    notes,
    cases,
    forbidden_target_ids: ['dataset.private-canary', 'dataset.client-notes'],
    forbidden_strings: ['PRIVATE_GRAPH_CANARY_74D2'],
  };
}

test('typed graph evaluator measures proposal precision and recall without exposing fixture content', () => {
  const data = fixture();
  const bytes = Buffer.from(JSON.stringify(data));
  const report = evaluateTypedGraphDiscovery(data, { fixtureBytes: bytes });
  assert.equal(data.cases.length, 23);
  assert.equal(TYPED_GRAPH_MIN_CASES, 20);
  assert.equal(report.fixture_sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(report.case_count, 23);
  assert.equal(report.false_positive, 0, 'explicitly negated edges are not proposed');
  assert.equal(report.false_negative, 0, '"not only" remains a positive relation');
  assert.equal(report.precision, 1);
  assert.equal(report.recall, 1);
  assert.equal(report.privacy_violations, 0);
  assert.equal(report.decision, 'eligible_for_human_review');
  assert.equal(report.auto_promotion, false);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /PRIVATE_GRAPH_CANARY_74D2|Source 01|workflow\.source-01|Data Pipeline|Support Team/);
});

test('typed graph evaluator refuses too-small, duplicate-source, and invalid expectation fixtures', () => {
  const data = fixture();
  assert.equal(validateTypedGraphFixture({ ...data, cases: data.cases.slice(0, 19) }).length, 0);
  const smallReport = evaluateTypedGraphDiscovery({ ...data, cases: data.cases.slice(0, 19) });
  assert.equal(smallReport.decision, 'needs_more_cases');
  assert.ok(validateTypedGraphFixture({ ...data, cases: [data.cases[0], { ...data.cases[1], source: data.cases[0].source }] }).includes('each source note may appear in only one case'));
  assert.ok(validateTypedGraphFixture({ ...data, cases: [{ ...data.cases[0], expected: [{ predicate: 'invented', target_id: 'dataset.pipeline' }] }] }).some((error) => /allowlisted predicates/.test(error)));
  assert.throws(() => evaluateTypedGraphDiscovery({ ...data, notes: data.notes.map((n, i) => i === 0 ? { ...n, private: true } : n) }), /visible, non-generated/);
  assert.throws(() => evaluateTypedGraphDiscovery({ ...data, notes: data.notes.map((n, i) => i === 0 ? { ...n, raw: n.raw.replace('type: dataset', 'private: true\ntype: dataset') } : n) }), /visible, non-generated/);
});

test('typed graph evaluator blocks review when a candidate excerpt contains a forbidden target identifier', () => {
  const data = fixture();
  const sourceRel = data.cases[0].source;
  const notes = data.notes.map((note) => note.rel === sourceRel ? { ...note, body: note.body.replace('fictional review 1.', 'fictional review 1; hidden ref dataset.private-canary.') } : note);
  const report = evaluateTypedGraphDiscovery({ ...data, notes });
  assert.ok(report.privacy_violations > 0);
  assert.equal(report.decision, 'blocked_privacy');
  assert.doesNotMatch(JSON.stringify(report), /dataset\.private-canary/);
});

test('eval-graph CLI produces a content-free report from an explicit fixture file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainlink-typed-graph-eval-'));
  const fixturePath = path.join(dir, 'fixture.json');
  await writeFile(fixturePath, `${JSON.stringify(fixture())}\n`);
  const output = execFileSync(process.execPath, ['bin/brainlink.mjs', 'eval-graph', '--fixture', fixturePath], { cwd: path.resolve('.'), encoding: 'utf8' });
  const report = JSON.parse(output);
  assert.equal(report.case_count, 23);
  assert.equal(report.evaluator_version, 'typed-graph-eval-v1');
  assert.equal(report.environment.node, process.version);
  assert.equal(report.auto_promotion, false);
  assert.doesNotMatch(output, /PRIVATE_GRAPH_CANARY_74D2|Source 01|workflow\.source-01|Data Pipeline|Support Team/);
});
