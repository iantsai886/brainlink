import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalize, validate } from '../src/config.mjs';
import { detect, connect, disconnect, test as testClient, UNSUPPORTED } from '../src/connectors.mjs';
import { runSync } from '../src/sync-cli.mjs';
import { startSetup } from '../src/setup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (p) => mkdtemp(path.join(tmpdir(), `brainlink-${p}-`));

// ---- config.mjs: optional `sync` key ----

test('config validate: optional sync key, valid and invalid', () => {
  const base = normalize({ vaults: [{ name: 'Work', path: '/tmp/work' }] });
  assert.deepEqual(validate({ ...base, sync: { provider: 'local', folder: null, device: 'mac1' } }), []);
  assert.deepEqual(validate({ ...base }), [], 'sync is optional; absent is fine');
  const bad = validate({ ...base, sync: { provider: 'nope', folder: null, device: 'mac1' } });
  assert.ok(bad.some((e) => /sync.provider/.test(e)));
  const bad2 = validate({ ...base, sync: { provider: 'gdrive', folder: 'relative/path', device: 'mac1' } });
  assert.ok(bad2.some((e) => /sync.folder/.test(e)));
});

// ---- src/sync-cli.mjs: `brainlink sync` ----

test('runSync: local-only by default, no store touched, writes one content-free activity line', async () => {
  const env = { BRAINLINK_HOME: await tmp('sync-home') };
  const cfg = normalize({});
  const r = await runSync(cfg, env);
  assert.equal(r.status, 'local-only');
  assert.equal(r.provider, 'local');
  const log = await readFile(path.join(env.BRAINLINK_HOME, 'activity.log'), 'utf8');
  assert.match(log, /"tool":"sync"/);
  assert.match(log, /"status":"local-only"/);
});

test('runSync: non-local provider with an offline folder queues instead of failing', async () => {
  const env = { BRAINLINK_HOME: await tmp('sync-home2') };
  const cfg = normalize({ sync: { provider: 'dropbox', folder: path.join(await tmp('not-mounted'), 'missing'), device: 'macA' } });
  const r = await runSync(cfg, env);
  assert.equal(r.status, 'queued');
});

// ---- connectors.mjs: {ok,message} wrappers + the ChatGPT honest note ----

test('connectors: detect() lists ChatGPT as unsupported; connect/disconnect/test never touch it', async () => {
  const home = await tmp('connectors-home');
  const opts = { home, os: 'linux', env: {}, launch: { command: 'node', args: ['cli.mjs', 'serve'] }, useCli: false };
  const found = await detect(opts);
  assert.equal(found.chatgpt.unsupported, true);
  assert.equal(found.chatgpt.present, false);
  assert.deepEqual(Object.keys(UNSUPPORTED), ['chatgpt']);
  for (const fn of [connect, disconnect, testClient]) {
    const r = await fn('chatgpt', opts);
    assert.equal(r.ok, false);
    assert.match(r.message, /remote HTTPS/);
  }
});

test('connectors: connect()/test()/disconnect() normalize to {ok,message} over the real connectClient/disconnectClient', async () => {
  const home = await tmp('connectors-home2');
  const opts = { home, os: 'linux', env: {}, launch: { command: 'node', args: ['cli.mjs', 'serve'] }, useCli: false };
  await mkdir(path.join(home, '.cursor'), { recursive: true });
  const before = await testClient('cursor', opts);
  assert.equal(before.ok, false);
  const c = await connect('cursor', opts);
  assert.equal(c.ok, true);
  assert.match(c.message, /Connected Cursor/);
  const after = await testClient('cursor', opts);
  assert.equal(after.ok, true);
  const d = await disconnect('cursor', opts);
  assert.equal(d.ok, true);
  const bad = await connect('nope-not-a-client', opts);
  assert.equal(bad.ok, false);
});

// ---- bin/brainlink.mjs: connect --all and sync ----

test('CLI: `brainlink connect --all` connects every present client and skips the rest', async () => {
  const home = await tmp('cli-home');
  await mkdir(path.join(home, '.cursor'), { recursive: true });
  await mkdir(path.join(home, '.config', 'Claude'), { recursive: true });
  const env = { ...process.env, HOME: home, BRAINLINK_HOME: path.join(home, 'app') };
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'brainlink.mjs'), 'connect', '--all'], { env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${out}`))));
  });
  const cursor = JSON.parse(await readFile(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.ok(cursor.mcpServers.brainlink);
  const claude = JSON.parse(await readFile(path.join(home, '.config', 'Claude', 'claude_desktop_config.json'), 'utf8'));
  assert.ok(claude.mcpServers.brainlink);
  await assert.rejects(readFile(path.join(home, '.gemini', 'settings.json')), 'gemini was never present, so --all must not create it');
});

test('CLI: `brainlink sync` runs end to end with no vault configured', async () => {
  const home = await tmp('cli-sync-home');
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'brainlink.mjs'), 'sync'], { env: { ...process.env, BRAINLINK_HOME: home } });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.on('exit', (code) => (code === 0 ? resolve(buf) : reject(new Error(`exit ${code}: ${buf}`))));
  });
  assert.match(out, /sync \(Local only\): local-only/);
});

// ---- setup.mjs: the sync choice route ----

test('setup UI: /api/sync chooses a provider (and rejects a bad one); state() reports it', async () => {
  const home = await tmp('setup-sync-home');
  const env = { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' };
  const s = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${s.port}`;
  const api = (method, p, body) => fetch(base + p, { method, headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  try {
    const st0 = await (await api('GET', '/api/state')).json();
    assert.equal(st0.sync.provider, 'local');
    assert.deepEqual(st0.sync.providers, ['local', 'gdrive', 'icloud', 'dropbox']);
    const target = path.join(home, 'DriveFolder');
    await mkdir(target, { recursive: true });
    const r = await (await api('POST', '/api/sync', { provider: 'gdrive', folder: target, device: 'test-device' })).json();
    assert.equal(r.ok, true);
    assert.equal(r.sync.provider, 'gdrive');
    const st1 = await (await api('GET', '/api/state')).json();
    assert.equal(st1.sync.folder, target);
    const bad = await api('POST', '/api/sync', { provider: 'gdrive', folder: 'relative' });
    assert.equal(bad.status, 400);
  } finally { s.server.close(); }
});
