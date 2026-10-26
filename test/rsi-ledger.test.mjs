import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRsiLedger } from '../src/rsi-ledger.mjs';
import { startSetup } from '../src/setup.mjs';

const temp = (prefix) => mkdtemp(path.join(tmpdir(), 'brainlink-rsi-' + prefix + '-'));
const validIdea = { title: 'Improve handoff context', user_problem: 'Agents repeat searches after handoff.', hypothesis: 'A source-linked compact packet will reduce redundant reads without reducing task success.', memory_types: ['working', 'episodic'], sources: [{ url: 'https://example.org/research', accessed_at: '2026-10-25', claim: 'Study motivates a test, not proof for BrainLink.' }] };

test('RSI ledger appends proposals, enforces transitions and optimistic revisions', async () => {
  const ledger = createRsiLedger({ home: await temp('unit'), now: () => new Date('2026-10-25T00:00:00.000Z') });
  const idea = await ledger.create(validIdea);
  assert.equal(idea.status, 'discovered');
  assert.equal(idea.revision, 1);
  await assert.rejects(ledger.update({ id: idea.id, expected_revision: 1, status: 'accepted' }), /cannot move/);
  const triaged = await ledger.update({ id: idea.id, expected_revision: 1, status: 'triaged', note: 'Relevant to continuity.' });
  assert.equal(triaged.revision, 2);
  await assert.rejects(ledger.update({ id: idea.id, expected_revision: 1, status: 'researching' }), /changed/);
  await assert.rejects(ledger.update({ id: idea.id, expected_revision: 2, status: 'testing' }), /cannot move/);
  const researching = await ledger.update({ id: idea.id, expected_revision: 2, status: 'researching' });
  assert.equal(researching.status, 'researching');
  assert.equal(researching.history.length, 3);
  assert.equal((await readFile(ledger.file, 'utf8')).trim().split(/\r?\n/).length, 3);
});

test('RSI acceptance requires recorded evidence, reviewer, promotion commit and rollback', async () => {
  const ledger = createRsiLedger({ home: await temp('accept') });
  const idea = await ledger.create(validIdea);
  let current = idea;
  for (const status of ['triaged', 'proposed', 'testing', 'review']) current = await ledger.update({ id: idea.id, expected_revision: current.revision, status });
  await assert.rejects(ledger.update({ id: idea.id, expected_revision: current.revision, status: 'accepted' }), /requires baseline/);
  const evidence = {
    baseline_version: 'commit:base123', candidate_version: 'release:1.2.9', test_set_version: 'fictional-v1', results: 'Task success held; measured read count fell in this fixture.', metrics: ['task success: unchanged', 'reads: lower'], guardrails: ['no privacy leak'], reviewer: 'Independent reviewer', decision_and_reason: 'Accept within stated fixture limits.', rollback: 'Revert commit abc123.',
  };
  await assert.rejects(ledger.update({ id: idea.id, expected_revision: current.revision, status: 'accepted', fields: evidence }), /promotion commit SHA/);
  await assert.rejects(ledger.update({ id: idea.id, expected_revision: current.revision, fields: { promotion_commit_sha: 'abc123' } }), /full 40-character Git commit SHA/);
  const accepted = await ledger.update({ id: idea.id, expected_revision: current.revision, status: 'accepted', fields: {
    ...evidence, promotion_commit_sha: 'a'.repeat(40),
  } });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.fields.promotion_commit_sha, 'a'.repeat(40));
  const monitoring = {
    monitored_commit_sha: 'a'.repeat(40), window_start: '2026-10-25', window_end: '2026-10-26', test_set_version: 'fictional-post-release-v1', sample_count: 24,
    decision: 'stable', primary_metric: { name: 'task success rate', baseline: 0.9, observed: 0.9 }, guardrail_status: 'pass',
    guardrails: ['privacy canary: passed', 'source recall: unchanged'], results: 'No regression found in the reviewed sample.', reviewer: 'Independent reviewer', evidence_ref: 'https://example.org/monitor/receipt-1',
  };
  await assert.rejects(ledger.recordMonitoring({ id: idea.id, expected_revision: accepted.revision, monitoring: { ...monitoring, monitored_commit_sha: 'b'.repeat(40) } }), /exact accepted promotion commit/);
  await assert.rejects(ledger.recordMonitoring({ id: idea.id, expected_revision: accepted.revision, monitoring: { ...monitoring, window_end: '2999-01-01' } }), /cannot end in the future/);
  await assert.rejects(ledger.recordMonitoring({ id: idea.id, expected_revision: accepted.revision, monitoring: { ...monitoring, decision: 'stable', guardrail_status: 'fail' } }), /do not agree/);
  const monitored = await ledger.recordMonitoring({ id: idea.id, expected_revision: accepted.revision, monitoring });
  assert.equal(monitored.status, 'accepted', 'monitoring never changes promotion status');
  assert.equal(monitored.monitoring.length, 1);
  assert.equal(monitored.monitoring[0].decision, 'stable');
  assert.match(monitored.monitoring[0].monitoring_id, /^BL-RSI-MON-\d{8}-[a-f0-9-]{8,36}$/);
  await assert.rejects(ledger.recordMonitoring({ id: idea.id, expected_revision: accepted.revision, monitoring }), /changed/);
  await assert.rejects(ledger.update({ id: idea.id, expected_revision: monitored.revision, status: 'rolled_back' }), /why/);
  const rolledBack = await ledger.update({ id: idea.id, expected_revision: monitored.revision, status: 'rolled_back', note: 'Regression in a fresh test set.' });
  assert.equal(rolledBack.status, 'rolled_back');
});

