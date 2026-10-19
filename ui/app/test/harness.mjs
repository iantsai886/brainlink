// Shared test harness: real reference store + fictional seed + mock services. No private data.
import path from 'node:path'; import { pathToFileURL } from 'node:url'; import { existsSync } from 'node:fs';
const DIR = process.env.BRAINLINK_STORE_DIR || ['../../../src/store', '../../../../brainlink-store'].map((p) => path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), p)).find((d) => existsSync(path.join(d, 'memory-store.mjs')));
// Prefer actual reference store; use explicitly labeled fixture only when not provided.
export const { createMemoryStore } = await import(DIR ? pathToFileURL(path.join(DIR, 'memory-store.mjs')).href : new URL('./support/memory-store.mjs', import.meta.url).href);
export const VAULTS = [{ name: 'Work', private: false }, { name: 'Journal', private: true }];
export const NOTES = [
  ['Home.md', { type: 'index', tags: ['home'] }, '# Home\n\nStart here. See [[Projects/Website relaunch]] and [[Decisions/Pick a sync mode]].'],
  ['Projects/Website relaunch.md', { type: 'project', status: 'active', tags: ['web', 'q4'] }, '# Website relaunch\n\n- [ ] Draft copy\n\nRelated: [[Decisions/Pick a sync mode]], [[People/Robin]].'],
  ['Decisions/Pick a sync mode.md', { type: 'decision', status: 'accepted', tags: ['sync'] }, '# Pick a sync mode\n\nLocal only by default. See [[Home]].'],
  ['People/Robin.md', { type: 'person', tags: ['team'] }, '# Robin\n\nDesigner on [[Projects/Website relaunch]]. Asks about [[Missing note]].'],
];
export const SESSIONS = [
  { client: 'claude-code', source_id: 'a1', vault: 'Work', title: 'Plan the store contract', summary: 'Agreed the store contract and tests.', started_at: '2031-03-04T01:10:00Z', note_refs: ['Home.md'] },
  { client: 'cursor', source_id: 'b2', vault: 'Work', title: 'Fix wikilink parser', summary: 'Ignore links in code fences.', started_at: '2031-03-04T02:00:00Z', note_refs: [] },
  { client: 'codex', source_id: 'c3', vault: 'Journal', title: 'Private retro', summary: 'Personal notes.', started_at: '2031-03-03T20:00:00Z', note_refs: [] },
];
export async function makeStore() {
  let t = Date.parse('2031-03-04T05:00:00Z');
  const store = createMemoryStore({ vaults: VAULTS, clock: () => new Date(t += 1000).toISOString() });
  for (const [p, fm, body] of NOTES) await store.write({ vault: 'Work', path: p, body, frontmatter: fm, author: 'Test/Seed' }, { expected_etag: '' });
  await store.write({ vault: 'Journal', path: 'Diary.md', body: 'private sync worries' }, { expected_etag: '' });
  for (const s of SESSIONS) await store.putSession({ ...s, messages: [{ role: 'user', at: s.started_at, text: s.title }, { role: 'assistant', at: s.started_at, text: s.summary }] });
  return store;
}
const APPS = [['claude-desktop', 'Claude Desktop', 'stdio'], ['claude-code', 'Claude Code', 'stdio'], ['cursor', 'Cursor', 'stdio'], ['codex', 'Codex', 'stdio'], ['gemini-cli', 'Gemini CLI', 'stdio'], ['windsurf', 'Windsurf', 'stdio'], ['chatgpt', 'ChatGPT', 'tunnel']];
export function mockServices({ installed = ['claude-desktop', 'cursor', 'codex', 'gemini-cli', 'chatgpt'], failTestOnce = [] } = {}) {
  const apps = APPS.map(([id, name, transport]) => ({ id, name, transport, installed: installed.includes(id), connected: false, config_path: '' , last_test: null }));
  const fails = new Set(failTestOnce); const get = (id) => apps.find((a) => a.id === id);
  const calls = [];
  return {
    calls,
    connectors: {
      async detect() { calls.push('detect'); return apps.map((a) => ({ ...a })); },
      async connect(id) { calls.push(`connect:${id}`); const a = get(id); if (!a?.installed) throw Object.assign(new Error('not installed'), { code: 'E_INVALID' }); a.connected = true; return { ...a }; },
      async test(id) { calls.push(`test:${id}`); if (fails.delete(id)) return { ok: false, latency_ms: 0, tool_count: 0, error: 'client did not answer tools/list' }; return get(id).connected ? { ok: true, latency_ms: 40, tool_count: 6 } : { ok: false, latency_ms: 0, tool_count: 0, error: 'not connected' }; },
      async disconnect(id) { calls.push(`disconnect:${id}`); const a = get(id); a.connected = false; return { ...a }; },
    },
  };
}
