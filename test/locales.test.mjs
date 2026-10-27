// Locale files (ui/locales/*.json): plain JSON, no i18n dependency. Every key BrainLink ships
// must exist in every supported locale, or a user who picks zh-TW or pt ends up with blank UI text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCALES } from '../src/config.mjs';

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

test('connection wording distinguishes configured settings from an AI app that loaded them', async () => {
  const catalogs = Object.fromEntries(await Promise.all(LOCALES.map(async (id) => [id, await loadLocale(id)])));
  const en = catalogs.en;
  assert.equal(en['connect.connected'], 'Configured');
  assert.match(en['connect.hint'], /checks the selected permissions locally/i);
  assert.match(en['connect.hint'], /test BrainLink from inside that app/i);
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
