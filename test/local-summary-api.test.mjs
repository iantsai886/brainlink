import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize, saveConfig } from '../src/config.mjs';
import { openSessionStore } from '../src/sessions/index.mjs';
import { HARNESS_AUTO_DRAFT_IDLE_MS, recordSessionEndCue, sessionEndCueId } from '../src/sessions/end-cue.mjs';
import { readLocalSummaryDraft, saveLocalSummaryDraft } from '../src/sessions/local-summary.mjs';
import { startSetup } from '../src/setup.mjs';

test('local model discovery is authenticated, local-only, and returns sanitized installed model names', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'brainlink-local-models-'));
  const env = { BRAINLINK_HOME: path.join(home, 'app'), HOME: home, BRAINLINK_SEMANTIC: '0' };
  let requestedUrl = '';
  const app = await startSetup({ env, home, os: 'win32', port: 0, useCli: false, localSummaryModelsFetch: async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ models: [
      { name: 'qwen2.5:3b' }, { name: 'llama3.2:latest' }, { name: 'qwen2.5:3b' },
      { name: '../outside' }, { name: 'x'.repeat(161) }, { name: 42 },
    ] }) };
  } });
  const api = (token = app.token) => fetch(`http://127.0.0.1:${app.port}/api/sessions/local-summary/models`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': token }, body: '{}',
  });
  try {
    assert.equal((await api('bad-token')).status, 401);
    assert.deepEqual(await (await api()).json(), { available: true, models: ['llama3.2:latest', 'qwen2.5:3b'] });
    assert.equal(requestedUrl, 'http://127.0.0.1:11434/api/tags');
  } finally { await new Promise((resolve) => app.server.close(resolve)); }
});

test('local model discovery hides local service errors and reports unavailable', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'brainlink-local-models-offline-'));
  const env = { BRAINLINK_HOME: path.join(home, 'app'), HOME: home, BRAINLINK_SEMANTIC: '0' };
  const app = await startSetup({ env, home, os: 'win32', port: 0, useCli: false, localSummaryModelsFetch: async () => { throw new Error('private local service detail'); } });
  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/sessions/local-summary/models`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': app.token }, body: '{}',
    });
    assert.deepEqual(await response.json(), { available: false, models: [] });
  } finally { await new Promise((resolve) => app.server.close(resolve)); }
});

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
    assert.deepEqual(enabled.settings, { enabled: true, model: 'qwen2.5:3b', autoDraftOnEnd: false, autoFileOnEnd: false });
    const gated = await (await api('/api/sessions/local-summary/settings', { autoFileOnEnd: true })).json();
    assert.equal(gated.settings.autoFileOnEnd, false, 'auto-file cannot be enabled without auto-drafting');
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

test('opt-in auto-file writes only to the exact saved project folder and is idempotent', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'brainlink-local-summary-auto-file-'));
  const appHome = path.join(home, 'app'), vault = path.join(home, 'vault');
  await mkdir(path.join(vault, 'Projects', 'Fictional'), { recursive: true });
  const env = { BRAINLINK_HOME: appHome, HOME: home, BRAINLINK_SEMANTIC: '0' };
  const config = normalize({
    vaults: [{ name: 'Company', path: vault, writes: 'on' }],
    session_filing: { projectVaults: { 'Fictional Project': 'Company' }, projectFolders: { 'Fictional Project': { vault: 'Company', folder: 'Projects/Fictional' } } },
  });
  config.sessions.localSummary = { enabled: true, model: 'qwen2.5:3b', autoDraftOnEnd: true, autoFileOnEnd: true };
  await saveConfig(config, path.join(appHome, 'config.json'));
  const store = await openSessionStore(env);
  const session = await store.putSession({ client: 'codex', source_id: '/fictional/rollout-auto-file-1.jsonl', project: 'Fictional Project', title: 'Fictional project closeout',
    summary: 'Fictional source session.', started_at: new Date().toISOString(), private: true,
    messages: [{ role: 'user', at: new Date().toISOString(), text: 'Complete the fictional task and record the reviewed result.' }] });
  await recordSessionEndCue({ input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'auto-file-1' }), client: 'codex', dir: path.join(appHome, 'sessions', 'end-cues') });
  let calls = 0;
  const app = await startSetup({ env, home, os: 'win32', port: 0, useCli: false, localSummaryAutoDraftTickMs: 20, localSummaryFetch: async () => {
    calls++;
    return { ok: true, json: async () => ({ message: { content: JSON.stringify({ goal: 'Complete fictional task', outcome: 'Fictional work completed', decisions: ['Use the saved route'], corrections: [], next_actions: ['Human review'], open_questions: [] }) } }) };
  } });
  const api = (route, body) => fetch(`http://127.0.0.1:${app.port}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': app.token }, body: JSON.stringify(body),
  });
  try {
    const until = Date.now() + 5000;
    let notePath = null;
    let cue = null;
    while (!notePath && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const listed = await (await api('/api/sessions/end-cues', {})).json();
      cue = listed.cues.find((item) => item.session_ref === session.id);
      const destination = path.join(vault, 'Projects', 'Fictional');
      const note = (await readdir(destination)).find((name) => name.toLowerCase().endsWith('.md'));
      if (note) notePath = path.join(destination, note);
    }
    assert.ok(notePath, `eligible closeout should file to the exact saved folder; cue=${JSON.stringify(cue)}; modelCalls=${calls}`);
    const saved = await readFile(notePath, 'utf8');
    assert.match(saved, /type: episode/i);
    assert.match(saved, /status: proposed/i);
    assert.match(saved, /private: true/i);
    assert.match(saved, /BrainLink session s_[a-f0-9]{16}/i);
    assert.match(saved, /This is a private, unverified session summary/);
    assert.match(saved, /Fictional work completed/);
    assert.equal(calls, 1);
    assert.equal(cue?.summary_filed, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await readdir(path.join(vault, 'Projects', 'Fictional'))).filter((name) => name.toLowerCase().endsWith('.md')).length, 1, 'repeated scheduler ticks must not create duplicate notes');
    assert.equal(calls, 1, 'filing an existing draft must not rerun the model');
  } finally { await new Promise((resolve) => app.server.close(resolve)); }
});

