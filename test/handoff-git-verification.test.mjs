import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { normalize } from '../src/config.mjs';
import { createContext } from '../src/core.mjs';
import { listHandoffs } from '../src/writes.mjs';
import { verifyHandoffGitCheckpoint } from '../src/handoff-git.mjs';

const runGit = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function gitFixture(root) {
  const repo = path.join(root, 'fictional-repo');
  await mkdir(repo);
  runGit(repo, 'init', '-b', 'feature/demo');
  runGit(repo, 'config', 'user.name', 'Fictional Test');
  runGit(repo, 'config', 'user.email', 'fictional@example.invalid');
  await writeFile(path.join(repo, 'README.md'), 'fictional demo\n');
  runGit(repo, 'add', 'README.md');
  runGit(repo, 'commit', '-m', 'fictional baseline');
  runGit(repo, 'remote', 'add', 'origin', 'https://github.com/FictionalOrg/BrainLink-Demo.git');
  runGit(repo, 'update-ref', 'refs/remotes/origin/feature/demo', 'HEAD');
  runGit(repo, 'branch', '--set-upstream-to=origin/feature/demo');
  return repo;
}

function makeContext(root, vault, repo, canRead = true) {
  const cfg = normalize({
    vaults: [{ name: 'Fictional Organisation', path: vault }],
    handoff: { vault: 'Fictional Organisation', folder: 'Handoffs' },
    twin_profiles: [{
      id: 'fictional-org', name: 'Fictional Organisation', mode: 'organisation', owner: 'Fictional owner',
      vaults: [{ name: 'Fictional Organisation', access: 'read' }],
      github_repository: { remote: 'fictionalorg/brainlink-demo', path: repo, vault: 'Fictional Organisation', whole_vault: true, confirmed_at: '2026-10-28T00:00:00.000Z' },
    }],
  });
  const ctx = createContext(cfg, { env: { ...process.env, HOME: root, BRAINLINK_HOME: path.join(root, 'brainlink-data') } });
  ctx.enabled = ['Fictional Organisation'];
  ctx.twinScope = {
    mode: 'scoped', profile_id: 'fictional-org',
    grants: [{ name: 'Fictional Organisation', access: 'read', operations: [...(canRead ? ['read_note'] : []), 'handoff_read'] }],
  };
  return ctx;
}

test('handoff Git checkpoint matches the same Twin assigned local clone without network access', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-handoff-git-'));
  try {
    const repo = await gitFixture(root);
    const head = runGit(repo, 'rev-parse', 'HEAD');
    const ctx = makeContext(root, path.join(root, 'vault'), repo);
    const reported = { repo: 'fictionalorg/brainlink-demo', branch: 'feature/demo', head: head.slice(0, 12), dirty: false, ahead: 0 };
    const match = verifyHandoffGitCheckpoint(ctx, reported);
    assert.equal(match.status, 'matched', JSON.stringify(match));
    assert.deepEqual(match.checks, { repository: true, branch: true, commit: true, working_tree: true, ahead: true });
    assert.doesNotMatch(JSON.stringify(match), /fictional-repo|[A-Z]:\\/i, 'verification never reveals the local checkout path');

    runGit(repo, 'config', 'core.fsmonitor', 'brainlink-test-fsmonitor-helper');
    const fsmonitor = verifyHandoffGitCheckpoint(ctx, reported);
    assert.equal(fsmonitor.status, 'matched', 'repository fsmonitor helpers are disabled for the read-only check');
    assert.equal(runGit(repo, 'config', '--local', '--get', 'core.fsmonitor'), 'brainlink-test-fsmonitor-helper', 'verification does not rewrite repository config');
    runGit(repo, 'config', '--unset', 'core.fsmonitor');

    runGit(repo, 'config', 'filter.brainlink-test.clean', 'brainlink-test-filter-must-not-run');
    const customFilter = verifyHandoffGitCheckpoint(ctx, reported);
    assert.equal(customFilter.status, 'partial');
    assert.equal(customFilter.checks.working_tree, null, 'working-tree state stays unknown when custom filters could execute');
    runGit(repo, 'config', '--unset', 'filter.brainlink-test.clean');

    const mismatch = verifyHandoffGitCheckpoint(ctx, { ...reported, branch: 'main' });
    assert.equal(mismatch.status, 'mismatch');
    assert.equal(mismatch.checks.branch, false);
    assert.equal(verifyHandoffGitCheckpoint(ctx, { ...reported, repo: 'fictionalorg/another-repo' }).checks.repository, false);
    assert.equal(verifyHandoffGitCheckpoint(ctx, { ...reported, head: '0000000' }).checks.commit, false);
    assert.equal(verifyHandoffGitCheckpoint(ctx, { ...reported, ahead: 1 }).checks.ahead, false);

    runGit(repo, 'branch', '--unset-upstream');
    const partial = verifyHandoffGitCheckpoint(ctx, reported);
    assert.equal(partial.status, 'partial');
    assert.equal(partial.checks.ahead, null, 'unknown upstream count stays unknown rather than appearing as zero');

    await writeFile(path.join(repo, 'uncommitted.txt'), 'fictional only');
    const dirty = verifyHandoffGitCheckpoint(ctx, reported);
    assert.equal(dirty.status, 'mismatch');
    assert.equal(dirty.checks.working_tree, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('list_handoffs exposes checkpoint comparison only for the same scoped Twin with project read permission', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-handoff-list-git-'));
  try {
    const vault = path.join(root, 'vault');
    await mkdir(path.join(vault, 'Handoffs'), { recursive: true });
    const repo = await gitFixture(root);
    const head = runGit(repo, 'rev-parse', 'HEAD');
    const handoff = path.join(vault, 'Handoffs', '2026-10-28-1200-from-claude-code-to-codex-git-check.md');
    await writeFile(handoff, `---\ntype: handoff\nstatus: REQUEST\nfrom: Claude Code\nto: Codex\nsubject: Fictional checkpoint\ntwin_profile_id: fictional-org\ngit_checkpoint_schema: "1"\ngit_repo: fictionalorg/brainlink-demo\ngit_branch: feature/demo\ngit_head: ${head.slice(0, 12)}\ngit_dirty: "false"\ngit_ahead: "0"\nwritten_at: 2026-10-28T12:00:00.000Z\n---\n\n## Goal\n\nContinue the fictional demo.\n`, 'utf8');
    const ctx = makeContext(root, vault, repo);
    const result = await listHandoffs(ctx, { to: 'Codex' });
    assert.equal(result.length, 1);
    assert.equal(result[0].git_checkpoint_verification.status, 'matched');

    const noProjectRead = makeContext(root, vault, repo, false);
    const hiddenVerification = await listHandoffs(noProjectRead, { to: 'Codex' });
    assert.equal(hiddenVerification[0].git_checkpoint_verification.status, 'not_checked');
    assert.match(hiddenVerification[0].git_checkpoint_verification.reason, /cannot read/);
    assert.doesNotMatch(JSON.stringify(hiddenVerification), /fictional-repo|[A-Z]:\\/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
