import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCALES } from '../src/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('main navigation links to visible product sections and has labels in every locale', async () => {
  const page = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  const ids = new Set([...page.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const nav = page.match(/<nav id="main-nav"[\s\S]*?<\/nav>/)?.[0] || '';
  const links = [...nav.matchAll(/<a\b[^>]*data-main-nav="([^"]+)"[^>]*data-i18n="([^"]+)"[^>]*>/g)];

  assert.equal(links.length, 10, 'expected the ten top-level destinations');
  assert.ok(links.some(([, target, key]) => target === 'memory-review-panel' && key === 'memoryReview.title'), 'memory review should be directly reachable');
  assert.ok(links.some(([, target, key]) => target === 'proposal-review-panel' && key === 'proposals.title'), 'owner proposal review should be directly reachable');
  assert.ok(links.some(([, target, key]) => target === 's-ingestion' && key === 'nav.sources'), 'source scanning should be directly reachable');
  for (const [, target, key] of links) {
    assert.ok(ids.has(target), `navigation target #${target} must exist`);
    for (const locale of LOCALES) {
      const catalog = JSON.parse(await readFile(path.join(ROOT, 'ui', 'locales', `${locale}.json`), 'utf8'));
      assert.equal(typeof catalog[key], 'string', `${locale} must translate ${key}`);
      assert.notEqual(catalog[key].trim(), '', `${locale} translation for ${key} must not be empty`);
    }
  }

  assert.match(page, /<nav id="main-nav"[^>]*hidden>/, 'navigation starts hidden during onboarding');
  assert.match(page, /\$\('main-nav'\)\.hidden = !hasVault \|\| onboardingSync;/, 'navigation appears after vault setup');
  assert.match(page, /if \(settings\) settings\.open = true;/, 'settings destinations open their collapsed settings container');
  for (const id of ['brain-panel', 'sessions-panel', 'handoffs-panel']) {
    assert.match(page, new RegExp(`<details class="card" id="${id}" hidden>`), `${id} starts collapsed`);
  }
  assert.match(page, /if \(target\.tagName === 'DETAILS'\) target\.open = true;/, 'navigation opens a collapsed destination');
  const graph = await readFile(path.join(ROOT, 'ui', 'notes3d.js'), 'utf8');
  assert.match(graph, /brainPanel\.addEventListener\('toggle', maybeLoad\)/, 'opening notes loads the map');
});
