import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startSetup } from '../src/setup.mjs';
import { normalize, saveConfig } from '../src/config.mjs';
import { ingestionScheduleDue, localDateAndTime, validateIngestionSchedule } from '../src/ingestion-schedule.mjs';

const temp = (name) => mkdtemp(path.join(tmpdir(), `brainlink-ingestion-schedule-${name}-`));

test('daily scan schedule validates input and follows the configured local time', () => {
  assert.throws(() => validateIngestionSchedule({ enabled: true, vault: 'Team', folder: 'Raw', time: '25:00' }), /valid daily scan time/i);
  assert.throws(() => validateIngestionSchedule({ enabled: true, vault: 'Team', folder: '', time: '02:00' }), /Choose a vault and one folder/i);
  const at = new Date('2026-10-25T12:30:00.000Z');
  assert.deepEqual(localDateAndTime(at, 'UTC'), { date: '2026-10-25', time: '12:30' });
  const schedule = { enabled: true, vault: 'Team', folder: 'Raw', time: '12:00' };
  assert.equal(ingestionScheduleDue(schedule, at, 'UTC'), true);
  assert.equal(ingestionScheduleDue({ ...schedule, last_scheduled_date: '2026-10-25' }, at, 'UTC'), false);
  assert.equal(ingestionScheduleDue({ ...schedule, time: '13:00' }, at, 'UTC'), false);
  assert.equal(ingestionScheduleDue({ ...schedule, enabled: false }, at, 'UTC'), false);
  assert.equal(ingestionScheduleDue({ ...schedule, last_scheduled_date: '2026-10-25', retry_date: '2026-10-25', retry_after: '2026-10-25T12:31:00.000Z' }, at, 'UTC'), false);
  assert.equal(ingestionScheduleDue({ ...schedule, last_scheduled_date: '2026-10-25', retry_date: '2026-10-25', retry_after: '2026-10-25T12:29:00.000Z' }, at, 'UTC'), true);
  const retried = validateIngestionSchedule({ ...schedule, enabled: true }, { ...schedule, enabled: true, last_scheduled_date: '2026-10-25', retry_count: 1, retry_date: '2026-10-25', retry_after: '2026-10-25T12:45:00.000Z' });
  assert.equal(retried.retry_count, 1, 'saving unchanged settings preserves the retry schedule');
  assert.equal(validateIngestionSchedule({ ...schedule, time: '13:00' }, { ...schedule, retry_count: 1 }).retry_after, null, 'changing the schedule clears stale retries');
});

test('failed scheduled scan retries once the source folder returns, without logging note content', async () => {
  const home = await temp('retry');
  const appHome = path.join(home, 'app');
  const vault = path.join(home, 'vault');
  await mkdir(vault, { recursive: true });
  const env = { BRAINLINK_HOME: appHome, HOME: home, BRAINLINK_SEMANTIC: '0' };
  const now = new Date();
  const local = localDateAndTime(now, 'UTC');
  const pastMinute = `${local.time.slice(0, 2)}:${String(Math.max(0, Number(local.time.slice(3)) - 1)).padStart(2, '0')}`;
  await saveConfig(normalize({ timezone: 'UTC', vaults: [{ name: 'Fictional Team', path: vault }], ingestion: { enabled: true, vault: 'Fictional Team', folder: 'Raw', time: pastMinute } }), path.join(appHome, 'config.json'));
  const app = await startSetup({ env, home, os: 'linux', port: 0, useCli: false, ingestionTickMs: 20, ingestionRetryMs: 60 });
  const base = `http://127.0.0.1:${app.port}`;
  const getState = () => fetch(base + '/api/state', { headers: { 'X-BrainLink-Token': app.token } }).then((r) => r.json());
  try {
    let state;
    for (let i = 0; i < 100; i++) {
      state = await getState();
      if (state.ingestion.status?.retry_after) break;
      await delay(10);
    }
    assert.equal(state.ingestion.status.ok, false);
    assert.equal(state.ingestion.status.attempt, 1);
    assert.ok(state.ingestion.status.retry_after);
    await mkdir(path.join(vault, 'Raw'), { recursive: true });
    await writeFile(path.join(vault, 'Raw', 'Source.md'), '# Source\n\nPrivate body must not enter scan status.');
    for (let i = 0; i < 100; i++) {
      await delay(15);
      state = await getState();
      if (state.ingestion.status?.ok && state.ingestion.status.trigger === 'schedule') break;
    }
    assert.equal(state.ingestion.status.ok, true);
    assert.equal(state.ingestion.status.queued_total, 1);
    assert.equal(state.ingestion.status.attempt, undefined, 'successful scan status remains concise');
    const saved = await readFile(path.join(appHome, 'ingestion-state.json'), 'utf8');
    assert.doesNotMatch(saved, /Private body must not enter scan status/);
    const cfg = JSON.parse(await readFile(path.join(appHome, 'config.json'), 'utf8'));
    assert.equal(cfg.ingestion.retry_after, null, 'success clears the retry schedule');
  } finally { app.server.close(); }
});

