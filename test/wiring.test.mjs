import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { normalize, validate, saveConfig, configPath } from '../src/config.mjs';
import { detect, connect, disconnect, connectClient, disconnectClient, readClientAgentToken, test as testClient, UNSUPPORTED } from '../src/connectors.mjs';
import { runSync } from '../src/sync-cli.mjs';
import { startSetup } from '../src/setup.mjs';
import { openSessionStore } from '../src/sessions/index.mjs';
import { launchSpec, CLI_PATH } from '../src/runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const tmp = (p) => mkdtemp(path.join(tmpdir(), `brainlink-${p}-`));
const windowsAcl = (file) => {
  return execFileSync('icacls.exe', [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
};
function assertPrivateWindowsAcl(file) {
  const acl = windowsAcl(file);
  const userName = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/"([^"]+)"/)[1];
  const grants = acl.split(/\r?\n/).map((line) => line.trim()).filter((line) => /:\([^)]*\)\s*$/.test(line));
  assert.ok(acl.toLowerCase().includes(`${userName.toLowerCase()}:(f)`), 'current Windows user has access');
  assert.match(acl, /NT AUTHORITY\\SYSTEM:\(F\)/);
  assert.match(acl, /BUILTIN\\Administrators:\(F\)/);
  assert.equal(grants.length, 3, 'only the current user, SYSTEM and Administrators may access a token-bearing file');
  assert.ok(grants.every((line) => /:\(F\)\s*$/.test(line)), 'every access grant must be full control; partial extra grants are forbidden');
  assert.doesNotMatch(acl, /\(I\)|BUILTIN\\Users|Authenticated Users|Everyone/);
}

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
  const vault = await tmp('sync-offline-vault');
  const cfg = normalize({ vaults: [{ name: 'Brain', path: vault }], sync: { provider: 'dropbox', folder: path.join(await tmp('not-mounted'), 'missing'), device: 'macA' } });
  const r = await runSync(cfg, env);
  assert.equal(r.status, 'queued');
});

test('runSync: sends and receives real Markdown through the configured public vault', async () => {
  const env = { BRAINLINK_HOME: await tmp('sync-real-home') };
  const vault = await tmp('sync-real-vault');
  const folder = await tmp('sync-real-folder');
  await writeFile(path.join(vault, 'Local note.md'), '# Local note\nSaved in the actual vault.\n');
  const cfg = normalize({ vaults: [{ name: 'Work', path: vault }], sync: { provider: 'gdrive', folder, device: 'laptop' } });

  const first = await runSync(cfg, env);
  assert.equal(first.status, 'ok');
  assert.deepEqual(first.pushed, ['Local note.md']);
  assert.match(await readFile(path.join(folder, 'BrainLink', 'notes', 'Local note.md'), 'utf8'), /Saved in the actual vault/);

  await writeFile(path.join(folder, 'BrainLink', 'notes', 'Remote note.md'), '# Remote note\nCreated on another device.\n');
  const second = await runSync(cfg, env);
  assert.equal(second.status, 'ok');
  assert.deepEqual(second.pulled, ['Remote note.md']);
  assert.match(await readFile(path.join(vault, 'Remote note.md'), 'utf8'), /Created on another device/);
  assert.equal(await readFile(path.join(vault, 'Local note.md'), 'utf8'), '# Local note\nSaved in the actual vault.\n', 'the source file remains intact');
});

test('runSync: explicit vault choice selects one public vault and leaves other vaults untouched', async () => {
  const env = { BRAINLINK_HOME: await tmp('sync-selected-home') };
  const personal = await tmp('sync-selected-personal'); const work = await tmp('sync-selected-work');
  const folder = await tmp('sync-selected-target');
  await writeFile(path.join(personal, 'Personal.md'), 'private to the personal vault');
  await writeFile(path.join(work, 'Work.md'), 'belongs to the selected work vault');
  const cfg = normalize({
    vaults: [{ name: 'Personal', path: personal }, { name: 'Work', path: work }],
    sync: { provider: 'gdrive', folder, vault: 'Work', device: 'laptop' },
  });
  const r = await runSync(cfg, env);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.pushed, ['Work.md']);
  await assert.rejects(readFile(path.join(folder, 'BrainLink', 'notes', 'Personal.md')));
});

test('runSync: refuses an ambiguous vault and a target inside the selected vault', async () => {
  const env = { BRAINLINK_HOME: await tmp('sync-guard-home') };
  const one = await tmp('sync-guard-one'); const two = await tmp('sync-guard-two');
  const folder = await tmp('sync-guard-target');
  const ambiguous = normalize({ vaults: [{ name: 'One', path: one }, { name: 'Two', path: two }], sync: { provider: 'dropbox', folder, device: 'pc' } });
  assert.equal((await runSync(ambiguous, env)).status, 'vault-ambiguous');

  const nested = normalize({ vaults: [{ name: 'brain', path: one }], sync: { provider: 'dropbox', folder: path.join(one, 'cloud-sync'), device: 'pc' } });
  assert.equal((await runSync(nested, env)).status, 'target-inside-vault');
});

test('runSync: never syncs a private vault even when it is the only configured vault', async () => {
  const env = { BRAINLINK_HOME: await tmp('sync-private-home') };
  const vault = await tmp('sync-private-vault'); const folder = await tmp('sync-private-target');
  const cfg = normalize({ vaults: [{ name: 'brain', path: vault, private: true }], sync: { provider: 'dropbox', folder, device: 'pc' } });
  const r = await runSync(cfg, env);
  assert.equal(r.status, 'vault-required');
  await assert.rejects(readFile(path.join(folder, 'BrainLink', 'sessions', 'pc.json')));
});

