import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCALES } from '../src/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('main navigation has five destinations, every section belongs to one, and labels exist in every locale', async () => {
  const page = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  const ids = new Set([...page.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const nav = page.match(/<nav id="main-nav"[\s\S]*?<\/nav>/)?.[0] || '';
  const links = [...nav.matchAll(/<a\b[^>]*href="#([^"]+)"[^>]*data-nav-group-link="([^"]+)"[^>]*data-i18n="([^"]+)"[^>]*>/g)];
  const groups = JSON.parse(page.match(/const NAV_GROUPS = (\{.*\});/)?.[1] || '{}');

  assert.deepEqual(links.map(([, , group]) => group), ['home', 'find', 'review', 'access', 'system'], 'five top-level destinations');
  assert.deepEqual(Object.keys(groups), ['home', 'find', 'review', 'access', 'system']);
  const assigned = Object.values(groups).flat();
  assert.equal(new Set(assigned).size, assigned.length, 'a section belongs to exactly one destination');
  for (const id of assigned) assert.ok(ids.has(id), `grouped section #${id} must exist`);
  for (const id of ['ready', 'ask-panel', 'brain-panel', 'memory-review-panel', 'proposal-review-panel', 'sessions-panel', 'handoffs-panel', 's-ingestion', 's-connect', 's-vault', 's-backup', 'rsi-panel', 'help-panel', 'twin-profiles-panel', 'agents-panel']) {
    assert.ok(assigned.includes(id), `#${id} must stay reachable from a destination`);
  }
  for (const id of ['start', 'first-run', 'sync-onboarding']) assert.ok(!assigned.includes(id), `onboarding screen #${id} is never filtered by a destination`);
  for (const [, target, group, key] of links) {
    assert.ok(groups[group].includes(target), `the ${group} link points at one of its own sections`);
    for (const locale of LOCALES) {
      const catalog = JSON.parse(await readFile(path.join(ROOT, 'ui', 'locales', `${locale}.json`), 'utf8'));
      assert.equal(typeof catalog[key], 'string', `${locale} must translate ${key}`);
      assert.notEqual(catalog[key].trim(), '', `${locale} translation for ${key} must not be empty`);
    }
  }
  assert.match(page, /if \(active\) document\.body\.dataset\.navGroup = navGroup; else delete document\.body\.dataset\.navGroup;/, 'destinations filter sections only while the navigation is visible');

  assert.match(page, /<nav id="main-nav"[^>]*hidden>/, 'navigation starts hidden during onboarding');
  assert.match(page, /\$\('main-nav'\)\.hidden = !hasVault \|\| onboardingSync \|\| guidedFirstRun;/, 'navigation appears after vault setup');
  assert.match(page, /if \(settings\) settings\.open = true;/, 'settings destinations open their collapsed settings container');
  for (const id of ['brain-panel', 'sessions-panel', 'handoffs-panel']) {
    assert.match(page, new RegExp(`<details class="card" id="${id}" hidden>`), `${id} starts collapsed`);
  }
  assert.match(page, /if \(target\.tagName === 'DETAILS'\) target\.open = true;/, 'navigation opens a collapsed destination');
  const graph = await readFile(path.join(ROOT, 'ui', 'notes3d.js'), 'utf8');
  assert.match(graph, /brainPanel\.addEventListener\('toggle', maybeLoad\)/, 'opening notes loads the map');
});
