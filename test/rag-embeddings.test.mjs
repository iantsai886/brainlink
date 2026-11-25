import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { detectEmbedder } from '../src/embed.mjs';
import { normalize, saveConfig } from '../src/config.mjs';
import { createContext, searchWithVerdict } from '../src/core.mjs';
import { buildAnswerReceipt } from '../src/answer-receipt.mjs';
import { createMcp } from '../src/server.mjs';
import { startSetup } from '../src/setup.mjs';

const tmp = (p) => mkdtemp(path.join(tmpdir(), `brainlink-rag-s1-${p}-`));

async function startMockOllama({ models = ['nomic-embed-text:latest'], embed = null } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    calls.push({ url: req.url, body });
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
      return;
    }
    if (req.url === '/api/embed') {
      const inputs = Array.isArray(body?.input) ? body.input : [];
      const embeddings = inputs.map((text) => (embed ? embed(text) : defaultVec(text)));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ embeddings }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function defaultVec(text) {
  const s = String(text).toLowerCase();
  // Distinct orthogonal directions for semantic-only matching tests
  const semanticTarget = /canine|hound|puppy|dog/.test(s) ? 1 : 0;
  const financeNoise = /quarterly|invoice|ledger/.test(s) ? 1 : 0;
  const fallback = semanticTarget || financeNoise ? 0.05 : 1;
  return [semanticTarget, financeNoise, fallback, 0.1];
}

async function makeFixtureVault() {
  const dir = await tmp('vault');
  const home = await tmp('home');
  await writeFile(path.join(dir, 'Pet Policy.md'), [
    '---',
    'status: active',
    '---',
    '# Pet Policy',
    '',
    'Friendly hounds and puppies are welcome in the studio on Fridays.',
  ].join('\n'));
  await writeFile(path.join(dir, 'Quarterly Ledger.md'), [
    '---',
    'status: active',
    '---',
    '# Quarterly Ledger',
    '',
    'Quarterly invoice review happens on the first Monday of each month.',
  ].join('\n'));
  return { dir, home };
}

test('S1: detectEmbedder reports preferred_model and setup_hint when Ollama is unavailable or lacks an embedding model', async () => {
  const emptyOllama = await startMockOllama({ models: ['qwen3.5:2b'] });
  try {
    const missingModel = await detectEmbedder({}, { BRAINLINK_EMBED_URL: emptyOllama.url });
    assert.equal(missingModel.available, false);
    assert.equal(missingModel.preferred_model, 'nomic-embed-text');
    assert.match(missingModel.reason, /nomic-embed-text/);
    assert.match(missingModel.setup_hint, /ollama pull nomic-embed-text/);
  } finally {
    await emptyOllama.close();
  }

  const down = await detectEmbedder({}, { BRAINLINK_EMBED_URL: 'http://127.0.0.1:1' });
  assert.equal(down.available, false);
  assert.equal(down.preferred_model, 'nomic-embed-text');
  assert.match(down.reason, /Ollama/i);
  assert.match(down.setup_hint, /ollama\.com/i);
  assert.match(down.setup_hint, /ollama pull nomic-embed-text/);
});

test('S1: detectEmbedder preserves fallback embedding models when nomic-embed-text is absent', async () => {
  const mock = await startMockOllama({ models: ['bge-m3:latest', 'qwen3.5:2b'] });
  try {
    const status = await detectEmbedder({}, { BRAINLINK_EMBED_URL: mock.url });
    assert.equal(status.available, true);
    assert.equal(status.model, 'bge-m3:latest');
    assert.equal(status.preferred_model, 'nomic-embed-text');
  } finally {
    await mock.close();
  }
});

test('S1: searchWithVerdict uses local Ollama embeddings by default when available and fuses with keyword results', async () => {
  const { dir, home } = await makeFixtureVault();
  const mock = await startMockOllama({ models: ['nomic-embed-text:latest'] });
  try {
    const cfg = normalize({ vaults: [{ name: 'Brain', path: dir }] });
    const ctx = createContext(cfg, { env: { BRAINLINK_HOME: home, BRAINLINK_EMBED_URL: mock.url }, trustedLocal: true });
    // Query uses "dog" (not in note text "hounds and puppies") so only semantic embedding finds Pet Policy.md
    const result = await searchWithVerdict(ctx, 'Brain', 'dog studio policy', { limit: 5 });
    assert.equal(result.semantic?.available, true);
    assert.equal(result.semantic?.model, 'nomic-embed-text:latest');
    assert.equal(result.results[0]?.path, 'Pet Policy.md');
    assert.match(result.results[0]?.match || '', /meaning/);
    const receipt = buildAnswerReceipt(result, { vault: 'Brain' });
    assert.equal(receipt.search_mode, 'meaning');
    assert.equal(receipt.semantic_unavailable_reason, undefined);
  } finally {
    await mock.close();
  }
});

test('S1: searchWithVerdict falls back cleanly to keyword search when Ollama is unavailable and reports reason + setup_hint', async () => {
  const { dir, home } = await makeFixtureVault();
  const cfg = normalize({ vaults: [{ name: 'Brain', path: dir }] });
  const ctx = createContext(cfg, { env: { BRAINLINK_HOME: home, BRAINLINK_EMBED_URL: 'http://127.0.0.1:1' }, trustedLocal: true });

  const result = await searchWithVerdict(ctx, 'Brain', 'quarterly invoice review', { limit: 5 });
  assert.equal(result.results[0]?.path, 'Quarterly Ledger.md');
  assert.equal(result.semantic?.available, false);
  assert.match(result.semantic?.reason || '', /Ollama/i);
  assert.match(result.semantic?.setup_hint || '', /ollama pull nomic-embed-text/);

  const receipt = buildAnswerReceipt(result, { vault: 'Brain' });
  assert.equal(receipt.search_mode, 'keyword');
  assert.match(receipt.semantic_unavailable_reason || '', /Ollama/i);
  assert.match(receipt.semantic_setup_hint || '', /ollama pull nomic-embed-text/);
});

test('S1: brainlink_guide and POST /api/ask surface semantic status and setup guidance', async () => {
  const { dir, home } = await makeFixtureVault();
  const cfg = normalize({ vaults: [{ name: 'Brain', path: dir }] });
  const env = { BRAINLINK_HOME: home, BRAINLINK_EMBED_URL: 'http://127.0.0.1:1' };
  const ctx = createContext(cfg, { env, trustedLocal: true });
  const mcp = createMcp(ctx);

  const guideRes = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brainlink_guide', arguments: {} } });
  const guide = JSON.parse(guideRes.result.content[0].text);
  assert.equal(guide.semantic?.available, false);
  assert.match(guide.semantic?.setup_hint || '', /ollama pull nomic-embed-text/);

  await mkdir(home, { recursive: true });
  await saveConfig(cfg, path.join(home, 'config.json'));
  const setup = await startSetup({ env, home: await tmp('s1-userhome'), os: 'win32', port: 0, openUrl: null, useCli: false });
  try {
    const res = await fetch(`http://127.0.0.1:${setup.port}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': setup.token },
      body: JSON.stringify({ vault: 'Brain', query: 'quarterly invoice review' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.search_mode, 'keyword');
    assert.equal(body.semantic?.available, false);
    assert.match(body.semantic?.setup_hint || '', /ollama pull nomic-embed-text/);
  } finally {
    setup.server.close();
  }
});
