import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recordSessionEndCue, listSessionEndCues, parseSessionEndEvent } from '../src/sessions/end-cue.mjs';

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
