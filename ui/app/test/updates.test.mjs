import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('Settings update check gives plain messages and keeps a retry after download failure', async () => {
  const html = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  const locales = await Promise.all(['en', 'pt', 'zh-TW'].map((locale) => readFile(path.join(ROOT, 'ui', 'locales', `${locale}.json`), 'utf8').then(JSON.parse)));
  const checkFlow = html.slice(html.indexOf("getElementById('updates-check')"), html.indexOf("function toast"));
  assert.match(html, /id="updates-check"/);
  assert.match(checkFlow, /api\('GET', '\/api\/updates\/check'\)/);
  assert.match(checkFlow, /api\('POST', '\/api\/updates\/download'/);
  assert.match(checkFlow, /updates\.downloadFailed/);
  assert.match(checkFlow, /updates\.retryDownload/);
  assert.match(checkFlow, /retry\.dataset\.updatePrepare = '1'/);
  assert.doesNotMatch(checkFlow, /error\.message/);
  for (const locale of locales) {
    assert.equal(typeof locale['updates.downloadFailed'], 'string');
    assert.equal(typeof locale['updates.retryDownload'], 'string');
    assert.equal(typeof locale['updates.preparing'], 'string');
  }
});
