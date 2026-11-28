import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize, saveConfig } from '../src/config.mjs';
import { createContext, searchWithVerdict, warmSemantic, findRemoteSensitive } from '../src/core.mjs';
import { isLocalEmbedder, detectEmbedder, saveEmbedApiKey } from '../src/embed.mjs';
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

    // 2. With remote_consent: true + matching remote_consent_host, warmSemantic + searches across both vaults.
    const cfgConsent = normalize({
      vaults: [
        { name: 'Shared', path: sharedDir, private: false },
        { name: 'PrivateVault', path: privateDir, private: true },
      ],
      semantic: { enabled: true, provider: 'openai', url: remoteUrl, model: 'text-embedding-3-small', remote_consent: true, remote_consent_host: 'api.example.test' },
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

test('R1: findRemoteSensitive blocks plain-text credentials, headers, credential URLs, JWTs, Taiwan IDs, without over-blocking prose', async () => {
  const root = await tmp('r1');
  const vaultDir = path.join(root, 'shared');
  const home = path.join(root, 'home');
  await mkdir(vaultDir, { recursive: true });
  await mkdir(home, { recursive: true });
  await saveEmbedApiKey(home, 'sk-proj-R1TESTKEY12345678901234567890');

  const blockedNotes = [
    ['cred-password.md', 'Login password: hunter2Hunter2!'],
    ['cred-passwd.md', 'DB passwd=AlphaPass99'],
    ['cred-pwd.md', 'Shell pwd: BetaPass88'],
    ['cred-pin.md', 'Door pin: 4921'],
    ['cred-passcode.md', 'Lock passcode=778899'],
    ['cred-secret.md', 'App secret: mySharedSecretVal'],
    ['cred-token.md', 'Service token=tok_plain_9911'],
    ['cred-apikey.md', 'Vendor api_key: plainKey123'],
    ['cred-apikey2.md', 'Vendor apikey=plainKey456'],
    ['cred-client-secret.md', 'OAuth client_secret: cs_plain_789'],
    ['cred-cjk-trad.md', '帳號 密碼：myCjkPass1'],
    ['cred-cjk-simp.md', '账号 密码: myCjkPass2'],
    ['header-bearer.md', 'Authorization: Bearer fakeHeaderToken99'],
    ['header-basic.md', 'Authorization: Basic dXNlcjpwYXNz'],
    ['cred-url.md', 'Endpoint https://alice:secretpass@db.example.test/app'],
    ['cred-jwt.md', 'Session eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['tw-id-1.md', 'Applicant ID A123456789'],
    ['tw-id-2.md', 'Applicant ID F298765432'],
  ];
  const allowedProse = [
    ['prose-policy.md', 'We need a password policy for onboarding new teammates.'],
    ['prose-pin.md', 'Remember to reset your PIN in settings after the first login.'],
  ];

  for (const [name, text] of blockedNotes) {
    assert.ok(findRemoteSensitive(text).length > 0, `Expected findRemoteSensitive to flag ${name}`);
    await writeFile(path.join(vaultDir, name), `# ${name}\n${text}\n`);
  }
  for (const [name, text] of allowedProse) {
    assert.equal(findRemoteSensitive(text).length, 0, `Expected findRemoteSensitive NOT to over-block prose in ${name}`);
    await writeFile(path.join(vaultDir, name), `# ${name}\n${text}\n`);
  }

  const remoteUrl = 'https://api.example.test/v1';
  const sent = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(remoteUrl)) {
      const parsed = init?.body ? JSON.parse(String(init.body)) : {};
      const items = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
      sent.push(...items.map(String));
      return new Response(JSON.stringify({ data: items.map((_, index) => ({ index, embedding: [0.5, 0.5] })) }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return origFetch(url, init);
  };

  try {
    const cfg = normalize({
      vaults: [{ name: 'Shared', path: vaultDir, private: false }],
      semantic: { enabled: true, provider: 'openai', url: remoteUrl, model: 'text-embedding-3-small', remote_consent: true, remote_consent_host: 'api.example.test' },
    });
    const ctx = createContext(cfg, { env: { BRAINLINK_HOME: home }, trustedLocal: true });
    await warmSemantic(ctx, 'Shared');
    await searchWithVerdict(ctx, 'Shared', 'password: hunter2Hunter2!');

    const joined = sent.join('\n');
    for (const [name, text] of blockedNotes) {
      assert.ok(!joined.includes(text), `Blocked credential note ${name} must NEVER be sent to remote embedder`);
    }
    for (const [name, text] of allowedProse) {
      assert.ok(joined.includes(text), `Safe prose note ${name} MUST still be sent to remote embedder`);
    }
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('R2: remote consent is strictly bound to approved host (match, env override, legacy no-host, URL change clears consent)', async () => {
  const root = await tmp('r2');
  const vaultDir = path.join(root, 'shared');
  const home = path.join(root, 'home');
  const userHome = path.join(root, 'user-home');
  await mkdir(vaultDir, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(userHome, { recursive: true });
  await saveEmbedApiKey(home, 'sk-proj-R2TESTKEY12345678901234567890');

  const cfg = normalize({
    vaults: [{ name: 'Shared', path: vaultDir, private: false }],
    semantic: {
      enabled: true,
      provider: 'openai',
      url: 'https://api.openai.com/v1',
      model: 'text-embedding-3-small',
      remote_consent: true,
      remote_consent_host: 'api.openai.com',
    },
  });

  // 1. Exact host match -> available
  const match = await detectEmbedder(cfg, { BRAINLINK_HOME: home });
  assert.equal(match.available, true);
  assert.equal(match.action, 'ready');

  // 2. Env override to another host -> consent_required naming new host
  const envOverride = await detectEmbedder(cfg, { BRAINLINK_HOME: home, BRAINLINK_EMBED_URL: 'https://other.example/v1' });
  assert.equal(envOverride.available, false);
  assert.equal(envOverride.action, 'consent_required');
  assert.match(envOverride.reason, /other\.example/);

  // 3. Legacy consent (remote_consent: true without remote_consent_host) -> fail closed
  const legacyCfg = normalize({
    vaults: [{ name: 'Shared', path: vaultDir, private: false }],
    semantic: { enabled: true, provider: 'openai', url: 'https://api.openai.com/v1', model: 'text-embedding-3-small', remote_consent: true },
  });
  const legacyRes = await detectEmbedder(legacyCfg, { BRAINLINK_HOME: home });
  assert.equal(legacyRes.available, false);
  assert.equal(legacyRes.action, 'consent_required');

  // 4. Changing provider URL in Setup without confirming new host clears consent
  const cfgFile = path.join(home, 'config.json');
  await saveConfig(cfg, cfgFile);
  const setup = await startSetup({
    env: { BRAINLINK_HOME: home },
    home: userHome,
    os: 'win32',
    port: 0,
    openUrl: null,
    useCli: false,
  });
  try {
    const res = await fetch(`http://127.0.0.1:${setup.port}/api/rag-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': setup.token },
      body: JSON.stringify({ provider: 'openai', url: 'https://other.example/v1', model: 'text-embedding-3-small' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.config.remote_consent, false);
    assert.equal(body.config.remote_consent_host, '');
    assert.equal(body.semantic.available, false);
    assert.equal(body.semantic.action, 'consent_required');
    assert.match(body.semantic.reason, /other\.example/);
  } finally {
    setup.server.close();
  }
});
