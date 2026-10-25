import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recordSessionEndCue, listSessionEndCues, parseSessionEndEvent, matchSessionEndCue } from '../src/sessions/end-cue.mjs';
import { startSetup } from '../src/setup.mjs';

const temp = () => mkdtemp(path.join(tmpdir(), 'brainlink-end-cue-'));
const hookEvent = (extra = {}) => JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'fictional-session-17', reason: 'other', cwd: 'C:\\Private\\Northwind', transcript_path: 'C:\\Private\\Northwind\\secret.jsonl', ...extra });

test('SessionEnd cue records only local metadata and never the transcript path or cwd', async () => {
  const dir = path.join(await temp(), 'end-cues');
  const recorded = await recordSessionEndCue({ input: hookEvent(), client: 'claude-code', dir, now: new Date('2026-10-24T03:00:00Z') });
  assert.equal(recorded.ok, true);
  assert.deepEqual(recorded.cue, { schema: 1, client: 'claude-code', session_id: 'fictional-session-17', ended_at: '2026-10-24T03:00:00.000Z', reason: 'other' });
  const files = await readdir(dir);
  assert.equal(files.length, 1);
  const raw = await readFile(path.join(dir, files[0]), 'utf8');
  assert.doesNotMatch(raw, /Northwind|secret\.jsonl|transcript_path|cwd/);
  assert.deepEqual(await listSessionEndCues(dir), [recorded.cue]);
});

test('SessionEnd cue is idempotent under duplicate and concurrent hook delivery', async () => {
  const dir = path.join(await temp(), 'end-cues');
  const input = hookEvent();
  const results = await Promise.all(Array.from({ length: 5 }, () => recordSessionEndCue({ input, client: 'codex', dir })));
  assert.equal(results.filter((r) => !r.duplicate).length, 1);
  assert.equal((await listSessionEndCues(dir)).length, 1);
});

test('SessionEnd cue accepts only supported clients and bounded well-formed event payloads', async () => {
  assert.throws(() => parseSessionEndEvent(hookEvent(), 'chatgpt'), /client must be/);
  assert.throws(() => parseSessionEndEvent('{bad', 'codex'), /valid JSON/);
  assert.throws(() => parseSessionEndEvent(JSON.stringify({ hook_event_name: 'Stop', session_id: 'x' }), 'codex'), /SessionEnd/);
  assert.throws(() => parseSessionEndEvent(JSON.stringify({ hook_event_name: 'SessionEnd', session_id: '  ' }), 'codex'), /session_id/);
  assert.throws(() => parseSessionEndEvent(' '.repeat(32 * 1024 + 1), 'codex'), /too large/);
  assert.equal(parseSessionEndEvent(hookEvent({ reason: 'do-not-persist-free-text' }), 'codex').reason, 'other');
  assert.throws(() => parseSessionEndEvent(hookEvent({ session_id: '../private' }), 'codex'), /session_id/);
});

test('SessionEnd cue links only one exact imported transcript from the same client', () => {
  const claudeCue = { client: 'claude-code', session_id: 'session-abc' };
  const codexCue = { client: 'codex', session_id: 'session-abc' };
  const rows = [
    { id: 's_claude', client: 'claude-code', source_id: 'project-a/session-abc.jsonl' },
    { id: 's_codex', client: 'codex', source_id: '2026/10/25/rollout-session-abc.jsonl' },
    { id: 's_other', client: 'claude-code', source_id: 'project-b/session-other.jsonl' },
  ];
  assert.equal(matchSessionEndCue(claudeCue, rows), 's_claude');
  assert.equal(matchSessionEndCue(codexCue, rows), 's_codex');
  assert.equal(matchSessionEndCue({ ...claudeCue, session_id: 'missing' }, rows), null);
  assert.equal(matchSessionEndCue(claudeCue, [...rows, { ...rows[0], id: 's_duplicate' }]), null, 'ambiguous source matches fail closed');
  assert.equal(matchSessionEndCue(codexCue, rows.filter((row) => row.client !== 'codex')), null, 'cross-client matches are refused');
});

test('CLI hook command records and lists a cue using the isolated BrainLink home', async () => {
  const home = await temp();
  const cli = fileURLToPath(new URL('../bin/brainlink.mjs', import.meta.url));
  const run = (args, input = '') => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, BRAINLINK_HOME: home }, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (x) => { stdout += x; });
    child.stderr.setEncoding('utf8').on('data', (x) => { stderr += x; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}: ${stderr}`)));
    child.stdin.end(input);
  });
  assert.match(await run(['session-end-cue', '--client', 'codex'], hookEvent()), /cue recorded/);
  const listed = await run(['session-end-cues']);
  assert.match(listed, /codex  session fictional-session-17/);
  assert.doesNotMatch(listed, /Northwind|secret\.jsonl/);
});

test('local cue UI API requires authentication, minimizes metadata, and preserves dismissed records', async () => {
  const taskHome = await temp();
  const env = { ...process.env, BRAINLINK_HOME: taskHome, HOME: taskHome, USERPROFILE: taskHome };
  const dir = path.join(taskHome, 'sessions', 'end-cues');
  const transcript = path.join(taskHome, '.codex', 'sessions', '2026', '10', '25', 'rollout-fictional-session-17.jsonl');
  await mkdir(path.dirname(transcript), { recursive: true });
  await writeFile(transcript, [
    { timestamp: '2026-10-25T01:00:00.000Z', type: 'session_meta', payload: { id: 'fictional-session-17', cwd: 'C:\\Private\\Northwind' } },
    { timestamp: '2026-10-25T01:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fictional private project question' }] } },
    { timestamp: '2026-10-25T01:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fictional private project outcome' }] } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  await recordSessionEndCue({ input: hookEvent(), client: 'codex', dir });
  const app = await startSetup({ env, home: taskHome, os: 'win32', port: 0, useCli: false });
  const call = (route, body = {}, token = app.token) => fetch(`http://127.0.0.1:${app.port}/api/sessions/end-cues${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': token }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await call('', {}, 'wrong')).status, 401);
    const { cues } = await (await call('')).json();
    assert.equal(cues.length, 1);
    assert.deepEqual(Object.keys(cues[0]).sort(), ['client', 'ended_at', 'id', 'session_ref']);
    assert.match(cues[0].session_ref, /^s_[a-f0-9]{16}$/);
    assert.doesNotMatch(JSON.stringify(cues), /fictional-session|Northwind|transcript_path|Fictional private project/);
    const readSession = (includePrivate) => fetch(`http://127.0.0.1:${app.port}/api/sessions/read`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': app.token },
      body: JSON.stringify({ id: cues[0].session_ref, include_private: includePrivate }),
    });
    const withheld = await (await readSession(false)).json();
    assert.equal(withheld.private, true, 'cue matching does not disclose the private summary');
    const explicitlyReviewed = await (await readSession(true)).json();
    assert.match(explicitlyReviewed.summary, /Fictional private project/);
    assert.equal((await (await call('/dismiss', { id: cues[0].id })).json()).ok, true);
    assert.deepEqual((await (await call('')).json()).cues, []);
    assert.match(await readFile(path.join(dir, `${cues[0].id}.json`), 'utf8'), /fictional-session-17/);
    await recordSessionEndCue({ input: hookEvent(), client: 'codex', dir });
    assert.deepEqual(await listSessionEndCues(dir), [], 'duplicate delivery must not revive a dismissed reminder');
    assert.equal((await call('/dismiss', { id: '../config' })).ok, false);
  } finally { app.server.close(); }
});
