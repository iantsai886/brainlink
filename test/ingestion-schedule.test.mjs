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
  assert.throws(() => validateIngestionSchedule({ enabled: true, targets: [], time: '02:00' }), /Add at least one vault folder/i);
  assert.throws(() => validateIngestionSchedule({ enabled: true, targets: [{ vault: 'Team', folder: '../private' }], time: '02:00' }), /safe folder path/i);
  assert.throws(() => validateIngestionSchedule({ enabled: true, targets: [{ vault: 'Team', folder: 'Raw' }, { vault: 'team', folder: 'raw' }], time: '02:00' }), /only be added once/i);
  assert.throws(() => validateIngestionSchedule({ enabled: true, targets: Array.from({ length: 21 }, (_, i) => ({ vault: 'Team', folder: `Raw${i}` })), time: '02:00' }), /no more than 20/i);
  assert.throws(() => validateIngestionSchedule({ enabled: true, mode: 'watch', intervalMinutes: 2, targets: [{ vault: 'Team', folder: 'Raw' }] }), /supported background check interval/i);
  const watch = { enabled: true, mode: 'watch', intervalMinutes: 5, targets: [{ vault: 'Team', folder: 'Raw' }] };
  assert.equal(ingestionScheduleDue(watch, new Date('2026-10-25T12:30:00.000Z')), true, 'a new background check runs immediately');
  assert.equal(ingestionScheduleDue({ ...watch, last_scan_at: '2026-10-25T12:25:00.000Z' }, new Date('2026-10-25T12:29:59.999Z')), false);
  assert.equal(ingestionScheduleDue({ ...watch, last_scan_at: '2026-10-25T12:25:00.000Z' }, new Date('2026-10-25T12:30:00.000Z')), true);
  assert.equal(ingestionScheduleDue({ ...watch, last_scan_at: 'invalid' }, new Date('2026-10-25T12:40:00.000Z')), false, 'corrupt scan state fails closed');
  assert.equal(ingestionScheduleDue({ ...watch, retry_after: '2026-10-25T12:29:00.000Z' }, new Date('2026-10-25T12:30:00.000Z')), true, 'background retries are bounded by their saved retry time');
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
  assert.deepEqual(normalize({ ingestion: { vault: 'Legacy', folder: 'Raw' } }).ingestion.targets, [{ vault: 'Legacy', folder: 'Raw' }], 'old single-folder settings migrate to a one-item list');
});

