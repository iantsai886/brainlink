import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalize, saveConfig } from '../src/config.mjs';
import { createContext } from '../src/core.mjs';
import { listGitHubShareCandidates, previewGitHubRepository, commitGitHubSelectedNotes, pushGitHubSelectedNotes } from '../src/sync/github-preview.mjs';
import { startSetup } from '../src/setup.mjs';

const tmp = (tag) => mkdtemp(path.join(tmpdir(), `brainlink-gh-preview-${tag}-`));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();

async function fixture() {
  const root = await tmp('fixture');
  const vault = path.join(root, 'Company');
  const repo = path.join(root, 'shared-repo');
  await mkdir(vault, { recursive: true });
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(vault, 'Public.md'), '---\ntitle: Public\n---\nPUBLIC_NOTE_BODY_CANARY_7421\n');
  await writeFile(path.join(vault, 'Private.md'), '---\nprivate: true\n---\nPRIVATE_NOTE_BODY_CANARY_8164\n');
  await writeFile(path.join(vault, 'Generated.md'), '---\ngenerated_by: brainlink\n---\nGENERATED_NOTE_BODY_CANARY_2259\n');
  await mkdir(path.join(vault, 'Secrets'), { recursive: true });
  await writeFile(path.join(vault, 'Secrets', 'Credential.md'), '---\ntitle: Credential\n---\nghp_012345678901234567890123456789012345\n');
  git(repo, 'init', '--quiet');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/example/shared-brain.git');
  const cfg = normalize({ vaults: [{ name: 'Company', path: vault }] });
  const ctx = createContext(cfg, { env: { BRAINLINK_SEMANTIC: '0' } });
  return { root, vault, repo, cfg, ctx };
}

test('GitHub candidates and preview expose only selected visible metadata, never note bodies', async () => {
  const f = await fixture();
  const candidates = await listGitHubShareCandidates(f.ctx, 'Company');
  assert.deepEqual(candidates.map((x) => x.path), ['Public.md']);
  const preview = await previewGitHubRepository({ ctx: f.ctx, repoPath: f.repo, vaultName: 'Company', paths: ['Public.md'] });
  assert.equal(preview.preview_only, true);
  assert.equal(preview.remote_state, 'not_checked');
  assert.deepEqual(preview.files, [{ path: 'Public.md', action: 'add' }]);
  const output = JSON.stringify({ candidates, preview });
  assert.doesNotMatch(output, /PUBLIC_NOTE_BODY_CANARY_7421|PRIVATE_NOTE_BODY_CANARY_8164|GENERATED_NOTE_BODY_CANARY_2259/);
  assert.equal(await readFile(path.join(f.repo, 'BrainLink', 'notes', 'Public.md'), 'utf8').then(() => true, () => false), false);
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
});

test('GitHub preview rejects private, unlisted, secret-bearing and malformed selections without echoing content', async () => {
  const f = await fixture();
  await assert.rejects(listGitHubShareCandidates({ ...f.ctx, byName: new Map([['Company', { private: true }]]) }, 'Company'), /Private vaults/);
  await assert.rejects(previewGitHubRepository({ ctx: f.ctx, repoPath: f.repo, vaultName: 'Company', paths: ['Private.md'] }), /unavailable for sharing/);
  await assert.rejects(previewGitHubRepository({ ctx: f.ctx, repoPath: f.repo, vaultName: 'Company', paths: ['Generated.md'] }), /unavailable for sharing/);
  await assert.rejects(previewGitHubRepository({ ctx: f.ctx, repoPath: f.repo, vaultName: 'Company', paths: ['Secrets/Credential.md'] }), (error) => {
    assert.match(error.message, /privacy review/);
    assert.doesNotMatch(error.message, /ghp_|0123456789/);
    return true;
  });
  await assert.rejects(previewGitHubRepository({ ctx: f.ctx, repoPath: f.repo, vaultName: 'Company', paths: ['../outside.md'] }), /distinct Markdown paths/);
});

