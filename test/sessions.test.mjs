import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

import { redactText } from '../src/sessions/redact.mjs';
import { estTokens, clip } from '../src/sessions/tokens.mjs';
import { createSessionStore } from '../src/sessions/store.mjs';
import { createSessionRefresher } from '../src/sessions/index.mjs';
import { importClaudeCode, defaultRoot as defaultClaudeRoot } from '../src/sessions/claude-code.mjs';
import { importCodex, defaultRoot as defaultCodexRoot, defaultHistoryFile } from '../src/sessions/codex.mjs';
import { importDeepSeekHarness, defaultRoot as defaultDeepSeekHarnessRoot } from '../src/sessions/deepseek-harness.mjs';
import { importHermes, defaultRoot as defaultHermesRoot } from '../src/sessions/hermes.mjs';
import { autoSummary } from '../src/sessions/import-util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const tmp = (p) => mkdtemp(path.join(tmpdir(), `brainlink-${p}-`));

test('automatic session excerpt keeps goal, latest meaningful direction, and final reply in separate token budgets', () => {
  const summary = autoSummary([
    { role: 'user', text: `Build the fictional garden planner. ${'opening detail '.repeat(120)}` },
    { role: 'assistant', text: 'I inspected the sample project.' },
    { role: 'user', text: 'continue' },
    { role: 'user', text: `Keep the planner private and add a recovery export. ${'recent detail '.repeat(30)}` },
    { role: 'assistant', text: `API_TOKEN=classified-value. Implemented the private planner and tested restore in an isolated folder. ${'final detail '.repeat(80)}` },
  ]);
  assert.match(summary, /Goal: Build the fictional garden planner/);
  assert.match(summary, /Latest direction: Keep the planner private and add a recovery export/);
  assert.match(summary, /Last reply \(unverified\): API_TOKEN=\[REDACTED\] Implemented the private planner and tested restore/);
  assert.match(summary, /API_TOKEN=\[REDACTED\]/);
  assert.doesNotMatch(summary, /classified-value/);
  assert.ok(estTokens(summary) <= 115, `summary should remain compact, got ${estTokens(summary)} tokens`);
});

test('automatic session excerpt avoids duplicating one-turn sessions and handles user-only history', () => {
  const oneTurn = autoSummary([{ role: 'user', text: 'Write a short project note.' }, { role: 'assistant', text: 'Saved the draft.' }]);
  assert.equal((oneTurn.match(/Goal:/g) || []).length, 1);
  assert.match(oneTurn, /Last reply \(unverified\): Saved the draft\./);
  assert.equal(autoSummary([{ role: 'user', text: 'Check local project status.' }, { role: 'user', text: 'okay' }]), 'Goal: Check local project status.');
});

// Tests never read real ~/.claude or ~/.codex; fixtures are small fake histories only.
test('session importer paths default under the real home (not exercised here) and accept an override root', () => {
  assert.match(defaultClaudeRoot('/home/x'), /\.claude[\/\\]projects$/);
  assert.match(defaultCodexRoot('/home/x'), /\.codex[\/\\]sessions$/);
  assert.match(defaultHistoryFile('/home/x'), /\.codex[\/\\]history\.jsonl$/);
  assert.match(defaultDeepSeekHarnessRoot('/home/x', {}), /\.dsh[\/\\]sessions$/);
  assert.equal(defaultDeepSeekHarnessRoot('/home/x', { DSH_HOME: '/custom/dsh' }), path.join('/custom/dsh', 'sessions'));
  assert.equal(defaultHermesRoot('/home/x', { HERMES_HOME: '/custom/hermes' }), path.resolve('/custom/hermes'));
  assert.equal(defaultHermesRoot('/home/x', {}), path.resolve(process.platform === 'win32'
    ? path.join('/home/x', 'AppData', 'Local', 'hermes') : '/home/x/.hermes'));
});

// ---- redact ----

test('redact: API keys, tokens, private keys, emails and a planted key=value password', () => {
  const planted = 'DB_PASSWORD=hunter2SECRET';
  const out = redactText(`key sk-${'a'.repeat(32)} token ghp_${'b'.repeat(36)} mail a.b@example.com\n${planted}`);
  assert.ok(!out.includes('hunter2SECRET'), 'planted password value must not survive');
  assert.ok(!out.includes('sk-' + 'a'.repeat(32)));
  assert.ok(!out.includes('ghp_' + 'b'.repeat(36)));
  assert.ok(!out.includes('a.b@example.com'));
  assert.match(out, /DB_PASSWORD=\[REDACTED\]/);
});

