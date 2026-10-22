// Regression test for a real first-load crash: applyI18n() (ui/index.html) does
// `el.innerHTML = translatedText` for every element carrying data-i18n. If that element also
// wraps a live form control (<select>/<input>/<textarea>), the control is wiped out of the DOM
// the moment the page applies translations -- before any code gets a chance to read or fill it.
// That turned "Local only -> Continue" into a dead end (`$('sync-provider')` / `$('sync-onb-device')`
// returned null) and crashed first load with "Cannot set properties of null (setting 'innerHTML')".
// The fix is the pattern already used elsewhere in this file: data-i18n on its own <span>, sibling
// to the control, never wrapping it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCALES } from '../src/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = path.join(ROOT, 'ui', 'locales');

test('ui/index.html: no data-i18n element directly wraps a live form control', async () => {
  const html = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  const offenders = [...html.matchAll(/<(\w+)[^>]*\bdata-i18n="[^"]+"[^>]*>\s*<(select|input|textarea)\b/g)];
  assert.deepEqual(offenders.map((m) => `<${m[1]} data-i18n> wraps <${m[2]}>`), []);
});

// A2: the folder picker's fallback (used when the OS has no GUI folder dialog available) must be
// a real, labelled form -- never window.prompt(), a jargon-y browser dialog with no room for
// plain-language instructions.
test('ui/index.html and ui/share.js: the folder-picker fallback never uses window.prompt', async () => {
  const html = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  const shareJs = await readFile(path.join(ROOT, 'ui', 'share.js'), 'utf8');
  assert.doesNotMatch(html, /\bwindow\.prompt\(/);
  assert.doesNotMatch(shareJs, /\bwindow\.prompt\?\.\(/);
  assert.match(html, /id="folder-fallback-modal"/);
  assert.match(html, /window\.promptForFolder\s*=/);
});

// After a vault is picked/created, index.html's load() must tell other self-contained panels
// (agents.js, share.js) right away, so they stop saying "Add a vault first" without needing a
// manual reload.
test('ui/index.html dispatches brainlink:state-updated; agents.js and share.js listen for it', async () => {
  const html = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  const agentsJs = await readFile(path.join(ROOT, 'ui', 'agents.js'), 'utf8');
  const shareJs = await readFile(path.join(ROOT, 'ui', 'share.js'), 'utf8');
  assert.match(html, /dispatchEvent\(new CustomEvent\(['"]brainlink:state-updated['"]/);
  assert.match(agentsJs, /addEventListener\(['"]brainlink:state-updated['"]/);
  assert.match(shareJs, /addEventListener\(['"]brainlink:state-updated['"]/);
});

// The Agents card (ui/agents.js) and the "Share with cloud agents" card (ui/share.js) are
// self-contained scripts that look up every string through the page's global t()/data-i18n
// (ui/index.html), not hard-coded English — see RB7/RB8. This scans their actual t(...) calls
// (plus the agents./share./sync.provider. data-i18n attributes in index.html) and checks every
// key they use exists, as a non-empty string, in every shipped locale: a key referenced here but
// missing from a catalog would silently fall back to raw English (or the key itself) for that
// language instead of erroring, so it would never be caught just by using the app once in English.
test('every en key actually used by the Agents / Share cards (and sync provider labels) exists, non-empty, in every locale', async () => {
  const html = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  const agentsJs = await readFile(path.join(ROOT, 'ui', 'agents.js'), 'utf8');
  const shareJs = await readFile(path.join(ROOT, 'ui', 'share.js'), 'utf8');

  const keys = new Set();
  const scanCalls = (src) => { for (const m of src.matchAll(/\bt\(\s*['"]([a-zA-Z0-9_.]+)['"]/g)) keys.add(m[1]); };
  scanCalls(agentsJs);
  scanCalls(shareJs);
  for (const m of html.matchAll(/data-i18n(?:-placeholder)?="(agents\.[a-zA-Z0-9_.]+|share\.[a-zA-Z0-9_.]+)"/g)) keys.add(m[1]);
  // The provider <select> options are built as t('sync.provider.' + p) for p in PROVIDERS
  // (src/sync/settings.mjs), not a literal key t() can be grepped for.
  if (/t\(\s*['"]sync\.provider\.['"]\s*\+\s*\w+\)/.test(html)) {
    for (const p of ['local', 'gdrive', 'icloud', 'dropbox']) keys.add(`sync.provider.${p}`);
  }
  assert.ok(keys.size > 30, `sanity check: expected many keys scanned, got ${keys.size}`);

  const catalogs = Object.fromEntries(await Promise.all(LOCALES.map(async (id) => [id, JSON.parse(await readFile(path.join(LOCALES_DIR, `${id}.json`), 'utf8'))])));
  for (const id of LOCALES) {
    for (const key of keys) {
      assert.ok(key in catalogs[id], `${id}.json is missing "${key}", used by the Agents/Share cards`);
      assert.equal(typeof catalogs[id][key], 'string', `${id}.json["${key}"] must be a string`);
      assert.notEqual(catalogs[id][key].trim(), '', `${id}.json["${key}"] must not be empty`);
    }
  }
});
