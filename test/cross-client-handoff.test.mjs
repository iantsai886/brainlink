import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize, validate } from '../src/config.mjs';
import { createContext } from '../src/core.mjs';
import { createMcp } from '../src/server.mjs';
import { hashToken } from '../src/mcp-agents.mjs';

async function call(mcp, name, args = {}) {
  const response = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(response.error, undefined, `${name} transport call must succeed`);
  const result = response.result;
  let value;
  try { value = JSON.parse(result.content[0].text); } catch { value = result.content[0].text; }
  return { isError: result.isError, value };
}

async function activate(mcp, name) {
  const listed = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const tool = listed.result.tools.find((item) => item.name === `agent_connect_${slug}`)
    || listed.result.tools.find((item) => item.name === 'agent_connect');
  assert.ok(tool, `activation tool exists for ${name}`);
  const args = tool.name === 'agent_connect' ? { agent: name } : {};
  const response = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool.name, arguments: args } });
  assert.equal(response.result?.isError, false, JSON.stringify(response));
}

test('fictional Claude-to-Codex handoff previews, filters private sources, continues, and acknowledges', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-cross-client-'));
  const companyVault = path.join(root, 'company-vault');
  const personalVault = path.join(root, 'personal-vault');
  const mailboxVault = path.join(root, 'shared-handoff-vault');
  const mailbox = path.join(mailboxVault, 'Handoffs');
  await Promise.all([companyVault, personalVault, mailbox].map((folder) => mkdir(folder, { recursive: true })));
  await writeFile(path.join(companyVault, 'Public-Plan.md'), '---\ntitle: Public plan\n---\nApproved fictional scope: build a local demo only.');
  await writeFile(path.join(companyVault, 'Private-Plan.md'), '---\nprivate: true\ntitle: Fictional private note\n---\nZQXPRIVATE_HANDOFF_CANARY');
  await writeFile(path.join(personalVault, 'Personal-Note.md'), '---\nprivate: true\ntitle: Personal note\n---\nZQXPERSONAL_VAULT_CANARY');
  const cfg = normalize({
    version: 2,
    vaults: [
      { name: 'Fictional Company', path: companyVault },
      { name: 'Fictional Personal', path: personalVault, private: true },
      { name: 'Shared Handoff Mailbox', path: mailboxVault },
    ],
    handoff: { vault: 'Shared Handoff Mailbox', folder: 'Handoffs' },
    agents: [
      { name: 'Fictional Claude Role', vault: 'Fictional Company', role: 'Company task role.', activation: ['Connect to Fictional Claude Role'], close: [], connect_notes: [], tail_notes: [], close_target: { mode: 'proposal-only', path: 'BrainLink/Review.md' } },
      { name: 'Fictional Codex Role', vault: 'Fictional Company', role: 'Company task role.', activation: ['Connect to Fictional Codex Role'], close: [], connect_notes: [], tail_notes: [], close_target: { mode: 'proposal-only', path: 'BrainLink/Review.md' } },
      { name: 'Fictional Personal Role', vault: 'Fictional Personal', role: 'Personal task role.', activation: ['Connect to Fictional Personal Role'], close: [], connect_notes: [], tail_notes: [], close_target: { mode: 'proposal-only', path: 'BrainLink/Review.md' } },
    ],
    ai_agents: [
      { id: 'claude_code', name: 'Fictional Claude Code', tokenHash: hashToken('fictional-claude-token') },
      { id: 'codex', name: 'Fictional Codex', tokenHash: hashToken('fictional-codex-token') },
      { id: 'personal_ai', name: 'Fictional Personal AI', tokenHash: hashToken('fictional-personal-token') },
      { id: 'unassigned', name: 'Unassigned Agent', tokenHash: hashToken('fictional-unassigned-token') },
    ],
    twin_profiles: [
      {
        id: 'fictional_org_twin', name: 'Fictional Organisation Twin', mode: 'organisation', owner: 'fictional-owner',
        vaults: [{ name: 'Fictional Company', access: 'propose' }, { name: 'Shared Handoff Mailbox', access: 'propose' }],
        source_policy: { private_default: true, provenance_required: true, session_capture: 'summary-proposal' },
        memory_policy: { working: true, semantic: true, procedural: true, episodic: true },
        allowed_actions: ['search', 'read_note', 'handoff_read', 'write_handoff'],
        agent_access: ['claude_code', 'codex'].map((agent_id) => ({
          agent_id,
          vaults: [
            { name: 'Fictional Company', access: 'propose', operations: ['search', 'read_note'] },
            { name: 'Shared Handoff Mailbox', access: 'propose', operations: ['handoff_read', 'write_handoff'] },
          ],
        })),
      },
      {
        id: 'fictional_personal_twin', name: 'Fictional Personal Twin', mode: 'personal', owner: 'fictional-personal-owner',
        vaults: [{ name: 'Fictional Personal', access: 'read' }, { name: 'Shared Handoff Mailbox', access: 'propose' }],
        source_policy: { private_default: true, provenance_required: true, session_capture: 'summary-proposal' },
        memory_policy: { working: true, semantic: true, procedural: true, episodic: true },
        allowed_actions: ['search', 'read_note', 'handoff_read', 'write_handoff'],
        agent_access: [{
          agent_id: 'personal_ai',
          vaults: [
            { name: 'Fictional Personal', access: 'read', operations: ['search', 'read_note'] },
            { name: 'Shared Handoff Mailbox', access: 'propose', operations: ['handoff_read', 'write_handoff'] },
          ],
        }],
      },
    ],
  });
  assert.deepEqual(validate(cfg), [], 'the isolated sender and recipient have valid, explicit Twin grants');
  const makeClient = (platform, token) => createMcp(createContext(cfg, { env: {
    HOME: root, BRAINLINK_HOME: path.join(root, `app-${platform}`), BRAINLINK_AI_PLATFORM: platform,
    BRAINLINK_AGENT_TOKEN: token, BRAINLINK_SEMANTIC: '0',
  } }));
  const claude = makeClient('Claude Code', 'fictional-claude-token');
  const codex = makeClient('Codex', 'fictional-codex-token');
  const personal = makeClient('Personal AI', 'fictional-personal-token');
  const unassigned = makeClient('Unassigned Agent', 'fictional-unassigned-token');
  await activate(claude, 'Fictional Claude Role');
  await activate(codex, 'Fictional Codex Role');
  await activate(personal, 'Fictional Personal Role');
  const taskId = 'fictional-cross-client-task-01';
  const payload = {
    to: 'Codex', subject: 'Continue fictional local demo', goal: 'Finish the isolated demo UI',
    current_state: 'Scaffold and local route are present; no deployment was performed.',
    decisions: ['Keep all data fictional', 'Do not deploy'], modified_files: ['demo/index.html'],
    tests: ['node --test test/demo.test.mjs — passed'], open_questions: ['Check keyboard navigation'],
    next_steps: ['Run the local accessibility check', 'Report its actual result'],
    git: { repo: 'iantsai886/fictional-demo', branch: 'feature/local-demo', head: 'abcdef1234567', dirty: true, ahead: 2 },
    source_refs: ['Fictional Company::Public-Plan.md'], scope: 'company', confidence: 'reported',
    ai_platform: 'Claude Code', agent_or_role: 'implementation agent', session_or_task_id: taskId,
  };
  try {
    const deniedTools = await unassigned.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(deniedTools.result.tools.some((tool) => tool.name === 'list_handoffs'), false, 'an unassigned agent is not offered handoff tools');
    const denied = await unassigned.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_handoffs', arguments: { to: 'Codex' } } });
    assert.equal(denied.error?.code, -32602, 'direct attempts by an unassigned agent are refused');
    assert.doesNotMatch(JSON.stringify(denied), /Fictional Company|ZQXPRIVATE_HANDOFF_CANARY/);
    const guide = await call(claude, 'brainlink_guide');
    assert.equal(guide.value.handoff_mailbox, 'Shared Handoff Mailbox/Handoffs', JSON.stringify(guide));
    const rejected = await call(claude, 'send_handoff', { ...payload, source_refs: ['Fictional Company::Private-Plan.md'] });
    assert.equal(rejected.value.ok, false);
    const preview = await call(claude, 'send_handoff', { ...payload, confirm: false });
    assert.equal(preview.value.ok, true, JSON.stringify(preview));
    assert.equal(preview.value.written, false);
    assert.match(preview.value.path, /^Shared Handoff Mailbox\/Handoffs\/\d{4}-\d{2}-\d{2}-\d{4}-from-claude-code-to-codex-continue-fictional-local-demo\.md$/);
    const persistedBeforeApproval = await readFile(path.join(mailbox, path.basename(preview.value.path)), 'utf8').catch(() => null);
    assert.equal(persistedBeforeApproval, null);

    const sent = await call(claude, 'send_handoff', { ...payload, preview_path: preview.value.path, confirm: true });
    assert.equal(sent.value.written, true);
    assert.equal(sent.value.path, preview.value.path);
    const note = await readFile(path.join(mailbox, path.basename(sent.value.path)), 'utf8');
    assert.match(note, /## Goal\n\nFinish the isolated demo UI/);
    assert.match(note, /git_checkpoint_schema: 1/);
    assert.match(note, /Git checkpoint \(reported by sender; not verified by BrainLink\)/);
    assert.match(note, /Working tree dirty: true/);
    assert.match(note, /`Fictional Company::Public-Plan\.md`/);
    assert.doesNotMatch(note, /ZQXPRIVATE_HANDOFF_CANARY/);

    const pickup = await call(codex, 'list_handoffs', { to: 'Codex' });
    assert.equal(pickup.value.length, 1);
    assert.equal(pickup.value[0].path, sent.value.path);
    assert.deepEqual(pickup.value[0].git_checkpoint, { repo: 'iantsai886/fictional-demo', branch: 'feature/local-demo', head: 'abcdef1234567', dirty: true, ahead: 2, source: 'reported' });
    assert.match(pickup.value[0].excerpt, /Finish the isolated demo UI/);
    assert.doesNotMatch(JSON.stringify(pickup.value), /ZQXPRIVATE_HANDOFF_CANARY|Private-Plan/);

    const ack = await call(codex, 'send_handoff', {
      to: 'Claude Code', subject: 'Picked up fictional local demo', goal: 'Continue the isolated demo',
      current_state: 'Reviewed the authorized handoff and confirmed the current scaffold.',
      ack_of: sent.value.path, scope: 'company', confidence: 'reported',
      ai_platform: 'Codex', agent_or_role: 'implementation agent', session_or_task_id: `${taskId}-ack`, confirm: true,
    });
    assert.equal(ack.value.written, true);
    const returned = await call(claude, 'list_handoffs', { to: 'Claude Code' });
    assert.equal(returned.value.length, 1);
    assert.equal(returned.value[0].ack_of, sent.value.path);
    const source = await readFile(path.join(mailbox, path.basename(returned.value[0].path)), 'utf8');
    assert.doesNotMatch(source, /ZQXPRIVATE_HANDOFF_CANARY/);
    const changedCheckpoint = note.replace('git_ahead: 2', 'git_ahead: nope');
    assert.notEqual(changedCheckpoint, note);
    await writeFile(path.join(mailbox, path.basename(sent.value.path)), changedCheckpoint);
    const malformed = await call(codex, 'list_handoffs', { to: 'Codex' });
    const malformedItem = malformed.value.find(item => item.path === sent.value.path);
    assert.equal(malformedItem.git_checkpoint, undefined);

    const personalInbox = await call(personal, 'list_handoffs', { to: 'Codex' });
    assert.deepEqual(personalInbox.value, [], 'a Personal Twin does not receive the Organisation Twin handoff');
    const crossTwinSource = await call(personal, 'send_handoff', {
      to: 'Codex', subject: 'Attempt to cite company source', goal: 'Must be refused',
      source_refs: ['Fictional Company::Public-Plan.md'], scope: 'personal', confidence: 'reported',
      ai_platform: 'Personal AI', agent_or_role: 'personal assistant', session_or_task_id: `${taskId}-cross-twin`, confirm: false,
    });
    assert.equal(crossTwinSource.value.ok, false, 'a Personal Twin cannot cite a Company note through the shared mailbox');
    assert.doesNotMatch(JSON.stringify(crossTwinSource), /Approved fictional scope|ZQXPRIVATE_HANDOFF_CANARY/);
    const personalTools = await personal.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    assert.equal(personalTools.result.tools.some((tool) => tool.name === 'vault_search'), true);
    const wrongScopeRead = await personal.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'vault_search', arguments: { vault: 'Fictional Company', query: 'Public plan' } } });
    assert.equal(wrongScopeRead.result?.isError, true, 'Personal agent cannot search the company vault');
    assert.doesNotMatch(JSON.stringify(wrongScopeRead), /Approved fictional scope|ZQXPRIVATE_HANDOFF_CANARY/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Git handoff checkpoints reject URLs, unsafe branches, invalid SHAs, and unbounded ahead counts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-git-checkpoint-'));
  const vault = path.join(root, 'vault'), mailbox = path.join(vault, 'Handoffs');
  await mkdir(mailbox, { recursive: true });
  const ctx = createContext(normalize({ vaults: [{ name: 'Fictional', path: vault }], handoff: { vault: 'Fictional', folder: 'Handoffs' } }), { env: { HOME: root, BRAINLINK_HOME: path.join(root, 'app') } });
  const base = { to: 'Codex', subject: 'Safe checkpoint', goal: 'Continue fictional work', ai_platform: 'Claude Code', agent_or_role: 'builder', session_or_task_id: 'checkpoint-validation', confirm: false };
  try {
    for (const git of [
      { repo: 'https://github.com/iantsai886/demo', branch: 'main', head: 'abcdef1234567', dirty: false, ahead: 0 },
      { repo: 'owner/repo', branch: '../main', head: 'abcdef1234567', dirty: false, ahead: 0 },
      { repo: 'owner/repo', branch: 'main', head: 'not-a-sha', dirty: false, ahead: 0 },
      { repo: 'owner/repo', branch: 'main', head: 'abcdef1234567', dirty: false, ahead: 10001 },
    ]) {
      const result = await call(createMcp(ctx), 'send_handoff', { ...base, git });
      assert.equal(result.value.ok, false);
      assert.ok(result.value.errors.some(error => error.startsWith('git.')));
    }
    const noCheckpoint = await call(createMcp(ctx), 'send_handoff', base);
    assert.equal(noCheckpoint.value.ok, true);
    assert.doesNotMatch(noCheckpoint.value.preview, /Git checkpoint|git_checkpoint/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