test('redact: env-style API key assignment and URL credentials', () => {
  const out = redactText('STRIPE_API_KEY=sk_live_demoFAKEKEY1234567890 and postgres://user:s3cret@host/db');
  assert.ok(!out.includes('sk_live_demoFAKEKEY1234567890'));
  assert.ok(!out.includes('user:s3cret@'));
  assert.match(out, /postgres:\/\/\[REDACTED\]@host\/db/);
});

// ---- tokens ----

test('tokens: estTokens counts CJK chars as 1 and clip stays under budget', () => {
  assert.equal(estTokens('abcd'), 1);
  assert.ok(estTokens('知識') <= 2);
  const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  const clipped = clip(long, 10);
  assert.ok(estTokens(clipped) <= 10);
});

// ---- local session store ----

test('session store: persists across reopen; setSessionPrivate toggles and survives', async () => {
  const dir = await tmp('sessions-store');
  let store = await createSessionStore({ dir });
  const s = await store.putSession({ client: 'claude-code', source_id: 'p/1', project: '/x', title: 'T', summary: 'S', started_at: '2026-10-10T00:00:00Z', note_refs: [], private: true, messages: [{ role: 'user', at: '2026-10-10T00:00:00Z', text: 'hello' }] });
  assert.equal(s.private, true);
  store = await createSessionStore({ dir }); // reopen: must load from disk
  assert.equal((await store.listSessions()).length, 1);
  const made = await store.setSessionPrivate(s.id, false);
  assert.equal(made.private, false);
  store = await createSessionStore({ dir });
  assert.equal((await store.listSessions())[0].private, false);
});

test('session store: explicit Twin assignment is one-way, private, and survives reopen', async () => {
  const dir = await tmp('sessions-twin-owner');
  let store = await createSessionStore({ dir });
  const session = await store.putSession({ client: 'codex', source_id: 'fictional/1', project: '/fictional', title: 'Synthetic work', summary: 'No real personal data.', started_at: '2026-10-24T00:00:00Z', note_refs: [], private: false, messages: [{ role: 'user', at: '2026-10-24T00:00:00Z', text: 'Synthetic message.' }] });
  const assigned = await store.assignSessionProfile(session.id, 'personal_twin');
  assert.equal(assigned.profile_id, 'personal_twin');
  assert.equal(assigned.private, true, 'Twin assignment always keeps the source private');
  await assert.rejects(store.assignSessionProfile(session.id, 'org_twin'), /already belongs/);
  await assert.rejects(store.setSessionPrivate(session.id, false), /must remain private/);
  store = await createSessionStore({ dir });
  const persisted = await store.readSession(session.id, { profile_id: 'personal_twin', limit: 10 });
  assert.equal(persisted.session.private, true);
  assert.equal(persisted.messages[0].text, 'Synthetic message.');
  await assert.rejects(store.readSession(session.id, { profile_id: 'org_twin' }), (error) => error.code === 'E_NOT_FOUND');
});

test('session store fails closed on a corrupt journal and preserves the original bytes', async () => {
  const dir = await tmp('sessions-corrupt');
  const file = path.join(dir, 'sessions.jsonl');
  const corrupted = '{"session":{"client":"codex"},"messages":[]}\n{not-valid-json}\n';
  await writeFile(file, corrupted, 'utf8');
  const store = await createSessionStore({ dir });
  await assert.rejects(store.listSessions(), SyntaxError);
  assert.equal(await readFile(file, 'utf8'), corrupted, 'opening a damaged journal must never treat it as empty or replace it');
});

