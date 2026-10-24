import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { setSessionHook, sessionHookStatus } from '../src/sessions/hooks.mjs';
import { listSessionEndCues } from '../src/sessions/end-cue.mjs';
import { startSetup } from '../src/setup.mjs';
import { CLI_PATH } from '../src/runtime.mjs';

test('hook enable/disable preserves unrelated settings, backs up originals and emits a working isolated command', async () => {
  const taskHome = await mkdtemp(path.join(tmpdir(), 'bl-hook-home with spaces-'));
  const env = { BRAINLINK_HOME: path.join(taskHome, 'BrainLink Data'), CODEX_HOME: path.join(taskHome, 'Codex'), CLAUDE_CONFIG_DIR: path.join(taskHome, 'Claude') };
  const opts = { home: taskHome, env };
  for (const client of ['claude-code', 'codex']) {
    const file = client === 'codex' ? path.join(env.CODEX_HOME, 'hooks.json') : path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
    await mkdir(path.dirname(file), { recursive: true });
    const original = { theme: 'dark', hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'echo unrelated' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo keep' }] }] } };
    const raw = JSON.stringify(original);
    await writeFile(file, raw);
    const result = await setSessionHook(client, true, opts);
    assert.equal(await readFile(result.backup, 'utf8'), raw);
    assert.equal((await sessionHookStatus(client, opts)).configured, true);
    const configured = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(configured.hooks.Stop, original.hooks.Stop);
    assert.deepEqual(configured.hooks.SessionEnd[0], original.hooks.SessionEnd[0]);
    assert.equal((await setSessionHook(client, true, opts)).changed, false, 'repeated enabling must not duplicate the handler');
    const command = configured.hooks.SessionEnd[1].hooks[0].command;
    await new Promise((resolve, reject) => {
      const child = spawn(command, { shell: true, windowsHide: true, env: { ...process.env, ...env } });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`)));
      child.stdin.end(JSON.stringify({ hook_event_name: 'SessionEnd', session_id: `fake-${client}`, reason: 'other', transcript_path: '/unreadable/private.jsonl' }));
    });
    await setSessionHook(client, false, opts);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original);
    assert.equal((await sessionHookStatus(client, opts)).configured, false);
  }
  assert.equal((await listSessionEndCues(path.join(env.BRAINLINK_HOME, 'sessions', 'end-cues'))).length, 2);
  for (const client of ['claude-code', 'codex']) await setSessionHook(client, true, opts);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, 'disconnect-all'], { windowsHide: true, env: { ...process.env, ...env, HOME: taskHome, USERPROFILE: taskHome, APPDATA: path.join(taskHome, 'AppData') } });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`disconnect-all exited ${code}`)));
  });
  for (const client of ['claude-code', 'codex']) assert.equal((await sessionHookStatus(client, opts)).configured, false, 'uninstall cleanup removes marked handlers');
});

test('hook installer refuses malformed client settings without rewriting them', async () => {
  const taskHome = await mkdtemp(path.join(tmpdir(), 'bl-hook-bad-'));
  const env = { CODEX_HOME: taskHome, BRAINLINK_HOME: path.join(taskHome, 'data') };
  const file = path.join(taskHome, 'hooks.json');
  for (const raw of ['{broken', '{"hooks":{"SessionEnd":"bad"}}']) {
    await writeFile(file, raw);
    await assert.rejects(setSessionHook('codex', true, { home: taskHome, env }), /JSON|structure/);
    assert.equal(await readFile(file, 'utf8'), raw);
  }
});

test('Setup hook controls require authentication and explicit boolean consent', async () => {
  const taskHome = await mkdtemp(path.join(tmpdir(), 'bl-hook-api-'));
  const env = { ...process.env, HOME: taskHome, USERPROFILE: taskHome, BRAINLINK_HOME: path.join(taskHome, 'data'), CODEX_HOME: path.join(taskHome, 'codex'), CLAUDE_CONFIG_DIR: path.join(taskHome, 'claude') };
  const app = await startSetup({ home: taskHome, env, port: 0, useCli: false });
  const call = (route, body = {}, token = app.token) => fetch(`http://127.0.0.1:${app.port}/api/sessions/hooks${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': token }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await call('/set', { client: 'codex', enabled: true }, 'wrong')).status, 401);
    assert.equal((await call('/set', { client: 'codex', enabled: 'false' })).ok, false);
    assert.equal((await (await call('/set', { client: 'codex', enabled: true })).json()).configured, true);
    const { clients } = await (await call('')).json();
    assert.equal(clients.find((c) => c.client === 'codex').configured, true);
    assert.equal(clients.find((c) => c.client === 'codex').trust_required, true);
    assert.equal((await (await call('/set', { client: 'codex', enabled: false })).json()).configured, false);
  } finally { app.server.close(); }
});
