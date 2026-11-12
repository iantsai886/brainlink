import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createProposalInbox } from '../src/proposal-inbox.mjs';
import { createContext } from '../src/core.mjs';
import { createMcp } from '../src/server.mjs';
import { listHandoffs } from '../src/writes.mjs';
import { normalize, saveConfig } from '../src/config.mjs';
import { startSetup } from '../src/setup.mjs';

test('proposal inbox deduplicates local drafts and rejects unsafe paths or secret-bearing content', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-proposal-inbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault'); await mkdir(vault);
  const inbox = createProposalInbox({ home: path.join(root, 'app') });
  const proposal = { vault: 'Fictional', vaultPath: vault, path: 'Inbox/New Note.md', content: '# Fictional\n', tool: 'propose_note', agent: 'Fixture AI' };
  const first = await inbox.add(proposal);
  const duplicate = await inbox.add(proposal);
  assert.equal(first.id, duplicate.id);
  assert.equal((await inbox.listPending()).length, 1);
  assert.equal(await inbox.add({ ...proposal, path: '../outside.md' }), null);
  assert.equal(await inbox.add({ ...proposal, path: 'Inbox/Secret.md', content: 'sk-test-12345678901234567890' }), null);
  await inbox.resolve(first.id, 'rejected');
  assert.deepEqual(await inbox.listPending(), []);
  assert.equal((await readdir(path.join(root, 'app', 'proposals', 'resolved'))).length, 1);
});

test('MCP queues proposal-only new-note previews without changing the vault', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-proposal-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vaultPath = path.join(root, 'vault'); await mkdir(path.join(vaultPath, 'Inbox'), { recursive: true });
  const cfg = normalize({ vaults: [{ name: 'Fictional', path: vaultPath, private: true, writes: 'on' }] });
  const ctx = createContext(cfg, { env: { BRAINLINK_SEMANTIC: '0' } });
  const queued = [];
  const mcp = createMcp(ctx, { onProposal: async (proposal) => { queued.push(proposal); return { id: 'queued' }; } });
  const result = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'propose_note', arguments: {
    vault: 'Fictional', folder: 'Inbox', title: 'A safe idea', body: 'Fictional draft.', source: 'user request',
    ai_platform: 'Fixture AI', agent_or_role: 'Assistant', session_or_task_id: 'fictional-task', confirm: true, auto_link: false,
  } } });
  assert.equal(result.result.structuredContent.written, false);
  assert.equal(result.result.structuredContent.owner_review_id, 'queued');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].path, 'Inbox/2026-11-11 — A safe idea.md');
  assert.deepEqual(await readdir(path.join(vaultPath, 'Inbox')), []);
});

