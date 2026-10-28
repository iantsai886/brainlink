import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { installHarnessCueListeners } from '../src/sessions/deepseek-harness-cue-plugin.mjs';
import { deepSeekSessionCueStatus, resolveClient, setDeepSeekSessionCue } from '../src/connectors.mjs';
import { listSessionEndCues, matchSessionEndCue, parseSessionEndEvent } from '../src/sessions/end-cue.mjs';
import { startSetup } from '../src/setup.mjs';

const temp = () => mkdtemp(path.join(tmpdir(), 'brainlink-dsh-cue-'));
const waitFor = async (condition) => {
  for (let i = 0; i < 50; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for Harness cue');
};

test('Harness plugin creates a cue after a successful root turn and clears it on the next turn', async () => {
  const dir = path.join(await temp(), 'cues');
  const listeners = new Map();
  const liveRoots = [];
  const ctx = {
    agents: { roots: () => [...liveRoots] },
    logger: { warn() {} },
    on(event, listener) { listeners.set(event, listener); },
  };
  installHarnessCueListeners(ctx, dir);
  const root = { id: 'root-session-123', session: { id: 'root-session-123' } };
  liveRoots.push(root);
  listeners.get('agent/created')({ agent: root });
  const child = { id: 'child-session-456', session: { id: 'child-session-456' } };
  listeners.get('agent/created')({ agent: child });
  listeners.get('agent/disposed')({ agent: child });
  assert.equal((await readdir(dir).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))).length, 0);
  listeners.get('session/event')(root.session, { type: 'turn/end', data: { reason: { kind: 'error' } } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await readdir(dir).catch(() => [])).length, 0, 'failed turns do not create a closeout cue');
  listeners.get('session/event')(root.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await waitFor(async () => (await readdir(dir).catch(() => [])).length === 1);
  const cues = await listSessionEndCues(dir);
  assert.equal(cues.length, 1);
  assert.deepEqual(Object.keys(cues[0]).sort(), ['client', 'ended_at', 'reason', 'schema', 'session_id']);
  assert.equal(cues[0].client, 'deepseek-harness');
  assert.equal(cues[0].session_id, root.id);
  assert.equal(cues[0].reason, 'turn-completed');
  assert.doesNotMatch(JSON.stringify(cues), /prompt|transcript|cwd|token|child-session/);
  listeners.get('session/event')(root.session, { type: 'turn/start' });
  await waitFor(async () => (await readdir(dir).catch(() => [])).length === 0);
  listeners.get('agent/disposed')({ agent: root });
});

test('Harness cue links only the matching imported session and rejects hook-based capture', () => {
  const cue = { client: 'deepseek-harness', session_id: 'fictional-session-id' };
  const rows = [
    { id: 's_match', client: 'deepseek-harness', source_id: '--fictional-project--/fictional-session-id/session.v4.jsonl.zstd' },
    { id: 's_wrong_client', client: 'codex', source_id: 'fictional-session-id/session.v4.jsonl.zstd' },
    { id: 's_wrong_file', client: 'deepseek-harness', source_id: 'fictional-session-id/other.jsonl' },
    { id: 's_duplicate', client: 'deepseek-harness', source_id: 'other/fictional-session-id/session.v3.jsonl' },
  ];
  assert.equal(matchSessionEndCue(cue, rows), null, 'ambiguous session IDs fail closed');
  assert.equal(matchSessionEndCue(cue, rows.slice(0, 3)), 's_match');
  assert.throws(() => parseSessionEndEvent(JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'id' }), 'deepseek-harness'), /client must be/);
});

test('old Harness turn cues expire from the reminder list', async () => {
  const dir = path.join(await temp(), 'cues');
  await mkdir(dir, { recursive: true });
  const cue = { schema: 1, client: 'deepseek-harness', session_id: 'old-session', ended_at: '2026-01-01T00:00:00.000Z', reason: 'turn-completed' };
  const id = createHash('sha256').update(`${cue.client}\0${cue.session_id}`).digest('hex');
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify(cue));
  assert.deepEqual(await listSessionEndCues(dir, { now: Date.parse('2026-01-20T00:00:00Z') }), []);
});