test('RSI experiment receipts are aggregate-only, append-only, and require a fresh testing revision', async () => {
  const ledger = createRsiLedger({ home: await temp('experiment-receipt') });
  let idea = await ledger.create(validIdea);
  for (const status of ['triaged', 'proposed']) idea = await ledger.update({ id: idea.id, expected_revision: idea.revision, status });
  idea = await ledger.update({ id: idea.id, expected_revision: idea.revision, status: 'testing', fields: { candidate_version: 'per-case-rephrasing-v1' } });
  const receipt = {
    schema: 1, run_id: 'BL-RSI-RUN-20261025-12345678', suite: 'retrieval-rsi-v1',
    started_at: '2026-10-25T00:00:00.000Z', completed_at: '2026-10-25T00:00:01.000Z',
    fixture_sha256: 'a'.repeat(64), evaluator_version: 'retrieval-eval-v2', software_version: '1.2.8', candidate_version: 'per-case-rephrasing-v1',
    candidate_policy: 'fixed fictional evaluation', sample_count: 21, decision: 'eligible_for_review',
    primary_metric: { name: 'hit_at_k_rate', baseline: 0.8, candidate: 0.9 },
    secondary_metric: { name: 'mean_reciprocal_rank', baseline: 0.7, candidate: 0.8 },
    guardrails: { baseline_privacy_violations: 0, candidate_privacy_violations: 0 },
    estimated_context_tokens: { baseline: 500, candidate: 450 }, limitations: ['Fictional data only.'],
  };
  receipt.run_id = 'BL-RSI-RUN-20261025-abcdef12';
  await assert.rejects(ledger.recordExperiment({ id: idea.id, expected_revision: idea.revision - 1, receipt }), /changed/);
  const recorded = await ledger.recordExperiment({ id: idea.id, expected_revision: idea.revision, receipt });
  assert.equal(recorded.experiments.length, 1);
  assert.equal(recorded.experiments[0].run_id, receipt.run_id);
  await assert.rejects(ledger.recordExperiment({ id: idea.id, expected_revision: recorded.revision, receipt: { ...receipt, query: 'private query' } }), /invalid/i);
  const secondRun = await ledger.recordExperiment({ id: idea.id, expected_revision: recorded.revision, receipt: { ...receipt, run_id: 'BL-RSI-RUN-20261025-fedcba98' } });
  assert.equal(secondRun.experiments.length, 2);
  const raw = await readFile(ledger.file, 'utf8');
  assert.doesNotMatch(raw, /private query|query|snippet|vault_path/i);
  assert.equal(raw.trim().split(/\r?\n/).length, 6);
  let compactIdea = await ledger.create({ ...validIdea, title: 'Lossless compact search experiment' });
  for (const status of ['triaged', 'proposed']) compactIdea = await ledger.update({ id: compactIdea.id, expected_revision: compactIdea.revision, status });
  compactIdea = await ledger.update({ id: compactIdea.id, expected_revision: compactIdea.revision, status: 'testing', fields: { candidate_version: 'compact-search-v1' } });
  const compactReceipt = { ...receipt, run_id: 'BL-RSI-RUN-20261026-abcdef01', suite: 'retrieval-independent-v1', evaluator_version: 'retrieval-eval-v3', candidate_version: 'compact-search-v1', candidate_policy: 'lossless production compact response projection' };
  const compactRecorded = await ledger.recordExperiment({ id: compactIdea.id, expected_revision: compactIdea.revision, receipt: compactReceipt });
  assert.equal(compactRecorded.experiments[0].evaluator_version, 'retrieval-eval-v3');
  assert.equal(compactRecorded.experiments[0].candidate_version, 'compact-search-v1');
});

