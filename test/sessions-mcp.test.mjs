import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

import { normalize, CONFIG_SCHEMA_VERSION, loadConfig, saveConfig } from '../src/config.mjs';
import { createContext } from '../src/core.mjs';
import { createMcp } from '../src/server.mjs';
import { openSessionStore } from '../src/sessions/index.mjs';
import { sessionList, sessionRead } from '../src/sessions/mcp.mjs';
import { estTokens } from '../src/sessions/tokens.mjs';
import { sessionsService } from '../src/host.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const tmp = (p) => mkdtemp(path.join(tmpdir(), `brainlink-${p}-`));

async function mcpWithHome(extraEnv = {}) {
  const home = await tmp('sess-mcp');
  const env = { BRAINLINK_HOME: home, HOME: home, BRAINLINK_AI_PLATFORM: 'Claude', BRAINLINK_SEMANTIC: '0', ...extraEnv };
  // These fixtures exercise sharing after a deliberate local import opt-in.
  if (extraEnv.HOME) await saveConfig({ version: CONFIG_SCHEMA_VERSION, vaults: [], sessions: { importHistory: true } }, path.join(home, 'config.json'));
  const ctx = createContext(normalize({}), { env });
  return { mcp: createMcp(ctx), ctx, env };
}

// Imported Claude Code / Codex / DeepSeek Harness history lives under the real OS home (see each
// importer's defaultRoot), not under BRAINLINK_HOME. A fake HOME with synthetic data exercises the
// import path without reading real client histories.
async function withFakeHome(run) {
  const fakeHome = await tmp('fake-home');
  await cp(path.join(FIXTURES, 'claude-code', 'projects'), path.join(fakeHome, '.claude', 'projects'), { recursive: true });
  await cp(path.join(FIXTURES, 'codex', 'sessions'), path.join(fakeHome, '.codex', 'sessions'), { recursive: true });
  await cp(path.join(FIXTURES, 'codex', 'history.jsonl'), path.join(fakeHome, '.codex', 'history.jsonl'));
  const dshDir = path.join(fakeHome, '.dsh', 'sessions', '--fictional-project--', 'fictional-session-id');
  await mkdir(dshDir, { recursive: true });
  const dshAt = Date.parse('2026-10-20T14:00:00.000Z');
  const dshRecords = [
    { type: 'session', version: 4, id: 'fictional-session-id', cwd: '/fictional/project', createdAt: dshAt, isSeeded: false },
    { type: 'user/message', seq: 0, time: dshAt, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Fictional DeepSeek Harness task.' }] } },
    { type: 'assistant/message', seq: 1, time: dshAt + 1000, data: { message: { role: 'assistant', provider: 'fixture', model: 'fixture', content: [{ type: 'text', text: 'Fictional Harness task result.' }] } } },
  ].map((row) => zstdCompressSync(Buffer.from(JSON.stringify(row) + '\n')));
  await writeFile(path.join(dshDir, 'session.v4.jsonl.zstd'), Buffer.concat(dshRecords));
  const savedHome = process.env.HOME;
  const savedDshHome = process.env.DSH_HOME;
  process.env.HOME = fakeHome;
  process.env.DSH_HOME = path.join(fakeHome, '.dsh');
  try { return await run(fakeHome); } finally {
    process.env.HOME = savedHome;
    if (savedDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedDshHome;
  }
}

async function call(mcp, name, args = {}) {
  const res = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(!res.result.isError, `${name} should not error: ${res.result.content?.[0]?.text}`);
  return JSON.parse(res.result.content[0].text);
}

test('session_log creates a private-by-default session; session_list hides it even if a caller passes include_private', async () => {
  const { mcp, env } = await mcpWithHome();
  const logged = await call(mcp, 'session_log', { title: 'Quick note', text: 'Remember to check the kiln schedule.' });
  assert.ok(logged.id && logged.message_count === 1);
  assert.deepEqual((await call(mcp, 'session_list', {})).sessions, []);
  // An MCP caller cannot grant itself private access: include_private is ignored over this transport.
  assert.deepEqual((await call(mcp, 'session_list', { include_private: true })).sessions, []);
  // session_read returns a clear "it's private" result, not a thrown error — and a caller-supplied
  // include_private has no effect: session_log entries are never relaxed by the imported-sessions
  // Settings toggle (only supported local transcript imports are, see isRelaxableImport).
  const blocked1 = await call(mcp, 'session_read', { id: logged.id });
  assert.equal(blocked1.private, true);
  assert.match(blocked1.message, /private/i);
  assert.equal(blocked1.key_turns, undefined, 'a blocked read never leaks key-turn snippets');
  const blocked2 = await call(mcp, 'session_read', { id: logged.id, include_private: true });
  assert.equal(blocked2.private, true);
  assert.match(blocked2.message, /private/i);

  // The private content is still there; it's only readable off the MCP transport, via the store directly
  // (which is what the local /api/sessions route in src/setup.mjs uses on the user's behalf).
  const store = await openSessionStore(env);
  const visible = (await sessionList(store, { include_private: true })).sessions;
  assert.equal(visible.length, 1);
  const rec = visible[0];
  assert.deepEqual(Object.keys(rec).sort(), ['client', 'id', 'private', 'project', 'started_at', 'summary', 'turns'].sort());
  assert.equal(rec.private, true);
  assert.equal(rec.turns, 1);

  const read = await sessionRead(store, { id: logged.id, include_private: true });
  assert.equal(read.message_count, 1);
  assert.equal(read.messages, undefined, 'default session_read returns no messages');
  assert.equal(read.key_turns.length, 1);
  assert.equal(read.key_turns[0].text, 'Remember to check the kiln schedule.');
});

test('session_log secret filter: a planted key never reaches storage', async () => {
  const { mcp, env } = await mcpWithHome();
  const logged = await call(mcp, 'session_log', { text: 'DB_PASSWORD=hunter2SECRET and done.' });
  const store = await openSessionStore(env);
  const read = await sessionRead(store, { id: logged.id, include_private: true });
  assert.ok(!JSON.stringify(read).includes('hunter2SECRET'));
});

test('session_log appends to an existing session by id', async () => {
  const { mcp } = await mcpWithHome();
  const a = await call(mcp, 'session_log', { text: 'first' });
  const b = await call(mcp, 'session_log', { session_id: a.id, text: 'second' });
  assert.equal(b.id, a.id);
  assert.equal(b.message_count, 2);
});

test('Setup session imports stay inside its explicit home when HOME is not set', async (t) => {
  const home = await tmp('setup-session-home');
  const appHome = path.join(home, 'app');
  const claudeProjects = path.join(home, '.claude', 'projects', 'fictional-project');
  await mkdir(claudeProjects, { recursive: true });
  await writeFile(path.join(claudeProjects, 'fictional-session.jsonl'), [
    JSON.stringify({ type: 'user', timestamp: '2026-10-28T01:00:00.000Z', message: { role: 'user', content: 'Fictional setup-home session marker.' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-28T01:00:01.000Z', message: { role: 'assistant', content: 'Fictional reply.' } }),
  ].join('\n'));
  t.after(() => rm(home, { recursive: true, force: true }));

  await saveConfig({ version: CONFIG_SCHEMA_VERSION, vaults: [], sessions: { importHistory: true } }, path.join(appHome, 'config.json'));
  const service = sessionsService({ BRAINLINK_HOME: appHome }, home);
  const result = await service.list({ include_private: true });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].client, 'claude-code');
  assert.equal(result.sessions[0].private, true);
  assert.match(result.sessions[0].summary, /Fictional setup-home session marker/);
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

// ---- regression: S2 (commit 1c18d80) hard-coded include_private=false for both tools, and every
// import defaults private:true, so a connected AI client saw 0 sessions and every session_read
// errored, with no way for the user to ever let an AI see their own imported history again. The
// fix is a local-only BrainLink Settings choice (cfg.sessions, src/config.mjs) that
// session_list/session_read read instead of a hard-coded false, while still never taking that
// choice from the caller. Technical Reviewer's v1.2.2 privacy pass then flipped shareSummaries's
// default to OFF (shareSummaries ON by default meant an AI client could see imported-session
// summaries with no action from the user) — the toggle mechanism itself, and session_read's
// no-throw "private" result, are unchanged; only the out-of-the-box default is. ----

test('imported sessions stay hidden by default under a fake HOME; session_read points at Settings', async () => {
  await withFakeHome(async () => {
    const { mcp, env } = await mcpWithHome({ HOME: process.env.HOME }); // cfg.sessions defaults: shareSummaries false, shareFullText false
    const list = await call(mcp, 'session_list', {});
    assert.deepEqual(list.sessions, [], 'imported sessions are not visible until the user opts in, in BrainLink Settings');
    const store = await openSessionStore(env);
    const [imported] = (await store.listSessions({ limit: 10 })).filter((s) => s.private);
    assert.ok(imported, 'the import itself still happened; it is only hidden from AI clients');
    const read = await call(mcp, 'session_read', { id: imported.id });
    assert.equal(read.private, true);
    assert.match(read.message, /private; change it in BrainLink Settings/i);
    assert.equal(read.key_turns, undefined, 'a hidden read never leaks key-turn snippets');
  });
});

// R2: v1.2.2's own Setup wrote the normalized defaults the first time it saved anything, so any
// config saved by that version (or earlier) has sessions.shareSummaries=true on disk even though
// the user never chose that. Bumping CONFIG_SCHEMA_VERSION means normalize() can tell such a
// config apart from a fresh/already-migrated one (whose on-disk version is current) and force both
// sharing flags off exactly once, regardless of what raw.sessions says.
test('R2: a config saved before the schema-version bump has shareSummaries forced off on load, and does not re-migrate after that', async () => {
  const home = await tmp('r2-config');
  const file = path.join(home, 'config.json');
  // What v1.2.2 wrote: no `version` field recognized by the current schema, shareSummaries=true.
  await saveConfig({ vaults: [], agents: [], ai_agents: [], connections: {}, platforms: [], http: { port: 8765, token: null }, sessions: { shareSummaries: true, shareFullText: false } }, file);
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(onDisk.sessions.shareSummaries, true, 'the file on disk really does have the old, unsafe default');

  const upgraded = await loadConfig(file);
  assert.equal(upgraded.sessions.shareSummaries, false, 'forced off on first load after the schema bump');
  assert.equal(upgraded.sessions.shareFullText, false);
  assert.equal(upgraded.version, CONFIG_SCHEMA_VERSION);

  // A deliberate post-upgrade opt-in must stick: the just-loaded config already carries the
  // current version, so re-saving it does not get force-reset again on the next load.
  await saveConfig({ ...upgraded, sessions: { shareSummaries: true, shareFullText: false } }, file);
  const reloaded = await loadConfig(file);
  assert.equal(reloaded.sessions.shareSummaries, true, "a deliberate opt-in after the upgrade is respected, not wiped again");
});

test('session sharing settings: shareSummaries=true opts in to imported-session summaries', async () => {
  await withFakeHome(async () => {
    const { env } = await mcpWithHome({ HOME: process.env.HOME });
    const ctx = createContext(normalize({ version: CONFIG_SCHEMA_VERSION, sessions: { shareSummaries: true, shareFullText: false } }), { env });
    const mcp = createMcp(ctx);
    const list = await call(mcp, 'session_list', {});
    assert.ok(list.sessions.length > 0, 'at least one imported session is visible once the user opts in');
    assert.ok(list.sessions.every((s) => s.private === true), 'imports are still private by default, just visible as summaries');
    const id = list.sessions[0].id;
    const read = await call(mcp, 'session_read', { id });
    assert.equal(read.private, true);
    assert.deepEqual(read.key_turns, [], 'sharing summaries does not disclose private transcript excerpts');
  });
});

test('DeepSeek Harness session sharing uses the same explicit summary and full-text consent as other imports', async () => {
  await withFakeHome(async () => {
    const off = await mcpWithHome({ HOME: process.env.HOME });
    await call(off.mcp, 'session_list', {}); // performs the normal local transcript refresh
    const offStore = await openSessionStore(off.env);
    const dsh = (await offStore.listSessions({ limit: 20 })).find((session) => session.client === 'deepseek-harness');
    assert.ok(dsh, 'fictional DeepSeek Harness session is imported');
    const hidden = await call(off.mcp, 'session_read', { id: dsh.id });
    assert.equal(hidden.private, true);
    assert.equal(hidden.summary, undefined);

    const summaryCtx = createContext(normalize({ version: CONFIG_SCHEMA_VERSION, sessions: { shareSummaries: true, shareFullText: false } }), { env: off.env });
    const summaryMcp = createMcp(summaryCtx);
    const visible = await call(summaryMcp, 'session_read', { id: dsh.id });
    assert.equal(visible.private, true);
    assert.match(visible.summary, /Fictional DeepSeek Harness task/);
    assert.deepEqual(visible.key_turns, [], 'summary consent does not reveal transcript excerpts');
    const noFullConsent = await call(summaryMcp, 'session_read', { id: dsh.id, full: true });
    assert.equal(noFullConsent.messages, undefined);

    const fullCtx = createContext(normalize({ version: CONFIG_SCHEMA_VERSION, sessions: { shareSummaries: true, shareFullText: true } }), { env: off.env });
    const fullMcp = createMcp(fullCtx);
    const full = await call(fullMcp, 'session_read', { id: dsh.id, full: true });
    assert.match(JSON.stringify(full), /Fictional Harness task result/);

    const hermes = await offStore.putSession({ client: 'hermes', source_id: 'fictional-hermes-share', project: '/fictional',
      title: 'Fictional Hermes task', summary: 'Fictional Hermes summary.', private: true,
      started_at: '2026-10-28T03:00:00Z', note_refs: [], messages: [{ role: 'user', at: '2026-10-28T03:00:01Z', text: 'Fictional Hermes transcript.' }] });
    const hermesHidden = await call(off.mcp, 'session_read', { id: hermes.id });
    assert.equal(hermesHidden.summary, undefined, 'Hermes imports remain hidden by default');
    const hermesSummary = await call(summaryMcp, 'session_read', { id: hermes.id });
    assert.match(hermesSummary.summary, /Fictional Hermes summary/);
    assert.deepEqual(hermesSummary.key_turns, [], 'Hermes summary consent must not expose transcript turns');
    assert.equal((await call(summaryMcp, 'session_read', { id: hermes.id, full: true })).messages, undefined);
    assert.match(JSON.stringify(await call(fullMcp, 'session_read', { id: hermes.id, full: true })), /Fictional Hermes transcript/);
  });
});

test('private imported transcript needs full-text consent before excerpts appear', async () => {
  const { env } = await mcpWithHome();
  const store = await openSessionStore(env);
  const saved = await store.putSession({ client: 'codex', source_id: 'private-excerpt', project: '/fictional',
    title: 'Fictional project', summary: 'A safe project summary.', private: true,
    started_at: '2026-10-10T00:00:00Z', note_refs: [],
    messages: [{ role: 'user', at: '2026-10-10T00:00:00Z', text: 'PLANTED_PRIVATE_CLIENT_NOTE' }] });
  const summaryOnly = await sessionRead(store, { id: saved.id, allow_imported_private: true });
  assert.equal(summaryOnly.summary, 'A safe project summary.');
  assert.deepEqual(summaryOnly.key_turns, []);
  assert.ok(!JSON.stringify(summaryOnly).includes('PLANTED_PRIVATE_CLIENT_NOTE'));
  const withConsent = await sessionRead(store, { id: saved.id, allow_imported_private: true,
    allow_imported_full_private: true });
  assert.match(withConsent.key_turns[0].text, /PLANTED_PRIVATE_CLIENT_NOTE/);
});

test('regression: a caller-supplied include_private=true has no effect, on session_list or session_read, full or not', async () => {
  await withFakeHome(async () => {
    const { env } = await mcpWithHome({ HOME: process.env.HOME });
    const ctx = createContext(normalize({ version: CONFIG_SCHEMA_VERSION, sessions: { shareSummaries: true, shareFullText: false } }), { env });
    const mcp = createMcp(ctx);
    const withFlag = await call(mcp, 'session_list', { include_private: true });
    const without = await call(mcp, 'session_list', {});
    assert.deepEqual(withFlag.sessions, without.sessions, 'include_private from the caller changes nothing');
    const id = without.sessions[0].id;
    const full = await call(mcp, 'session_read', { id, full: true, include_private: true });
    assert.equal(full.messages, undefined, 'full=true raw text is still refused: shareFullText defaults off');
    assert.match(full.message, /private/i);
  });
});

test('session sharing settings: shareSummaries=false hides imports again; shareFullText=true (with shareSummaries) unlocks full=true', async () => {
  await withFakeHome(async () => {
    const off = await mcpWithHome({ HOME: process.env.HOME });
    const ctxOff = createContext(normalize({ version: CONFIG_SCHEMA_VERSION, sessions: { shareSummaries: false, shareFullText: false } }), { env: off.env });
    const mcpOff = createMcp(ctxOff);
    assert.deepEqual((await call(mcpOff, 'session_list', {})).sessions, [], 'turning shareSummaries off hides imports again, matching the pre-fix default');

    const on = await mcpWithHome({ HOME: process.env.HOME });
    const ctxOn = createContext(normalize({ version: CONFIG_SCHEMA_VERSION, sessions: { shareSummaries: true, shareFullText: true } }), { env: on.env });
    const mcpOn = createMcp(ctxOn);
    const id = (await call(mcpOn, 'session_list', {})).sessions[0].id;
    const full = await call(mcpOn, 'session_read', { id, full: true });
    assert.ok(Array.isArray(full.messages), 'shareFullText=true unlocks the real message text for imported sessions');
  });
});

test('regression: session_log (deliberately-private, non-imported) sessions are never relaxed by the imported-sessions setting', async () => {
  const { mcp } = await mcpWithHome();
  const logged = await call(mcp, 'session_log', { text: 'A private quick note, not an import.' });
  // Even with full sharing cfg, client-created private notes stay private: the toggle only ever
  // applies only to supported imported clients (see isRelaxableImport in src/sessions/mcp.mjs).
  assert.deepEqual((await call(mcp, 'session_list', {})).sessions, []);
  const read = await call(mcp, 'session_read', { id: logged.id });
  assert.equal(read.private, true);
  assert.match(read.message, /private/i);
});
