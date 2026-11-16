// Locale files (ui/locales/*.json): plain JSON, no i18n dependency. Every key BrainLink ships
// must exist in every supported locale, or a user who picks zh-TW or pt ends up with blank UI text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCALES } from '../src/config.mjs';
import { presetGrantActions, presetActionAllowed } from '../ui/permissions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = path.join(ROOT, 'ui', 'locales');

async function loadLocale(id) {
  return JSON.parse(await readFile(path.join(LOCALES_DIR, `${id}.json`), 'utf8'));
}

test('every supported locale ships a JSON file with the exact same keys as English', async () => {
  assert.deepEqual(LOCALES, ['en', 'zh-TW', 'pt']);
  const catalogs = Object.fromEntries(await Promise.all(LOCALES.map(async (id) => [id, await loadLocale(id)])));
  const enKeys = Object.keys(catalogs.en).sort();
  assert.ok(enKeys.length > 0, 'en.json should not be empty');
  for (const id of LOCALES) {
    if (id === 'en') continue;
    const keys = Object.keys(catalogs[id]).sort();
    assert.deepEqual(keys, enKeys, `${id}.json must have exactly the same keys as en.json`);
    for (const key of enKeys) {
      assert.equal(typeof catalogs[id][key], 'string', `${id}.json["${key}"] must be a string`);
      assert.notEqual(catalogs[id][key].trim(), '', `${id}.json["${key}"] must not be empty`);
    }
  }
});

