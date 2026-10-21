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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('ui/index.html: no data-i18n element directly wraps a live form control', async () => {
  const html = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  const offenders = [...html.matchAll(/<(\w+)[^>]*\bdata-i18n="[^"]+"[^>]*>\s*<(select|input|textarea)\b/g)];
  assert.deepEqual(offenders.map((m) => `<${m[1]} data-i18n> wraps <${m[2]}>`), []);
});
