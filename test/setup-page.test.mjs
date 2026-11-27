import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOT } from '../src/runtime.mjs';
import { renderSetupPage } from '../src/setup-page.mjs';

test('Setup assembles destination panels without leaving include markers', async () => {
  const html = await renderSetupPage(ROOT);
  assert.doesNotMatch(html, /<!-- brainlink-include:/);
  for (const id of [
    'ask-panel', 'brain-panel', 'memory-review-panel', 'proposal-review-panel',
    'decision-reviews-panel', 'conflicts-panel', 'tidy-panel', 'sessions-panel',
    'handoffs-panel', 's-ingestion',
  ]) assert.match(html, new RegExp(`id=["']${id}["']`), `${id} is present in the assembled Setup page`);
});

test('Setup loads ES-module permissions.js with type="module" and consistent access-profile wording', async () => {
  const html = await renderSetupPage(ROOT);
  assert.match(html, /<script\s+type="module"\s+src="permissions\.js"><\/script>/);
  assert.doesNotMatch(html, /<script\s+src="permissions\.js"><\/script>/);
  assert.doesNotMatch(html, /Select every Twin this AI app should access/);
});
