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
  const links = [...page.matchAll(/<a\b[^>]*data-main-nav="([^"]+)"[^>]*data-i18n="([^"]+)"[^>]*>/g)];

  assert.equal(links.length, 7, 'expected the seven top-level destinations');
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
});