test('RSI ledger rejects secret-bearing text and non-public source URLs', async () => {
  const ledger = createRsiLedger({ home: await temp('reject') });
  await assert.rejects(ledger.create({ ...validIdea, user_problem: 'API key: sk-test-123456789012345678901234' }), /secret/i);
  await assert.rejects(ledger.create({ ...validIdea, sources: [{ url: 'http://127.0.0.1/private' }] }), /HTTPS/);
  await assert.rejects(ledger.create({ ...validIdea, sources: [{ url: 'https://192.168.1.10/research' }] }), /public HTTPS/);
  await assert.rejects(ledger.create({ ...validIdea, sources: [{ url: 'https://example.org/research', confidence: 'certain' }] }), /confidence/);
  await assert.rejects(ledger.create({ ...validIdea, sources: [{ url: 'https://example.org/research', published_at: 'yesterday' }] }), /YYYY-MM-DD/);
  await assert.rejects(ledger.create({ ...validIdea, memory_types: ['private'] }), /memory_types/);
  assert.deepEqual(await ledger.list(), []);
});

test('RSI ledger detects tampering and fails closed', async () => {
  const ledger = createRsiLedger({ home: await temp('tamper') });
  await ledger.create(validIdea);
  const original = await readFile(ledger.file, 'utf8');
  await writeFile(ledger.file, original.replace('Improve handoff context', 'Altered handoff context'));
  await assert.rejects(ledger.list(), /integrity check failed/);
});

test('separate BrainLink instances serialize writes to one RSI journal', async () => {
  const home = await temp('multi-instance');
  const first = createRsiLedger({ home }), second = createRsiLedger({ home });
  const [a, b] = await Promise.all([first.create(validIdea), second.create({ ...validIdea, title: 'Track source freshness' })]);
  assert.notEqual(a.id, b.id);
  const listed = await Promise.all([first.list(), second.list()]);
  assert.equal(listed[0].length, 2);
  assert.equal(listed[1].length, 2);
  assert.deepEqual(new Set(listed[0].map(x => x.id)), new Set([a.id, b.id]));
});

test('RSI similarity check suggests overlapping ideas without blocking intentional duplicates', async () => {
  const ledger = createRsiLedger({ home: await temp('similar') });
  const saved = await ledger.create(validIdea);
  const matches = await ledger.similar({ ...validIdea, title: 'Improve handoff context', user_problem: 'Agents repeat searches after handoff.' });
  assert.equal(matches[0].id, saved.id);
  assert.ok(matches[0].score >= 55);
  assert.deepEqual(await ledger.similar({ title: 'Water garden plants', user_problem: 'The greenhouse needs watering schedules.' }), []);
  // Suggestions are advisory: callers can still intentionally record a related experiment.
  const intentional = await ledger.create({ ...validIdea, title: 'Improve handoff context for mobile' });
  assert.equal(intentional.status, 'discovered');
});

test('RSI Setup panel has unique ids and one render/submit path', async () => {
  const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  assert.equal((html.match(/id="rsi-panel"/g) || []).length, 1);
  assert.equal((html.match(/id="rsi-idea-form"/g) || []).length, 1);
  assert.match(html, /data-rsi-field="promotion_commit_sha"/);
  assert.match(html, /data-rsi-monitor-submit/);
  for (const locale of ['en', 'zh-TW', 'pt']) {
    const catalog = JSON.parse(await readFile(new URL(`../ui/locales/${locale}.json`, import.meta.url), 'utf8'));
    assert.ok(catalog['rsi.promotionCommit'], `${locale} promotion commit label`);
    assert.ok(catalog['rsi.promotionCommitHint'], `${locale} promotion commit limitation`);
    for (const key of ['rsi.monitor.title', 'rsi.monitor.hint', 'rsi.monitor.start', 'rsi.monitor.end', 'rsi.monitor.testSet', 'rsi.monitor.samples', 'rsi.monitor.decision.stable', 'rsi.monitor.decision.regression', 'rsi.monitor.decision.inconclusive', 'rsi.monitor.guardrail.pass', 'rsi.monitor.guardrail.fail', 'rsi.monitor.guardrail.unknown', 'rsi.monitor.metricName', 'rsi.monitor.baseline', 'rsi.monitor.observed', 'rsi.monitor.reviewer', 'rsi.monitor.guardrails', 'rsi.monitor.results', 'rsi.monitor.evidenceRef', 'rsi.monitor.save', 'rsi.monitor.saved', 'rsi.monitor.history']) assert.ok(catalog[key], `${locale} ${key}`);
  }
  assert.equal((html.match(/async function loadRsi\(\)/g) || []).length, 1);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length);
  assert.doesNotThrow(() => new Function(scripts.at(-1)[1]));
});