test('background folder checks scan only selected folders and report their own trigger', async () => {
  const home = await temp('watch');
  const appHome = path.join(home, 'app');
  const vault = path.join(home, 'vault');
  await mkdir(path.join(vault, 'Raw'), { recursive: true });
  await mkdir(path.join(vault, 'Other'), { recursive: true });
  await writeFile(path.join(vault, 'Raw', 'First.md'), '# First\n\nA fictional selected-folder source.');
  await writeFile(path.join(vault, 'Other', 'Ignored.md'), '# Ignored\n\nThis folder is outside the selected target.');
  const env = { BRAINLINK_HOME: appHome, HOME: home, BRAINLINK_SEMANTIC: '0' };
  const oldScan = new Date(Date.now() - 10 * 60_000).toISOString();
  await saveConfig(normalize({ vaults: [{ name: 'Fictional Team', path: vault }], ingestion: { enabled: true, mode: 'watch', intervalMinutes: 1, last_scan_at: oldScan, targets: [{ vault: 'Fictional Team', folder: 'Raw' }] } }), path.join(appHome, 'config.json'));
  const app = await startSetup({ env, home, os: 'linux', port: 0, useCli: false, ingestionTickMs: 10 });
  const base = `http://127.0.0.1:${app.port}`;
  const headers = { 'X-BrainLink-Token': app.token };
  try {
    const deadline = Date.now() + 5000;
    let state;
    while (Date.now() < deadline) {
      state = await fetch(base + '/api/state', { headers }).then((r) => r.json());
      if (state.ingestion.status?.trigger === 'watch' && !state.ingestion.running) break;
      await delay(10);
    }
    assert.equal(state.ingestion.status?.trigger, 'watch');
    assert.equal(state.ingestion.status.queued_total, 1, 'only files under configured folders are scanned');
    const configPath = path.join(appHome, 'config.json');
    const cfg = JSON.parse(await readFile(configPath, 'utf8'));
    assert.ok(Date.parse(cfg.ingestion.last_scan_at) >= Date.now() - 5000, 'the next interval is measured from the completed scan reservation');
    assert.equal(state.ingestion.status.targets[0].folder, 'Raw');
  } finally { await new Promise((resolve) => app.server.close(resolve)); }
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
  // Keep the retry safely in the future, then advance the fixture's persisted retry timestamp.
  // This avoids a wall-clock race where a slow full-suite run can pass several short intervals
  // before the test gets a chance to observe the first failure.
  const app = await startSetup({ env, home, os: 'linux', port: 0, useCli: false, ingestionTickMs: 20, ingestionRetryMs: 60_000 });
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
    const retryConfigPath = path.join(appHome, 'config.json');
    const retryConfig = JSON.parse(await readFile(retryConfigPath, 'utf8'));
    retryConfig.ingestion.retry_after = new Date(Date.now() - 1_000).toISOString();
    await saveConfig(retryConfig, retryConfigPath);
    const retryDeadline = Date.now() + 10_000;
    while (Date.now() < retryDeadline) {
      await delay(25);
      state = await getState();
      const cfg = JSON.parse(await readFile(path.join(appHome, 'config.json'), 'utf8'));
      if (state.ingestion.status?.ok && state.ingestion.status.trigger === 'schedule' && cfg.ingestion.retry_after === null) break;
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
  const secondVault = path.join(home, 'second-vault');
  const privateVault = path.join(home, 'private-vault');
  await mkdir(path.join(vault, 'Raw'), { recursive: true });
  await writeFile(path.join(vault, 'Raw', 'Source.md'), '# Source\n\nFictional intake item.');
  await mkdir(path.join(secondVault, 'Incoming'), { recursive: true });
  await writeFile(path.join(secondVault, 'Incoming', 'Second.md'), '# Second\n\nAnother fictional intake item.');
  await mkdir(path.join(privateVault, 'Raw'), { recursive: true });
  const env = { BRAINLINK_HOME: appHome, HOME: home, BRAINLINK_SEMANTIC: '0' };
  const now = new Date();
  const local = localDateAndTime(now, 'UTC');
  const previousDate = new Date(`${local.date}T00:00:00.000Z`);
  previousDate.setUTCDate(previousDate.getUTCDate() - 1);
  // Simulate BrainLink being closed at today's scheduled time, then started later.
  // It should catch up once, while the existing last-run guard prevents a second scan.
  await saveConfig(normalize({ timezone: 'UTC', vaults: [{ name: 'Fictional Team', path: vault }, { name: 'Fictional Project', path: secondVault }, { name: 'Private Notes', path: privateVault, private: true }], ingestion: { enabled: true, last_scheduled_date: previousDate.toISOString().slice(0, 10), targets: [{ vault: 'Fictional Team', folder: 'Raw' }, { vault: 'Fictional Project', folder: 'Incoming' }], time: '00:00' } }), path.join(appHome, 'config.json'));
  const app = await startSetup({ env, home, os: 'linux', port: 0, useCli: false, ingestionTickMs: 20 });
  const base = `http://127.0.0.1:${app.port}`;
  const get = (route, token = app.token) => fetch(base + route, { headers: { 'X-BrainLink-Token': token } });
  const post = (route, body = {}, token = app.token) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': token }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/ingestion/folders', { vault: 'Fictional Team' }, 'wrong')).status, 401);
    const folderChoices = await post('/api/ingestion/folders', { vault: 'Fictional Team' });
    assert.equal(folderChoices.status, 200);
    assert.deepEqual((await folderChoices.json()).folders, ['Raw']);
    assert.notEqual((await post('/api/ingestion/folders', { vault: 'Private Notes' })).status, 200, 'private vault folders are never offered');
    assert.equal((await post('/api/ingestion/run', {}, 'wrong')).status, 401);
    assert.notEqual((await post('/api/ingestion/settings', { enabled: true, autoDrafts: true, targets: [{ vault: 'Fictional Team', folder: 'Raw' }], time: '00:00' })).status, 200, 'scheduled AI drafts require local model opt-in first');
    let status;
    for (let i = 0; i < 100; i++) {
      status = await get('/api/state').then((r) => r.json());
      if (status.ingestion.status?.trigger === 'schedule') break;
      await delay(20);
    }
    assert.equal(status.ingestion.status.trigger, 'schedule', `the background timer scans at the configured local time: ${JSON.stringify(status.ingestion)}`);
    assert.equal(status.ingestion.status.queued_total, 2);
    assert.equal(status.ingestion.status.targets.length, 2);
    for (let i = 0; i < 100 && status.ingestion.running; i++) { await delay(10); status = await get('/api/state').then((r) => r.json()); }
    assert.equal(status.ingestion.running, false, 'scheduled work finishes before the manual run starts');
    assert.equal((await readFile(path.join(appHome, 'ingestion-state.json'), 'utf8')).includes('Fictional intake item'), false, 'saved scan status contains no note body');
    const manual = await post('/api/ingestion/run', { vault: 'Fictional Team', folder: 'Raw' });
    assert.equal(manual.status, 200, await manual.clone().text());
    const manualResult = await manual.json();
    assert.equal(manualResult.trigger, 'manual');
    assert.equal(manualResult.queued_total, 1);
    assert.equal(manualResult.candidates[0].path, 'Raw/Source.md');
    const scanEvents = (await readFile(path.join(appHome, 'activity.log'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse).filter((entry) => entry.tool === 'source_scan');
    assert.ok(scanEvents.length >= 2, 'scheduled and manual scans are observed');
    assert.ok(scanEvents.every((entry) => typeof entry.ok === 'boolean' && !('vault' in entry) && !('folder' in entry) && !('path' in entry)));
    assert.doesNotMatch(JSON.stringify(scanEvents), /Fictional Team|Raw\/Source\.md/);
    const multi = await post('/api/ingestion/run', { targets: [{ vault: 'Fictional Team', folder: 'Raw' }, { vault: 'Fictional Project', folder: 'Incoming' }] });
    const multiResult = await multi.json();
    assert.equal(multiResult.queued_total, 2);
    assert.deepEqual(new Set(multiResult.candidates.map((item) => item.vault)), new Set(['Fictional Team', 'Fictional Project']));
    const unknownTarget = await post('/api/ingestion/settings', { enabled: true, targets: [{ vault: 'Fictional Team', folder: 'Raw' }, { vault: 'Missing Vault', folder: 'Raw' }], time: '00:00' });
    assert.notEqual(unknownTarget.status, 200, 'unknown vault targets are refused before saving');
    const privateTarget = await post('/api/ingestion/settings', { enabled: true, targets: [{ vault: 'Fictional Team', folder: 'Raw' }, { vault: 'Private Notes', folder: 'Raw' }], time: '00:00' });
    assert.notEqual(privateTarget.status, 200, 'private vault targets are refused before saving');
    await post('/api/vault/private', { name: 'Fictional Project', private: true });
    const privacyConfig = JSON.parse(await readFile(path.join(appHome, 'config.json'), 'utf8'));
    assert.deepEqual(privacyConfig.ingestion.targets, [{ vault: 'Fictional Team', folder: 'Raw' }], 'making one vault private removes only its scan target');
    assert.equal(privacyConfig.ingestion.enabled, true, 'other public scan targets keep their schedule');
    const saved = await post('/api/ingestion/settings', { enabled: false, vault: 'Fictional Team', folder: 'Raw', time: '00:00' });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).ingestion.enabled, false);
  } finally { app.server.close(); }
});

