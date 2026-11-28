import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
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
    assert.equal(body.semantic?.action, 'install_ollama');
    assert.match(body.semantic?.setup_hint || '', /ollama pull nomic-embed-text/);
  } finally {
    setup.server.close();
  }
});

test('S1: flexible RAG supports Ollama install prompt, OpenAI-compatible local server, cloud API (0600 key), and Smart Lexical mode', async () => {
  const { dir, home } = await makeFixtureVault();

  // 1. Smart Lexical mode (no Ollama, no API needed)
  const lexRes = await detectEmbedder({ semantic: { provider: 'lexical' } }, { BRAINLINK_HOME: home });
  assert.equal(lexRes.available, false);
  assert.equal(lexRes.provider, 'lexical');
  assert.equal(lexRes.action, 'lexical_active');

  // 2. Cloud API without key asks for key
  const noKeyRes = await detectEmbedder({ semantic: { provider: 'openai' } }, { BRAINLINK_HOME: home });
  assert.equal(noKeyRes.available, false);
  assert.equal(noKeyRes.provider, 'openai');
  assert.equal(noKeyRes.action, 'set_api_key');

  // 3. Fake OpenAI-compatible /v1/models + /v1/embeddings server works end-to-end
  let seenAuth = '';
  const fakeCompat = http.createServer((req, res) => {
    seenAuth = req.headers.authorization || '';
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'local-embed-v1' }] }));
      return;
    }
    if (req.url === '/v1/embeddings') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        const data = body.input.map((txt, index) => ({
          index,
          embedding: /invoice|payment/i.test(txt) ? [1, 0, 0] : [0, 1, 0],
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => fakeCompat.listen(0, '127.0.0.1', r));
  const compatUrl = `http://127.0.0.1:${fakeCompat.address().port}/v1`;

  await mkdir(home, { recursive: true });
  const cfg = normalize({ vaults: [{ name: 'Brain', path: dir }] });
  const cfgFile = path.join(home, 'config.json');
  await saveConfig(cfg, cfgFile);
  const setup = await startSetup({ env: { BRAINLINK_HOME: home }, home: await tmp('s1-flex-userhome'), os: 'win32', port: 0, openUrl: null, useCli: false });

  try {
    const secretKey = 'sk-test-embed-secret-never-in-config-json';
    const saveRes = await fetch(`http://127.0.0.1:${setup.port}/api/rag-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': setup.token },
      body: JSON.stringify({ provider: 'openai-compatible', url: compatUrl, model: 'local-embed-v1', api_key: secretKey }),
    });
    assert.equal(saveRes.status, 200);
    const savedBody = await saveRes.json();
    assert.equal(savedBody.ok, true);
    assert.equal(savedBody.semantic?.available, true);
    assert.equal(savedBody.semantic?.provider, 'openai-compatible');
    assert.equal(savedBody.config?.has_api_key, true);
    // Secret key must NEVER be echoed in HTTP responses or stored in config.json!
    assert.ok(!JSON.stringify(savedBody).includes(secretKey), 'API key must never be echoed in /api/rag-config response');
    const cfgRaw = await readFile(cfgFile, 'utf8');
    assert.ok(!cfgRaw.includes(secretKey), 'API key must never be saved in config.json');

    // Run semantic search through the configured OpenAI-compatible server
    const loadedCfg = normalize(JSON.parse(cfgRaw));
    const ctx = createContext(loadedCfg, { env: { BRAINLINK_HOME: home }, trustedLocal: true });
    const searchRes = await searchWithVerdict(ctx, 'Brain', 'payment billing', { limit: 3 });
    assert.equal(searchRes.semantic?.available, true);
    assert.equal(searchRes.semantic?.provider, 'openai-compatible');
    assert.equal(seenAuth, `Bearer ${secretKey}`);
  } finally {
    setup.server.close();
    fakeCompat.close();
  }
});

test('S1: POST /api/rag-ollama-action supports one-click install, start, and pull with auto-recheck', async () => {
  const dir = await tmp('s1-ollama-action-vault');
  const home = await tmp('s1-ollama-action-home');
  await mkdir(dir, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(dir, 'Note.md'), '# Note\nTest content.\n');
  const cfg = normalize({ vaults: [{ name: 'Brain', path: dir }] });
  await saveConfig(cfg, path.join(home, 'config.json'));

  const seenActions = [];
  const setup = await startSetup({
    env: { BRAINLINK_HOME: home, BRAINLINK_EMBED_URL: 'http://127.0.0.1:1' },
    home: await tmp('s1-ollama-action-user'),
    os: 'win32',
    port: 0,
    openUrl: null,
    useCli: false,
    ollamaRunner: async ({ action, model }) => {
      seenActions.push({ action, model });
      return { ok: true, method: 'mock', message: `Ran ${action} for ${model}` };
    },
  });

  try {
    for (const action of ['install', 'start', 'pull']) {
      const res = await fetch(`http://127.0.0.1:${setup.port}/api/rag-ollama-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': setup.token },
        body: JSON.stringify(action === 'pull' ? { action, model: 'bge-m3', activate: true } : { action }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.action, action);
      assert.equal(body.method, 'mock');
      assert.ok(body.semantic && typeof body.semantic === 'object');
      if (action === 'pull') assert.equal(body.config?.model, 'bge-m3');
    }
    assert.deepEqual(seenActions.map((x) => x.action), ['install', 'start', 'pull']);
    assert.equal(seenActions[2].model, 'bge-m3');

    const bad = await fetch(`http://127.0.0.1:${setup.port}/api/rag-ollama-action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': setup.token },
      body: JSON.stringify({ action: 'delete-everything' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    setup.server.close();
  }
});