test('authenticated owner approval saves one new file, respects read-only mode, and rejects without writing', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-proposal-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appHome = path.join(root, 'app'), vaultPath = path.join(root, 'vault');
  await mkdir(path.join(vaultPath, 'Inbox'), { recursive: true });
  await mkdir(path.join(vaultPath, 'Mailbox'), { recursive: true });
  const env = { BRAINLINK_HOME: appHome, BRAINLINK_SEMANTIC: '0' };
  const cfg = normalize({ vaults: [{ name: 'Fictional', path: vaultPath, private: true, writes: 'on' }], handoff: { vault: 'Fictional', folder: 'Mailbox' } });
  await saveConfig(cfg, path.join(appHome, 'config.json'));
  const inbox = createProposalInbox({ home: appHome });
  const app = await startSetup({ env, home: root, os: 'linux', port: 0, useCli: false });
  t.after(() => app.server.close());
  const base = `http://127.0.0.1:${app.port}`;
  const api = async (method, route, body = {}) => {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': app.token }, body: method === 'GET' ? undefined : JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  };
  const proposal = await inbox.add({ vault: 'Fictional', vaultPath, path: 'Inbox/Approved.md', content: '# Approved\n\nFictional content.\n', tool: 'propose_note', agent: 'Fixture AI' });
  const listed = await api('GET', '/api/proposals');
  assert.equal(listed.json.proposals.length, 1);
  const denied = await fetch(base + '/api/proposals/approve', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': 'wrong-token' }, body: JSON.stringify({ id: proposal.id, confirm: true }) });
  assert.equal(denied.status, 401);
  const saved = await api('POST', '/api/proposals/approve', { id: proposal.id, confirm: true });
  assert.equal(saved.json.path, 'Fictional/Inbox/Approved.md');
  assert.equal(await readFile(path.join(vaultPath, 'Inbox', 'Approved.md'), 'utf8'), proposal.content);
  assert.deepEqual((await api('GET', '/api/proposals')).json.proposals, []);
  const handoffMcp = createMcp(createContext(cfg, { env: { BRAINLINK_SEMANTIC: '0', BRAINLINK_AI_PLATFORM: 'Claude' } }), { onProposal: (draft) => inbox.add(draft) });
  const handoff = await handoffMcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send_handoff', arguments: {
    to: 'Codex', subject: 'Continue the fictional task', goal: 'Finish the sample task', current_state: 'The first AI prepared a draft.',
    next_steps: ['Review the draft'], body: 'Use only fictional test content.', scope: 'company', confidence: 'reported',
    ai_platform: 'Claude', agent_or_role: 'Fixture assistant', session_or_task_id: 'fictional-handoff-1', confirm: true,
  } } });
  assert.equal(handoff.result.structuredContent.written, false);
  const handoffId = handoff.result.structuredContent.owner_review_id;
  const handoffApproval = await api('POST', '/api/proposals/approve', { id: handoffId, confirm: true });
  assert.equal(handoffApproval.json.ok, true);
  const receiver = createContext(cfg, { env: { BRAINLINK_SEMANTIC: '0', BRAINLINK_AI_PLATFORM: 'Codex' } });
  const receipts = await listHandoffs(receiver, { to: 'Codex' });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].subject, 'Continue the fictional task');
  const memoryMcp = createMcp(createContext(cfg, { env: { BRAINLINK_SEMANTIC: '0', BRAINLINK_AI_PLATFORM: 'Claude' } }), { onProposal: (draft) => inbox.add(draft) });
  const memory = await memoryMcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'remember', arguments: {
    vault: 'Fictional', fact: 'The fictional user prefers short notes.', source: 'fictional request', ai_platform: 'Claude', confirm: true,
  } } });
  assert.equal(memory.result.structuredContent.written, false);
  assert.equal(memory.result.structuredContent.owner_review_id != null, true);
  const memoryApproval = await api('POST', '/api/proposals/approve', { id: memory.result.structuredContent.owner_review_id, confirm: true });
  assert.equal(memoryApproval.json.ok, true);
  assert.match(await readFile(path.join(vaultPath, 'BrainLink', 'Memories.md'), 'utf8'), /fictional user prefers short notes/);
  const daily = await memoryMcp.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'append_daily', arguments: {
    vault: 'Fictional', text: 'A fictional daily capture.', source: 'fictional task', ai_platform: 'Claude', confirm: true,
  } } });
  assert.equal(daily.result.structuredContent.written, false);
  assert.equal(daily.result.structuredContent.owner_review_id != null, true);
  const dailyApproval = await api('POST', '/api/proposals/approve', { id: daily.result.structuredContent.owner_review_id, confirm: true });
  assert.equal(dailyApproval.json.ok, true);
  assert.match(await readFile(path.join(vaultPath, 'Daily', '2026-11-11.md'), 'utf8'), /A fictional daily capture/);
  const appendPath = 'Inbox/Append.md';
  const appendFile = path.join(vaultPath, 'Inbox', 'Append.md');
  const original = '# Existing note\n\nOriginal approved content.\n';
  await writeFile(appendFile, original);
  const appendProposal = await inbox.add({ vault: 'Fictional', vaultPath, path: appendPath, content: '\nAI draft to append.\n', action: 'append', expectedHash: createHash('sha256').update(original).digest('hex'), tool: 'append_daily', agent: 'Fixture AI' });
  const appended = await api('POST', '/api/proposals/approve', { id: appendProposal.id, confirm: true });
  assert.equal(appended.json.ok, true);
  assert.equal(await readFile(appendFile, 'utf8'), original + '\nAI draft to append.\n');
  const staleProposal = await inbox.add({ vault: 'Fictional', vaultPath, path: appendPath, content: 'Stale append.\n', action: 'append', expectedHash: createHash('sha256').update(await readFile(appendFile)).digest('hex'), tool: 'append_daily', agent: 'Fixture AI' });
  await writeFile(appendFile, original + '\nAn owner edit.\n');
  const stale = await api('POST', '/api/proposals/approve', { id: staleProposal.id, confirm: true });
  assert.equal(stale.status, 400);
  assert.equal(await readFile(appendFile, 'utf8'), original + '\nAn owner edit.\n');
  const conflict = await inbox.add({ vault: 'Fictional', vaultPath, path: 'Inbox/Approved.md', content: '# Must not overwrite\n', tool: 'propose_note', agent: 'Fixture AI' });
  const refused = await api('POST', '/api/proposals/approve', { id: conflict.id, confirm: true });
  assert.equal(refused.status, 400);
  assert.equal(await readFile(path.join(vaultPath, 'Inbox', 'Approved.md'), 'utf8'), proposal.content);
  const discarded = await inbox.add({ vault: 'Fictional', vaultPath, path: 'Inbox/Rejected.md', content: '# Discarded\n', tool: 'propose_note', agent: 'Fixture AI' });
  assert.equal((await api('POST', '/api/proposals/reject', { id: discarded.id, confirm: true })).json.ok, true);
  await assert.rejects(readFile(path.join(vaultPath, 'Inbox', 'Rejected.md')));
});
