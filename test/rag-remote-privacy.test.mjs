import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize, saveConfig } from '../src/config.mjs';
import { createContext, searchWithVerdict, warmSemantic } from '../src/core.mjs';
import { isLocalEmbedder, saveEmbedApiKey } from '../src/embed.mjs';
import { createMcp } from '../src/server.mjs';
import { startSetup } from '../src/setup.mjs';
import { runDoctor } from '../src/doctor.mjs';

const tmp = (name) => mkdtemp(path.join(tmpdir(), `brainlink-remote-priv-${name}-`));

test('isLocalEmbedder distinguishes loopback from LAN, public hosts, and lookalikes', () => {
  assert.equal(isLocalEmbedder({ url: 'http://127.0.0.1:11434' }), true);
  assert.equal(isLocalEmbedder({ url: 'http://localhost:1234/v1' }), true);
  assert.equal(isLocalEmbedder({ url: 'http://[::1]:11434' }), true);
  assert.equal(isLocalEmbedder({ url: 'https://127.0.0.1:8443/v1' }), true);

  assert.equal(isLocalEmbedder({ url: 'https://api.openai.com/v1' }), false);
  assert.equal(isLocalEmbedder({ url: 'http://192.168.1.42:11434' }), false);
  assert.equal(isLocalEmbedder({ url: 'http://203.0.113.9/v1' }), false);
  assert.equal(isLocalEmbedder({ url: 'https://localhost.evil.test/v1' }), false);
  assert.equal(isLocalEmbedder({ url: 'not-a-url' }), false);
  assert.equal(isLocalEmbedder(null), false);
});

