// RB2 demo features: cited instant answer (/api/ask, /api/note), connect + live health check
// (/api/connect's health field, /api/client-health), and the `brainlink sync` session-count fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startSetup } from '../src/setup.mjs';
import { normalize } from '../src/config.mjs';
import { runSync } from '../src/sync-cli.mjs';
import { openSessionStore } from '../src/sessions/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (p) => mkdtemp(path.join(tmpdir(), `brainlink-${p}-`));

async function withSampleVault(label) {
  const home = await tmp(`${label}-home`);
  const vaultPath = path.join(home, 'Acme Studio');
  await cp(path.join(ROOT, 'samples', 'acme-studio'), vaultPath, { recursive: true });
  const env = { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' };
  const s = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${s.port}`;
  const api = (p, body) => fetch(base + p, { method: 'POST', headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const r = await (await api('/api/vault', { path: vaultPath, name: 'Acme Studio', pack: 'simple', scaffold: false })).json();
  assert.equal(r.ok, true, JSON.stringify(r));
  return { home, env, s, api, vaultPath };
}

// ---- /api/ask: cited instant answer ----

test('/api/ask: answers from the vault with clickable source chips; /api/note opens one', async () => {
  const { s, api } = await withSampleVault('ask');
  try {
    const r = await (await api('/api/ask', { query: 'What is the price of the Brand Sprint?' })).json();
    assert.equal(r.status, 'hits');
    assert.ok(r.answer && r.answer.length > 0, 'answer must not be empty when the vault has a hit');
    assert.ok(r.sources.length > 0);
    const pricing = r.sources.find((x) => x.path === 'Pricing and Packages.md');
    assert.ok(pricing, JSON.stringify(r.sources));

    const note = await (await api('/api/note', { vault: pricing.vault, path: pricing.path })).json();
    assert.match(note.body, /Brand Sprint/);
  } finally { s.server.close(); }
});

test('S1: /api/ask never answers from or cites a private note', async () => {
  const { s, api, vaultPath } = await withSampleVault('ask-private');
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(vaultPath, 'Secret Pricing.md'), '---\nprivate: true\n---\n# Secret Pricing\n\nThe real Brand Sprint price is secretly $1.');
    const r = await (await api('/api/ask', { query: 'What is the price of the Brand Sprint?' })).json();
    assert.ok(!r.sources.some((x) => x.path === 'Secret Pricing.md'), JSON.stringify(r.sources));
    assert.ok(!String(r.answer).includes('secretly'));
  } finally { s.server.close(); }
});

test('/api/note refuses a private note and a note in an excluded folder', async () => {
  const { s, api, vaultPath } = await withSampleVault('note-private');
  try {
    const { writeFile, mkdir } = await import('node:fs/promises');
    await writeFile(path.join(vaultPath, 'Secret Plan.md'), '---\nprivate: true\n---\n# Secret Plan\n\nAcquire Globex quietly.');
    await mkdir(path.join(vaultPath, '00 Home'), { recursive: true });
    await writeFile(path.join(vaultPath, '00 Home', 'Diary.md'), '# Diary\n\nvery personal notes');
    await writeFile(path.join(vaultPath, '.brainlinkignore'), '00 Home/\n');

    const privRes = await api('/api/note', { vault: 'Acme Studio', path: 'Secret Plan.md' });
    assert.equal(privRes.status, 400);
    const privBody = await privRes.json();
    assert.match(privBody.error, /private/i);
    assert.ok(!JSON.stringify(privBody).includes('Globex'));

    const exclRes = await api('/api/note', { vault: 'Acme Studio', path: '00 Home/Diary.md' });
    assert.equal(exclRes.status, 400);
    assert.match((await exclRes.json()).error, /private/i);
  } finally { s.server.close(); }
});

test('/api/ask: a question with nothing in the vault says so instead of guessing', async () => {
  const { s, api } = await withSampleVault('ask-miss');
  try {
    const r = await (await api('/api/ask', { query: 'What is our cholesterol screening policy for pangolins' })).json();
    assert.equal(r.status, 'not_in_brain');
    assert.equal(r.answer, null);
  } finally { s.server.close(); }
});

test('/api/ask and /api/note: no vault configured yet returns a clear error, not a crash', async () => {
  const home = await tmp('ask-empty-home');
  const env = { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' };
  const s = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${s.port}`;
  const api = (p, body) => fetch(base + p, { method: 'POST', headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  try {
    const bad = await api('/api/ask', { query: 'anything' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /Add a vault/);
  } finally { s.server.close(); }
});

// ---- /api/client-health + /api/connect: live MCP call after connect ----

test('/api/client-health: a real in-process MCP call (brainlink_guide) runs and is logged to Activity', async () => {
  const { home, env, s, api } = await withSampleVault('health');
  try {
    const r = await (await api('/api/client-health', { client: 'cursor' })).json();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.tool, 'brainlink_guide');
    assert.ok(typeof r.took_ms === 'number');

    const log = await readFile(path.join(env.BRAINLINK_HOME, 'activity.log'), 'utf8');
    const lines = log.trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.tool === 'brainlink_guide' && l.mode === 'health-check' && l.ok === true), JSON.stringify(lines));
  } finally { s.server.close(); }
});

