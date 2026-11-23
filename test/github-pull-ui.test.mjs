import test from 'node:test';
import { readSetupHtml } from './helpers/setup-html.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('GitHub pull UI keeps updates opt-in and conflicts separate', async () => {
  const html = await readSetupHtml();
  assert.match(html, /n\.action === 'add' \? 'checked' : ''/);
  assert.match(html, /\['add', 'update', 'conflict'\]\.includes\(n\.action\)/);
  assert.match(html, /githubPullSelection\('add,update'\)/);
  assert.match(html, /githubPullSelection\('conflict'\)/);
  assert.match(html, /r\.updated \|\| \[\]/);
});

test('GitHub update confirmation explains the safety rule in every shipped locale', async () => {
  for (const locale of ['en', 'pt', 'zh-TW']) {
    const catalog = JSON.parse(await readFile(path.join(root, 'ui', 'locales', `${locale}.json`), 'utf8'));
    assert.ok(catalog['github.confirmImport'].includes('{paths}'), `${locale}: path review is missing`);
    const confirmation = catalog['github.confirmImport'].toLowerCase();
    const localCopy = locale === 'zh-TW' ? '本機副本' : locale === 'pt' ? 'cópias locais' : 'local copies';
    assert.ok(confirmation.includes(localCopy), `${locale}: local update boundary is missing`);
    assert.ok(catalog['github.pullAction.update'], `${locale}: update action label is missing`);
    assert.ok(catalog['github.pullAction.conflict'], `${locale}: conflict action label is missing`);
  }
});
