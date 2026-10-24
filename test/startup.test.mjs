import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isStartupEnabled, setStartupEnabled, startupLauncherPath, startupLauncherSource } from '../src/startup.mjs';
import { startSetup } from '../src/setup.mjs';

test('startup launcher is hidden, opens no browser, and safely quotes paths', () => {
  const source = startupLauncherSource('C:\\Program Files\\BrainLink\\node.exe', 'C:\\Users\\Ian\\Brain Link\\brainlink.mjs');
  assert.match(source, /setup --app --no-open/);
  assert.match(source, /, 0, False/);
  assert.match(source, /Program Files/);
  assert.match(source, /Brain Link/);
});

test('startup setting creates and removes only its own launcher', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brainlink-startup-'));
  const env = { APPDATA: root };
  try {
    assert.equal(await isStartupEnabled(env), false);
    assert.equal(await setStartupEnabled(true, { env, os: 'win32', nodePath: 'C:\\node.exe', cliPath: 'C:\\brainlink.mjs' }), true);
    const file = startupLauncherPath(env);
    assert.match(await readFile(file, 'utf8'), /BrainLink managed startup launcher/);
    assert.equal(await isStartupEnabled(env), true);
    assert.equal(await setStartupEnabled(false, { env, os: 'win32' }), false);
    assert.equal(await isStartupEnabled(env), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('startup setting preserves an unrelated existing startup file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brainlink-startup-'));
  const env = { APPDATA: root };
  const file = startupLauncherPath(env);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'user-owned launcher');
    await assert.rejects(setStartupEnabled(true, { env, os: 'win32' }), /not managed|already exists/);
    assert.equal(await readFile(file, 'utf8'), 'user-owned launcher');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('authenticated Setup API reports and changes the Windows sign-in setting', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brainlink-startup-api-'));
  const env = { APPDATA: path.join(root, 'roaming'), BRAINLINK_HOME: path.join(root, 'home'), HOME: root, BRAINLINK_SEMANTIC: '0' };
  const app = await startSetup({ env, home: root, os: 'win32', port: 0, useCli: false });
  const request = (method, route, body) => fetch(`http://127.0.0.1:${app.port}${route}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': app.token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    const initial = await request('GET', '/api/state').then((r) => r.json());
    assert.equal(initial.startup_at_login, false);
    assert.equal((await request('POST', '/api/startup', { enabled: true })).status, 200);
    const enabled = await request('GET', '/api/state').then((r) => r.json());
    assert.equal(enabled.startup_at_login, true);
    assert.equal((await request('POST', '/api/startup', { enabled: false })).status, 200);
    const disabled = await request('GET', '/api/state').then((r) => r.json());
    assert.equal(disabled.startup_at_login, false);
  } finally {
    app.server.close();
    await rm(root, { recursive: true, force: true });
  }
});
