import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readGitSourceState } from '../src/git-source-state.mjs';

test('Git source state recognizes a clean commit and refuses dirty or missing repositories', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-git-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git(['init', '--quiet']);
  git(['config', 'user.name', 'BrainLink Test']);
  git(['config', 'user.email', 'brainlink-test@example.invalid']);
  await writeFile(path.join(root, 'fixture.txt'), 'committed source\n');
  git(['add', 'fixture.txt']);
  git(['commit', '--quiet', '-m', 'fixture']);
  const clean = readGitSourceState(root);
  assert.match(clean.commit_sha, /^[a-f0-9]{40}$/);
  assert.equal(clean.clean, true);
  await writeFile(path.join(root, 'fixture.txt'), 'uncommitted source\n');
  assert.deepEqual(readGitSourceState(root), { commit_sha: clean.commit_sha, clean: false });
  assert.deepEqual(readGitSourceState(tmpdir()), { commit_sha: null, clean: false });
});
