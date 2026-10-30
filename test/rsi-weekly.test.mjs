import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRsiWeekly, validateMiss } from '../src/rsi-weekly.mjs';

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