test('runSync: non-private sessions get scope "brain" so they reach the sync target; private sessions stay local', async () => {
  const env = { BRAINLINK_HOME: await tmp('sync-sessions-home') };
  const folder = await tmp('sync-sessions-folder');
  const vault = await tmp('sync-sessions-vault');
  const cfg = normalize({ vaults: [{ name: 'brain', path: vault }], sync: { provider: 'dropbox', folder, device: 'd1' } });
  const store = await openSessionStore(env);
  const pub = await store.putSession({ client: 'claude-code', source_id: 'pub/1', project: '/x', title: 'Public', summary: 'pub summary', started_at: '2026-10-10T00:00:00Z', note_refs: [], private: false, messages: [] });
  await store.putSession({ client: 'claude-code', source_id: 'priv/1', project: '/x', title: 'Private', summary: 'priv summary', started_at: '2026-10-10T00:00:00Z', note_refs: [], private: true, messages: [] });
  const r = await runSync(cfg, env);
  assert.equal(r.sessions, 1, 'only the non-private session reaches the sync target');
  const idx = JSON.parse(await readFile(path.join(folder, 'BrainLink', 'sessions', 'd1.json'), 'utf8'));
  assert.deepEqual(idx.sessions.map((s) => s.id), [pub.id]);
});

// ---- src/sessions/index.mjs: importAll wiring (DEMO-CRITICAL: it must have callers) ----

