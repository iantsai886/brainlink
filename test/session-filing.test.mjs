import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize, saveConfig } from '../src/config.mjs';
import { createContext, readNote } from '../src/core.mjs';
import { fileSessionSummary, filingFields } from '../src/sessions/filing.mjs';
import { recommendSessionVault } from '../src/sessions/routing.mjs';
import { listSessionFilingFolders, suggestedSessionFolder } from '../src/sessions/folders.mjs';
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

test('session filing previews links from the chosen vault and excludes private and other-vault notes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-filing-links-'));
  const company = path.join(root, 'company');
  const personal = path.join(root, 'personal');
  await mkdir(path.join(company, 'Inbox'), { recursive: true });
  await mkdir(path.join(personal, 'Inbox'), { recursive: true });
  await import('node:fs/promises').then(({ writeFile }) => Promise.all([
    writeFile(path.join(company, 'Public Roadmap.md'), 'Northwind launch timing is pending review. This public roadmap captures the fictional project milestones, expected owner updates, and open questions for the next planning meeting.'),
    writeFile(path.join(company, 'Private Review.md'), '---\nprivate: true\n---\nNorthwind secret acquisition plan.'),
    writeFile(path.join(personal, 'Personal Notes.md'), 'Northwind launch timing and family plans.'),
  ]));
  const ctx = createContext(normalize({ vaults: [
    { name: 'Company', path: company }, { name: 'Personal', path: personal },
  ] }), { env: { BRAINLINK_AI_PLATFORM: 'BrainLink Local', BRAINLINK_HOME: path.join(root, 'app') } });
  const session = { id: 'fictional-links-001', title: 'Northwind status', summary: 'Public Roadmap says Northwind launch timing remains pending review.', client: 'codex', project: 'Northwind' };
  const preview = await fileSessionSummary(ctx, session, 'Company');
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.linked_to, ['Public Roadmap']);
  assert.match(preview.preview, /\[\[Public Roadmap\]\]/);
  assert.doesNotMatch(preview.preview, /Private Review|acquisition plan|Personal Notes|family plans/);
  const saved = await fileSessionSummary(ctx, session, 'Company', true);
  assert.equal(saved.written, true);
  const rel = saved.path.slice('Company/'.length);
  assert.match(await readFile(path.join(company, ...rel.split('/')), 'utf8'), /\[\[Public Roadmap\]\]/);
  assert.equal((await readdir(path.join(personal, 'Inbox'))).length, 0);
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

test('folder suggestions reuse only an exact project choice that still exists in the chosen vault', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-filing-folder-route-'));
  const personal = path.join(root, 'personal');
  await mkdir(path.join(root, 'Projects', 'Northwind'), { recursive: true });
  await mkdir(path.join(root, 'Inbox'), { recursive: true });
  await mkdir(path.join(personal, 'Inbox'), { recursive: true });
  const cfg = normalize({ vaults: [{ name: 'Company', path: root }, { name: 'Personal', path: personal }], session_filing: {
    projectFolders: { Northwind: { vault: 'Company', folder: 'Projects/Northwind' }, Similar: { vault: 'Company', folder: 'Missing' } },
  } });
  const ctx = createContext(cfg);
  assert.deepEqual(await suggestedSessionFolder(ctx, { project: 'Northwind' }, 'Company'), {
    folder: 'Projects/Northwind', source: 'saved', reason: 'Matches your saved choice for this exact project.',
  });
  assert.equal(await suggestedSessionFolder(ctx, { project: 'Northwind-Other' }, 'Company'), null);
  assert.equal(await suggestedSessionFolder(ctx, { project: 'Northwind' }, 'Personal'), null);
  assert.equal(await suggestedSessionFolder(ctx, { project: 'Similar' }, 'Company'), null);
});

