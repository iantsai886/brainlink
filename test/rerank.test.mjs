import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, search } from '../src/core.mjs';
import { normalize } from '../src/config.mjs';
import { rerankResults, testReranker, validateRerankerSettings } from '../src/rerank.mjs';

const enabled = { enabled: true, url: 'http://127.0.0.1:8080/rerank' };

test('reranker accepts only supported loopback HTTP endpoints', () => {
  assert.deepEqual(validateRerankerSettings(enabled), enabled);
  for (const url of [
    'https://127.0.0.1:8080/rerank', 'http://example.com/rerank',
    'http://user:pass@127.0.0.1/rerank', 'http://127.0.0.1/rerank?x=1',
    'http://127.0.0.1/admin',
  ]) assert.throws(() => validateRerankerSettings({ enabled: true, url }));
  assert.throws(() => validateRerankerSettings({ ...enabled, token: 'secret' }), /Unknown/);
});

test('reranker sends bounded text and follows returned order while keeping exact links first', async () => {
  let sent;
  const results = [
    { path: 'linked.md', title: 'Linked note', match: 'mention', snippet: 'exact user reference' },
    ...Array.from({ length: 24 }, (_, i) => ({ path: `${i}.md`, title: `Note ${i}`, heading: 'Facts', snippet: `text ${i}` })),
  ];
  const ordered = await rerankResults(enabled, 'find it', results, {
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return { ok: true, json: async () => ({ results: sent.documents.map((_doc, index) => ({ index, relevance_score: 20 - index })) }) };
    },
  });
  assert.equal(sent.documents.length, 20);
  assert.deepEqual(Object.keys(sent), ['query', 'documents', 'top_n']);
  assert.equal(ordered[0].path, 'linked.md');
  assert.equal(ordered[1].path, '0.md');
  assert.equal(ordered.at(-1).path, '23.md');
});

test('malformed response fails closed and connection check measures protocol response only', async () => {
  await assert.rejects(rerankResults(enabled, 'query', [{ title: 'A' }, { title: 'B' }], {
    fetchImpl: async () => ({ ok: true, json: async () => ({ results: [{ index: 9, score: 1 }] }) }),
  }), /no usable scores/);
  const result = await testReranker(enabled, { fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ results: body.documents.map((_text, index) => ({ index, score: 1 - index })) }) };
  } });
  assert.equal(result.ok, true);
  assert.ok(result.elapsed_ms >= 0);
});

test('search filters private notes before sending candidates to the local reranker', async () => {
  const vault = await mkdtemp(path.join(os.tmpdir(), 'brainlink-rerank-private-'));
  const files = {
    'Local plan.md': '# Local plan\nThe project schedule uses a local weekly calendar and a review checklist.',
    'Calendar notes.md': '# Calendar notes\nThe weekly project calendar tracks milestones and review dates.',
    'Review workflow.md': '# Review workflow\nThe project calendar is checked during the weekly planning review.',
    'Private.md': '---\nprivate: true\n---\n# Secret project calendar\nZQX-RERANK-PRIVATE-CANARY hidden launch plan.',
  };
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(vault, name), body);
  const ctx = createContext(normalize({ vaults: [{ name: 'Test', path: vault }], reranker: enabled }), {
    env: { ...process.env, BRAINLINK_HOME: await mkdtemp(path.join(os.tmpdir(), 'brainlink-rerank-home-')), BRAINLINK_SEMANTIC: '0' },
  });
  const originalFetch = globalThis.fetch;
  let payload;
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, json: async () => ({ results: payload.documents.map((_text, index) => ({ index, score: 10 - index })) }) };
  };
  try {
    await search(ctx, 'Test', 'project calendar weekly review', { limit: 5, semantic: false });
  } finally { globalThis.fetch = originalFetch; }
  assert.ok(payload, 'reranker was called');
  const sent = JSON.stringify(payload);
  assert.doesNotMatch(sent, /ZQX-RERANK-PRIVATE-CANARY|Secret project calendar|Private\.md/i);
});

test('reranker settings and connection controls are present in all user locales', async () => {
  const { readFile } = await import('node:fs/promises');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const html = await readFile(path.join(root, 'ui', 'index.html'), 'utf8');
  assert.match(html, /id="reranker-form"/);
  assert.match(html, /api\('POST', '\/api\/reranker\/settings'/);
  assert.match(html, /api\('POST', '\/api\/reranker\/test'/);
  for (const locale of ['en', 'pt', 'zh-TW']) {
    const strings = JSON.parse(await readFile(path.join(root, 'ui', 'locales', `${locale}.json`), 'utf8'));
    for (const key of ['reranker.title', 'reranker.hint', 'reranker.enabled', 'reranker.url', 'reranker.save', 'reranker.test', 'reranker.testing', 'reranker.ready', 'reranker.failed', 'reranker.savedOn', 'reranker.savedOff']) assert.ok(strings[key], `${locale} ${key}`);
  }
});