test('GitHub preview rejects credential-bearing/non-GitHub remotes and flags dirty selected files', async () => {
  const f = await fixture();
  git(f.repo, 'remote', 'set-url', 'origin', 'https://user:ghp_fakecredential@github.com/example/shared-brain.git');
  await assert.rejects(previewGitHubRepository({ ctx: f.ctx, repoPath: f.repo, vaultName: 'Company', paths: ['Public.md'] }), (error) => {
    assert.match(error.message, /GitHub URL without embedded credentials/);
    assert.doesNotMatch(error.message, /ghp_fakecredential/);
    return true;
  });
  git(f.repo, 'remote', 'set-url', 'origin', 'https://example.com/shared-brain.git');
  await assert.rejects(previewGitHubRepository({ ctx: f.ctx, repoPath: f.repo, vaultName: 'Company', paths: ['Public.md'] }), /GitHub URL/);
  git(f.repo, 'remote', 'set-url', 'origin', 'https://github.com/example/shared-brain.git');
  await mkdir(path.join(f.repo, 'BrainLink', 'notes'), { recursive: true });
  await writeFile(path.join(f.repo, 'BrainLink', 'notes', 'Public.md'), 'local uncommitted edit');
  const preview = await previewGitHubRepository({ ctx: f.ctx, repoPath: f.repo, vaultName: 'Company', paths: ['Public.md'] });
  assert.deepEqual(preview.files, [{ path: 'Public.md', action: 'blocked_local_change' }]);
  assert.doesNotMatch(JSON.stringify(preview), /local uncommitted edit|PUBLIC_NOTE_BODY_CANARY_7421/);
});

test('explicit local commit publishes only selected notes and never pushes', async () => {
  const f = await fixture();
  git(f.repo, 'config', 'user.name', 'BrainLink Test');
  git(f.repo, 'config', 'user.email', 'brainlink-test@example.invalid');
  git(f.repo, 'commit', '--allow-empty', '-m', 'fixture baseline');
  await writeFile(path.join(f.vault, 'Second.md'), '---\ntitle: Second\n---\nSECOND_NOTE_BODY_CANARY_3916\n');
  const result = await commitGitHubSelectedNotes({ ctx: f.ctx, repoPath: f.repo, vaultName: 'Company', paths: ['Public.md'] });
  assert.equal(result.committed, true);
  assert.match(result.commit, /^[a-f0-9]{7,}$/);
  assert.deepEqual(result.files, [{ path: 'Public.md', action: 'add' }]);
  assert.equal(await readFile(path.join(f.repo, 'BrainLink', 'notes', 'Public.md'), 'utf8'), await readFile(path.join(f.vault, 'Public.md'), 'utf8'));
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
  assert.equal(git(f.repo, 'show', '--pretty=format:', '--name-only').replaceAll('\\', '/'), 'BrainLink/notes/Public.md');
  assert.equal(git(f.repo, 'log', '-1', '--format=%s'), 'BrainLink: update selected shared notes');
  assert.doesNotMatch(JSON.stringify(result), /SECOND_NOTE_BODY_CANARY_3916|PUBLIC_NOTE_BODY_CANARY_7421/);
});

test('explicit GitHub push sends only the selected BrainLink commit to its tracked branch', async () => {
  const f = await fixture(), bare = path.join(f.root, 'remote.git');
  await mkdir(bare, { recursive: true });
  git(bare, 'init', '--bare', '--quiet');
  git(f.repo, 'config', 'user.name', 'BrainLink Test');
  git(f.repo, 'config', 'user.email', 'brainlink-test@example.invalid');
  git(f.repo, 'switch', '-c', 'main');
  git(f.repo, 'commit', '--allow-empty', '-m', 'fixture baseline');
  // Keep the origin looking like the credential-free GitHub URL under test while redirecting
  // network operations to an isolated local bare remote; no live GitHub access occurs.
  git(f.repo, 'config', `url.${pathToFileURL(bare).href}.insteadOf`, 'https://github.com/example/shared-brain.git');
  git(f.repo, 'push', '--set-upstream', 'origin', 'main');
  const local = await commitGitHubSelectedNotes({ ctx: f.ctx, repoPath: f.repo, vaultName: 'Company', paths: ['Public.md'] });
  assert.equal(local.committed, true);
  const pushed = await pushGitHubSelectedNotes({ ctx: f.ctx, repoPath: f.repo, vaultName: 'Company', paths: ['Public.md'], commit: local.commit });
  assert.equal(pushed.pushed, true);
  assert.equal(pushed.branch, 'main');
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
  assert.equal(execFileSync('git', [`--git-dir=${bare}`, 'show', 'main:BrainLink/notes/Public.md'], { encoding: 'utf8' }), await readFile(path.join(f.vault, 'Public.md'), 'utf8'));
  assert.equal(execFileSync('git', [`--git-dir=${bare}`, 'show', '--pretty=format:', '--name-only', 'main'], { encoding: 'utf8' }).trim(), 'BrainLink/notes/Public.md');
});

