import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { setSessionHook, sessionHookStatus, setHermesSessionHook, hermesSessionHookStatus } from '../src/sessions/hooks.mjs';
import { listSessionEndCues, recordSessionEndCue, matchSessionEndCue } from '../src/sessions/end-cue.mjs';
import { hermesSourceId } from '../src/sessions/hermes.mjs';
import { parseDocument } from 'yaml';
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

test('Hermes finalize hook is opt-in, profile-scoped, reversible, and stores only an opaque cue', async () => {
  const taskHome = await mkdtemp(path.join(tmpdir(), 'bl-hermes-hook-'));
  const profile = path.join(taskHome, 'Hermes profile');
  const brainHome = path.join(taskHome, 'BrainLink data');
  const env = { ...process.env, BRAINLINK_HOME: brainHome };
  const config = path.join(profile, 'config.yaml');
  const original = '# keep this comment\nmodel: deepseek/deepseek-chat\nhooks:\n  on_session_finalize:\n    - command: "echo unrelated"\n      timeout: 4\n  on_session_start:\n    - command: "echo keep"\n';
  await mkdir(profile, { recursive: true });
  await writeFile(config, original);
  const enabled = await setHermesSessionHook(profile, true, { env, os: process.platform });
  assert.equal(enabled.configured, true);
  assert.equal(await readFile(enabled.backup, 'utf8'), original);
  assert.equal((await hermesSessionHookStatus(profile)).configured, true);
  const configured = parseDocument(await readFile(config, 'utf8'));
  assert.match(configured.toString(), /keep this comment/);
  assert.equal(configured.getIn(['hooks', 'on_session_start', 0, 'command']), 'echo keep');
  const entries = configured.getIn(['hooks', 'on_session_finalize']);
  assert.equal(entries.items.length, 2, 'unrelated Hermes finalize hook is retained');
  const command = entries.items.map((item) => item.get('command')).find((value) => value.includes('session-end-cue') && value.includes('--client') && value.includes('hermes'));
  assert.ok(command);
  assert.match(command, /--session-root/);
  assert.equal((await setHermesSessionHook(profile, true, { env })).changed, false, 'repeated enable does not duplicate');

  const event = JSON.stringify({ hook_event_name: 'on_session_finalize', session_id: 'private-hermes-session', cwd: 'C:/Private/Project', extra: { platform: 'cli', conversation_history: ['private transcript'] } });
  const cueRun = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, 'session-end-cue', '--client', 'hermes', '--data-home', brainHome, '--session-root', profile], { windowsHide: true, env });
    let stderr = '', stdout = '';
    child.stdout.setEncoding('utf8').on('data', (x) => { stdout += x; });
    child.stderr.setEncoding('utf8').on('data', (x) => { stderr += x; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `exit ${code}`)));
    child.stdin.end(event);
  });
  assert.match(cueRun, /cue recorded/);
  const cues = await listSessionEndCues(path.join(brainHome, 'sessions', 'end-cues'));
  assert.equal(cues.length, 1);
  assert.equal(cues[0].client, 'hermes');
  assert.equal(cues[0].session_id, hermesSourceId(profile, 'private-hermes-session'));
  assert.doesNotMatch(JSON.stringify(cues), /private-hermes-session|Private\/Project|private transcript|conversation_history/);
  assert.equal(matchSessionEndCue(cues[0], [{ id: 's_fake', client: 'hermes', source_id: hermesSourceId(profile, 'private-hermes-session') }]), 's_fake');
  await assert.rejects(() => recordSessionEndCue({ input: JSON.stringify({ hook_event_name: 'on_session_finalize', session_id: 'other', platform: 'telegram' }), client: 'hermes', dir: path.join(taskHome, 'cues'), sessionRoot: profile }), /CLI sessions only/);

  const disabled = await setHermesSessionHook(profile, false, { env });
  assert.equal(disabled.configured, false);
  assert.equal((await hermesSessionHookStatus(profile)).configured, false);
  const restored = await readFile(config, 'utf8');
  assert.match(restored, /keep this comment/);
  assert.match(restored, /echo unrelated/);
  assert.match(restored, /echo keep/);
  assert.doesNotMatch(restored, /session-end-cue --client hermes/);
});

test('Hermes hook installer refuses malformed YAML or event shape without overwriting it', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'bl-hermes-bad-'));
  const file = path.join(profile, 'config.yaml');
  for (const raw of ['hooks: [bad', 'hooks:\n  on_session_finalize: invalid\n']) {
    await writeFile(file, raw);
    await assert.rejects(setHermesSessionHook(profile, true), /invalid YAML|unsupported structure/);
    assert.equal(await readFile(file, 'utf8'), raw);
  }
});

test('Setup hook controls require authentication and explicit boolean consent', async () => {
  const taskHome = await mkdtemp(path.join(tmpdir(), 'bl-hook-api-'));
  const hermesHome = path.join(taskHome, 'hermes-profile');
  await mkdir(hermesHome, { recursive: true });
  const env = { ...process.env, HOME: taskHome, USERPROFILE: taskHome, HERMES_HOME: hermesHome, BRAINLINK_HOME: path.join(taskHome, 'data'), CODEX_HOME: path.join(taskHome, 'codex'), CLAUDE_CONFIG_DIR: path.join(taskHome, 'claude') };
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
    const hermes = clients.find((c) => c.client === 'hermes');
    assert.equal(hermes.configured, false);
    assert.equal(hermes.privileged_shell_hook, true);
    const hermesEnabled = await (await call('/set', { client: 'hermes', enabled: true })).json();
    assert.equal(hermesEnabled.configured, true, JSON.stringify(hermesEnabled));
    assert.equal((await call('/set', { client: 'hermes', enabled: 'false' })).ok, false);
    assert.equal((await (await call('/set', { client: 'hermes', enabled: false })).json()).configured, false);
    assert.equal((await (await call('/set', { client: 'codex', enabled: false })).json()).configured, false);
  } finally { app.server.close(); }
});