test('importAll wiring: `brainlink sync` and `session_list` both see real ~/.claude and ~/.codex history under a fake HOME', async () => {
  const home = await tmp('fake-home');
  await mkdir(path.join(home, '.claude', 'projects'), { recursive: true });
  await mkdir(path.join(home, '.codex', 'sessions'), { recursive: true });
  await cp(path.join(FIXTURES, 'claude-code', 'projects'), path.join(home, '.claude', 'projects'), { recursive: true });
  await cp(path.join(FIXTURES, 'codex', 'sessions'), path.join(home, '.codex', 'sessions'), { recursive: true });
  const env = { ...process.env, HOME: home, BRAINLINK_AI_PLATFORM: 'Cursor' };

  // 1) `brainlink sync` must call importAll so the local session index is no longer empty.
  const syncEnv = { ...env, BRAINLINK_HOME: path.join(home, 'app-sync') };
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'brainlink.mjs'), 'sync'], { env: syncEnv });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.on('exit', (code) => (code === 0 ? resolve(buf) : reject(new Error(`exit ${code}: ${buf}`))));
  });
  const afterSync = await (await openSessionStore(syncEnv)).listSessions({ limit: 10 });
  assert.equal(afterSync.length, 2, '`brainlink sync` must import Claude Code + Codex history into the local session index');
  assert.deepEqual(afterSync.map((s) => s.client).sort(), ['claude-code', 'codex']);

  // 2) `brainlink serve`'s session_list must independently trigger its own lazy import, starting
  // from a fresh BRAINLINK_HOME with nothing imported yet. Imported sessions are private by
  // default, and BrainLink Settings' "share summaries of imported sessions" toggle (cfg.sessions,
  // src/config.mjs) also defaults OFF (v1.2.2 privacy fix: an AI client sees none of a user's
  // imported session history until the user opts in) — so session_list reports 0 sessions here. A
  // caller-supplied include_private is still never honoured: it changes nothing here either way.
  // The import itself still happens lazily regardless of the sharing setting (checked below).
  const serveEnv = { ...env, BRAINLINK_HOME: path.join(home, 'app-serve') };
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'brainlink.mjs'), 'serve'], { env: serveEnv });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) !== -1) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_list', arguments: { include_private: true } } }) + '\n');
  for (let i = 0; i < 100 && lines.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  assert.equal(lines.length, 2, 'expected an initialize + tools/call response');
  const result = JSON.parse(lines[1].result.content[0].text);
  assert.equal(result.sessions.length, 0, 'imported sessions stay hidden by default until the user opts in, and include_private from a caller has no effect');

  const afterServe = await (await openSessionStore(serveEnv)).listSessions({ limit: 10 });
  assert.equal(afterServe.length, 2, 'session_list must still trigger its own lazy import behind the scenes');
  assert.deepEqual(afterServe.map((s) => s.client).sort(), ['claude-code', 'codex']);
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

test('connectors: every config format protects BrainLink tokens and token-bearing backups', async () => {
  const home = await tmp('connector-private-configs');
  const cases = [
    { id: 'cursor', dir: path.join(home, '.cursor'), file: path.join(home, '.cursor', 'mcp.json'), original: '{"mcpServers":{"other":{"command":"other-mcp"}}}\n', env: {} },
    { id: 'hermes', dir: path.join(home, 'hermes'), file: path.join(home, 'hermes', 'config.yaml'), original: 'model: fictional\n', env: { HERMES_HOME: path.join(home, 'hermes') } },
    { id: 'codex', dir: path.join(home, 'codex'), file: path.join(home, 'codex', 'config.toml'), original: 'model = "fictional"\n', env: { CODEX_HOME: path.join(home, 'codex') } },
  ];
  const launch = { command: process.execPath, args: ['brainlink.mjs', 'serve'] };
  const assertPrivate = async (file) => {
    if (process.platform === 'win32') assertPrivateWindowsAcl(file);
    else assert.equal((await stat(file)).mode & 0o777, 0o600, `${file} must be private`);
  };
  for (const client of cases) {
    await mkdir(client.dir, { recursive: true });
    await writeFile(client.file, client.original);
    const opts = { home, os: process.platform, env: client.env, launch, useCli: false, extraEnv: { BRAINLINK_AGENT_TOKEN: `fictional-${client.id}-token` } };
    const connected = await connectClient(client.id, opts);
    assert.equal(connected.ok, undefined, 'connectClient returns its detailed receipt');
    await assertPrivate(client.file);
    await assertPrivate(connected.backup);
    assert.equal(await readFile(connected.backup, 'utf8'), client.original);
    const disconnected = await disconnectClient(client.id, opts);
    assert.equal(disconnected.removed, true);
    assert.match(await readFile(disconnected.backup, 'utf8'), new RegExp(`fictional-${client.id}-token`));
    await assertPrivate(disconnected.backup);
    await assertPrivate(client.file);
  }
});

test('connectors: Antigravity one-click setup merges and backs up global MCP config, and disconnect preserves other servers', async () => {
  const home = await tmp('antigravity-connect');
  const folder = path.join(home, '.gemini', 'config');
  const file = path.join(folder, 'mcp_config.json');
  await mkdir(folder, { recursive: true });
  const original = JSON.stringify({ mcpServers: { 'google-docs': { command: 'docs-mcp' }, brainlink: { command: 'old' } } }, null, 2) + '\n';
  await writeFile(file, original);
  const opts = {
    home, os: 'win32', env: {}, launch: { command: process.execPath, args: ['brainlink.mjs', 'serve'] }, useCli: false,
    now: new Date('2026-10-25T12:00:00.000Z'),
  };

  const before = await detect(opts);
  assert.equal(before.antigravity.present, true);
  assert.equal(before.antigravity.connected, true);
  assert.equal(before.antigravity.canConnect, true);

  const connected = await connect('antigravity', opts);
  assert.equal(connected.ok, true);
  const config = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(config.mcpServers['google-docs'].command, 'docs-mcp', 'other MCP entries must be preserved');
  assert.equal(config.mcpServers.brainlink.env.BRAINLINK_AI_PLATFORM, 'Google Antigravity');
  const backupName = (await readdir(folder)).find((name) => name.includes('.brainlink-backup-'));
  assert.ok(backupName, 'existing global MCP settings must be backed up');
  assert.equal(await readFile(path.join(folder, backupName), 'utf8'), original);

  const removed = await disconnect('antigravity', opts);
  assert.equal(removed.ok, true);
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(after.mcpServers.brainlink, undefined);
  assert.equal(after.mcpServers['google-docs'].command, 'docs-mcp');
});

test('connectors: Antigravity is available as a manual setup but is not auto-detected from Gemini folders', async () => {
  const home = await tmp('antigravity-manual-detect');
  await mkdir(path.join(home, '.gemini', 'config'), { recursive: true });
  const opts = { home, os: 'win32', env: {}, launch: { command: process.execPath, args: ['brainlink.mjs', 'serve'] }, useCli: false };
  const found = await detect(opts);
  assert.equal(found.antigravity.present, false);
  assert.equal(found.antigravity.manual, true);
  assert.equal(found.antigravity.canConnect, true);
});

test('connectors: MCP clients receive the configured BrainLink home and custom config path', async () => {
  const home = await tmp('custom-brainlink-home');
  const codexHome = path.join(home, '.codex');
  const dataHome = path.join(home, 'isolated-brainlink-data');
  const configFile = path.join(home, 'custom-config', 'brainlink.json');
  await mkdir(codexHome, { recursive: true });
  const config = path.join(codexHome, 'config.toml');
  await writeFile(config, 'model = "fictional"\n');
  const opts = {
    home, os: 'win32', env: { CODEX_HOME: codexHome, BRAINLINK_HOME: dataHome, BRAINLINK_CONFIG: configFile },
    launch: { command: process.execPath, args: ['brainlink.mjs', 'serve'] }, useCli: false,
    extraEnv: { BRAINLINK_AGENT_TOKEN: 'fictional-custom-home-token' },
  };
  await connectClient('codex', opts);
  const saved = await readFile(config, 'utf8');
  assert.ok(saved.includes(`BRAINLINK_HOME = ${JSON.stringify(dataHome)}`));
  assert.ok(saved.includes(`BRAINLINK_CONFIG = ${JSON.stringify(configFile)}`));
  assert.match(saved, /BRAINLINK_AGENT_TOKEN = "fictional-custom-home-token"/);
});

test('connect: the generated Codex config launches BrainLink against its isolated vault and keeps private notes hidden', async () => {
  const home = await tmp('codex-isolated-runtime');
  const codexHome = path.join(home, '.codex');
  const brainHome = path.join(home, 'brainlink-data');
  const vault = path.join(home, 'fictional-vault');
  const configFile = path.join(home, 'brainlink-config', 'config.json');
  const clientConfig = path.join(codexHome, 'config.toml');
  await mkdir(codexHome, { recursive: true });
  await mkdir(vault, { recursive: true });
  await writeFile(clientConfig, 'model = "fictional-test-model"\n');
  await writeFile(path.join(vault, 'Public Project.md'), '# ORCHIDPUBLIC\n\nA fictional public project note for runtime isolation testing.');
  await writeFile(path.join(vault, 'Private Project.md'), '---\nprivate: true\n---\n# ORCHIDPRIVATE\n\nA fictional private note that must never be returned.');
  await saveConfig(normalize({ vaults: [{ name: 'Fictional Runtime Vault', path: vault }] }), configFile);

  const launch = { command: process.execPath, args: [path.join(ROOT, 'bin/brainlink.mjs'), 'serve'] };
  await connectClient('codex', {
    home, os: 'win32', env: { CODEX_HOME: codexHome, BRAINLINK_HOME: brainHome, BRAINLINK_CONFIG: configFile },
    launch, useCli: false,
  });

  // Read back the exact values written to the generated Codex config, then launch that entry.
  const saved = await readFile(clientConfig, 'utf8');
  const clientEntry = { command: null, args: null, env: {} };
  let section = '';
  for (const line of saved.split(/\r?\n/)) {
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) { section = header[1]; continue; }
    const setting = line.match(/^([A-Z0-9_]+|command|args) = (.+)$/);
    if (!setting) continue;
    const [, key, encoded] = setting;
    if (section === 'mcp_servers.brainlink') {
      if (key === 'command') clientEntry.command = JSON.parse(encoded);
      if (key === 'args') clientEntry.args = JSON.parse(encoded);
    } else if (section === 'mcp_servers.brainlink.env') clientEntry.env[key] = JSON.parse(encoded);
  }
  assert.equal(clientEntry.command, launch.command);
  assert.deepEqual(clientEntry.args, launch.args);
  assert.equal(clientEntry.env.BRAINLINK_HOME, brainHome);
  assert.equal(clientEntry.env.BRAINLINK_CONFIG, configFile);

  const child = spawn(clientEntry.command, clientEntry.args, {
    cwd: ROOT,
    env: { ...process.env, ...clientEntry.env, BRAINLINK_SEMANTIC: '0' },
    windowsHide: true,
  });
  const responses = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) responses.push(JSON.parse(line));
    }
  });
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'brainlink_guide', arguments: {} } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'vault_search', arguments: { vault: 'Fictional Runtime Vault', query: 'ORCHIDPUBLIC' } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'vault_search', arguments: { vault: 'Fictional Runtime Vault', query: 'ORCHIDPRIVATE' } } })}\n`);
    for (let i = 0; i < 300 && responses.length < 4 && child.exitCode === null; i++) await delay(50);
    assert.equal(responses.length, 4, `expected four MCP responses; received ${responses.length}, child exit=${child.exitCode}`);
    assert.equal(responses[1].result.isError, false);
    const guide = JSON.stringify(responses[1].result);
    assert.match(guide, /Fictional Runtime Vault/);
    assert.doesNotMatch(guide, /ORCHIDPRIVATE/);
    assert.match(JSON.stringify(responses[2].result), /ORCHIDPUBLIC/);
    assert.doesNotMatch(JSON.stringify(responses[3].result), /ORCHIDPRIVATE/);
    const runtimeConfig = JSON.parse(await readFile(configFile, 'utf8'));
    assert.equal(runtimeConfig.vaults[0].path, vault, 'the spawned server loaded the isolated config, not the default app config');
    assert.ok(await readFile(path.join(brainHome, 'activity.log'), 'utf8').then((log) => log.includes('vault_search')));
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test('connectors: Hermes merges YAML safely, reads its scoped token, backs up settings, and disconnects only BrainLink', async () => {
  const home = await tmp('hermes-connect');
  const folder = path.join(home, '.hermes');
  const file = path.join(folder, 'config.yaml');
  await mkdir(folder, { recursive: true });
  const original = '# Keep this comment\nmodel: deepseek-chat\nmcp_servers:\n  calendar:\n    command: calendar-mcp\n  brainlink:\n    command: old-command\n';
  await writeFile(file, original);
  const opts = {
    home, os: 'win32', env: {}, launch: { command: process.execPath, args: ['brainlink.mjs', 'serve'] }, useCli: false,
    extraEnv: { BRAINLINK_AGENT_TOKEN: 'fictional-hermes-token' }, now: new Date('2026-10-27T12:00:00.000Z'),
  };

  const before = await detect(opts);
  assert.equal(before.hermes.present, true);
  assert.equal(before.hermes.connected, true);
  assert.equal(before.hermes.canConnect, true);
  const connected = await connect('hermes', opts);
  assert.equal(connected.ok, true);
  const config = parse(await readFile(file, 'utf8'));
  assert.equal(config.model, 'deepseek-chat');
  assert.equal(config.mcp_servers.calendar.command, 'calendar-mcp');
  assert.equal(config.mcp_servers.brainlink.env.BRAINLINK_AGENT_TOKEN, 'fictional-hermes-token');
  assert.equal(await readClientAgentToken('hermes', opts), 'fictional-hermes-token');
  assert.match(await readFile(file, 'utf8'), /# Keep this comment/, 'YAML comments should be retained');
  const backupName = (await readdir(folder)).find((name) => name.includes('.brainlink-backup-'));
  assert.ok(backupName);
  assert.equal(await readFile(path.join(folder, backupName), 'utf8'), original);

  const removed = await disconnect('hermes', opts);
  assert.equal(removed.ok, true);
  const after = parse(await readFile(file, 'utf8'));
  assert.equal(after.mcp_servers.brainlink, undefined);
  assert.equal(after.mcp_servers.calendar.command, 'calendar-mcp');
  assert.equal(after.model, 'deepseek-chat');
});

test('connectors: Hermes refuses malformed YAML without changing or backing it up', async () => {
  const home = await tmp('hermes-bad-yaml');
  const folder = path.join(home, '.hermes');
  const file = path.join(folder, 'config.yaml');
  await mkdir(folder, { recursive: true });
  const original = 'mcp_servers: [\n';
  await writeFile(file, original);
  const opts = { home, os: 'win32', env: {}, launch: { command: process.execPath, args: ['brainlink.mjs', 'serve'] }, useCli: false };
  const connected = await connect('hermes', opts);
  assert.equal(connected.ok, false);
  assert.match(connected.message, /not valid YAML/);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal((await readdir(folder)).some((name) => name.includes('.brainlink-backup-')), false);
});

test('connectors: Hermes uses its Windows LocalAppData default, honors HERMES_HOME, and falls back to legacy home', async () => {
  const home = await tmp('hermes-paths');
  const localAppData = path.join(home, 'LocalAppData');
  const currentFile = path.join(localAppData, 'hermes', 'config.yaml');
  const legacyFile = path.join(home, '.hermes', 'config.yaml');
  const overrideFile = path.join(home, 'custom-hermes', 'config.yaml');
  const opts = { home, os: 'win32', env: { LOCALAPPDATA: localAppData }, launch: { command: process.execPath, args: ['brainlink.mjs', 'serve'] }, useCli: false };

  await mkdir(path.dirname(currentFile), { recursive: true });
  await writeFile(currentFile, 'model: current\n');
  assert.equal((await detect(opts)).hermes.file, currentFile, 'Windows should use the current LocalAppData location');

  const overridden = { ...opts, env: { ...opts.env, HERMES_HOME: path.dirname(overrideFile) } };
  assert.equal((await detect(overridden)).hermes.file, overrideFile, 'an explicit Hermes profile/home must win');

  const legacyHome = await tmp('hermes-legacy-path');
  await mkdir(path.dirname(path.join(legacyHome, '.hermes', 'config.yaml')), { recursive: true });
  await writeFile(path.join(legacyHome, '.hermes', 'config.yaml'), 'model: legacy\n');
  const legacy = await detect({ ...opts, home: legacyHome, env: { LOCALAPPDATA: path.join(legacyHome, 'LocalAppData') } });
  assert.equal(legacy.hermes.file, path.join(legacyHome, '.hermes', 'config.yaml'), 'existing legacy config remains discoverable');
});

test('connectors: DeepSeek Harness adds one profile patch entry, preserves other plugins, and disconnects cleanly', async () => {
  const home = await tmp('dsh-connect');
  const dshHome = path.join(home, '.dsh');
  const file = path.join(dshHome, 'cordis.patch.yml');
  await mkdir(dshHome, { recursive: true });
  const original = '# Keep this note\n- insert:\n    - id: existing-tool\n      name: example/plugin\n      config: { enabled: true }\n';
  await writeFile(file, original);
  const opts = { home, os: 'win32', env: { DSH_HOME: dshHome }, launch: { command: process.execPath, args: ['brainlink.mjs', 'serve'] }, useCli: false, extraEnv: { BRAINLINK_AGENT_TOKEN: 'fictional-dsh-token' }, now: new Date('2026-10-27T12:00:00.000Z') };
  const before = await detect(opts);
  assert.equal(before['deepseek-harness'].present, true);
  assert.equal(before['deepseek-harness'].connected, false);
  assert.equal(before['deepseek-harness'].canConnect, true);
  const connected = await connect('deepseek-harness', opts);
  assert.equal(connected.ok, true, connected.message);
  const config = parse(await readFile(file, 'utf8'));
  assert.equal(config[0].insert[0].id, 'existing-tool');
  const brainlink = config.flatMap((patch) => patch.insert || []).find((row) => row.id === 'mcp-brainlink');
  assert.equal(brainlink.name, '@deepseek-ai/dsh-mcp-client');
  assert.equal(brainlink.config.serverName, 'brainlink');
  assert.equal(brainlink.config.transport, 'stdio');
  assert.equal(brainlink.config.env.BRAINLINK_AGENT_TOKEN, 'fictional-dsh-token');
  assert.equal((await detect(opts))['deepseek-harness'].connected, true);
  assert.equal(await readClientAgentToken('deepseek-harness', opts), 'fictional-dsh-token');
  assert.match(await readFile(file, 'utf8'), /# Keep this note/);
  const backupPath = await readdir(dshHome).then((names) => path.join(dshHome, names.find((name) => name.includes('.brainlink-backup-'))));
  assert.equal(await readFile(backupPath, 'utf8'), original);
  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600, 'the Harness config contains an agent token and must not be group/world readable');
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600, 'the backup also contains a credential and must stay private');
  } else {
    assertPrivateWindowsAcl(file);
    assertPrivateWindowsAcl(backupPath);
  }
  const removed = await disconnect('deepseek-harness', opts);
  assert.equal(removed.ok, true, removed.message);
  const after = parse(await readFile(file, 'utf8'));
  assert.equal(after.flatMap((patch) => patch.insert || []).some((row) => row.id === 'mcp-brainlink'), false);
  assert.equal(after[0].insert[0].id, 'existing-tool');
  if (process.platform === 'win32') {
    const disconnectBackups = await readdir(dshHome).then((names) => names.filter((name) => name.includes('.brainlink-backup-')).map((name) => path.join(dshHome, name)));
    const disconnectBackup = await Promise.all(disconnectBackups.map(async (candidate) => ({ candidate, content: await readFile(candidate, 'utf8') }))).then((items) => items.find((item) => item.content.includes('fictional-dsh-token'))?.candidate);
    assert.ok(disconnectBackup, 'disconnect backup retains the previous token-bearing config');
    assertPrivateWindowsAcl(disconnectBackup);
    assertPrivateWindowsAcl(file);
  }
});

test('connectors: DeepSeek Harness refuses malformed patch YAML without overwriting it', async () => {
  const home = await tmp('dsh-bad-patch');
  const dshHome = path.join(home, '.dsh');
  const file = path.join(dshHome, 'cordis.patch.yml');
  await mkdir(dshHome, { recursive: true });
  const original = '- insert: [\n';
  await writeFile(file, original);
  const opts = { home, os: 'win32', env: { DSH_HOME: dshHome }, launch: { command: process.execPath, args: ['brainlink.mjs', 'serve'] }, useCli: false };
  const connected = await connect('deepseek-harness', opts);
  assert.equal(connected.ok, false);
  assert.match(connected.message, /not valid YAML/);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal((await readdir(dshHome)).some((name) => name.includes('.brainlink-backup-')), false);
});

test('connectors: DeepSeek Harness named profiles get separate tokens and config files', async () => {
  const home = await tmp('dsh-profile-scopes');
  const dshHome = path.join(home, '.dsh');
  const profileA = path.join(dshHome, 'profiles', 'web');
  const profileB = path.join(dshHome, 'profiles', 'headless');
  await mkdir(profileA, { recursive: true });
  await mkdir(profileB, { recursive: true });
  for (const folder of [profileA, profileB]) await writeFile(path.join(folder, 'cordis.patch.yml'), '[]\n');
  const opts = { home, os: 'win32', env: { DSH_HOME: dshHome }, launch: { command: process.execPath, args: ['brainlink.mjs', 'serve'] }, useCli: false };
  const detected = await detect(opts);
  assert.equal(detected['deepseek-harness@web'].canConnect, true);
  assert.equal(detected['deepseek-harness@headless'].canConnect, true);
  assert.equal(detected['deepseek-harness'], undefined, 'do not offer a shared connection when named profiles exist');

  const web = { ...opts, extraEnv: { BRAINLINK_AGENT_TOKEN: 'fictional-web-token' } };
  const headless = { ...opts, extraEnv: { BRAINLINK_AGENT_TOKEN: 'fictional-headless-token' } };
  assert.equal((await connect('deepseek-harness@web', web)).ok, true);
  assert.equal((await connect('deepseek-harness@headless', headless)).ok, true);
  assert.equal(await readClientAgentToken('deepseek-harness@web', opts), 'fictional-web-token');
  assert.equal(await readClientAgentToken('deepseek-harness@headless', opts), 'fictional-headless-token');
  const webRows = parse(await readFile(path.join(profileA, 'cordis.patch.yml'), 'utf8')).flatMap((patch) => patch.insert || []);
  const headlessRows = parse(await readFile(path.join(profileB, 'cordis.patch.yml'), 'utf8')).flatMap((patch) => patch.insert || []);
  const webServerName = webRows.find((row) => row.name === '@deepseek-ai/dsh-mcp-client').config.serverName;
  const headlessServerName = headlessRows.find((row) => row.name === '@deepseek-ai/dsh-mcp-client').config.serverName;
  assert.notEqual(webServerName, headlessServerName);
  assert.ok(webServerName.length <= 32 && headlessServerName.length <= 32, 'Harness server names stay within its 32-character limit');
  assert.equal((await detect(opts))['deepseek-harness@web'].connected, true);
  await disconnect('deepseek-harness@web', opts);
  assert.equal((await detect(opts))['deepseek-harness@web'].connected, false);
  assert.equal((await detect(opts))['deepseek-harness@headless'].connected, true, 'disconnecting one profile must leave the other connected');
});

test('connectors: named Harness connection blocks an existing home-level shared token', async () => {
  const home = await tmp('dsh-profile-block-shared');
  const dshHome = path.join(home, '.dsh');
  await mkdir(path.join(dshHome, 'profiles', 'web'), { recursive: true });
  const homePatch = '- insert:\n    - id: preserved-plugin\n      name: example/plugin\n      config: {}\n    - id: user-renamed-brainlink\n      name: "@deepseek-ai/dsh-mcp-client"\n      config: { serverName: brainlink-shared, transport: stdio, command: node, args: [], env: { BRAINLINK_AGENT_TOKEN: old-shared-token } }\n';
  await writeFile(path.join(dshHome, 'cordis.patch.yml'), homePatch);
  await writeFile(path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), '[]\n');
  const opts = { home, os: 'win32', env: { DSH_HOME: dshHome }, launch: { command: process.execPath, args: [] }, useCli: false };
  const result = await connect('deepseek-harness@web', opts);
  assert.equal(result.ok, false);
  assert.match(result.message, /old shared DeepSeek Harness connection/);
  assert.equal(await readFile(path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'), '[]\n');
  assert.equal((await detect(opts))['deepseek-harness'].connected, true, 'renamed shared entries must remain visible for cleanup');
  assert.equal((await disconnect('deepseek-harness', opts)).ok, true);
  const remainingHomeRows = parse(await readFile(path.join(dshHome, 'cordis.patch.yml'), 'utf8')).flatMap((patch) => patch.insert || []);
  assert.deepEqual(remainingHomeRows.map((row) => row.id), ['preserved-plugin']);
});

// ---- bin/brainlink.mjs: connect --all and sync ----

test('CLI: `brainlink connect --all` connects every present client and skips the rest', async () => {
  const home = await tmp('cli-home');
  await mkdir(path.join(home, '.cursor'), { recursive: true });
  const claudeFile = process.platform === 'win32'
    ? path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  await mkdir(path.dirname(claudeFile), { recursive: true });
  const env = { ...process.env, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), BRAINLINK_HOME: path.join(home, 'app') };
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'brainlink.mjs'), 'connect', '--all'], { env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${out}`))));
  });
  const cursor = JSON.parse(await readFile(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.ok(cursor.mcpServers.brainlink);
  const claude = JSON.parse(await readFile(claudeFile, 'utf8'));
  assert.ok(claude.mcpServers.brainlink);
  await assert.rejects(readFile(path.join(home, '.gemini', 'settings.json')), 'gemini was never present, so --all must not create it');
});