test('GitHub push refuses unrelated local commits and never force-pushes', async () => {
  const f = await fixture(), bare = path.join(f.root, 'remote.git');
  await mkdir(bare, { recursive: true });
  git(bare, 'init', '--bare', '--quiet');
  git(f.repo, 'config', 'user.name', 'BrainLink Test');
  git(f.repo, 'config', 'user.email', 'brainlink-test@example.invalid');
  git(f.repo, 'switch', '-c', 'main');
  git(f.repo, 'commit', '--allow-empty', '-m', 'fixture baseline');
  git(f.repo, 'config', `url.${pathToFileURL(bare).href}.insteadOf`, 'https://github.com/example/shared-brain.git');
  git(f.repo, 'push', '--set-upstream', 'origin', 'main');
  const local = await commitGitHubSelectedNotes({ ctx: f.ctx, repoPath: f.repo, vaultName: 'Company', paths: ['Public.md'] });
  git(f.repo, 'commit', '--allow-empty', '-m', 'unrelated local work');
  await assert.rejects(pushGitHubSelectedNotes({ ctx: f.ctx, repoPath: f.repo, vaultName: 'Company', paths: ['Public.md'], commit: local.commit }), /HEAD no longer matches/);
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
  assert.equal(execFileSync('git', [`--git-dir=${bare}`, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(), git(f.repo, 'rev-parse', `${local.commit}^`));
});

test('GitHub push stops when the tracked remote branch advances after preview', async () => {
  const f = await fixture(), bare = path.join(f.root, 'remote.git'), other = path.join(f.root, 'other-contributor');
  await mkdir(bare, { recursive: true });
  git(bare, 'init', '--bare', '--quiet');
  git(f.repo, 'config', 'user.name', 'BrainLink Test');
  git(f.repo, 'config', 'user.email', 'brainlink-test@example.invalid');
  git(f.repo, 'switch', '-c', 'main');
  git(f.repo, 'commit', '--allow-empty', '-m', 'fixture baseline');
  git(f.repo, 'config', `url.${pathToFileURL(bare).href}.insteadOf`, 'https://github.com/example/shared-brain.git');
  git(f.repo, 'push', '--set-upstream', 'origin', 'main');
  const local = await commitGitHubSelectedNotes({ ctx: f.ctx, repoPath: f.repo, vaultName: 'Company', paths: ['Public.md'] });
  await mkdir(other, { recursive: true });
  git(other, 'clone', '--quiet', '--branch', 'main', bare, '.');
  git(other, 'config', 'user.name', 'Other Contributor');
  git(other, 'config', 'user.email', 'other@example.invalid');
  git(other, 'commit', '--allow-empty', '-m', 'remote contributor update');
  git(other, 'push', 'origin', 'main');
  const remoteBefore = execFileSync('git', [`--git-dir=${bare}`, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  await assert.rejects(pushGitHubSelectedNotes({ ctx: f.ctx, repoPath: f.repo, vaultName: 'Company', paths: ['Public.md'], commit: local.commit }), /remote branch changed/);
  assert.equal(execFileSync('git', [`--git-dir=${bare}`, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(), remoteBefore);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), git(f.repo, 'rev-parse', local.commit));
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
});

test('local commit refuses a dirty repository without changing any files', async () => {
  const f = await fixture();
  git(f.repo, 'config', 'user.name', 'BrainLink Test');
  git(f.repo, 'config', 'user.email', 'brainlink-test@example.invalid');
  git(f.repo, 'commit', '--allow-empty', '-m', 'fixture baseline');
  await writeFile(path.join(f.repo, 'unrelated.txt'), 'keep this local work');
  await assert.rejects(commitGitHubSelectedNotes({ ctx: f.ctx, repoPath: f.repo, vaultName: 'Company', paths: ['Public.md'] }), /repository has changes/);
  assert.equal(await readFile(path.join(f.repo, 'unrelated.txt'), 'utf8'), 'keep this local work');
  assert.equal(await readFile(path.join(f.repo, 'BrainLink', 'notes', 'Public.md'), 'utf8').then(() => true, () => false), false);
});

test('failed local commit restores selected files and leaves the index clean', async () => {
  const f = await fixture();
  git(f.repo, 'config', 'user.name', 'BrainLink Test');
  git(f.repo, 'config', 'user.email', 'brainlink-test@example.invalid');
  git(f.repo, 'commit', '--allow-empty', '-m', 'fixture baseline');
  git(f.repo, 'config', 'user.useConfigOnly', 'true');
  git(f.repo, 'config', '--unset', 'user.name');
  git(f.repo, 'config', '--unset', 'user.email');
  await assert.rejects(commitGitHubSelectedNotes({ ctx: f.ctx, repoPath: f.repo, vaultName: 'Company', paths: ['Public.md'] }), /Git could not complete/);
  assert.equal(await readFile(path.join(f.repo, 'BrainLink', 'notes', 'Public.md'), 'utf8').then(() => true, () => false), false);
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
});

test('Setup GitHub preview endpoints require the local token; commit endpoint is separately authenticated', async () => {
  const f = await fixture();
  const home = path.join(f.root, 'app-home');
  await mkdir(home, { recursive: true });
  const env = { BRAINLINK_HOME: home, HOME: home, BRAINLINK_SEMANTIC: '0' };
  await saveConfig(f.cfg, path.join(home, 'config.json'));
  const app = await startSetup({ env, home, os: 'linux', port: 0, useCli: false });
  const post = (route, body, token = app.token) => fetch(`http://127.0.0.1:${app.port}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': token }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await post('/api/github/share-candidates', { vault: 'Company' }, 'wrong')).status, 401);
    const candidateResponse = await post('/api/github/share-candidates', { vault: 'Company' });
    const candidates = await candidateResponse.json();
    assert.equal(candidateResponse.status, 200);
    assert.deepEqual(candidates.notes.map((x) => x.path), ['Public.md']);
    const response = await post('/api/github/preview', { repository: f.repo, vault: 'Company', paths: ['Public.md'] });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.preview_only, true);
    assert.doesNotMatch(JSON.stringify(body), /PUBLIC_NOTE_BODY_CANARY_7421/);
    assert.equal(git(f.repo, 'status', '--porcelain'), '');
    assert.equal((await post('/api/github/commit-selected', { repository: f.repo, vault: 'Company', paths: ['Public.md'] }, 'wrong')).status, 401);
    assert.equal((await post('/api/github/push-selected', { repository: f.repo, vault: 'Company', paths: ['Public.md'], commit: 'deadbee' }, 'wrong')).status, 401);
    git(f.repo, 'config', 'user.name', 'BrainLink Test');
    git(f.repo, 'config', 'user.email', 'brainlink-test@example.invalid');
    git(f.repo, 'commit', '--allow-empty', '-m', 'fixture baseline');
    const committedResponse = await post('/api/github/commit-selected', { repository: f.repo, vault: 'Company', paths: ['Public.md'] });
    const committed = await committedResponse.json();
    assert.equal(committedResponse.status, 200);
    assert.equal(committed.committed, true);
    assert.equal(git(f.repo, 'status', '--porcelain'), '');
  } finally { app.server.close(); }
});
