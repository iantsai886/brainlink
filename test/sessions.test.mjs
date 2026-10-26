import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactText } from '../src/sessions/redact.mjs';
import { estTokens, clip } from '../src/sessions/tokens.mjs';
import { createSessionStore } from '../src/sessions/store.mjs';
import { createSessionRefresher } from '../src/sessions/index.mjs';
import { importClaudeCode, defaultRoot as defaultClaudeRoot } from '../src/sessions/claude-code.mjs';
import { importCodex, defaultRoot as defaultCodexRoot, defaultHistoryFile } from '../src/sessions/codex.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const tmp = (p) => mkdtemp(path.join(tmpdir(), `brainlink-${p}-`));

// Tests never read real ~/.claude or ~/.codex; fixtures are small fake histories only.
test('session importer paths default under the real home (not exercised here) and accept an override root', () => {
  assert.match(defaultClaudeRoot('/home/x'), /\.claude[\/\\]projects$/);
  assert.match(defaultCodexRoot('/home/x'), /\.codex[\/\\]sessions$/);
  assert.match(defaultHistoryFile('/home/x'), /\.codex[\/\\]history\.jsonl$/);
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
