import { spawnSync } from 'node:child_process';

// A commit-bound receipt is available only when the code checkout can identify its exact HEAD
// and Git reports no tracked or untracked changes. Failure is represented as unknown so callers
// can still produce a useful local evaluation, but it cannot be promoted as commit-bound proof.
export function readGitSourceState(cwd) {
  const run = (args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const head = run(['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head.error || head.status !== 0 || !/^[a-f0-9]{40}\s*$/i.test(head.stdout || '')) {
    return { commit_sha: null, clean: false };
  }
  const status = run(['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.error || status.status !== 0) return { commit_sha: head.stdout.trim().toLowerCase(), clean: false };
  return { commit_sha: head.stdout.trim().toLowerCase(), clean: status.stdout === '' };
}