test('Setup exposes the RSI ledger only through authenticated local APIs', async () => {
  const home = await temp('api'), env = { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' };
  const app = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const base = 'http://127.0.0.1:' + app.port;
  const post = (route, body, token = app.token) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': token }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/rsi/ideas', validIdea, 'wrong-token')).status, 401);
    const created = await post('/api/rsi/ideas', validIdea).then(r => r.json());
    assert.equal(created.idea.status, 'discovered');
    assert.equal((await post('/api/rsi/ideas/check', validIdea, 'wrong-token')).status, 401);
    const similar = await post('/api/rsi/ideas/check', validIdea).then(r => r.json());
    assert.equal(similar.similar[0].id, created.idea.id);
    assert.equal((await fetch(base + '/api/rsi', { headers: { 'X-BrainLink-Token': 'wrong-token' } })).status, 401);
    const listed = await fetch(base + '/api/rsi', { headers: { 'X-BrainLink-Token': app.token } }).then(r => r.json());
    assert.equal(listed.ideas.length, 1);
    const bad = await post('/api/rsi/ideas/update', { id: created.idea.id, expected_revision: 1, status: 'accepted' }).then(r => r.json());
    assert.match(bad.error, /cannot move/);
    assert.equal((await post('/api/rsi/experiments/run', { idea_id: created.idea.id, suite: 'retrieval-rsi-v1' }, 'wrong-token')).status, 401);
    const earlyRun = await post('/api/rsi/experiments/run', { idea_id: created.idea.id, suite: 'retrieval-rsi-v1' }).then(r => r.json());
    assert.match(earlyRun.error, /before running/);
    let idea = created.idea;
    for (const status of ['triaged', 'proposed']) idea = (await post('/api/rsi/ideas/update', { id: idea.id, expected_revision: idea.revision, status }).then(r => r.json())).idea;
    idea = (await post('/api/rsi/ideas/update', { id: idea.id, expected_revision: idea.revision, status: 'testing', fields: { candidate_version: 'per-case-rephrasing-v1' } }).then(r => r.json())).idea;
    const run = await post('/api/rsi/experiments/run', { idea_id: idea.id, suite: 'retrieval-rsi-v1' }).then(r => r.json());
    assert.equal(run.error, undefined, JSON.stringify(run));
    assert.equal(run.idea.experiments.length, 1);
    assert.equal(run.idea.experiments[0].suite, 'retrieval-rsi-v1');
    assert.equal(run.idea.experiments[0].candidate_version, idea.fields.candidate_version);
    assert.doesNotMatch(JSON.stringify(run), /RSI_PRIVATE_CANARY_9D7|Acquisition Budget\.md|Northwind Coffee\.md/);
    const unknownSuite = await post('/api/rsi/experiments/run', { idea_id: idea.id, suite: '../user-vault' }).then(r => r.json());
    assert.match(unknownSuite.error, /built-in fictional/);
    idea = (await post('/api/rsi/ideas/update', { id: idea.id, expected_revision: run.idea.revision, status: 'review' }).then(r => r.json())).idea;
    const approval = { baseline_version: '1.2.8', candidate_version: 'per-case-rephrasing-v1', promotion_commit_sha: 'c'.repeat(40), test_set_version: 'fictional-v1', results: 'Reviewed fixture evidence.', metrics: ['task success 0.9'], guardrails: ['privacy pass'], reviewer: 'Reviewer', decision_and_reason: 'Synthetic test only.', rollback: 'Revert commit.' };
    idea = (await post('/api/rsi/ideas/update', { id: idea.id, expected_revision: idea.revision, status: 'accepted', fields: approval }).then(r => r.json())).idea;
    const sampleMonitoring = { monitored_commit_sha: 'c'.repeat(40), window_start: '2026-10-25', window_end: '2026-10-26', test_set_version: 'fictional-monitor-v1', sample_count: 12, decision: 'regression', primary_metric: { name: 'task success', baseline: 0.9, observed: 0.7 }, guardrail_status: 'fail', guardrails: ['task success fell'], results: 'Synthetic regression signal.', reviewer: 'Reviewer', evidence_ref: '' };
    assert.equal((await post('/api/rsi/ideas/monitor', { id: idea.id, expected_revision: idea.revision, monitoring: sampleMonitoring }, 'wrong-token')).status, 401);
    const monitor = await post('/api/rsi/ideas/monitor', { id: idea.id, expected_revision: idea.revision, monitoring: sampleMonitoring }).then(r => r.json());
    assert.equal(monitor.idea.monitoring.length, 1);
    assert.equal(monitor.idea.status, 'accepted', 'the service records evidence but does not roll back automatically');
    assert.doesNotMatch(JSON.stringify(monitor), /RSI_PRIVATE_CANARY_9D7|Acquisition Budget\.md|Northwind Coffee\.md/);
  } finally { app.server.close(); }
});