test('session refresher throttles routine transcript scans but can force a fresh import', async () => {
  const home = await tmp('session-refresh');
  const appHome = path.join(home, 'brainlink-data');
  const env = { HOME: home, BRAINLINK_HOME: appHome };
  const store = await createSessionStore({ dir: path.join(appHome, 'sessions') });
  let now = 1_000_000;
  const refresh = createSessionRefresher({ getStore: async () => store, env, clock: () => now, cooldownMs: 5000 });
  const root = path.join(home, '.codex', 'sessions', '2026', '10', '26');
  await mkdir(root, { recursive: true });
  const writeRollout = async (id, prompt) => writeFile(path.join(root, `rollout-${id}.jsonl`), [
    JSON.stringify({ type: 'session_meta', payload: { id, cwd: path.join(home, 'fictional-project') } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-10-26T01:00:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }),
  ].join('\n') + '\n');
  await writeRollout('first', 'Synthetic first session');
  await refresh();
  assert.equal((await store.listSessions()).length, 1);
  await writeRollout('second', 'Synthetic second session');
  now += 1000;
  await refresh();
  assert.equal((await store.listSessions()).length, 1, 'recent routine reads use the cached import');
  await refresh({ force: true });
  assert.equal((await store.listSessions()).length, 2, 'an explicit session review imports new transcripts immediately');
  now += 5000;
  await refresh();
  assert.equal((await store.listSessions()).length, 2, 'routine refresh resumes after the cooldown');
});

// ---- Claude Code importer ----

test('claude-code importer: imports fixture session, redacts secrets, skips tool_use, idempotent re-run', async () => {
  const dir = await tmp('cc-import');
  const store = await createSessionStore({ dir });
  const root = path.join(FIXTURES, 'claude-code', 'projects');
  const cursorsFile = path.join(dir, 'cursors.json');
  const r1 = await importClaudeCode({ store, root, cursorsFile });
  assert.equal(r1.imported, 1);
  assert.equal(r1.errors.length, 0);
  const list = await store.listSessions();
  assert.equal(list.length, 1);
  const s = list[0];
  assert.equal(s.client, 'claude-code');
  assert.equal(s.project, '/home/demo/garden-app');
  assert.equal(s.private, true, 'imported sessions default to private');
  assert.equal(s.summary, 'Fixed the watering script to skip watering when it rains.');
  const page = await store.readSession(s.id, { limit: 50 });
  const blob = JSON.stringify(page);
  assert.ok(!blob.includes('hunter2SECRET'), 'secret redacted before it ever reaches the store');
  assert.ok(!blob.includes('Edit'), 'tool_use blocks are never imported, only message text');
  assert.equal(page.messages.length, 4, 'only user/assistant text lines; the summary line is metadata, not a message');

  const r2 = await importClaudeCode({ store, root, cursorsFile });
  assert.equal(r2.imported, 0);
  assert.equal(r2.unchanged, 1, 're-running with unchanged files imports nothing twice');
  assert.equal((await store.listSessions()).length, 1);
});

// ---- Codex importer ----

test('codex importer: rollouts take priority, skips function_call/output/event_msg, redacts keys', async () => {
  const dir = await tmp('codex-import');
  const store = await createSessionStore({ dir });
  const root = path.join(FIXTURES, 'codex', 'sessions');
  const historyFile = path.join(FIXTURES, 'codex', 'history.jsonl');
  const r = await importCodex({ store, root, historyFile, cursorsFile: path.join(dir, 'cursors.json') });
  assert.equal(r.source, 'rollouts');
  assert.equal(r.imported, 1);
  const list = await store.listSessions();
  assert.equal(list.length, 1);
  assert.equal(list[0].project, '/home/demo/notes-app');
  const page = await store.readSession(list[0].id, { limit: 50 });
  const blob = JSON.stringify(page);
  assert.ok(!blob.includes('sk-' + 'a'.repeat(50)));
  assert.ok(!blob.includes('function_call'), 'tool call items never reach the store');
  assert.ok(!blob.includes('token_count'));
  assert.equal(page.messages.length, 2);
});

// ---- DeepSeek Harness importer ----

