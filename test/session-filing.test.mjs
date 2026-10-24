import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize, saveConfig } from '../src/config.mjs';
import { createContext, readNote } from '../src/core.mjs';
import { fileSessionSummary, filingFields } from '../src/sessions/filing.mjs';
import { recommendSessionVault } from '../src/sessions/routing.mjs';
import { openSessionStore } from '../src/sessions/index.mjs';
import { startSetup } from '../src/setup.mjs';

test('private session summary files only to the chosen vault after preview', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-filing-'));
  const company = path.join(root, 'company');
  const personal = path.join(root, 'personal');
  await mkdir(path.join(company, 'Inbox'), { recursive: true });
  await mkdir(path.join(personal, 'Inbox'), { recursive: true });
  const ctx = createContext(normalize({ vaults: [
    { name: 'Company', path: company }, { name: 'Personal', path: personal },
  ] }), { env: { BRAINLINK_AI_PLATFORM: 'BrainLink Local', BRAINLINK_HOME: path.join(root, 'app') } });
  const session = { id: 'fictional-001', title: 'Client: / Northwind', summary: 'Northwind launch is proposed; no approval yet.', client: 'codex', project: 'Northwind', updated_at: '2026-10-24T00:00:00Z', private: true };
  const preview = await fileSessionSummary(ctx, session, 'Company');
  assert.equal(preview.ok, true);
  assert.equal(preview.written, false);
  assert.match(preview.preview, /private: true/);
  assert.match(preview.preview, /type: episode/);
  assert.equal((await readdir(path.join(company, 'Inbox'))).length, 0);
  const saved = await fileSessionSummary(ctx, session, 'Company', true);
  assert.equal(saved.written, true);
  const rel = saved.path.slice('Company/'.length);
  assert.match(await readFile(path.join(company, ...rel.split('/')), 'utf8'), /Northwind launch is proposed/);
  await assert.rejects(readNote(ctx, 'Company', rel), /private/i);
  assert.equal((await readdir(path.join(personal, 'Inbox'))).length, 0);
  assert.equal((await fileSessionSummary(ctx, session, 'Company', true)).ok, false, 'never overwrite existing capture');
});

test('filing refuses missing summary, missing destination and credentials', async () => {
  assert.throws(() => filingFields({ id: 'x', summary: '' }, 'Company'), /no summary/);
  assert.throws(() => filingFields({ id: 'x', summary: 'ok' }, ''), /destination/);
  const root = await mkdtemp(path.join(tmpdir(), 'bl-filing-refuse-'));
  await mkdir(path.join(root, 'Inbox'));
  const ctx = createContext(normalize({ vaults: [{ name: 'Company', path: root }] }), { env: { BRAINLINK_AI_PLATFORM: 'BrainLink Local' } });
  const result = await fileSessionSummary(ctx, { id: 'x', summary: 'API key sk-abcdefghijklmnopqrstuvwxyz123', client: 'codex' }, 'Company', true);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /secrets/);
  assert.equal((await readdir(path.join(root, 'Inbox'))).length, 0);
});

test('destination recommendation uses only an exact saved project choice and writable vaults', () => {
  const cfg = { vaults: [{ name: 'Company', writes: 'on' }, { name: 'Personal', writes: 'off' }], session_filing: { projectVaults: { Northwind: 'Company', PersonalProject: 'Personal' } } };
  assert.deepEqual(recommendSessionVault({ project: 'Northwind' }, cfg), { vault: 'Company', reason: 'Suggested from your saved choice for this exact project.' });
  assert.equal(recommendSessionVault({ project: 'Northwind-Other' }, cfg).vault, null, 'similar names are not fuzzy-matched');
  assert.equal(recommendSessionVault({ project: 'PersonalProject' }, cfg).vault, null, 'read-only or inaccessible destinations are not suggested');
  assert.equal(recommendSessionVault({ project: '' }, cfg).vault, null);
});

test('local filing API requires its token and writes a private note only after confirmation', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'bl-filing-api-'));
  const vault = path.join(home, 'vault');
  await mkdir(path.join(vault, 'Inbox'), { recursive: true });
  const env = { BRAINLINK_HOME: path.join(home, 'app'), HOME: home, BRAINLINK_SEMANTIC: '0' };
  const personal = path.join(home, 'personal');
  await mkdir(path.join(personal, 'Inbox'), { recursive: true });
  await saveConfig(normalize({ vaults: [{ name: 'Company', path: vault }, { name: 'Personal', path: personal }] }), path.join(env.BRAINLINK_HOME, 'config.json'));
  const store = await openSessionStore(env);
  const saved = await store.putSession({ client: 'codex', source_id: 'fictional-project-1', project: 'fictional-project', title: 'Project decision',
    summary: 'Draft decision for a made-up product.', started_at: '2026-10-24T00:00:00Z', private: true,
    messages: [{ role: 'user', at: '2026-10-24T00:00:00Z', text: 'private raw turn marker' }] });
  const next = await store.putSession({ client: 'claude-code', source_id: 'fictional-project-2', project: 'fictional-project', title: 'Second work item',
    summary: 'Another made-up project outcome.', started_at: '2026-10-24T01:00:00Z', private: true, messages: [] });
  const app = await startSetup({ env, home, os: 'win32', port: 0, useCli: false });
  const call = (body, token = app.token) => fetch(`http://127.0.0.1:${app.port}/api/sessions/file`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': token }, body: JSON.stringify(body),
  });
  const recommend = (id) => fetch(`http://127.0.0.1:${app.port}/api/sessions/recommend`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': app.token }, body: JSON.stringify({ id }),
  }).then((r) => r.json());
  try {
    assert.equal((await recommend(saved.id)).vault, null);
    assert.equal((await call({ id: saved.id, vault: 'Company', confirm: true }, 'wrong')).status, 401);
    const preview = await (await call({ id: saved.id, vault: 'Company', confirm: false })).json();
    assert.equal(preview.written, false);
    assert.match(preview.preview, /private: true/);
    assert.doesNotMatch(preview.preview, /private raw turn marker/);
    assert.equal((await readdir(path.join(vault, 'Inbox'))).length, 0);
    const written = await (await call({ id: saved.id, vault: 'Company', confirm: true, rememberDestination: true })).json();
    assert.equal(written.written, true);
    assert.equal(written.destination_rule_saved, true);
    assert.match(await readFile(path.join(vault, ...written.path.slice('Company/'.length).split('/')), 'utf8'), /private: true/);
    assert.deepEqual(await recommend(next.id), { vault: 'Company', reason: 'Suggested from your saved choice for this exact project.', project: 'fictional-project', remember_available: true });
    assert.equal((await readdir(path.join(personal, 'Inbox'))).length, 0);
  } finally { app.server.close(); }
});
