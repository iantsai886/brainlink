import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize } from '../src/config.mjs';
import { createContext } from '../src/core.mjs';
import { createMcp } from '../src/server.mjs';

async function call(mcp, name, args = {}) {
  const response = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(response.error, undefined, `${name} transport call must succeed`);
  const result = response.result;
  const value = JSON.parse(result.content[0].text);
  return { isError: result.isError, value };
}

test('fictional Claude-to-Codex handoff previews, filters private sources, continues, and acknowledges', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-cross-client-'));
  const vault = path.join(root, 'company-vault');
  const mailbox = path.join(vault, 'Handoffs');
  await mkdir(mailbox, { recursive: true });
  await writeFile(path.join(vault, 'Public-Plan.md'), '---\ntitle: Public plan\n---\nApproved fictional scope: build a local demo only.');
  await writeFile(path.join(vault, 'Private-Plan.md'), '---\nprivate: true\ntitle: Fictional private note\n---\nZQXPRIVATE_HANDOFF_CANARY');
  const cfg = normalize({ vaults: [{ name: 'Fictional Company', path: vault }], handoff: { vault: 'Fictional Company', folder: 'Handoffs' } });
  const makeClient = (platform) => createMcp(createContext(cfg, { env: {
    HOME: root, BRAINLINK_HOME: path.join(root, 'app'), BRAINLINK_AI_PLATFORM: platform, BRAINLINK_SEMANTIC: '0',
  } }));
  const claude = makeClient('Claude Code');
  const codex = makeClient('Codex');
  const taskId = 'fictional-cross-client-task-01';
  const payload = {
    to: 'Codex', subject: 'Continue fictional local demo', goal: 'Finish the isolated demo UI',
    current_state: 'Scaffold and local route are present; no deployment was performed.',
    decisions: ['Keep all data fictional', 'Do not deploy'], modified_files: ['demo/index.html'],
    tests: ['node --test test/demo.test.mjs — passed'], open_questions: ['Check keyboard navigation'],
    next_steps: ['Run the local accessibility check', 'Report its actual result'],
    git: { repo: 'iantsai886/fictional-demo', branch: 'feature/local-demo', head: 'abcdef1234567', dirty: true, ahead: 2 },
    source_refs: ['Public-Plan.md'], scope: 'company', confidence: 'reported',
    ai_platform: 'Claude Code', agent_or_role: 'implementation agent', session_or_task_id: taskId,
  };
  try {
    assert.equal((await call(claude, 'brainlink_guide')).value.handoff_mailbox, 'Fictional Company/Handoffs');
    const rejected = await call(claude, 'send_handoff', { ...payload, source_refs: ['Private-Plan.md'] });
    assert.equal(rejected.value.ok, false);
    const preview = await call(claude, 'send_handoff', { ...payload, confirm: false });
    assert.equal(preview.value.ok, true);
    assert.equal(preview.value.written, false);
    assert.match(preview.value.path, /^Fictional Company\/Handoffs\/\d{4}-\d{2}-\d{2}-\d{4}-from-claude-code-to-codex-continue-fictional-local-demo\.md$/);
    const persistedBeforeApproval = await readFile(path.join(mailbox, path.basename(preview.value.path)), 'utf8').catch(() => null);
    assert.equal(persistedBeforeApproval, null);

    const sent = await call(claude, 'send_handoff', { ...payload, confirm: true });
    assert.equal(sent.value.written, true);
    assert.equal(sent.value.path, preview.value.path);
    const note = await readFile(path.join(mailbox, path.basename(sent.value.path)), 'utf8');
    assert.match(note, /## Goal\n\nFinish the isolated demo UI/);
    assert.match(note, /git_checkpoint_schema: 1/);
    assert.match(note, /Git checkpoint \(reported by sender; not verified by BrainLink\)/);
    assert.match(note, /Working tree dirty: true/);
    assert.match(note, /\[\[Public-Plan\]\]/);
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
