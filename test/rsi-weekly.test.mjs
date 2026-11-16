import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRsiWeekly, validateMiss } from '../src/rsi-weekly.mjs';
import { emptyConfig, saveConfig } from '../src/config.mjs';
import { startSetup } from '../src/setup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const date = '2026-10-30T12:00:00+08:00';
const example = { date, profile: 'Fictional Organisation', agent: 'Fictional Agent', question: 'Where is the fictional roadmap?', result: 'not_found', seconds: 3, fix_needed: 'add_index_entry' };
const fixture = async () => createRsiWeekly({ home: await mkdtemp(path.join(tmpdir(), 'brainlink-rsi-weekly-')) });
test('miss schema, question redaction, profile separation, and secret rejection', async () => {
  const safe = validateMiss(example);
  assert.equal(safe.fix_needed, 'add_index_entry');
  assert.equal('question' in safe, false);
  assert.match(safe.question_sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => validateMiss({ ...example, seconds: -3 }), /seconds/);
  assert.throws(() => validateMiss({ ...example, date: '2026-10-30' }), /date/);
  assert.throws(() => validateMiss({ ...example, question: 'access token sk-proj-abcdefghijklmnopqrstuvwxyz12345678901234567890' }), /sensitive/);
  const home = await mkdtemp(path.join(tmpdir(), 'brainlink-rsi-weekly-'));
  const r = createRsiWeekly({ home });
  await r.addMiss(example);
  const { createRsiLedger } = await import('../src/rsi-ledger.mjs');
  const evidence = await readFile(createRsiLedger({ home }).file, 'utf8');
  assert.equal(evidence.includes(example.question), false);
  assert.equal((await r.listMisses('Fictional Organisation')).length, 1);
  assert.equal((await r.listMisses('Ian Personal')).length, 0);
  await assert.rejects(() => r.listMisses(), /profile is required/);
});
test('idempotent Markdown import and verified ledger', async () => {
  const r = await fixture();
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'brainlink-markdown-')), 'log.md');
  await writeFile(file, `| date | profile | agent | question | result (found/not found/stale) | seconds | fix needed | fixed by |\n|---|---|---|---|---|---|---|---|\n| 2026-10-30 | Fictional Organisation | Fictional Agent | Where is the fictional roadmap? | not found | 3 | add 00 INDEX entry | |\n`);
  assert.equal((await r.importMarkdown(file)).added, 1);
  assert.equal((await r.importMarkdown(file)).added, 0);
  assert.equal((await r.listMisses('Fictional Organisation')).length, 1);
});
test('aggregation groups normalized questions and week/fix type', async () => {
  const r = await fixture();
  await r.addMiss(example);
  await r.addMiss({ ...example, date: '2026-11-06T12:00:00+08:00', question: '  WHERE   is the fictional roadmap?  ', fix_needed: 'add_link' });
  const a = await r.aggregateMisses('Fictional Organisation');
  assert.equal(a.total, 2);
  assert.equal(Object.keys(a.groups).length, 1);
  assert.equal(a.by_week['2026-W44'], 1);
  assert.equal(a.by_week['2026-W45'], 1);
  assert.equal(a.by_fix_needed.add_link, 1);
});
test('automatic retrieval observations keep only coarse outcomes and separate Twin profiles', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'brainlink-rsi-observations-'));
  const r = createRsiWeekly({ home, now: () => new Date('2026-10-30T04:00:00.000Z') });
  assert.deepEqual(await r.recordRetrievalObservation({ profileId: null, tool: 'vault_search', status: 'not_in_brain', durationMs: 400 }), { recorded: false, reason: 'unscoped' });
  assert.deepEqual(await r.recordRetrievalObservation({ profileId: 'fictional_org', tool: 'vault_search', status: 'not_in_brain', durationMs: 389 }), { recorded: true });
  await r.recordRetrievalObservation({ profileId: 'fictional_org', tool: 'context_packet', status: 'hits', durationMs: 741 });
  await r.recordRetrievalObservation({ profileId: 'fictional_personal', tool: 'vault_search', status: 'weak', durationMs: 525 });
  const report = await r.retrievalObservationReport('fictional_org');
  assert.equal(report.total, 2);
  assert.deepEqual(report.by_status, { not_in_brain: 1, hits: 1 });
  assert.deepEqual(report.by_tool, { vault_search: 1, context_packet: 1 });
  assert.equal((await r.retrievalObservationReport('fictional_personal')).total, 1);
  const { createRsiLedger } = await import('../src/rsi-ledger.mjs');
  const ledger = await readFile(createRsiLedger({ home }).file, 'utf8');
  assert.doesNotMatch(ledger, /question|query|note content|private-folder|secret-note/i);
  assert.match(ledger, /\"profile_id\":\"fictional_org\"/);
  assert.match(ledger, /\"duration_bucket_ms\":500/);
  const stored = ledger.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(stored.every((row) => !Object.hasOwn(row.data, 'duration_ms') && !Object.hasOwn(row.data, 'duration')),
    'the journal must not store exact response durations');
});
test('week-on-week delta and applied fix type', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'brainlink-rsi-weekly-'));
  const r = createRsiWeekly({ home });
  const { createRsiLedger } = await import('../src/rsi-ledger.mjs');
  const ledger = createRsiLedger({ home });
  for (const [week, count] of [['2026-W44', 10], ['2026-W45', 14]]) {
    const evidence = { week, fixture_sha256: 'a'.repeat(64), evaluator_version: 'retrieval-eval-v3', case_count: 20, first_try_correct: { count, total: 20, percent: count * 5 }, privacy_violations: 0, failed_case_count: 20 - count };
    await ledger.appendRsiEvidence('weekly_benchmark', evidence, (week === '2026-W44' ? 'a' : 'b').repeat(64));
  }
  await r.addMiss({ ...example, fixed_by: { agent: 'Fixer', date: '2026-11-06T13:00:00+08:00', note: 'Fictional index' } });
  const report = await r.benchmarkReport();
  assert.equal(report.length, 2);
  assert.equal(report[1].delta_pp, 20);
  assert.equal('applied_fix_types' in report[1], false);
});

