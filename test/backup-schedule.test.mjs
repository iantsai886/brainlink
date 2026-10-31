import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { backupScheduleDue, normalizeBackupSchedule } from '../src/backup-schedule.mjs';
import { localDateAndTime } from '../src/ingestion-schedule.mjs';
import { normalize, saveConfig } from '../src/config.mjs';
import { startSetup } from '../src/setup.mjs';

const temp = (name) => mkdtemp(path.join(tmpdir(), `brainlink-backup-schedule-${name}-`));

test('backup schedule keeps interval compatibility and validates daily local time', () => {
  assert.deepEqual(normalizeBackupSchedule({ intervalHours: 24 }), {
    scheduleMode: 'interval', intervalHours: 24, time: '02:00', last_scheduled_date: null,
  });
  assert.deepEqual(normalizeBackupSchedule({ scheduleMode: 'daily', time: '23:59' }), {
    scheduleMode: 'daily', intervalHours: 24, time: '23:59', last_scheduled_date: null,
  });
  assert.throws(() => normalizeBackupSchedule({ scheduleMode: 'weekly' }), /interval or daily/i);
  assert.throws(() => normalizeBackupSchedule({ scheduleMode: 'daily', time: '24:00' }), /valid daily backup time/i);
  assert.throws(() => normalizeBackupSchedule({ last_scheduled_date: 'yesterday' }), /date is invalid/i);
  assert.throws(() => normalizeBackupSchedule({ last_scheduled_date: '2026-99-99' }), /date is invalid/i);
});

test('daily backup becomes due at the chosen local time once per local day', () => {
  const schedule = { enabled: true, scheduleMode: 'daily', time: '08:00', last_scheduled_date: null };
  const at = new Date('2026-07-20T12:15:00.000Z'); // 08:15 in New York during daylight saving time
  assert.equal(backupScheduleDue(schedule, at, 'America/New_York'), true);
  assert.equal(backupScheduleDue({ ...schedule, time: '08:30' }, at, 'America/New_York'), false);
  assert.equal(backupScheduleDue({ ...schedule, last_scheduled_date: '2026-07-20' }, at, 'America/New_York'), false);
  assert.equal(backupScheduleDue({ ...schedule, enabled: false }, at, 'America/New_York'), false);
  assert.deepEqual(localDateAndTime(at, 'America/New_York'), { date: '2026-07-20', time: '08:15' });
});

test('daily scheduled backups run in the background once per day at configured local time', async () => {
  const home = await temp('daily');
  const appHome = path.join(home, 'app');
  const vault = path.join(home, 'vault');
  const destination = path.join(home, 'destination');
  await mkdir(vault, { recursive: true });
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(vault, 'Project.md'), 'Fictional backup fixture.');
  const today = localDateAndTime(new Date(), 'UTC').date;
  const priorDate = new Date(`${today}T00:00:00.000Z`);
  priorDate.setUTCDate(priorDate.getUTCDate() - 1);
  const yesterday = priorDate.toISOString().slice(0, 10);
  const env = { BRAINLINK_HOME: appHome, HOME: home, BRAINLINK_SEMANTIC: '0' };
  await saveConfig(normalize({
    timezone: 'UTC', vaults: [{ name: 'Fictional Project', path: vault }],
    backup: { enabled: true, folder: destination, scheduleMode: 'daily', time: '00:00', last_scheduled_date: yesterday },
  }), path.join(appHome, 'config.json'));
  const app = await startSetup({ env, home, os: 'linux', port: 0, useCli: false, backupTickMs: 15, idleMinutes: 0.01 });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    let state;
    for (let i = 0; i < 150; i++) {
      state = await fetch(base + '/api/state', { headers: { 'X-BrainLink-Token': app.token } }).then((r) => r.json());
      if (state.backup?.status?.trigger === 'schedule' && state.backup.status.ok && state.backup.last_scheduled_date === today) break;
      await delay(20);
    }
    assert.equal(state.backup.status.trigger, 'schedule', 'the app runs the due backup without a button click');
    assert.equal(state.backup.last_scheduled_date, today, 'the completed local date is saved to prevent duplicate daily runs');
    assert.equal((await readdir(destination)).length, 1);
    await delay(80);
    assert.equal((await readdir(destination)).length, 1, 'the frequent due-check does not repeat a completed daily backup');
  } finally { app.server.close(); }
});

test('a failed daily backup retries after a short backoff and marks the day only after success', async () => {
  const home = await temp('retry');
  const appHome = path.join(home, 'app');
  const vault = path.join(home, 'vault');
  const destination = path.join(home, 'destination');
  await mkdir(vault, { recursive: true });
  await writeFile(path.join(vault, 'Project.md'), 'Fictional retry fixture.');
  const today = localDateAndTime(new Date(), 'UTC').date;
  const prior = new Date(`${today}T00:00:00.000Z`);
  prior.setUTCDate(prior.getUTCDate() - 1);
  const env = { BRAINLINK_HOME: appHome, HOME: home, BRAINLINK_SEMANTIC: '0' };
  await saveConfig(normalize({
    timezone: 'UTC', vaults: [{ name: 'Fictional Project', path: vault }],
    backup: { enabled: true, folder: destination, scheduleMode: 'daily', time: '00:00', last_scheduled_date: prior.toISOString().slice(0, 10) },
  }), path.join(appHome, 'config.json'));
  const app = await startSetup({ env, home, os: 'linux', port: 0, useCli: false, backupTickMs: 10, backupRetryMs: 50, idleMinutes: 0.01 });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const getState = () => fetch(base + '/api/state', { headers: { 'X-BrainLink-Token': app.token } }).then((r) => r.json());
    let state;
    for (let i = 0; i < 100; i++) {
      state = await getState();
      if (state.backup?.status?.trigger === 'schedule' && !state.backup.status.ok) break;
      await delay(15);
    }
    assert.equal(state.backup.status.ok, false, 'the missing destination is reported as a failed scheduled attempt');
    assert.notEqual(state.backup.last_scheduled_date, today, 'a failure does not consume today\'s scheduled backup');
    await mkdir(destination, { recursive: true });
    for (let i = 0; i < 150; i++) {
      state = await getState();
      if (state.backup?.status?.trigger === 'schedule' && state.backup.status.ok && state.backup.last_scheduled_date === today) break;
      await delay(15);
    }
    assert.equal(state.backup.status.ok, true, 'the backup retries after the configured backoff');
    assert.equal(state.backup.last_scheduled_date, today);
    assert.equal((await readdir(destination)).length, 1);
  } finally { app.server.close(); }
});