test('/api/client-health: with no vault yet, reports a friendly message instead of an empty success', async () => {
  const home = await tmp('health-empty-home');
  const env = { BRAINLINK_HOME: path.join(home, 'app'), BRAINLINK_SEMANTIC: '0' };
  const s = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${s.port}`;
  const api = (p, body) => fetch(base + p, { method: 'POST', headers: { 'X-BrainLink-Token': s.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  try {
    const r = await (await api('/api/client-health', { client: 'cursor' })).json();
    assert.equal(r.ok, false);
    assert.match(r.message, /Add a vault/);
  } finally { s.server.close(); }
});

test('/api/connect: one-click connect returns a live health-check result alongside the connect result', async () => {
  const { home, s, api } = await withSampleVault('connect-health');
  await mkdir(path.join(home, '.cursor'), { recursive: true });
  try {
    const r = await (await api('/api/connect', { client: 'cursor' })).json();
    assert.match(r.title, /Cursor/);
    assert.equal(r.health.ok, true, JSON.stringify(r.health));
    assert.equal(r.health.tool, 'brainlink_guide');
  } finally { s.server.close(); }
});

// ---- ui/index.html: the note-reading modal must start hidden and stay closable ----
// `[hidden]` is a UA-stylesheet rule; an author rule with equal-or-lower specificity that also
// sets `display` on the same selector overrides it, which silently defeats the `hidden` attribute.
// `.modal-overlay[hidden] { display: none }` is required so the always-present #note-modal
// (ui/index.html) does not cover the whole page and swallow clicks from first load.
test('ui/index.html: #note-modal starts hidden (author CSS cannot override the hidden attribute) and Close/Esc wire up', async () => {
  const html = await readFile(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  assert.match(html, /<div id="note-modal" class="modal-overlay" hidden>/, 'the modal must start with the hidden attribute in markup');
  assert.match(html, /\.modal-overlay\[hidden\]\s*\{\s*display:\s*none;?\s*\}/, 'an explicit [hidden] override is required because .modal-overlay also sets `display`');
  assert.match(html, /\$\('note-close'\)\.onclick\s*=\s*closeNote/, 'Close must hide the modal');
  assert.match(html, /e\.key === 'Escape'\)\s*closeNote\(\)/, 'Escape must hide the modal');
});

// ---- sync-cli / sync/engine: local-only `sessions` count (was hardcoded 0) ----

test('runSync: local-only still counts imported, non-private sessions instead of always reporting 0', async () => {
  const env = { BRAINLINK_HOME: await tmp('sync-count-home') };
  const cfg = normalize({});
  const store = await openSessionStore(env);
  await store.putSession({ client: 'claude-code', source_id: 'a/1', project: '/x', title: 'A', summary: 'a', started_at: '2026-10-10T00:00:00Z', note_refs: [], private: false, messages: [] });
  await store.putSession({ client: 'codex', source_id: 'b/1', project: '/x', title: 'B', summary: 'b', started_at: '2026-10-10T00:00:00Z', note_refs: [], private: true, messages: [] });
  const r = await runSync(cfg, env);
  assert.equal(r.status, 'local-only');
  assert.equal(r.sessions, 1, 'only the non-private session is sync-eligible, but it must be counted, not reported as 0');
});