test('Setup weekly benchmark is authenticated, uses only the built-in fictional vault, and stores aggregates', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'brainlink-rsi-weekly-setup-'));
  let sourcePair = ['a'.repeat(40), 'a'.repeat(40)], sourceRead = 0;
  const weeklyBenchmarkSourceState = () => ({ commit_sha: sourcePair[sourceRead++ % 2], clean: true });
  const app = await startSetup({ env: { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' }, home, os: 'linux', port: 0, useCli: false, weeklyBenchmarkSourceState });
  const base = `http://127.0.0.1:${app.port}`;
  const api = (route, { method = 'GET', token = app.token } = {}) => fetch(`${base}${route}`, {
    method,
    ...(token ? { headers: { 'X-BrainLink-Token': token, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) } } : {}),
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
  try {
    assert.equal((await api('/api/rsi/weekly-benchmark', { token: '' })).status, 401);
    assert.equal((await api('/api/rsi/weekly-benchmark/run', { method: 'POST', token: '' })).status, 401);
    assert.deepEqual((await (await api('/api/rsi/weekly-benchmark')).json()).runs, []);

    const response = await api('/api/rsi/weekly-benchmark/run', { method: 'POST' });
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.run.recorded, true);
    assert.equal(saved.run.case_count, 20);
    assert.equal(saved.run.first_try_correct.total, 20);
    assert.equal(saved.run.privacy_violations, 0);
    assert.equal(saved.run.software_version, JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version);
    assert.match(saved.run.source_commit_sha, /^[a-f0-9]{40}$/);
    assert.equal(saved.run.source_commit_sha_after, 'a'.repeat(40));
    assert.equal(saved.run.source_tree_clean, true);
    assert.equal(saved.run.source_tree_clean_after, true);
    assert.equal(saved.run.source_stable, true);
    assert.ok(Date.parse(saved.run.started_at) <= Date.parse(saved.run.completed_at));
    assert.match(saved.run.fixture_sha256, /^[a-f0-9]{64}$/);
    assert.equal(saved.runs.length, 1);
    const serialized = JSON.stringify(saved);
    assert.doesNotMatch(serialized, /fictional-marker-\d+|Fictional Topic \d+\.md|fictional-\d{2}/, 'case questions, paths and IDs must not be stored or returned');
    assert.doesNotMatch(serialized, /connected vault|user vault/i);
    const repeated = await (await api('/api/rsi/weekly-benchmark/run', { method: 'POST' })).json();
    assert.equal(repeated.run.recorded, false, 'the same week, fixture, evaluator and source revision is idempotent');
    assert.equal(repeated.runs.length, 1);
    sourcePair = ['b'.repeat(40), 'c'.repeat(40)];
    sourceRead = 0;
    const changed = await (await api('/api/rsi/weekly-benchmark/run', { method: 'POST' })).json();
    assert.equal(changed.run.recorded, true, 'a different source interval receives a distinct receipt');
    assert.equal(changed.run.source_commit_sha, 'b'.repeat(40));
    assert.equal(changed.run.source_commit_sha_after, 'c'.repeat(40));
    assert.equal(changed.run.source_stable, false, 'a source change during evaluation is not reported as stable');
    assert.equal(changed.runs.length, 1, 'history presents the latest receipt for the week');
    const fixture = JSON.parse(await readFile(path.join(ROOT, 'samples', 'evaluation', 'rsi-weekly-fictional-20.json'), 'utf8'));
    assert.equal(fixture.cases.length, 20);
  } finally { app.server.close(); }
});

test('Setup exposes localized weekly benchmark controls and labels their evidence limits', async () => {
  const html = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  assert.match(html, /id="rsi-weekly-run"/);
  assert.match(html, /id="rsi-weekly-schedule-form"/);
  assert.match(html, /POST', '\/api\/rsi\/weekly-benchmark\/settings/);
  assert.match(html, /POST', '\/api\/rsi\/weekly-benchmark\/run/);
  assert.match(html, /loadWeeklyBenchmark\(\)\.catch/);
  for (const locale of ['en', 'pt', 'zh-TW']) {
    const catalog = JSON.parse(await readFile(path.join(ROOT, 'ui', 'locales', `${locale}.json`), 'utf8'));
    for (const key of ['rsi.weekly.title', 'rsi.weekly.hint', 'rsi.weekly.run', 'rsi.weekly.running', 'rsi.weekly.saved', 'rsi.weekly.empty', 'rsi.weekly.result', 'rsi.weekly.sourceClean', 'rsi.weekly.sourceWorking', 'rsi.weekly.sourceStable', 'rsi.weekly.sourceUnstable', 'rsi.weekly.sourceUnknown', 'rsi.weekly.scheduleEnabled', 'rsi.weekly.saveSchedule', 'rsi.weekly.scheduleOff', 'rsi.weekly.scheduleOn', 'rsi.weekly.scheduleDone', 'rsi.weekly.scheduleFailed']) assert.ok(catalog[key], `${locale} ${key}`);
  }
});

test('Setup weekly benchmark schedule is authenticated and runs only the fixed fictional fixture once per week', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'brainlink-rsi-weekly-schedule-'));
  const appHome = path.join(home, 'app');
  await saveConfig({ ...emptyConfig(), timezone: 'Asia/Taipei' }, path.join(appHome, 'config.json'));
  const app = await startSetup({
    env: { BRAINLINK_HOME: appHome, BRAINLINK_SEMANTIC: '0' }, home, os: 'linux', port: 0, useCli: false,
    weeklyBenchmarkNow: () => new Date('2026-10-26T01:00:00.000Z'), weeklyBenchmarkTickMs: 10,
  });
  const base = `http://127.0.0.1:${app.port}`;
  const api = (route, { method = 'GET', token = app.token, body } = {}) => fetch(`${base}${route}`, {
    method,
    ...(token ? { headers: { 'X-BrainLink-Token': token, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) } } : {}),
    ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}),
  });
  try {
    assert.equal((await api('/api/rsi/weekly-benchmark/settings', { method: 'POST', token: '' })).status, 401);
    const saved = await (await api('/api/rsi/weekly-benchmark/settings', { method: 'POST', body: { enabled: true, weekday: 1, time: '09:00' } })).json();
    assert.equal(saved.schedule.enabled, true);
    assert.equal(saved.schedule.last_scheduled_week, null);

    let status;
    for (let i = 0; i < 100; i++) {
      status = await (await api('/api/rsi/weekly-benchmark')).json();
      if (status.schedule.last_run_ok === true) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(status.schedule.last_scheduled_week, '2026-W44');
    assert.equal(status.schedule.last_run_ok, true);
    assert.equal(status.runs.length, 1);
    await new Promise(resolve => setTimeout(resolve, 80));
    status = await (await api('/api/rsi/weekly-benchmark')).json();
    assert.equal(status.runs.length, 1, 'timer must not append duplicate results within the scheduled week');
    assert.equal(status.runs[0].case_count, 20);
  } finally { app.server.close(); }
});