test('ingestion scan UI has manual, daily and repeated background controls in every locale', async () => {
  const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  for (const id of ['ingestion-enabled', 'ingestion-mode', 'ingestion-interval', 'ingestion-auto-drafts', 'ingestion-auto-file', 'ingestion-vault', 'ingestion-folder', 'ingestion-add', 'ingestion-target-list', 'ingestion-time', 'ingestion-save', 'ingestion-run', 'ingestion-status', 'ingestion-queue', 'ingestion-draft-status', 'ingestion-draft-list']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
  }
  assert.match(html, /<select id="ingestion-folder"><\/select>/, 'folder target is selected from existing directories, not typed as a path');
  assert.match(html, /api\('POST', '\/api\/ingestion\/folders', \{ vault \}\)/, 'folder options come from the authenticated vault-scoped endpoint');
  assert.match(html, /destinationOnly: true/, 'automatic filing destinations use the existing same-vault folder picker');
  assert.match(html, /mode: \$\('ingestion-mode'\)\.value/);
  assert.match(html, /intervalMinutes: Number\(\$\('ingestion-interval'\)\.value\)/);
  assert.match(html, /#ingestion-time-wrap\[hidden\], #ingestion-interval-wrap\[hidden\] \{ display: none; \}/, 'daily and repeated-scan controls hide the inactive input');
  assert.match(html, /api\('POST', '\/api\/ingestion\/run', \{ targets: currentIngestionTargets\(\) \}\)/);
  assert.match(html, /api\('POST', '\/api\/ingestion\/draft'/, 'the selected source can be summarized by the local draft route');
  assert.match(html, /api\('POST', '\/api\/ingestion\/save-draft'.*confirm: true/, 'saving requires a separate confirmation action');
  assert.match(html, /api\('GET', '\/api\/ingestion\/drafts'\)/, 'local drafts reload from private app data');
  assert.match(html, /api\('POST', '\/api\/ingestion\/discard-draft'/, 'stale or unwanted local drafts can be removed');
  assert.match(html, /autoDrafts: \$\('ingestion-auto-drafts'\)\.checked/, 'scheduled local draft processing is a separate opt-in');
  assert.match(html, /autoFile: \$\('ingestion-auto-file'\)\.checked/, 'saving proposed notes is a separate opt-in');
  assert.match(html, /window\.confirm\(t\(saveDraft\.dataset\.ingestionRetry === 'true' \? 'ingestion\.confirmRetryProposal' : 'ingestion\.confirmSaveProposal'\)\)/);
  assert.match(html, /data-ingestion-retry=.*ingestion\.retryProposal/, 'a partial filing shows a retry action and its saved destination');
  assert.match(html, /ingestion\.confirmRetryProposal/, 'retry asks for confirmation using a clear retry message');
  assert.match(html, /ingestion\.partialFiling/, 'the local draft view explains when a main note was saved but suggestions remain');
  assert.match(html, /data-open-note="\$\{esc\(item\.vault \|\| r\.vault\)\}::\$\{esc\(item\.path\)\}"/, 'queue entries open each source note in its own vault');
  assert.match(html, /document\.addEventListener\('click', async \(event\) => \{\s*const removeIngestionTarget/);
  assert.match(html, /currentIngestionTargets\(\)\.push\(target\)/);
  for (const locale of ['en', 'zh-TW', 'pt']) {
    const catalog = JSON.parse(await readFile(new URL(`../ui/locales/${locale}.json`, import.meta.url), 'utf8'));
    for (const key of ['ingestion.title', 'ingestion.hint', 'ingestion.enabled', 'ingestion.mode', 'ingestion.modeDaily', 'ingestion.modeWatch', 'ingestion.interval', 'ingestion.autoDrafts', 'ingestion.autoDraftsHint', 'ingestion.autoFile', 'ingestion.autoFileHint', 'ingestion.scanFiled', 'ingestion.pendingDrafts', 'ingestion.noPendingDrafts', 'ingestion.localDraftReady', 'ingestion.autoDraftStatus', 'ingestion.vault', 'ingestion.folder', 'ingestion.chooseFolder', 'ingestion.addTarget', 'ingestion.targets', 'ingestion.removeTarget', 'ingestion.emptyTargets', 'ingestion.targetRequired', 'ingestion.maxTargets', 'ingestion.duplicateTarget', 'ingestion.time', 'ingestion.save', 'ingestion.run', 'ingestion.never', 'ingestion.running', 'ingestion.lastRun', 'ingestion.failed', 'ingestion.retryScheduled', 'ingestion.saved', 'ingestion.disabled', 'ingestion.scanDone', 'ingestion.empty', 'ingestion.limited', 'ingestion.trigger.manual', 'ingestion.trigger.schedule', 'ingestion.trigger.watch', 'ingestion.makeLocalDraft', 'ingestion.localDraftNeedsModel', 'ingestion.localDraftUnverified', 'ingestion.memoryType', 'ingestion.reviewDraft', 'ingestion.destination', 'ingestion.chooseDestination', 'ingestion.noDestination', 'ingestion.saveProposal', 'ingestion.retryProposal', 'ingestion.partialFiling', 'ingestion.discardDraft', 'ingestion.confirmDiscardDraft', 'ingestion.confirmSaveProposal', 'ingestion.confirmRetryProposal', 'ingestion.proposalSaved', 'ingestion.proposalUnverified', 'ingestion.proposalNeedsReview']) assert.ok(catalog[key], `${locale} ${key}`);
    assert.match(catalog['ingestion.hint'], /HTML\/HTM/iu, `${locale} describes supported HTML files`);
    assert.doesNotMatch(catalog['ingestion.hint'], /scanned PDFs? (and )?other formats (are )?(skipped|ignored)/iu, `${locale} does not claim scanned PDFs are skipped`);
    if (locale === 'en') assert.match(catalog['ingestion.hint'], /PDFs up to 100 pages.*scanned pages with local OCR/iu);
  }
});