test('auto-file leaves the draft private when this exact project has no saved destination', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'brainlink-local-summary-no-route-'));
  const appHome = path.join(home, 'app'), vault = path.join(home, 'vault');
  await mkdir(vault, { recursive: true });
  const env = { BRAINLINK_HOME: appHome, HOME: home, BRAINLINK_SEMANTIC: '0' };
  const config = normalize({ vaults: [{ name: 'Company', path: vault, writes: 'on' }] });
  config.sessions.localSummary = { enabled: true, model: 'qwen2.5:3b', autoDraftOnEnd: true, autoFileOnEnd: true };
  await saveConfig(config, path.join(appHome, 'config.json'));
  const store = await openSessionStore(env);
  const session = await store.putSession({ client: 'codex', source_id: '/fictional/rollout-no-route-1.jsonl', project: 'Unmapped Fictional Project', title: 'Private draft only',
    summary: 'Fictional session.', started_at: new Date().toISOString(), private: true,
    messages: [{ role: 'user', at: new Date().toISOString(), text: 'Complete a fictional task without a saved folder.' }] });
  await recordSessionEndCue({ input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'no-route-1' }), client: 'codex', dir: path.join(appHome, 'sessions', 'end-cues') });
  const app = await startSetup({ env, home, os: 'win32', port: 0, useCli: false, localSummaryAutoDraftTickMs: 20, localSummaryFetch: async () => ({
    ok: true, json: async () => ({ message: { content: JSON.stringify({ goal: 'Fictional task', outcome: 'Draft only', decisions: [], corrections: [], next_actions: [], open_questions: [] }) } }),
  }) });
  const api = (route, body) => fetch(`http://127.0.0.1:${app.port}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': app.token }, body: JSON.stringify(body),
  });
  try {
    const until = Date.now() + 4000;
    let cue;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      cue = (await (await api('/api/sessions/end-cues', {})).json()).cues.find((item) => item.session_ref === session.id);
      if (cue?.auto_file_status === 'needs_destination') break;
    }
    assert.equal(cue?.summary_ready, true);
    assert.equal(cue?.summary_filed, false);
    assert.equal(cue?.auto_file_status, 'needs_destination');
    assert.equal((await readdir(vault)).length, 0, 'no guessed vault folder should be written');
    const draft = await readLocalSummaryDraft(path.join(appHome, 'sessions', 'auto-summary'), session.id);
    assert.match(draft.summary, /Draft only/);
  } finally { await new Promise((resolve) => app.server.close(resolve)); }
});

test('opt-in background closeout drafts a quiet Harness session only after 30 minutes and keeps it private', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'brainlink-harness-idle-summary-'));
  const appHome = path.join(home, 'app'), vault = path.join(home, 'vault');
  await mkdir(vault, { recursive: true });
  const env = { BRAINLINK_HOME: appHome, HOME: home, BRAINLINK_SEMANTIC: '0' };
  const config = normalize({ vaults: [{ name: 'Company', path: vault }] });
  config.sessions.localSummary = { enabled: true, model: 'qwen2.5:3b', autoDraftOnEnd: true };
  await saveConfig(config, path.join(appHome, 'config.json'));
  const store = await openSessionStore(env);
  const now = Date.now();
  const cueTime = new Date(now - HARNESS_AUTO_DRAFT_IDLE_MS - 60_000).toISOString();
  const messageTime = new Date(Date.parse(cueTime) - 60_000).toISOString();
  const session = await store.putSession({ client: 'deepseek-harness', source_id: '--fictional-project--/fictional-harness-session/session.v4.jsonl.zstd', project: 'Fictional project', title: 'Fictional Harness session', summary: 'Fictional source session.', started_at: messageTime, private: true,
    messages: [{ role: 'user', at: messageTime, text: 'Complete the fictional task.' }, { role: 'assistant', at: messageTime, text: 'The fictional task is complete.' }] });
  const cue = { schema: 1, client: 'deepseek-harness', session_id: 'fictional-harness-session', ended_at: cueTime, reason: 'turn-completed' };
  const cueDir = path.join(appHome, 'sessions', 'end-cues');
  await mkdir(cueDir, { recursive: true });
  await writeFile(path.join(cueDir, `${sessionEndCueId(cue)}.json`), `${JSON.stringify(cue)}\n`);
  await saveLocalSummaryDraft(path.join(appHome, 'sessions', 'auto-summary'), session.id, {
    summary: '## Outcome (unverified)\nStale draft from an earlier turn.', model: 'qwen2.5:3b',
    generated_at: new Date(Date.parse(cueTime) - 60_000).toISOString(), source: 'local_model_unverified',
  });
  let calls = 0;
  const app = await startSetup({ env, home, os: 'win32', port: 0, useCli: false, localSummaryAutoDraftTickMs: 20, localSummaryFetch: async () => {
    calls++;
    return { ok: true, json: async () => ({ message: { content: JSON.stringify({ goal: 'Complete fictional task', outcome: 'Completed after an idle Harness turn', decisions: [], corrections: [], next_actions: ['Review the draft'], open_questions: [] }) } }) };
  } });
  const api = (route, body) => fetch(`http://127.0.0.1:${app.port}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': app.token }, body: JSON.stringify(body),
  });
  try {
    const draftDir = path.join(appHome, 'sessions', 'auto-summary');
    const until = Date.now() + 4000;
    let draft = null;
    while ((!draft || /Stale draft/.test(draft.summary)) && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      draft = await readLocalSummaryDraft(draftDir, session.id);
    }
    assert.ok(draft, `quiet Harness session should get a local review draft; model calls=${calls}`);
    assert.match(draft.summary, /Completed after an idle Harness turn/);
    assert.doesNotMatch(draft.summary, /Stale draft/);
    assert.equal(calls, 1);
    assert.equal((await readFile(path.join(vault, 'Fictional Harness session.md')).catch(() => '')).length, 0, 'idle detection never writes a vault note');
    const shown = await (await api('/api/sessions/end-cues', {})).json();
    assert.equal(shown.cues[0]?.client, 'deepseek-harness');
    assert.equal(shown.cues[0]?.summary_ready, true);
  } finally { await new Promise((resolve) => app.server.close(resolve)); }
});