test('remote embedder privacy canaries: consent gate, private-vault block, secret scan, key non-leakage, HTTPS enforcement', async () => {
  const root = await tmp('suite');
  const sharedDir = path.join(root, 'shared-vault');
  const privateDir = path.join(root, 'private-vault');
  const home = path.join(root, 'home');
  const userHome = path.join(root, 'user-home');

  await mkdir(path.join(sharedDir, '00 Home'), { recursive: true });
  await mkdir(path.join(sharedDir, 'IgnoredSecret'), { recursive: true });
  await mkdir(privateDir, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(userHome, { recursive: true });

  const sharedNormalCanary = 'SHARED_NORMAL_CANARY_9911';
  const privateFrontmatterCanary = 'PRIVATE_FRONTMATTER_CANARY_4422';
  const homeCanary = 'HOME_FOLDER_CANARY_5533';
  const ignoredCanary = 'IGNORED_FOLDER_CANARY_6644';
  const secretValue = 'sk-live-FAKECANARYSECRETVALUE998877665544';
  const privateVaultCanary = 'PRIVATE_VAULT_CANARY_7755';
  const privateQueryCanary = 'PRIVATE_QUERY_CANARY_8866';
  const savedApiKey = 'sk-proj-REMOTEEMBEDDERKEYCANARY1234567890';

  await writeFile(path.join(sharedDir, '.brainlinkignore'), 'IgnoredSecret/\n');
  await writeFile(path.join(sharedDir, 'Public Guide.md'), `# Public Guide\n${sharedNormalCanary}\n`);
  await writeFile(path.join(sharedDir, 'Private Note.md'), `---\nprivate: true\n---\n# Private Note\n${privateFrontmatterCanary}\n`);
  await writeFile(path.join(sharedDir, '00 Home', 'Overview.md'), `# Overview\n${homeCanary}\n`);
  await writeFile(path.join(sharedDir, 'IgnoredSecret', 'Hidden.md'), `# Hidden\n${ignoredCanary}\n`);
  await writeFile(path.join(sharedDir, 'Key Accident.md'), `# Key Accident\nToken: ${secretValue}\n`);
  await writeFile(path.join(privateDir, 'Diary.md'), `# Diary\n${privateVaultCanary}\n`);

  await saveEmbedApiKey(home, savedApiKey);

  const remoteUrl = 'https://api.example.test/v1';
  const sentInputs = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(remoteUrl)) {
      const parsed = init?.body ? JSON.parse(String(init.body)) : {};
      const items = Array.isArray(parsed.input) ? parsed.input : (parsed.input ? [parsed.input] : []);
      sentInputs.push(...items.map(String));
      return new Response(JSON.stringify({
        data: items.map((_, index) => ({ index, embedding: [0.5, 0.5, 0.5] })),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return origFetch(url, init);
  };

  try {
    // 1. Without remote_consent, nothing is sent.
    const cfgNoConsent = normalize({
      vaults: [
        { name: 'Shared', path: sharedDir, private: false },
        { name: 'PrivateVault', path: privateDir, private: true },
      ],
      semantic: { enabled: true, provider: 'openai', url: remoteUrl, model: 'text-embedding-3-small', remote_consent: false },
    });
    const ctxNoConsent = createContext(cfgNoConsent, { env: { BRAINLINK_HOME: home }, trustedLocal: true });
    await warmSemantic(ctxNoConsent, 'Shared');
    await warmSemantic(ctxNoConsent, 'PrivateVault');
    await searchWithVerdict(ctxNoConsent, 'Shared', sharedNormalCanary);
    await searchWithVerdict(ctxNoConsent, 'PrivateVault', privateQueryCanary);
    assert.equal(sentInputs.length, 0, 'Without remote_consent, zero texts may be sent to remote embedder');

    // 2. With remote_consent: true, warmSemantic + searches across both vaults.
    const cfgConsent = normalize({
      vaults: [
        { name: 'Shared', path: sharedDir, private: false },
        { name: 'PrivateVault', path: privateDir, private: true },
      ],
      semantic: { enabled: true, provider: 'openai', url: remoteUrl, model: 'text-embedding-3-small', remote_consent: true },
    });
    const ctxConsent = createContext(cfgConsent, { env: { BRAINLINK_HOME: home }, trustedLocal: true });
    await warmSemantic(ctxConsent, 'Shared');
    await warmSemantic(ctxConsent, 'PrivateVault');
    await searchWithVerdict(ctxConsent, 'Shared', sharedNormalCanary);
    const privSearch = await searchWithVerdict(ctxConsent, 'PrivateVault', privateQueryCanary);
    assert.equal(privSearch.semantic?.available, false);
    assert.match(privSearch.semantic?.reason || '', /private vault/i);

    const joined = sentInputs.join('\n');
    assert.ok(joined.includes(sharedNormalCanary), 'Shared normal note must be sent to remote embedder when consented');
    assert.ok(!joined.includes(privateVaultCanary), 'Private vault canary must NEVER be sent');
    assert.ok(!joined.includes(privateFrontmatterCanary), 'Private frontmatter canary must NEVER be sent');
    assert.ok(!joined.includes(ignoredCanary), 'Ignored folder canary must NEVER be sent');
    assert.ok(!joined.includes(secretValue), 'Secret-matching chunk must NEVER be sent');
    assert.ok(!joined.includes(privateQueryCanary), 'Private vault query must NEVER be sent');

    // 3. Saved API key must never appear in GET /api/state, POST /api/rag-config, MCP tools, or doctor output.
    const cfgFile = path.join(home, 'config.json');
    await saveConfig(cfgConsent, cfgFile);
    const setup = await startSetup({
      env: { BRAINLINK_HOME: home },
      home: userHome,
      os: 'win32',
      port: 0,
      openUrl: null,
      useCli: false,
    });
    try {
      const stateRes = await origFetch(`http://127.0.0.1:${setup.port}/api/state`, {
        headers: { 'X-BrainLink-Token': setup.token },
      });
      assert.equal(stateRes.status, 200);
      const stateText = await stateRes.text();
      assert.ok(!stateText.includes(savedApiKey), 'GET /api/state must never contain saved API key');
      assert.ok(!stateText.includes('_apiKey'), 'GET /api/state must never expose _apiKey field');

      const ragRes = await origFetch(`http://127.0.0.1:${setup.port}/api/rag-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': setup.token },
        body: JSON.stringify({ provider: 'openai', url: remoteUrl, model: 'text-embedding-3-small', remote_consent: true }),
      });
      assert.equal(ragRes.status, 200);
      const ragText = await ragRes.text();
      assert.ok(!ragText.includes(savedApiKey), 'POST /api/rag-config must never contain saved API key');

      const mcp = createMcp(ctxConsent);
      const guideOut = JSON.stringify(await mcp.tools.find((t) => t.name === 'brainlink_guide').run({}));
      const searchOut = JSON.stringify(await mcp.tools.find((t) => t.name === 'vault_search').run({ vault: 'Shared', query: sharedNormalCanary }));
      const packetOut = JSON.stringify(await mcp.tools.find((t) => t.name === 'context_packet').run({ vault: 'Shared', query: sharedNormalCanary }));
      assert.ok(!guideOut.includes(savedApiKey), 'brainlink_guide must never contain saved API key');
      assert.ok(!searchOut.includes(savedApiKey), 'vault_search must never contain saved API key');
      assert.ok(!packetOut.includes(savedApiKey), 'context_packet must never contain saved API key');

      const docOut = JSON.stringify(await runDoctor({ env: { BRAINLINK_HOME: home } }));
      assert.ok(!docOut.includes(savedApiKey), 'brainlink doctor output must never contain saved API key');

      // 4. Plaintext http:// to remote host must be rejected for every provider; loopback http:// accepted.
      for (const provider of ['ollama', 'openai-compatible', 'openai']) {
        const badRes = await origFetch(`http://127.0.0.1:${setup.port}/api/rag-config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': setup.token },
          body: JSON.stringify({ provider, url: 'http://203.0.113.9/v1', remote_consent: true }),
        });
        assert.equal(badRes.status, 400, `Expected 400 for plaintext remote http:// with provider ${provider}`);
      }
      const okLocal = await origFetch(`http://127.0.0.1:${setup.port}/api/rag-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': setup.token },
        body: JSON.stringify({ provider: 'openai-compatible', url: 'http://127.0.0.1:1234/v1' }),
      });
      assert.equal(okLocal.status, 200, 'Expected 200 for loopback http://127.0.0.1:1234/v1');
    } finally {
      setup.server.close();
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});