test('Twin read-and-propose preset affects only chosen agents and vaults and does not save', async () => {
  const html = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  assert.match(html, /id="twin-read-propose-preset"/);
  const start = html.indexOf("$('twin-read-propose-preset').addEventListener");
  const end = html.indexOf("$('twin-create').onclick", start);
  assert.ok(start >= 0 && end > start, 'preset handler is present');
  const handler = html.slice(start, end);
  assert.match(handler, /\[data-twin-vault\]:checked/);
  assert.match(handler, /\[data-twin-agent\]:checked/);
  assert.match(handler, /access\.value = 'propose'/);
  assert.match(handler, /\['search', 'read_note', 'propose_note'\]/);
  assert.match(handler, /data-twin-memory="semantic"/);
  assert.doesNotMatch(handler, /api\(|\.click\(\)|connect/);
});

test('connection grant controls keep read, propose and write capabilities separate', async () => {
  const catalogs = Object.fromEntries(await Promise.all(LOCALES.map(async (id) => [id, await loadLocale(id)])));
  for (const id of LOCALES) {
    assert.ok(catalogs[id]['connect.readNote'], `${id} explains read access`);
    assert.ok(catalogs[id]['twinProfiles.operation.propose_note'], `${id} explains proposal access`);
    assert.ok(catalogs[id]['twinProfiles.operation.write_note'], `${id} explains write access`);
  }
  assert.deepEqual(presetGrantActions({ name: 'Shared', access: 'propose' }), ['search', 'read_note', 'read_session', 'propose_note']);
  assert.equal(presetActionAllowed({ action: 'write_note', access: 'propose', memoryPolicy: { semantic: true }, selectedMemory: { semantic: true } }), false);
  assert.equal(presetActionAllowed({ action: 'write_note', access: 'write', memoryPolicy: { semantic: true }, selectedMemory: { semantic: true } }), true);
});
test('replay-miss teaching offers a preview-before-save flow in every locale', async () => {
  const catalogs = Object.fromEntries(await Promise.all(LOCALES.map(async (id) => [id, await loadLocale(id)])));
  const keys = ['replay.teach', 'replay.teachHeading', 'replay.teachAnswer', 'replay.teachFolderHint', 'replay.teachPreview', 'replay.teachConfirm', 'replay.teachFound'];
  for (const id of LOCALES) for (const key of keys) assert.ok(catalogs[id][key], `${id} defines ${key}`);
  const html = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  assert.match(html, /data-teach-miss=/, 'each unanswered miss can open Teach it');
  assert.match(html, /POST', '\/api\/replay-misses\/teach'/, 'saving uses the reviewed local Setup endpoint');
  assert.match(html, /replay-teach-preview-button/);
  assert.match(html, /replay-teach-confirm/);
});

test('decision review actions are localized and show append/new-note previews before confirmation', async () => {
  const catalogs = Object.fromEntries(await Promise.all(LOCALES.map(async (id) => [id, await loadLocale(id)])));
  const keys = ['decisionReviews.title', 'decisionReviews.hint', 'decisionReviews.empty', 'decisionReviews.stands', 'decisionReviews.changed', 'decisionReviews.retire', 'decisionReviews.confirm'];
  for (const id of LOCALES) for (const key of keys) assert.ok(catalogs[id][key], `${id} defines ${key}`);
  const html = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  assert.match(html, /id="decision-reviews-panel"/);
  assert.match(html, /decision-reviews\/preview/);
  assert.match(html, /decision-reviews\/confirm/);
  assert.match(html, /data-decision-preview/);
});

test('conflict review is localized and queues supersession for owner approval', async () => {
  const catalogs = Object.fromEntries(await Promise.all(LOCALES.map(async (id) => [id, await loadLocale(id)])));
  const keys = ['conflicts.title', 'conflicts.hint', 'conflicts.aStands', 'conflicts.bStands', 'conflicts.both', 'conflicts.dismiss', 'conflicts.confirm', 'conflicts.loadMore'];
  for (const id of LOCALES) for (const key of keys) assert.ok(catalogs[id][key], `${id} defines ${key}`);
  const html = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  assert.match(html, /id="conflicts-panel"/);
  assert.match(html, /conflicts\/preview/);
  assert.match(html, /conflicts\/confirm/);
  assert.match(html, /data-conflicts-more/);
});

test('on-demand tidy review is localized and previews append-only changes before confirmation', async () => {
  const catalogs = Object.fromEntries(await Promise.all(LOCALES.map(async (id) => [id, await loadLocale(id)])));
  const keys = ['tidy.title', 'tidy.hint', 'tidy.generate', 'tidy.previewApply', 'tidy.previewDismiss', 'tidy.confirm', 'tidy.loadMore'];
  for (const id of LOCALES) for (const key of keys) assert.ok(catalogs[id][key], `${id} defines ${key}`);
  const html = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  assert.match(html, /id="tidy-panel"/);
  assert.match(html, /tidy\/apply-preview/);
  assert.match(html, /tidy\/apply-confirm/);
  assert.match(html, /tidy\/dismiss-preview/);
  assert.match(html, /data-tidy-select/);
});

test('connection wording distinguishes configured settings from an AI app that loaded them', async () => {
  const catalogs = Object.fromEntries(await Promise.all(LOCALES.map(async (id) => [id, await loadLocale(id)])));
  const en = catalogs.en;
  assert.equal(en['connect.connected'], 'Configured');
  assert.match(en['connect.hint'], /checks access locally/i);
  assert.match(en['connect.hint'], /fully quit.*start a new chat/i);
  assert.match(en['connect.hint'], /does not prove the app loaded the new tools/i);
  assert.match(en['connect.connectedToast'], /added to/);
  assert.match(en['connect.liveOk'], /BrainLink check passed/);
  assert.doesNotMatch(en['connect.hint'], /live test call/i);
  assert.equal(en['agents.statusConnected'], 'BrainLink reached');
  assert.equal(en['agents.statusNotConnected'], 'Not checked yet');
  assert.match(en['agents.testSucceeded'], /does not confirm an AI app loaded the connection/i);
  for (const [id, catalog] of Object.entries(catalogs)) {
    assert.match(catalog['connect.hint'], /BrainLink/i, `${id} explains the local BrainLink check`);
    assert.match(catalog['agents.statusConnected'], /BrainLink/i, `${id} describes BrainLink reachability`);
    assert.match(catalog['agents.testSucceeded'], /BrainLink/i, `${id} distinguishes BrainLink from client loading`);
  }
  const agentsUi = await readFile(path.join(ROOT, 'ui', 'agents.js'), 'utf8');
  assert.match(agentsUi, /const succeeded = \/\^BrainLink access check passed/);
});

test('setup UI: /locales/<id>.json serves each catalog, /api/locale persists the choice', async () => {
  const { startSetup } = await import('../src/setup.mjs');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const home = await mkdtemp(path.join(tmpdir(), 'brainlink-locale-'));
  const env = { BRAINLINK_HOME: path.join(home, 'app') };
  const s = await startSetup({ env, home, os: 'darwin', port: 0, useCli: false });
  const base = `http://127.0.0.1:${s.port}`;
  try {
    for (const id of LOCALES) {
      const r = await fetch(`${base}/locales/${id}.json`);
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.deepEqual(Object.keys(body).sort(), Object.keys(await loadLocale('en')).sort());
    }
    const bad = await fetch(`${base}/locales/fr.json`);
    assert.equal(bad.status, 404);
    const set = await (await fetch(`${base}/api/locale`, { method: 'POST', headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ locale: 'zh-TW' }) })).json();
    assert.equal(set.ok, true);
    assert.equal(set.locale, 'zh-TW');
    const state = await (await fetch(`${base}/api/state`, { headers: { 'X-BrainLink-Token': s.token } })).json();
    assert.equal(state.locale, 'zh-TW');
  } finally { s.server.close(); }
});
