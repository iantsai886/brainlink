import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRsiObservationSchedule, validateObservationSettings } from '../src/rsi-observation-schedule.mjs';
import { createRsiLedger } from '../src/rsi-ledger.mjs';
import { createRsiWeekly } from '../src/rsi-weekly.mjs';

test('scheduled RSI observation is off by default and only stores aggregate, content-free reports', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'brainlink-rsi-observe-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let now = new Date('2026-10-27T12:00:00.000Z');
  const entries = [
    ...Array.from({ length: 6 }, (_, index) => ({ at: now.toISOString(), tool: 'vault_search', ok: index > 1, result_token_estimate: 120 + index, vault: 'PRIVATE_VAULT_CANARY', note: 'PRIVATE_NOTE_CANARY' })),
  ];
  const service = createRsiObservationSchedule({ home, now: () => now, readEntries: async () => entries });
  const initial = await service.status();
  assert.deepEqual(initial.settings, { enabled: false, interval_hours: 168, vault_health_enabled: false, vault_health_vault: '' });
  assert.equal(initial.report, null);
  assert.equal(await service.due(), false);

  const configured = await service.configure({ enabled: true, interval_hours: 24 });
  assert.equal(configured.next_run_at, now.toISOString());
  assert.equal(await service.due(), true);
  const run = await service.run('schedule');
  assert.equal(run.ok, true);
  assert.equal(run.last_run.trigger, 'schedule');
  assert.equal(run.report.privacy.report_saved, true);
  assert.equal(await service.due(), false);
  assert.doesNotMatch(JSON.stringify(run), /PRIVATE_(?:VAULT|NOTE)_CANARY/);

  const saved = await readFile(service.file, 'utf8');
  assert.doesNotMatch(saved, /PRIVATE_(?:VAULT|NOTE)_CANARY/);
  const reopened = createRsiObservationSchedule({ home, now: () => now, readEntries: async () => { throw new Error('should not run'); } });
  assert.deepEqual((await reopened.status()).report, run.report);
  now = new Date(now.getTime() + 24 * 3600e3);
  assert.equal(await reopened.due(), true, 'the saved interval resumes after Setup restarts');
});

test('RSI observation settings accept only explicit opt-in and supported intervals', () => {
  assert.deepEqual(validateObservationSettings({}), { enabled: false, interval_hours: 168, vault_health_enabled: false, vault_health_vault: '' });
  assert.deepEqual(validateObservationSettings({ enabled: true, interval_hours: 720 }), { enabled: true, interval_hours: 720, vault_health_enabled: false, vault_health_vault: '' });
  assert.deepEqual(validateObservationSettings({ vault_health_enabled: true, vault_health_vault: 'Personal' }), { enabled: false, interval_hours: 168, vault_health_enabled: true, vault_health_vault: 'Personal' });
  for (const invalid of [{ enabled: 1 }, { interval_hours: 23 }, { interval_hours: 48 }, { url: 'https://example.com' }, { vault_health_enabled: true }, { vault_health_enabled: 'true', vault_health_vault: 'Personal' }]) {
    assert.throws(() => validateObservationSettings(invalid));
  }
});

test('scheduled aggregate findings enter the review ledger while manual observations do not', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'brainlink-rsi-observe-ledger-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const now = new Date('2026-10-27T12:00:00.000Z');
  const entries = Array.from({ length: 8 }, (_, i) => ({ at: now.toISOString(), tool: 'vault_search', ok: i >= 4, note: 'PRIVATE_NOTE_CANARY', path: 'PRIVATE_PATH_CANARY' }));
  const ledger = createRsiLedger({ home, now: () => now });
  const service = createRsiObservationSchedule({ home, now: () => now, readEntries: async () => entries, ledger });
  const manual = await service.run('manual');
  assert.equal(manual.report.proposal_intake, undefined);
  assert.deepEqual(await ledger.list(), [], 'manual analysis only reports signals');
  await service.configure({ enabled: true });
  const scheduled = await service.run('schedule');
  assert.equal(scheduled.report.proposal_intake.created_count, 1);
  assert.equal((await ledger.list()).length, 1);
  assert.doesNotMatch(JSON.stringify(scheduled), /PRIVATE_(?:NOTE|PATH)_CANARY/);
  assert.doesNotMatch(await readFile(service.file, 'utf8'), /PRIVATE_(?:NOTE|PATH)_CANARY/);
  assert.doesNotMatch(await readFile(ledger.file, 'utf8'), /PRIVATE_(?:NOTE|PATH)_CANARY/);
});

