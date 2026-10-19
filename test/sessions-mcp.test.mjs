import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { normalize } from '../src/config.mjs';
import { createContext } from '../src/core.mjs';
import { createMcp } from '../src/server.mjs';
import { openSessionStore } from '../src/sessions/index.mjs';
import { estTokens } from '../src/sessions/tokens.mjs';

const tmp = (p) => mkdtemp(path.join(tmpdir(), `brainlink-${p}-`));
const PAID = { valid: true, plan: 'personal', email: 'test@example.com' };

async function mcpWithHome(extraEnv = {}) {
  const home = await tmp('sess-mcp');
  const env = { BRAINLINK_HOME: home, BRAINLINK_AI_PLATFORM: 'Claude', BRAINLINK_SEMANTIC: '0', ...extraEnv };
  const ctx = createContext(normalize({}), { env, license: PAID });
  return { mcp: createMcp(ctx), ctx, env };
}

async function call(mcp, name, args = {}) {
  const res = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(!res.result.isError, `${name} should not error: ${res.result.content?.[0]?.text}`);
  return JSON.parse(res.result.content[0].text);
}

test('session_log creates a private-by-default session; session_list hides it unless include_private', async () => {
  const { mcp } = await mcpWithHome();
  const logged = await call(mcp, 'session_log', { title: 'Quick note', text: 'Remember to check the kiln schedule.' });
  assert.ok(logged.id && logged.message_count === 1);
  assert.deepEqual((await call(mcp, 'session_list', {})).sessions, []);
  const visible = await call(mcp, 'session_list', { include_private: true });
  assert.equal(visible.sessions.length, 1);
  const rec = visible.sessions[0];
  assert.deepEqual(Object.keys(rec).sort(), ['client', 'id', 'private', 'project', 'started_at', 'summary', 'turns'].sort());
  assert.equal(rec.private, true);
  assert.equal(rec.turns, 1);

  await assert.rejects(call(mcp, 'session_read', { id: logged.id }), /private/i);
  const read = await call(mcp, 'session_read', { id: logged.id, include_private: true });
  assert.equal(read.message_count, 1);
  assert.equal(read.messages, undefined, 'default session_read returns no messages');
  assert.equal(read.key_turns.length, 1);
  assert.equal(read.key_turns[0].text, 'Remember to check the kiln schedule.');
});

test('session_log secret filter: a planted key never reaches storage', async () => {
  const { mcp } = await mcpWithHome();
  const logged = await call(mcp, 'session_log', { text: 'DB_PASSWORD=hunter2SECRET and done.' });
  const read = await call(mcp, 'session_read', { id: logged.id, include_private: true });
  assert.ok(!JSON.stringify(read).includes('hunter2SECRET'));
});

test('session_log appends to an existing session by id', async () => {
  const { mcp } = await mcpWithHome();
  const a = await call(mcp, 'session_log', { text: 'first' });
  const b = await call(mcp, 'session_log', { session_id: a.id, text: 'second' });
  assert.equal(b.id, a.id);
  assert.equal(b.message_count, 2);
});

test('session_read: full=true pages long sessions at ~4k tokens via next_offset; default stays small', async () => {
  const { mcp, env } = await mcpWithHome();
  const store = await openSessionStore(env); // same appHome as the MCP's lazily-created store
  const longMessages = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', at: `2026-10-0${1 + (i % 9)}T00:00:00Z`, text: `Message ${i}: ${'word '.repeat(80)}` }));
  const s = await store.putSession({ client: 'claude-code', source_id: 'long/1', project: '/x', title: 'Long session', summary: 'A long imported session.', started_at: longMessages[0].at, note_refs: [], private: false, messages: longMessages });

  const summary = await call(mcp, 'session_read', { id: s.id });
  assert.ok(estTokens(JSON.stringify(summary)) < 800, 'default session_read stays well under the ~800 token budget');
  assert.equal(summary.messages, undefined, 'default session_read returns no messages field');
  assert.equal(summary.key_turns.length, 3, 'default session_read returns at most 3 key-turn snippets');
  for (const turn of summary.key_turns) assert.ok(turn.text.length <= 200, 'each key-turn snippet is clipped to ~200 chars');

  let offset = 0, pages = 0, seen = 0;
  for (;;) {
    const page = await call(mcp, 'session_read', { id: s.id, full: true, offset });
    assert.ok(estTokens(JSON.stringify(page)) <= 4200, 'a full=true page stays near the ~4k token budget');
    assert.ok(Array.isArray(page.messages), 'full=true returns the real messages array');
    seen += page.messages.length;
    pages++;
    if (page.next_offset == null) break;
    assert.ok(page.next_offset > offset, 'pagination must make forward progress');
    offset = page.next_offset;
    assert.ok(pages < 20, 'sanity bound: must not loop forever');
  }
  assert.equal(seen, 60, 'every message is reachable across pages, none skipped or duplicated');
});

test('token budget: representative session_list/session_read calls average <=1050 tokens, none over 3000', async () => {
  const { mcp, env } = await mcpWithHome();
  const store = await openSessionStore(env);
  for (let i = 0; i < 6; i++) {
    await store.putSession({ client: i % 2 ? 'codex' : 'claude-code', source_id: `s${i}`, project: `/proj${i}`, title: `Session ${i}`, summary: `Summary of session ${i} about garden automation.`, started_at: '2026-10-10T00:00:00Z', note_refs: [], private: false, messages: [{ role: 'user', at: '2026-10-10T00:00:00Z', text: 'hi' }, { role: 'assistant', at: '2026-10-10T00:00:01Z', text: 'hello' }] });
  }
  const samples = [];
  samples.push(JSON.stringify(await call(mcp, 'session_list', {})));
  const first = (await call(mcp, 'session_list', {})).sessions[0];
  samples.push(JSON.stringify(await call(mcp, 'session_read', { id: first.id })));
  samples.push(JSON.stringify(await call(mcp, 'session_read', { id: first.id, include_private: true })));
  samples.push(JSON.stringify(await call(mcp, 'session_read', { id: first.id, full: true })));
  const toks = samples.map(estTokens).sort((a, b) => a - b);
  const median = toks[Math.floor(toks.length / 2)];
  assert.ok(toks.every((t) => t <= 3000), `max per-call budget exceeded: ${toks}`);
  assert.ok(median <= 1050, `median token budget exceeded: ${toks}`);
});