test('DeepSeek Harness importer: reads concatenated Zstandard frames, imports only direct visible text, redacts, and stays private', async () => {
  const dir = await tmp('dsh-import');
  const store = await createSessionStore({ dir });
  const root = path.join(dir, 'dsh', 'sessions');
  const sessionDir = path.join(root, '--fictional-project--', 'fictional-session-id');
  await mkdir(sessionDir, { recursive: true });
  const at = Date.parse('2026-10-28T01:00:00.000Z');
  const lines = [
    { type: 'session', version: 4, id: 'fictional-session-id', cwd: '/fictional/project', createdAt: at, isSeeded: false },
    { type: 'user/message', seq: 0, time: at, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Build a fictional garden app. API_TOKEN=synthetic-secret-value' }] } },
    { type: 'user/message', seq: 1, time: at + 1, data: { role: 'user', source: { kind: 'plugin', plugin: 'fictional-context' }, content: [{ type: 'text', text: 'INJECTED_PRIVATE_CANARY' }] } },
    { type: 'assistant/message', seq: 2, time: at + 2, data: { message: { role: 'assistant', provider: 'fake', model: 'fixture', content: [{ type: 'text', text: 'The fictional garden app is ready.' }, { type: 'reasoning', text: 'PRIVATE_REASONING_CANARY' }] } } },
    { type: 'tool/result', seq: 3, time: at + 3, data: { message: { role: 'tool', content: [{ type: 'text', text: 'PRIVATE_TOOL_CANARY' }] } } },
  ].map((line) => JSON.stringify(line) + '\n');
  const file = path.join(sessionDir, 'session.v4.jsonl.zstd');
  // Harness writes independent concatenated frames (one header frame, then event batches).
  await writeFile(file, Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(line)))));
  const cursorsFile = path.join(dir, 'cursors.json');
  const first = await importDeepSeekHarness({ store, root, cursorsFile });
  assert.equal(first.imported, 1);
  assert.deepEqual(first.errors, []);
  const [session] = await store.listSessions();
  assert.equal(session.client, 'deepseek-harness');
  assert.equal(session.project, '/fictional/project');
  assert.equal(session.private, true);
  const page = await store.readSession(session.id, { limit: 20 });
  assert.deepEqual(page.messages.map((m) => m.role), ['user', 'assistant']);
  const serialized = JSON.stringify(page);
  assert.doesNotMatch(serialized, /synthetic-secret-value|INJECTED_PRIVATE_CANARY|PRIVATE_REASONING_CANARY|PRIVATE_TOOL_CANARY/);
  assert.match(serialized, /API_TOKEN=\[REDACTED\]/);
  const second = await importDeepSeekHarness({ store, root, cursorsFile });
  assert.equal(second.imported, 0);
  assert.equal(second.unchanged, 1);
});