test('CLI: `brainlink connect --all` keeps going past one app\'s unreadable config and reports every app\'s result', async () => {
  const home = await tmp('cli-home-bad-config');
  await mkdir(path.join(home, '.cursor'), { recursive: true });
  await writeFile(path.join(home, '.cursor', 'mcp.json'), '{ broken'); // cursor is present but its config is not valid JSON
  const claudeFile = process.platform === 'win32'
    ? path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  await mkdir(path.dirname(claudeFile), { recursive: true });
  const env = { ...process.env, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), BRAINLINK_HOME: path.join(home, 'app') };
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'brainlink.mjs'), 'connect', '--all'], { env });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.on('exit', (code) => (code === 0 ? resolve(buf) : reject(new Error(`exit ${code}: ${buf}`))));
  });
  // cursor's bad config must not stop claude desktop from being connected.
  const claude = JSON.parse(await readFile(claudeFile, 'utf8'));
  assert.ok(claude.mcpServers.brainlink);
  assert.equal(await readFile(path.join(home, '.cursor', 'mcp.json'), 'utf8'), '{ broken', 'the broken file is never overwritten');
  // Every app's outcome is reported, not just the first failure.
  assert.match(out, /failed to connect Cursor.*not valid JSON/);
  assert.match(out, /Cursor: failed/);
  assert.match(out, /Claude Desktop: connected/);
});

