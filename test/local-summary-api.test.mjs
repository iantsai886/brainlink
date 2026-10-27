import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize, saveConfig } from '../src/config.mjs';
import { openSessionStore } from '../src/sessions/index.mjs';
import { recordSessionEndCue } from '../src/sessions/end-cue.mjs';
import { readLocalSummaryDraft } from '../src/sessions/local-summary.mjs';
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
    assert.deepEqual(enabled.settings, { enabled: true, model: 'qwen2.5:3b', autoDraftOnEnd: false });
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

test('opt-in background closeout drafts one matching ended session locally and never writes a vault note', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'brainlink-local-summary-auto-'));
  const appHome = path.join(home, 'app'), vault = path.join(home, 'vault');
  await mkdir(vault, { recursive: true });
  const env = { BRAINLINK_HOME: appHome, HOME: home, BRAINLINK_SEMANTIC: '0' };
  const config = normalize({ vaults: [{ name: 'Company', path: vault }] });
  config.sessions.localSummary = { enabled: true, model: 'qwen2.5:3b', autoDraftOnEnd: true };
  await saveConfig(config, path.join(appHome, 'config.json'));
  const store = await openSessionStore(env);
  const session = await store.putSession({ client: 'codex', source_id: '/fictional/rollout-auto-draft-1.jsonl', project: 'Fake project', title: 'Fake closeout',
    summary: 'Fictional source session.', started_at: new Date().toISOString(), private: true,
    messages: [{ role: 'user', at: new Date().toISOString(), text: 'We completed a fictional task. Save a private draft for review.' }] });
  await recordSessionEndCue({ input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'auto-draft-1' }), client: 'codex', dir: path.join(appHome, 'sessions', 'end-cues') });
  let calls = 0;
  const app = await startSetup({ env, home, os: 'win32', port: 0, useCli: false, localSummaryAutoDraftTickMs: 20, localSummaryFetch: async (url, options) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(options.body.includes(session.id), false, 'session identity is not sent to the local model');
    return { ok: true, json: async () => ({ message: { content: JSON.stringify({ goal: 'Complete fictional task', outcome: 'Task completed', decisions: [], corrections: [], next_actions: ['Review draft'], open_questions: [] }) } }) };
  } });
  const api = (route, body) => fetch(`http://127.0.0.1:${app.port}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': app.token }, body: JSON.stringify(body),
  });
  try {
    const draftDir = path.join(appHome, 'sessions', 'auto-summary');
    const listed = await (await api('/api/sessions/end-cues', {})).json();
    assert.equal(listed.cues[0]?.session_ref, session.id, JSON.stringify(listed));
    const until = Date.now() + 4000;
    let draft = null;
    while (!draft && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      draft = await readLocalSummaryDraft(draftDir, session.id);
    }
    assert.ok(draft, `background task should prepare a private draft for an exact matching cue; local model calls=${calls}`);
    assert.equal(draft.source, 'local_model_unverified');
    assert.equal(calls, 1);
    const shown = await (await api('/api/sessions/end-cues', {})).json();
    assert.equal(shown.cues[0].session_ref, session.id);
    assert.equal(shown.cues[0].summary_ready, true);
    const reviewed = await (await api('/api/sessions/local-summary/generate', { id: session.id })).json();
    assert.equal(reviewed.draft.summary, draft.summary);
    assert.equal(calls, 1, 'opening a prepared draft does not spend another local model run');
    assert.equal((await readFile(path.join(vault, 'Fake project closeout.md')).catch(() => '')).length, 0, 'background drafting never creates a vault note');
  } finally { await new Promise((resolve) => app.server.close(resolve)); }
});