test('Harness cue setup is profile-scoped, reversible, and preserves unrelated entries', async () => {
  const home = await temp();
  const dshHome = path.join(home, 'dsh');
  const profile = path.join(dshHome, 'profiles', 'fictional');
  const brainHome = path.join(home, 'brainlink');
  await mkdir(profile, { recursive: true });
  const patch = path.join(profile, 'cordis.patch.yml');
  const original = '- insert:\n    - id: user-plugin\n      name: fictional-plugin\n';
  await writeFile(patch, original);
  const opts = { home, os: process.platform, env: { ...process.env, DSH_HOME: dshHome, BRAINLINK_HOME: brainHome }, now: new Date('2026-10-28T00:00:00Z') };
  await assert.rejects(() => setDeepSeekSessionCue('deepseek-harness', true, opts), /named DeepSeek Harness profile/);
  const enabled = await setDeepSeekSessionCue('deepseek-harness@fictional', true, opts);
  assert.equal(enabled.configured, true);
  assert.equal(enabled.same_process_authority, true);
  assert.equal((await deepSeekSessionCueStatus('deepseek-harness@fictional', opts)).configured, true);
  const plugin = path.join(brainHome, 'plugins', 'deepseek-harness-session-cue.mjs');
  assert.match(await readFile(plugin, 'utf8'), /turn\/end/);
  const text = await readFile(patch, 'utf8');
  assert.match(text, /user-plugin/);
  assert.match(text, /brainlink-session-end-cue/);
  assert.match(text, /deepseek-harness-session-cue\.mjs/);
  assert.ok((await readFile(plugin, 'utf8')).includes(JSON.stringify(path.join(brainHome, 'sessions', 'end-cues'))));
  assert.ok((await stat(enabled.backup)).isFile());
  const { unlink } = await import('node:fs/promises');
  await unlink(plugin);
  assert.equal((await deepSeekSessionCueStatus('deepseek-harness@fictional', opts)).configured, false, 'a missing plugin file is not shown as configured');
  await setDeepSeekSessionCue('deepseek-harness@fictional', true, opts);
  const disabled = await setDeepSeekSessionCue('deepseek-harness@fictional', false, opts);
  assert.equal(disabled.configured, false);
  assert.equal((await deepSeekSessionCueStatus('deepseek-harness@fictional', opts)).configured, false);
  const after = await readFile(patch, 'utf8');
  assert.match(after, /user-plugin/);
  assert.doesNotMatch(after, /brainlink-session-end-cue/);
  assert.equal((await stat(plugin)).isFile(), true, 'shared plugin copy remains available to other Harness profiles');
});

test('Setup reminder controls are authenticated and list only connected named Harness profiles', async () => {
  const home = await temp();
  const dshHome = path.join(home, 'dsh');
  const profile = path.join(dshHome, 'profiles', 'fictional');
  await mkdir(profile, { recursive: true });
  const client = resolveClient('deepseek-harness@fictional');
  await writeFile(path.join(profile, 'cordis.patch.yml'), `- insert:\n    - id: ${client.entryId}\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: ${client.serverName}\n        transport: stdio\n        command: node\n        args: []\n        env:\n          BRAINLINK_AGENT_TOKEN: synthetic-test-token\n`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: dshHome, BRAINLINK_HOME: path.join(home, 'brainlink') };
  const app = await startSetup({ env, home, os: process.platform, port: 0, useCli: false });
  const call = (route, body = {}, token = app.token) => fetch(`http://127.0.0.1:${app.port}/api/sessions/hooks${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': token }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await call('', {}, 'wrong')).status, 401);
    const initial = await (await call('')).json();
    const row = initial.clients.find((item) => item.client === 'deepseek-harness@fictional');
    assert.equal(row.configured, false);
    assert.equal(row.title, 'DeepSeek Harness · fictional');
    assert.equal(row.same_process_authority, true);
    assert.equal((await call('/set', { client: row.client, enabled: true })).status, 200);
    const enabled = (await (await call('')).json()).clients.find((item) => item.client === row.client);
    assert.equal(enabled.configured, true);
    assert.equal((await call('/set', { client: row.client, enabled: false })).status, 200);
    const disabled = (await (await call('')).json()).clients.find((item) => item.client === row.client);
    assert.equal(disabled.configured, false);
    assert.equal((await call('/set', { client: 'deepseek-harness@unknown', enabled: true })).status, 400);
  } finally { app.server.close(); }
});

