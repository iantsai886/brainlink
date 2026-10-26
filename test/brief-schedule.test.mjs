import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startSetup } from '../src/setup.mjs';
import { normalize, saveConfig } from '../src/config.mjs';
import { briefScheduleDue, validateBriefSchedule } from '../src/brief-schedule.mjs';
import { localDateAndTime } from '../src/ingestion-schedule.mjs';

const temp = (name) => mkdtemp(path.join(tmpdir(), `brainlink-brief-${name}-`));

test('daily brief schedule validates a public vault and follows the selected local time', () => {
  assert.throws(() => validateBriefSchedule({ enabled: true, vault: '', time: '08:00' }), /Choose one public vault/);
  assert.throws(() => validateBriefSchedule({ enabled: false, vault: 'Team', time: '29:00' }), /valid daily brief time/);
  assert.deepEqual(validateBriefSchedule({ enabled: true, vault: 'Team', time: '08:15' }), { enabled: true, vault: 'Team', time: '08:15', last_scheduled_date: null });
  const at = new Date('2026-10-25T12:30:00.000Z');
  assert.equal(localDateAndTime(at, 'UTC').time, '12:30');
  assert.equal(briefScheduleDue({ enabled: true, vault: 'Team', time: '12:00' }, at, 'UTC'), true);
  assert.equal(briefScheduleDue({ enabled: true, vault: 'Team', time: '13:00' }, at, 'UTC'), false);
  assert.equal(briefScheduleDue({ enabled: true, vault: 'Team', time: '00:00', last_scheduled_date: '2026-10-25' }, at, 'UTC'), false);
  assert.equal(briefScheduleDue({ enabled: false, vault: 'Team', time: '00:00' }, at, 'UTC'), false);
});

test('Setup schedules and manually runs private-local briefs from one public vault only', async () => {
  const home = await temp('api');
  const appHome = path.join(home, 'app');
  const publicVault = path.join(home, 'public-vault');
  const privateVault = path.join(home, 'private-vault');
  await mkdir(publicVault, { recursive: true });
  await mkdir(privateVault, { recursive: true });
  await writeFile(path.join(publicVault, 'Project.md'), '# Project\n\nA public project note.');
  await writeFile(path.join(publicVault, 'Tasks.md'), '# Tasks\n\n- [ ] Finish public project\n');
  await writeFile(path.join(publicVault, 'Private.md'), '---\nprivate: true\n---\n# Private\n\nPRIVATE_BRIEF_CANARY_6184');
  await writeFile(path.join(privateVault, 'Secret.md'), '# Secret\n\nPRIVATE_VAULT_BRIEF_CANARY_1139');
  const before = await readdir(publicVault);
  const env = { BRAINLINK_HOME: appHome, HOME: home, BRAINLINK_SEMANTIC: '0' };
  await saveConfig(normalize({ timezone: 'UTC', vaults: [
    { name: 'Fictional Public', path: publicVault }, { name: 'Fictional Private', path: privateVault, private: true },
  ], brief: { enabled: true, vault: 'Fictional Public', time: '00:00' } }), path.join(appHome, 'config.json'));
  const app = await startSetup({ env, home, os: 'linux', port: 0, useCli: false, briefTickMs: 20 });
  const base = `http://127.0.0.1:${app.port}`;
  const get = (route, token = app.token) => fetch(base + route, { headers: { 'X-BrainLink-Token': token } });
  const post = (route, body = {}, token = app.token) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': token }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/brief/run', {}, 'wrong')).status, 401);
    let status;
    for (let i = 0; i < 100; i++) {
      status = await get('/api/state').then((r) => r.json());
      if (status.brief.status?.trigger === 'schedule') break;
      await delay(20);
    }
    assert.equal(status.brief.status.trigger, 'schedule', `background brief runs at the configured local time: ${JSON.stringify(status.brief)}`);
    assert.ok(status.brief.status.result.open_loops.tasks.some((item) => item.task === 'Finish public project'));
    assert.doesNotMatch(JSON.stringify(status.brief.status), /PRIVATE_BRIEF_CANARY_6184|PRIVATE_VAULT_BRIEF_CANARY_1139/);
    assert.doesNotMatch(await readFile(path.join(appHome, 'brief-state.json'), 'utf8'), /PRIVATE_BRIEF_CANARY_6184|PRIVATE_VAULT_BRIEF_CANARY_1139/);
    const manual = await post('/api/brief/run', { vault: 'Fictional Public' });
    assert.equal(manual.status, 200, await manual.clone().text());
    assert.equal((await manual.json()).trigger, 'manual');
    const rejected = await post('/api/brief/settings', { enabled: true, vault: 'Fictional Private', time: '08:00' });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /public vault/);
    assert.deepEqual((await readdir(publicVault)).sort(), before.sort(), 'brief generation is read-only and does not create notes');
    const saved = await post('/api/brief/settings', { enabled: false, vault: 'Fictional Public', time: '00:00' });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).brief.enabled, false);
  } finally { app.server.close(); }
});

test('daily brief UI has manual and scheduled controls with translations in every locale', async () => {
  const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  for (const id of ['brief-enabled', 'brief-vault', 'brief-time', 'brief-save', 'brief-run', 'brief-status', 'brief-output']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
  }
  assert.match(html, /api\('POST', '\/api\/brief\/run'/);
  assert.match(html, /map\(\(item\) => `<li>\$\{esc\(/, 'brief content is escaped before rendering');
  for (const locale of ['en', 'zh-TW', 'pt']) {
    const catalog = JSON.parse(await readFile(new URL(`../ui/locales/${locale}.json`, import.meta.url), 'utf8'));
    for (const key of ['brief.title', 'brief.hint', 'brief.enabled', 'brief.vault', 'brief.chooseVault', 'brief.time', 'brief.save', 'brief.run', 'brief.never', 'brief.running', 'brief.lastRun', 'brief.failed', 'brief.saved', 'brief.disabled', 'brief.done', 'brief.health', 'brief.healthCounts', 'brief.changed', 'brief.tasks', 'brief.next', 'brief.decisions', 'brief.questions', 'brief.trigger.manual', 'brief.trigger.schedule']) assert.ok(catalog[key], `${locale} ${key}`);
  }
});