test('folder suggestion can use a same-vault note explicitly mentioned in the session summary', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-filing-content-route-'));
  await mkdir(path.join(root, 'Projects', 'Bluebird'), { recursive: true });
  await mkdir(path.join(root, 'Finance'), { recursive: true });
  await writeFile(path.join(root, 'Projects', 'Bluebird', 'Delivery Plan.md'), 'The Bluebird migration plan tracks staged rollout, test owners, customer communications, rollback criteria, unresolved technical questions and weekly delivery milestones for the fictional project.');
  await writeFile(path.join(root, 'Finance', 'Private Budget.md'), '---\nprivate: true\n---\nThe Bluebird private budget has a canary-only marker and must never guide recommendations.');
  const ctx = createContext(normalize({ vaults: [{ name: 'Company', path: root }] }));
  const suggestion = await suggestedSessionFolder(ctx, { project: 'Bluebird', title: 'Migration update', summary: 'Delivery Plan says the Bluebird rollout remains in review.' }, 'Company');
  assert.deepEqual(suggestion, {
    folder: 'Projects/Bluebird', source: 'related_note', reason: 'Matches an existing note mentioned in this session summary.',
  });
  assert.doesNotMatch(JSON.stringify(suggestion), /Private Budget|canary-only/);
});

test('folder suggestion abstains when exact note mentions point to different folders', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-filing-content-ambiguous-'));
  await mkdir(path.join(root, 'Projects', 'Bluebird'), { recursive: true });
  await mkdir(path.join(root, 'Legal'), { recursive: true });
  await writeFile(path.join(root, 'Projects', 'Bluebird', 'Delivery Plan.md'), 'The Bluebird migration plan tracks staged rollout, test owners, customer communications, rollback criteria, unresolved technical questions and weekly delivery milestones for the fictional project.');
  await writeFile(path.join(root, 'Legal', 'Service Contract.md'), 'The fictional Bluebird service contract records the proposed term, review owner, cancellation window, renewal process and open legal questions for the project team.');
  const ctx = createContext(normalize({ vaults: [{ name: 'Company', path: root }] }));
  const suggestion = await suggestedSessionFolder(ctx, { project: 'Bluebird', summary: 'Delivery Plan and Service Contract are both under discussion.' }, 'Company');
  assert.equal(suggestion, null);
});

test('folder picker excludes hidden, protected and .brainlinkignore folders', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-filing-folder-picker-'));
  await mkdir(path.join(root, 'Inbox'), { recursive: true });
  await mkdir(path.join(root, 'Projects', 'Visible'), { recursive: true });
  await mkdir(path.join(root, 'Projects', 'Excluded'), { recursive: true });
  await mkdir(path.join(root, '00 INDEX'), { recursive: true });
  await mkdir(path.join(root, '.private'), { recursive: true });
  await writeFile(path.join(root, '.brainlinkignore'), 'Excluded\n');
  const ctx = createContext(normalize({ vaults: [{ name: 'Company', path: root }] }));
  const folders = await listSessionFilingFolders(ctx, 'Company');
  assert.deepEqual(folders.map((folder) => folder.path), ['Inbox', 'Projects', 'Projects/Visible']);
  assert.equal((await fileSessionSummary(ctx, { id: 'x', summary: 'safe summary' }, 'Company', false, {}, 'Projects/Excluded')).ok, false);
});