// A clean Mac has no `node` on PATH: the launch command written into AI clients' MCP configs
// must be the absolute path of whatever node is currently running (the bundled runtime when
// launched from the mac zip), never a bare "node" that only resolves via a shell PATH.
test('launchSpec(): defaults to this process\'s own absolute node path, not a bare "node"', () => {
  const spec = launchSpec({});
  assert.equal(spec.command, process.execPath);
  assert.ok(path.isAbsolute(spec.command), 'command must be an absolute path');
  assert.notEqual(spec.command, 'node');
  assert.deepEqual(spec.args, [CLI_PATH, 'serve']);
  assert.ok(path.isAbsolute(spec.args[0]), 'CLI_PATH must be absolute');
});

test('connect() writes the absolute node path into the client config, not a bare "node"', async () => {
  const home = await tmp('connectors-execpath');
  const opts = { home, os: 'linux', env: {}, launch: launchSpec({}), useCli: false };
  await mkdir(path.join(home, '.cursor'), { recursive: true });
  const r = await connect('cursor', opts);
  assert.equal(r.ok, true);
  const cfg = JSON.parse(await readFile(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.equal(cfg.mcpServers.brainlink.command, process.execPath);
  assert.ok(path.isAbsolute(cfg.mcpServers.brainlink.command));
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
  const env = { BRAINLINK_HOME: path.join(home, 'app'), HOME: home, BRAINLINK_SEMANTIC: '0' };
  const s = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${s.port}`;
  const api = (method, p, body) => fetch(base + p, { method, headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  try {
    const st0 = await (await api('GET', '/api/state')).json();
    assert.equal(st0.sync.provider, 'local');
    assert.deepEqual(st0.sync.providers, ['local', 'gdrive', 'icloud', 'dropbox']);
    const target = path.join(home, 'DriveFolder');
    await mkdir(target, { recursive: true });
    const r = await (await api('POST', '/api/sync', { provider: 'gdrive', folder: target, scheduled: false, intervalHours: 12, device: 'test-device' })).json();
    assert.equal(r.ok, true);
    assert.equal(r.sync.provider, 'gdrive');
    assert.equal(r.sync.scheduled, false);
    assert.equal(r.sync.intervalHours, 12);
    const st1 = await (await api('GET', '/api/state')).json();
    assert.equal(st1.sync.folder, target);
    const blocked = await (await api('POST', '/api/sync/run', {})).json();
    assert.equal(blocked.ok, false);
    assert.equal(blocked.result.status, 'vault-required', 'the manual action fails closed without a public vault');
    await api('POST', '/api/sync', { provider: 'local', device: 'test-device' });
    const localRun = await (await api('POST', '/api/sync/run', {})).json();
    assert.equal(localRun.ok, true);
    assert.equal(localRun.result.status, 'local-only');
    const bad = await api('POST', '/api/sync', { provider: 'gdrive', folder: 'relative' });
    assert.equal(bad.status, 400);
  } finally { s.server.close(); }
});

test('Setup runs scheduled folder sync, preserves private notes, and keeps its server alive', async () => {
  const home = await tmp('setup-scheduled-sync');
  const env = { BRAINLINK_HOME: path.join(home, 'app'), HOME: home, BRAINLINK_SEMANTIC: '0' };
  const vault = await tmp('setup-scheduled-sync-vault');
  const folder = await tmp('setup-scheduled-sync-target');
  await writeFile(path.join(vault, 'Public.md'), 'Shared knowledge.');
  await writeFile(path.join(vault, 'Private.md'), '---\nprivate: true\n---\nNever shared.');
  const cfg = normalize({ vaults: [{ name: 'Work', path: vault }], sync: { provider: 'dropbox', folder, vault: 'Work', scheduled: true, intervalHours: 1, device: 'test-device' } });
  await saveConfig(cfg, configPath(env));
  const s = await startSetup({ env, home, os: 'linux', port: 0, useCli: false, idleMinutes: 0.005, syncIntervalMs: 60_000 });
  const base = `http://127.0.0.1:${s.port}`;
  const api = (p) => fetch(base + p, { headers: { 'X-BrainLink-Token': s.token } });
  try {
    let state;
    for (let i = 0; i < 80; i++) {
      state = await (await api('/api/state')).json();
      if (state.sync.status?.trigger === 'schedule') break;
      await delay(25);
    }
    assert.equal(state.sync.status?.trigger, 'schedule', 'the scheduled pass ran without a user click');
    assert.equal(state.sync.status?.status, 'ok');
    assert.equal(state.sync.status?.pushed, 1);
    assert.match(await readFile(path.join(folder, 'BrainLink', 'notes', 'Public.md'), 'utf8'), /Shared knowledge/);
    await assert.rejects(readFile(path.join(folder, 'BrainLink', 'notes', 'Private.md')));
    await delay(350);
    assert.equal((await (await api('/api/state')).json()).sync.status.trigger, 'schedule', 'scheduled sync keeps Setup alive past its idle timeout');
    assert.equal(JSON.parse(await readFile(path.join(env.BRAINLINK_HOME, 'sync-status.json'), 'utf8')).config_key.length, 64);
  } finally { s.server.close(); }
});

test('scheduled sync resumes from its saved receipt after Setup restarts', async () => {
  const home = await tmp('setup-scheduled-sync-restart');
  const env = { BRAINLINK_HOME: path.join(home, 'app'), HOME: home, BRAINLINK_SEMANTIC: '0' };
  const vault = await tmp('setup-scheduled-sync-restart-vault');
  const folder = await tmp('setup-scheduled-sync-restart-target');
  await writeFile(path.join(vault, 'Public.md'), 'Shared knowledge.');
  await saveConfig(normalize({ vaults: [{ name: 'Work', path: vault }], sync: { provider: 'gdrive', folder, vault: 'Work', scheduled: true, intervalHours: 1, device: 'test-device' } }), configPath(env));
  const start = async () => {
    const s = await startSetup({ env, home, os: 'linux', port: 0, useCli: false, syncIntervalMs: 900 });
    const api = (p) => fetch(`http://127.0.0.1:${s.port}${p}`, { headers: { 'X-BrainLink-Token': s.token } });
    return { ...s, api };
  };
  const waitForScheduledRun = async (s, differentFrom = null) => {
    for (let i = 0; i < 100; i++) {
      const status = (await (await s.api('/api/state')).json()).sync.status;
      if (status?.trigger === 'schedule' && status.at !== differentFrom) return status;
      await delay(20);
    }
    assert.fail('scheduled sync did not run before the test deadline');
  };

  let first = await start();
  const firstReceipt = await waitForScheduledRun(first);
  await new Promise((resolve, reject) => first.server.close((error) => error ? reject(error) : resolve()));

  const second = await start();
  try {
    await delay(150);
    const resumed = (await (await second.api('/api/state')).json()).sync.status;
    assert.equal(resumed.at, firstReceipt.at, 'restart honors the saved interval instead of immediately repeating the run');
    const nextReceipt = await waitForScheduledRun(second, firstReceipt.at);
    assert.ok(Date.parse(nextReceipt.at) - Date.parse(firstReceipt.at) >= 700, 'the next run follows the configured interval');
  } finally { await new Promise((resolve) => second.server.close(resolve)); }
});

// ---- setup.mjs: Sessions view (src/host.mjs's sessionsService, over src/sessions/*) ----

test('setup UI: /api/sessions list/read/private wire the same session store as session_list/session_read', async () => {
  const home = await tmp('setup-sessions-home');
  const env = { BRAINLINK_HOME: path.join(home, 'app'), HOME: home, BRAINLINK_SEMANTIC: '0' };
  const store = await openSessionStore(env);
  const s = await store.putSession({ client: 'codex', source_id: 'proj/1', project: '/work', title: 'Fix the kiln', summary: 'Diagnosed the kiln controller.', started_at: '2026-10-10T00:00:00Z', note_refs: [], private: true, messages: [{ role: 'user', at: '2026-10-10T00:00:00Z', text: 'hi' }] });

  const srv = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${srv.port}`;
  const api = (p, body) => fetch(base + p, { method: 'POST', headers: { 'X-BrainLink-Token': srv.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
  try {
    assert.deepEqual((await api('/api/sessions', {})).sessions, [], 'private session hidden by default');
    const visible = await api('/api/sessions', { include_private: true });
    assert.equal(visible.sessions.length, 1);
    assert.equal(visible.sessions[0].id, s.id);
    assert.equal(visible.sessions[0].private, true);

    const read = await api('/api/sessions/read', { id: s.id, include_private: true });
    assert.equal(read.title, 'Fix the kiln');
    assert.equal(read.messages, undefined, 'read summary only, no messages');

    const toggled = await api('/api/sessions/private', { id: s.id, private: false });
    assert.equal(toggled.private, false);
    assert.deepEqual((await api('/api/sessions', {})).sessions.map((x) => x.id), [s.id], 'no longer private; visible without include_private');
  } finally { srv.server.close(); }
});
