import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRsiObservationSchedule, validateObservationSettings } from '../src/rsi-observation-schedule.mjs';

test('scheduled RSI observation is off by default and only stores aggregate, content-free reports', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'brainlink-rsi-observe-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let now = new Date('2026-10-27T12:00:00.000Z');
  const entries = [
    ...Array.from({ length: 6 }, (_, index) => ({ at: now.toISOString(), tool: 'vault_search', ok: index > 1, result_token_estimate: 120 + index, vault: 'PRIVATE_VAULT_CANARY', note: 'PRIVATE_NOTE_CANARY' })),
  ];
  const service = createRsiObservationSchedule({ home, now: () => now, readEntries: async () => entries });
  const initial = await service.status();
  assert.deepEqual(initial.settings, { enabled: false, interval_hours: 168 });
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
  assert.deepEqual(validateObservationSettings({}), { enabled: false, interval_hours: 168 });
  assert.deepEqual(validateObservationSettings({ enabled: true, interval_hours: 720 }), { enabled: true, interval_hours: 720 });
  for (const invalid of [{ enabled: 1 }, { interval_hours: 23 }, { interval_hours: 48 }, { url: 'https://example.com' }]) {
    assert.throws(() => validateObservationSettings(invalid));
  }
});

test('scheduled RSI observation fails closed on an unreadable persistent record', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'brainlink-rsi-corrupt-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const service = createRsiObservationSchedule({ home, readEntries: async () => [] });
  await mkdir(path.dirname(service.file), { recursive: true });
  await writeFile(service.file, '{broken');
  await assert.rejects(service.status(), /unreadable/);
});