test('scheduled RSI reviews weak retrieval rates per Twin and opens a review-only proposal', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'brainlink-rsi-retrieval-proposal-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let now = new Date('2026-10-27T12:00:00.000Z');
  const weekly = createRsiWeekly({ home, now: () => now });
  const record = (date, status) => weekly.recordRetrievalObservation({ profileId: 'fictional_org', tool: 'vault_search', status, durationMs: 500 });
  // Seed a synthetic previous window directly; the public recorder always uses its current clock.
  const { createHash } = await import('node:crypto');
  const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const ledger = createRsiLedger({ home, now: () => now });
  for (let i = 0; i < 20; i++) {
    const data = { date: new Date(now.getTime() - 45 * 86400000).toISOString(), profile_id: 'fictional_org', tool: 'vault_search', status: 'hits', duration_bucket_ms: 500 };
    await ledger.appendRsiEvidence('retrieval_observation', data, digest({ ...data, index: i }));
  }
  for (let i = 0; i < 20; i++) await record(now.toISOString(), i < 12 ? 'not_in_brain' : i < 16 ? 'weak' : 'hits');
  const service = createRsiObservationSchedule({
    home, now: () => now,
    readEntries: async () => [{ at: now.toISOString(), tool: 'vault_search', ok: true, query: 'QUESTION_CANARY', path: 'PRIVATE_PATH_CANARY', note: 'PRIVATE_NOTE_CANARY' }],
    readRetrievalObservations: ({ since } = {}) => weekly.listRetrievalObservations({ since }), ledger,
  });
  const manual = await service.run('manual');
  assert.equal(manual.report.retrieval_profiles[0].signal, 'review_retrieval_increase');
  assert.equal(manual.report.proposal_intake, undefined);
  assert.equal((await ledger.list()).length, 0);
  await service.configure({ enabled: true });
  const scheduled = await service.run('schedule');
  assert.equal(scheduled.report.proposal_intake.created_count, 1);
  const proposals = await ledger.list();
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].observation.profile_id, 'fictional_org');
  assert.equal(proposals[0].status, 'discovered');
  const serialized = JSON.stringify({ report: scheduled.report, proposals });
  assert.doesNotMatch(serialized, /QUESTION_CANARY|PRIVATE_PATH_CANARY|PRIVATE_NOTE_CANARY/);
  assert.match(serialized, /correct abstention/);
});

test('optional health snapshots are per-vault, local aggregates and compare only with the same vault', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'brainlink-rsi-vault-health-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let now = new Date('2026-10-27T12:00:00.000Z');
  let snapshot = { notes: 10, links: 8, orphan_count: 4, broken_count: 2, duplicate_title_count: 1, stale_active_count: 3, typed_entity_count: 5, verified_typed_relation_count: 3, proposed_typed_relation_count: 1, unresolved_typed_relation_count: 2, duplicate_typed_id_count: 1, path: 'PRIVATE_PATH_CANARY', text: 'PRIVATE_NOTE_CANARY' };
  let selected = [];
  const service = createRsiObservationSchedule({
    home, now: () => now, readEntries: async () => [],
    readVaultHealth: async (vault) => { selected.push(vault); return snapshot; },
  });
  await service.configure({ vault_health_enabled: true, vault_health_vault: 'Personal' });
  const first = await service.run('manual');
  assert.equal(first.report.vault_health.comparison.signal, 'baseline_unavailable');
  assert.equal(first.report.privacy.vault_health_content_read_locally, true);
  assert.equal(first.report.privacy.vault_health_content_persisted, false);
  assert.equal(JSON.stringify(first).includes('PRIVATE_PATH_CANARY'), false);
  assert.equal(JSON.stringify(first).includes('PRIVATE_NOTE_CANARY'), false);
  snapshot = { ...snapshot, links: 10, orphan_count: 2, broken_count: 0 };
  now = new Date(now.getTime() + 24 * 3600e3);
  const second = await service.run('schedule');
  assert.equal(second.report.vault_health.comparison.signal, 'improved');
  assert.deepEqual(selected, ['Personal', 'Personal']);
  const saved = await readFile(service.file, 'utf8');
  assert.doesNotMatch(saved, /PRIVATE_(?:PATH|NOTE)_CANARY/);
  const reopened = createRsiObservationSchedule({ home, now: () => now, readEntries: async () => [], readVaultHealth: async (vault) => ({ ...snapshot, vault }) });
  await reopened.configure({ vault_health_vault: 'Organisation' });
  const newScope = await reopened.run('manual');
  assert.equal(newScope.report.vault_health.comparison.signal, 'baseline_unavailable');
});

test('scheduled RSI observation fails closed on an unreadable persistent record', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'brainlink-rsi-corrupt-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const service = createRsiObservationSchedule({ home, readEntries: async () => [] });
  await mkdir(path.dirname(service.file), { recursive: true });
  await writeFile(service.file, '{broken');
  await assert.rejects(service.status(), /unreadable/);
});