test('DeepSeek Harness importer: supports raw v3 JSONL and leaves unsupported or malformed logs retryable', async () => {
  const dir = await tmp('dsh-raw-import');
  const store = await createSessionStore({ dir });
  const root = path.join(dir, 'sessions');
  const rawDir = path.join(root, '_no-cwd_', 'fictional-raw-id');
  const badDir = path.join(root, '_no-cwd_', 'fictional-bad-id');
  await mkdir(rawDir, { recursive: true });
  await mkdir(badDir, { recursive: true });
  const at = Date.parse('2026-10-28T02:00:00.000Z');
  const raw = [
    { type: 'session', version: 3, id: 'fictional-raw-id', createdAt: at, isSeeded: false },
    { type: 'user/message', seq: 0, time: at, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Fictional raw session' }] } },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n';
  await writeFile(path.join(rawDir, 'session.v3.jsonl'), raw);
  await writeFile(path.join(badDir, 'session.v5.jsonl'), JSON.stringify({ type: 'session', version: 5, id: 'fictional-future', createdAt: at }) + '\n');
  const cursorsFile = path.join(dir, 'cursors.json');
  const imported = await importDeepSeekHarness({ store, root, cursorsFile });
  assert.equal(imported.imported, 1);
  assert.equal(imported.errors.length, 1);
  assert.match(imported.errors[0].error, /supported formats: v3 and v4/);
  const cursors = JSON.parse(await readFile(cursorsFile, 'utf8'));
  assert.equal(Object.keys(cursors).length, 1, 'unsupported data must not advance its cursor');
  assert.equal((await store.listSessions())[0].client, 'deepseek-harness');
});

test('Hermes importer reads only ended CLI active user/assistant text, redacts secrets, pages, and never writes source DB', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = await tmp('hermes-import');
  const root = path.join(dir, 'hermes');
  const dbFile = path.join(root, 'state.db');
  await mkdir(root, { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT, title TEXT, cwd TEXT, started_at REAL, ended_at REAL);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL,
      active INTEGER, reasoning TEXT, tool_calls TEXT);
    INSERT INTO sessions VALUES
      ('cli-ended', 'cli', 'Fictional app work', '/fictional/project', 1793149200, 1793149260),
      ('cli-open', 'cli', 'Still running', '/fictional/project', 1793149200, NULL),
      ('telegram-ended', 'telegram', 'Private chat', NULL, 1793149200, 1793149260);
    INSERT INTO messages VALUES
      (1, 'cli-ended', 'user', 'Build a fictional garden app. API_TOKEN=synthetic-hermes-secret', 1793149201, 1, NULL, NULL),
      (2, 'cli-ended', 'assistant', 'The fictional garden app is ready.', 1793149202, 1, 'PRIVATE_REASONING_CANARY', '[{"name":"tool_canary"}]'),
      (3, 'cli-ended', 'assistant', 'Archived duplicate text.', 1793149203, 0, 'ARCHIVED_REASONING_CANARY', NULL),
      (4, 'cli-ended', 'tool', 'PRIVATE_TOOL_CANARY', 1793149204, 1, NULL, NULL),
      (5, 'telegram-ended', 'user', 'PRIVATE_TELEGRAM_CANARY', 1793149201, 1, NULL, NULL);`);
  db.close();
  const before = await readFile(dbFile);
  const store = await createSessionStore({ dir: path.join(dir, 'brainlink') });
  const cursorsFile = path.join(dir, 'brainlink', 'cursors.json');
  const first = await importHermes({ store, root, cursorsFile });
  assert.equal(first.imported, 1);
  assert.deepEqual(first.errors, []);
  const rows = await store.listSessions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].client, 'hermes');
  assert.equal(rows[0].private, true);
  assert.equal(rows[0].project, '/fictional/project');
  const page = await store.readSession(rows[0].id, { limit: 20 });
  assert.deepEqual(page.messages.map((m) => m.role), ['user', 'assistant']);
  const visible = JSON.stringify(page);
  assert.match(visible, /API_TOKEN=\[REDACTED\]/);
  assert.match(visible, /fictional garden app is ready/);
  assert.doesNotMatch(visible, /synthetic-hermes-secret|PRIVATE_REASONING|ARCHIVED_REASONING|PRIVATE_TOOL|PRIVATE_TELEGRAM|tool_canary/);
  assert.deepEqual(await readFile(dbFile), before, 'read-only import must not change the Hermes database');

  const later = new DatabaseSync(dbFile);
  later.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run('cli-later', 'cli', 'Later session', '', 1793149300, 1793149360);
  later.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(6, 'cli-later', 'user', 'A later fictional task.', 1793149301, 1, null, null);
  later.close();
  const second = await importHermes({ store, root, cursorsFile });
  assert.equal(second.imported, 1, 'incremental cursor should pick up the next ended CLI session');
  assert.equal((await store.listSessions()).length, 2);
});

test('Hermes importer safely skips when no local state database exists', async () => {
  const dir = await tmp('hermes-empty');
  const store = await createSessionStore({ dir });
  const result = await importHermes({ store, root: path.join(dir, 'missing') });
  assert.equal(result.files, 0);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(await store.listSessions(), []);
});

test('Hermes importer refuses a database without an active-message marker', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = await tmp('hermes-legacy-schema');
  const root = path.join(dir, 'hermes');
  await mkdir(root, { recursive: true });
  const db = new DatabaseSync(path.join(root, 'state.db'));
  db.exec(`CREATE TABLE sessions(id TEXT, source TEXT, started_at REAL, ended_at REAL);
    CREATE TABLE messages(id INTEGER, session_id TEXT, role TEXT, content TEXT, timestamp REAL);`);
  db.close();
  const store = await createSessionStore({ dir: path.join(dir, 'brainlink') });
  const result = await importHermes({ store, root });
  assert.equal(result.imported, 0);
  assert.match(result.errors[0].error, /missing active/);
  assert.deepEqual(await store.listSessions(), []);
});

test('codex importer: falls back to history.jsonl when no rollout files exist, grouped by session_id', async () => {
  const dir = await tmp('codex-history');
  const store = await createSessionStore({ dir });
  const emptyRoot = await tmp('codex-empty-root');
  const historyFile = path.join(FIXTURES, 'codex', 'history.jsonl');
  const r = await importCodex({ store, root: emptyRoot, historyFile, cursorsFile: path.join(dir, 'cursors.json') });
  assert.equal(r.source, 'history');
  assert.equal(r.imported, 1);
  const list = await store.listSessions();
  assert.equal(list.length, 1);
  assert.equal(list[0].client, 'codex');
  const page = await store.readSession(list[0].id, { limit: 50 });
  const blob = JSON.stringify(page);
  assert.ok(!blob.includes('sk_live_demoFAKEKEY1234567890'));
  assert.equal(page.messages.length, 2);
  assert.ok(page.messages.every((m) => m.role === 'user'), 'history.jsonl has no assistant replies');
});
