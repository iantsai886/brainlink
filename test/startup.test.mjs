import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isStartupEnabled, linuxStartupSource, macStartupSource, setStartupEnabled, startupLauncherPath, startupLauncherSource } from '../src/startup.mjs';
import { startSetup } from '../src/setup.mjs';

test('startup launcher is hidden, opens no browser, and safely quotes paths', () => {
  const source = startupLauncherSource('C:\\Program Files\\BrainLink\\node.exe', 'C:\\Users\\Ian\\Brain Link\\brainlink.mjs');
  assert.match(source, /setup --app --no-open/);
  assert.match(source, /, 0, False/);
  assert.match(source, /Program Files/);
  assert.match(source, /Brain Link/);
});

test('the shared background-start control is outside Backup and explains scheduled work', async () => {
  const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  assert.equal((html.match(/id="startup-at-login"/g) || []).length, 1);
  const background = html.match(/<section id="s-background">([\s\S]*?)<\/section>/)?.[1] || '';
  const backup = html.match(/<section id="s-backup">([\s\S]*?)<\/section>/)?.[1] || '';
  assert.match(background, /id="startup-at-login"/);
  assert.doesNotMatch(backup, /id="startup-at-login"/);
  for (const locale of ['en', 'zh-TW', 'pt']) {
    const catalog = JSON.parse(await readFile(new URL(`../ui/locales/${locale}.json`, import.meta.url), 'utf8'));
    assert.ok(catalog['startup.title']);
    assert.ok(catalog['startup.hint']);
  }
});

test('startup setting creates and removes only its own launcher', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brainlink-startup-'));
  const env = { APPDATA: root };
  try {
    assert.equal(await isStartupEnabled(env, undefined, 'win32'), false);
    assert.equal(await setStartupEnabled(true, { env, os: 'win32', nodePath: 'C:\\node.exe', cliPath: 'C:\\brainlink.mjs' }), true);
    const file = startupLauncherPath(env, undefined, 'win32');
    assert.match(await readFile(file, 'utf8'), /BrainLink managed startup launcher/);
    assert.equal(await isStartupEnabled(env, undefined, 'win32'), true);
    assert.equal(await setStartupEnabled(false, { env, os: 'win32' }), false);
    assert.equal(await isStartupEnabled(env, undefined, 'win32'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('startup setting preserves an unrelated existing startup file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brainlink-startup-'));
  const env = { APPDATA: root };
  const file = startupLauncherPath(env, undefined, 'win32');
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'user-owned launcher');
    await assert.rejects(setStartupEnabled(true, { env, os: 'win32' }), /not managed|already exists/);
    assert.equal(await readFile(file, 'utf8'), 'user-owned launcher');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('macOS and desktop Linux login entries are opt-in, hidden, quoted and removable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brainlink-startup-platforms-'));
  const home = path.join(root, 'Ian Home');
  const nodePath = path.join(home, 'Brain Link', 'node');
  const cliPath = path.join(home, 'Brain Link', 'brainlink.mjs');
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  try {
    const macFile = startupLauncherPath(env, home, 'darwin');
    assert.equal(await isStartupEnabled(env, home, 'darwin'), false);
    assert.equal(await setStartupEnabled(true, { env, home, os: 'darwin', nodePath, cliPath }), true);
    const plist = await readFile(macFile, 'utf8');
    assert.match(plist, /com\.iango\.brainlink\.background/);
    assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(plist, /<string>--no-open<\/string>/);
    assert.equal(await isStartupEnabled(env, home, 'darwin'), true);
    assert.equal(await setStartupEnabled(false, { env, home, os: 'darwin' }), false);
    assert.equal(await isStartupEnabled(env, home, 'darwin'), false);

    const linuxFile = startupLauncherPath(env, home, 'linux');
    assert.equal(await isStartupEnabled(env, home, 'linux'), false);
    assert.equal(await setStartupEnabled(true, { env, home, os: 'linux', nodePath, cliPath }), true);
    const desktop = await readFile(linuxFile, 'utf8');
    assert.match(desktop, /Type=Application/);
    assert.match(desktop, /Exec=".*Brain Link.*node" ".*brainlink\.mjs" setup --app --no-open/);
    assert.equal(await isStartupEnabled(env, home, 'linux'), true);
    assert.equal(await setStartupEnabled(false, { env, home, os: 'linux' }), false);
    assert.equal(await isStartupEnabled(env, home, 'linux'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native login launchers escape XML and desktop-entry metacharacters', () => {
  assert.match(macStartupSource('/Applications/Brain & Link/node', '/app/<brain>.mjs'), /Brain &amp; Link/);
  assert.match(macStartupSource('/node', '/app/<brain>.mjs'), /&lt;brain&gt;/);
  assert.match(linuxStartupSource('/home/Ian/Brain Link/node', '/home/Ian/Brain Link/brainlink.mjs'), /Exec="\/home\/Ian\/Brain Link\/node"/);
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

test('Setup reports and changes desktop Linux login launch using its native entry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brainlink-startup-linux-api-'));
  const home = path.join(root, 'home');
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), BRAINLINK_HOME: path.join(root, 'app'), BRAINLINK_SEMANTIC: '0' };
  const app = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const request = (method, route, body) => fetch(`http://127.0.0.1:${app.port}${route}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': app.token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    assert.equal((await request('GET', '/api/state').then((r) => r.json())).startup_at_login, false);
    assert.equal((await request('POST', '/api/startup', { enabled: true })).status, 200);
    assert.equal((await request('GET', '/api/state').then((r) => r.json())).startup_at_login, true);
    assert.match(await readFile(startupLauncherPath(env, home, 'linux'), 'utf8'), /--no-open/);
    assert.equal((await request('POST', '/api/startup', { enabled: false })).status, 200);
  } finally {
    app.server.close();
    await rm(root, { recursive: true, force: true });
  }
});
