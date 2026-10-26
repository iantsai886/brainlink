import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize, CONFIG_SCHEMA_VERSION } from '../src/config.mjs';
import { createContext, readNote } from '../src/core.mjs';
import { createMcp } from '../src/server.mjs';
import { openSessionStore } from '../src/sessions/index.mjs';
import { closeSession } from '../src/sessions/close.mjs';

const call = async (mcp, name, args = {}) => {
  const response = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const text = response.result.content[0].text;
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  return { error: response.result.isError, value };
};

test('MCP close previews, then saves one scoped private episode without exposing it via sharing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-close-'));
  const company = path.join(root, 'company');
  const personal = path.join(root, 'personal');
  await mkdir(path.join(company, 'Inbox'), { recursive: true });
  await mkdir(path.join(company, 'Projects', 'Fictional Launch'), { recursive: true });
  await mkdir(path.join(personal, 'Inbox'), { recursive: true });
  const env = { BRAINLINK_HOME: path.join(root, 'app'), HOME: root, BRAINLINK_AI_PLATFORM: 'Codex', BRAINLINK_VAULTS: 'Company', BRAINLINK_SEMANTIC: '0' };
  const cfg = normalize({ version: CONFIG_SCHEMA_VERSION, vaults: [{ name: 'Company', path: company }, { name: 'Personal', path: personal }], sessions: { shareSummaries: true, shareFullText: true } });
  const ctx = createContext(cfg, { env });
  const mcp = createMcp(ctx);
  const choices = await call(mcp, 'session_filing_folders', { vault: 'Company' });
  assert.equal(choices.error, false);
  assert.ok(choices.value.some((folder) => folder.path === 'Projects/Fictional Launch'));
  const forbiddenChoices = await call(mcp, 'session_filing_folders', { vault: 'Personal' });
  assert.equal(forbiddenChoices.error, true, 'a connection cannot enumerate a vault outside its enabled scope');
  const args = { vault: 'Company', folder: 'Projects/Fictional Launch', title: 'Fictional launch', goal: 'Plan the fictional launch', outcome: 'Drafted a plan; no deployment.', decisions: ['Review next week'], next_actions: ['Get approval'], session_or_task_id: 'fake-task-1' };
  const preview = await call(mcp, 'session_close', args);
  assert.equal(preview.error, false);
  assert.equal(preview.value.written, false);
  assert.equal(preview.value.session_saved, false);
  assert.match(preview.value.preview, /private: true/);
  assert.equal((await readdir(path.join(company, 'Projects', 'Fictional Launch'))).length, 0);
  assert.equal((await (await openSessionStore(env)).listSessions()).length, 0);

  const wrong = await call(mcp, 'session_close', { ...args, vault: 'Personal', confirm: true });
  assert.equal(wrong.error, true);
  assert.equal((await readdir(path.join(personal, 'Inbox'))).length, 0);
  const written = await call(mcp, 'session_close', { ...args, confirm: true });
  assert.equal(written.error, false);
  assert.equal(written.value.written, true);
  assert.equal(written.value.session_saved, true);
  const rel = written.value.path.slice('Company/'.length);
  const note = await readFile(path.join(company, ...rel.split('/')), 'utf8');
  assert.match(note, /private: true/);
  assert.match(note, /Plan the fictional launch/);
  await assert.rejects(readNote(ctx, 'Company', rel), /private/i);
  assert.deepEqual((await call(mcp, 'session_list')).value.sessions, [], 'global import sharing cannot expose a closed private session');
  assert.equal((await call(mcp, 'session_read', { id: written.value.session_id })).value.private, true);
  const duplicate = await call(mcp, 'session_close', { ...args, outcome: 'A conflicting later claim', confirm: true });
  assert.equal(duplicate.error, true);
  assert.match(duplicate.value.errors.join(), /already closed/);
  const stored = await (await openSessionStore(env)).readSession(written.value.session_id, {});
  assert.doesNotMatch(stored.session.summary, /conflicting later claim/);
  assert.equal((await readdir(path.join(personal, 'Inbox'))).length, 0);
});

test('MCP close rejects unsafe or incomplete outcomes before saving', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-close-invalid-'));
  await mkdir(path.join(root, 'Inbox'));
  const env = { BRAINLINK_HOME: path.join(root, 'app'), HOME: root, BRAINLINK_AI_PLATFORM: 'Claude' };
  const mcp = createMcp(createContext(normalize({ vaults: [{ name: 'Company', path: root }] }), { env }));
  const base = { vault: 'Company', title: 'Example', goal: 'Plan', outcome: 'Drafted', session_or_task_id: 'x', confirm: true };
  assert.equal((await call(mcp, 'session_close', { ...base, goal: '' })).error, true);
  assert.equal((await call(mcp, 'session_close', { ...base, outcome: 'API key sk-abcdefghijklmnopqrstuvwxyz123' })).error, true);
  assert.equal((await call(mcp, 'session_close', { ...base, folder: '../Outside' })).error, true);
  assert.equal((await readdir(path.join(root, 'Inbox'))).length, 0);
});

test('close reports a recoverable partial save when session storage succeeds but note filing fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-close-partial-'));
  await mkdir(path.join(root, 'Inbox'));
  const env = { BRAINLINK_HOME: path.join(root, 'app'), HOME: root, BRAINLINK_AI_PLATFORM: 'Codex' };
  const ctx = createContext(normalize({ vaults: [{ name: 'Company', path: root }] }), { env });
  const store = await openSessionStore(env);
  const args = { vault: 'Company', title: 'Fictional task', goal: 'Check recovery', outcome: 'Session saved', session_or_task_id: 'partial-1', confirm: true };
  const result = await closeSession(ctx, store, args, new Date('2026-10-27T00:00:00.000Z'), {
    fileSummary: async (_ctx, _session, _vault, confirm) => {
      if (!confirm) return { ok: true, written: false, preview: 'fictional preview' };
      throw new Error('sensitive filesystem detail must not escape');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.session_saved, true);
  assert.equal(result.filing_status, 'unknown');
  assert.equal(result.next, 'Open Sessions in BrainLink, review this saved session, then use File summary to finish filing it.');
  assert.doesNotMatch(JSON.stringify(result), /sensitive filesystem detail/);
  const saved = await store.readSession(result.session_id, {});
  assert.equal(saved.session.private, true);
  assert.equal(saved.session.summary.includes('Session saved'), true);
});

test('close reports a recoverable partial save when filing returns a non-written result', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-close-not-written-'));
  await mkdir(path.join(root, 'Inbox'));
  const env = { BRAINLINK_HOME: path.join(root, 'app'), HOME: root, BRAINLINK_AI_PLATFORM: 'Codex' };
  const ctx = createContext(normalize({ vaults: [{ name: 'Company', path: root }] }), { env });
  const store = await openSessionStore(env);
  const result = await closeSession(ctx, store, {
    vault: 'Company', title: 'Fictional task', goal: 'Check proposal-only response', outcome: 'No note was written.',
    session_or_task_id: 'not-written-1', confirm: true,
  }, new Date('2026-10-27T00:00:00.000Z'), {
    fileSummary: async (_ctx, _session, _vault, confirm) => confirm
      ? { ok: true, written: false, preview: 'unwritten proposal' }
      : { ok: true, written: false, preview: 'preview' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.session_saved, true);
  assert.equal(result.filing_status, 'not_written');
  assert.doesNotMatch(JSON.stringify(result), /unwritten proposal/);
  assert.equal((await store.readSession(result.session_id, {})).session.private, true);
});