test('Setup offers authenticated manual scans and runs an enabled daily scan in the background', async () => {
  const home = await temp('api');
  const appHome = path.join(home, 'app');
  const vault = path.join(home, 'vault');
  await mkdir(path.join(vault, 'Raw'), { recursive: true });
  await writeFile(path.join(vault, 'Raw', 'Source.md'), '# Source\n\nFictional intake item.');
  const env = { BRAINLINK_HOME: appHome, HOME: home, BRAINLINK_SEMANTIC: '0' };
  const now = new Date();
  const local = localDateAndTime(now, 'UTC');
  const pastMinute = `${local.time.slice(0, 2)}:${String(Math.max(0, Number(local.time.slice(3)) - 1)).padStart(2, '0')}`;
  await saveConfig(normalize({ timezone: 'UTC', vaults: [{ name: 'Fictional Team', path: vault }], ingestion: { enabled: true, vault: 'Fictional Team', folder: 'Raw', time: pastMinute } }), path.join(appHome, 'config.json'));
  const app = await startSetup({ env, home, os: 'linux', port: 0, useCli: false, ingestionTickMs: 20 });
  const base = `http://127.0.0.1:${app.port}`;
  const get = (route, token = app.token) => fetch(base + route, { headers: { 'X-BrainLink-Token': token } });
  const post = (route, body = {}, token = app.token) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': token }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/ingestion/run', {}, 'wrong')).status, 401);
    let status;
    for (let i = 0; i < 100; i++) {
      status = await get('/api/state').then((r) => r.json());
      if (status.ingestion.status?.trigger === 'schedule') break;
      await delay(20);
    }
    assert.equal(status.ingestion.status.trigger, 'schedule', `the background timer scans at the configured local time: ${JSON.stringify(status.ingestion)}`);
    assert.equal(status.ingestion.status.queued_total, 1);
    for (let i = 0; i < 100 && status.ingestion.running; i++) { await delay(10); status = await get('/api/state').then((r) => r.json()); }
    assert.equal(status.ingestion.running, false, 'scheduled work finishes before the manual run starts');
    assert.equal((await readFile(path.join(appHome, 'ingestion-state.json'), 'utf8')).includes('Fictional intake item'), false, 'saved scan status contains no note body');
    const manual = await post('/api/ingestion/run', { vault: 'Fictional Team', folder: 'Raw' });
    assert.equal(manual.status, 200, await manual.clone().text());
    const manualResult = await manual.json();
    assert.equal(manualResult.trigger, 'manual');
    assert.equal(manualResult.queued_total, 1);
    assert.equal(manualResult.candidates[0].path, 'Raw/Source.md');
    const saved = await post('/api/ingestion/settings', { enabled: false, vault: 'Fictional Team', folder: 'Raw', time: pastMinute });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).ingestion.enabled, false);
  } finally { app.server.close(); }
});

test('ingestion scan UI has manual and scheduled controls with all locale strings', async () => {
  const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  for (const id of ['ingestion-enabled', 'ingestion-vault', 'ingestion-folder', 'ingestion-time', 'ingestion-save', 'ingestion-run', 'ingestion-status', 'ingestion-queue']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
  }
  assert.match(html, /api\('POST', '\/api\/ingestion\/run'/);
  assert.match(html, /data-open-note="\$\{esc\(r\.vault\)\}::\$\{esc\(item\.path\)\}"/, 'queue entries open their source note in the existing safe reader');
  for (const locale of ['en', 'zh-TW', 'pt']) {
    const catalog = JSON.parse(await readFile(new URL(`../ui/locales/${locale}.json`, import.meta.url), 'utf8'));
    for (const key of ['ingestion.title', 'ingestion.hint', 'ingestion.enabled', 'ingestion.vault', 'ingestion.folder', 'ingestion.time', 'ingestion.save', 'ingestion.run', 'ingestion.never', 'ingestion.running', 'ingestion.lastRun', 'ingestion.failed', 'ingestion.retryScheduled', 'ingestion.saved', 'ingestion.disabled', 'ingestion.scanDone', 'ingestion.empty', 'ingestion.limited', 'ingestion.trigger.manual', 'ingestion.trigger.schedule']) assert.ok(catalog[key], `${locale} ${key}`);
  }
});