test('local filing API requires its token and writes a private note only after confirmation', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'bl-filing-api-'));
  const vault = path.join(home, 'vault');
  await mkdir(path.join(vault, 'Inbox'), { recursive: true });
  await mkdir(path.join(vault, 'Projects', 'fictional-project'), { recursive: true });
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
  const manageFiled = (body, token = app.token) => fetch(`http://127.0.0.1:${app.port}/api/sessions/filed-summary`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': token }, body: JSON.stringify(body),
  });
  const listFiled = (body, token = app.token) => fetch(`http://127.0.0.1:${app.port}/api/sessions/filed-summaries`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': token }, body: JSON.stringify(body),
  });
  const recommend = (id) => fetch(`http://127.0.0.1:${app.port}/api/sessions/recommend`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': app.token }, body: JSON.stringify({ id }),
  }).then((r) => r.json());
  const folders = (id, vaultName) => fetch(`http://127.0.0.1:${app.port}/api/sessions/filing-folders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': app.token }, body: JSON.stringify({ id, vault: vaultName }),
  }).then((r) => r.json());
  try {
    assert.equal((await recommend(saved.id)).vault, null);
    assert.equal((await call({ id: saved.id, vault: 'Company', confirm: true }, 'wrong')).status, 401);
    const folderOptions = await folders(saved.id, 'Company');
    assert.ok(folderOptions.folders.some((folder) => folder.path === 'Projects/fictional-project'));
    const preview = await (await call({ id: saved.id, vault: 'Company', folder: 'Projects/fictional-project', confirm: false })).json();
    assert.equal(preview.written, false);
    assert.match(preview.preview, /private: true/);
    assert.doesNotMatch(preview.preview, /private raw turn marker/);
    assert.equal((await readdir(path.join(vault, 'Projects', 'fictional-project'))).length, 0);
    const written = await (await call({ id: saved.id, vault: 'Company', folder: 'Projects/fictional-project', confirm: true, rememberDestination: true })).json();
    assert.equal(written.written, true);
    assert.equal(written.destination_rule_saved, true);
    const rel = written.path.slice('Company/'.length);
    const file = path.join(vault, ...rel.split('/'));
    assert.match(await readFile(file, 'utf8'), /private: true/);
    assert.equal((await listFiled({ vault: 'Company' }, 'wrong')).status, 401);
    const companyFiled = await (await listFiled({ vault: 'Company' })).json();
    assert.equal(companyFiled.summaries.length, 1);
    assert.equal(companyFiled.summaries[0].sessionId, saved.id);
    assert.equal('summary' in companyFiled.summaries[0], false, 'list metadata does not include the private summary text');
    assert.equal((await (await listFiled({ vault: 'Personal' })).json()).summaries.length, 0, 'vault selection prevents cross-vault results');
    const filedRef = { sessionId: saved.id, vault: 'Company', path: rel };
    assert.equal((await manageFiled({ ...filedRef, action: 'read' }, 'wrong')).status, 401);
    const opened = await (await manageFiled({ ...filedRef, action: 'read' })).json();
    assert.equal(opened.summary, 'Draft decision for a made-up product.', JSON.stringify(opened));
    assert.match((await (await manageFiled({ ...filedRef, sessionId: next.id, action: 'read' })).json()).error, /not an editable private session-summary proposal/);
    assert.match((await (await manageFiled({ ...filedRef, etag: opened.etag, action: 'correct', summary: 'credential sk-abcdefghijklmnopqrstuvwxyz123' })).json()).error, /may contain a secret/);
    const corrected = await (await manageFiled({ ...filedRef, etag: opened.etag, action: 'correct', summary: 'Corrected made-up product decision.' })).json();
    assert.equal(corrected.status, 'proposed');
    assert.match((await (await manageFiled({ ...filedRef, etag: opened.etag, action: 'correct', summary: 'stale write' })).json()).error, /changed since it was opened/, 'stale edits are refused');
    const afterCorrection = await (await manageFiled({ ...filedRef, action: 'read' })).json();
    assert.equal(afterCorrection.summary, 'Corrected made-up product decision.');
    const correctedRaw = await readFile(file, 'utf8');
    assert.match(correctedRaw, /private: true/);
    assert.match(correctedRaw, /Summary corrected by user/);
    assert.doesNotMatch(correctedRaw, /private raw turn marker/);
    const withdrawn = await (await manageFiled({ ...filedRef, etag: afterCorrection.etag, action: 'withdraw' })).json();
    assert.equal(withdrawn.status, 'withdrawn');
    const withdrawnRaw = await readFile(file, 'utf8');
    assert.match(withdrawnRaw, /status: withdrawn/);
    assert.match(withdrawnRaw, /Proposal withdrawn by user/);
    assert.match(withdrawnRaw, /Corrected made-up product decision/);
    assert.equal((await (await listFiled({ vault: 'Company' })).json()).summaries.length, 0, 'withdrawn proposals leave the active review list');
    assert.deepEqual(await recommend(next.id), { vault: 'Company', reason: 'Suggested from your saved choice for this exact project.', project: 'fictional-project', remember_available: true });
    const folderSuggestion = await folders(next.id, 'Company');
    assert.equal(folderSuggestion.suggested_folder, 'Projects/fictional-project');
    assert.equal(folderSuggestion.folder_suggestion_source, 'saved');
    assert.equal((await readdir(path.join(personal, 'Inbox'))).length, 0);
  } finally { app.server.close(); }
});
