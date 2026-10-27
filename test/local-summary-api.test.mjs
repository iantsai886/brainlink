import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize, saveConfig } from '../src/config.mjs';
import { openSessionStore } from '../src/sessions/index.mjs';
import { startSetup } from '../src/setup.mjs';

test('local summary API requires opt-in, generates private draft, and files only after preview and confirmation', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'brainlink-local-summary-api-'));
  const appHome = path.join(home, 'app'), vault = path.join(home, 'vault');
  await mkdir(path.join(vault, 'Inbox'), { recursive: true });
  const env = { BRAINLINK_HOME: appHome, HOME: home, BRAINLINK_SEMANTIC: '0' };
  await saveConfig(normalize({ vaults: [{ name: 'Company', path: vault }] }), path.join(appHome, 'config.json'));
  const store = await openSessionStore(env);
  const session = await store.putSession({ client: 'codex', source_id: 'fictional-local-summary', project: 'Fake project', title: 'Fake project closeout',
    summary: 'Deterministic placeholder summary.', started_at: '2026-10-27T00:00:00Z', private: true,
    messages: [{ role: 'user', at: '2026-10-27T00:00:00Z', text: 'We completed a fictional task and should review the result.' }] });
  let sentBody;
  const app = await startSetup({ env, home, os: 'win32', port: 0, useCli: false, localSummaryFetch: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    sentBody = options.body;
    return { ok: true, json: async () => ({ message: { content: JSON.stringify({ goal: 'Complete fictional task', outcome: 'Task completed', decisions: [], corrections: [], next_actions: ['Review draft'], open_questions: [] }) } }) };
  } });
  const api = (route, body, token = app.token) => fetch(`http://127.0.0.1:${app.port}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': token }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await api('/api/sessions/local-summary/generate', { id: session.id })).status, 400, 'generation is off by default');
    const enabled = await (await api('/api/sessions/local-summary/settings', { enabled: true, model: 'qwen2.5:3b' })).json();
    assert.deepEqual(enabled.settings, { enabled: true, model: 'qwen2.5:3b' });
    const sharing = await (await api('/api/sessions/sharing', { shareSummaries: false, shareFullText: false })).json();
    assert.deepEqual(sharing.sessions.localSummary, enabled.settings, 'changing AI-client sharing does not reset local summary consent');
    assert.equal((await api('/api/sessions/local-summary/generate', { id: session.id }, 'bad-token')).status, 401);
    const generated = await (await api('/api/sessions/local-summary/generate', { id: session.id })).json();
    assert.equal(generated.draft.source, 'local_model_unverified');
    assert.equal(sentBody.includes(session.id), false, 'session identity is not sent to the local model');
    const preview = await (await api('/api/sessions/file', { id: session.id, vault: 'Company', confirm: false, useLocalDraft: true })).json();
    assert.equal(preview.written, false);
    assert.match(preview.preview, /Task completed/);
    assert.match(preview.preview, /Drafted locally with: qwen2\.5:3b/);
    assert.match(preview.preview, /unverified/i);
    assert.equal((await readFile(path.join(vault, 'Inbox', 'Fake project closeout.md')).catch(() => '')).length, 0, 'preview creates no note');
    const saved = await (await api('/api/sessions/file', { id: session.id, vault: 'Company', confirm: true, useLocalDraft: true })).json();
    assert.equal(saved.written, true);
    const notePath = path.join(vault, saved.path.slice('Company/'.length));
    const note = await readFile(notePath, 'utf8');
    assert.match(note, /Task completed/);
    assert.match(note, /Drafted locally with: qwen2\.5:3b/);
  } finally { await new Promise((resolve) => app.server.close(resolve)); }
});
