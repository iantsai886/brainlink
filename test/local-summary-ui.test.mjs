import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');

test('local summary UI explains opt-in, local processing, and review requirements', () => {
  assert.match(html, /id="sess-local-summary-enabled"/);
  assert.match(html, /id="sess-local-summary-auto"/);
  assert.match(html, /id="sess-local-summary-model"/);
  assert.match(html, /id="sess-local-summary-find"/);
  assert.match(html, /POST', '\/api\/sessions\/local-summary\/models'/);
  assert.match(html, /sess-local-summary-model-options/);
  assert.match(html, /sessions\.localSummaryHint/);
  assert.match(html, /sessions\.localSummaryEnable/);
  assert.match(html, /sessions\.localSummaryAuto/);
  assert.match(html, /sessions\.localSummaryDraftReady/);
  assert.match(html, /sessions\.localSummaryDraftFailed/);
  assert.match(html, /autoDraftOnEnd: \$\('sess-local-summary-enabled'\)\.checked && \$\('sess-local-summary-auto'\)\.checked/);
  assert.match(html, /sessions_local_summary\?\.enabled \? `<button[^`]*data-sess-summarize/s);
});

test('automatic local-summary wording explains the Harness idle guess in every shipped language', async () => {
  for (const locale of ['en', 'zh-TW', 'pt']) {
    const catalog = JSON.parse(await readFile(new URL(`../ui/locales/${locale}.json`, import.meta.url), 'utf8'));
    assert.match(catalog['sessions.localSummaryAuto'], /30/);
    assert.match(catalog['sessions.localSummaryAuto'], /Harness/i);
    for (const key of ['sessions.localSummaryFind', 'sessions.localSummaryFound', 'sessions.localSummaryNone', 'sessions.localSummaryUnavailable']) {
      assert.equal(typeof catalog[key], 'string', `${locale} must define ${key}`);
    }
  }
});

test('local summary UI uses the reviewed private draft for both preview and explicit save', () => {
  assert.match(html, /useLocalDraft: fileLocalDraftIds\.has\(id\)/);
  assert.match(html, /useLocalDraft: fileLocalDraftIds\.has\(d\.fileConfirm\)/);
  assert.match(html, /if \(d\.fileConfirm\) act\(async \(\) =>/);
  assert.match(html, /sessions\.localSummaryReady/);
  assert.match(html, /data-file-confirm="\$\{esc\(id\)\}" hidden/);
  assert.match(html, /session-file-preview/);
});

test('the app never starts summary generation automatically while loading end-of-session cues', () => {
  const cuesLoader = html.match(/async function loadSessionEndCues\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.doesNotMatch(cuesLoader, /local-summary\/generate/);
  assert.match(html, /if \(d\.sessSummarize\) act\(async \(\) =>/);
});
