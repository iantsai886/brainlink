import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { resolveGitHubScope, githubRemoteIdentity } from './sync/github-assignment.mjs';
import { twinProfileForVault } from './twin-profiles.mjs';

function gitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  Object.assign(env, {
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  });
  return env;
}

function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'], env: gitEnvironment(),
  });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || '').trim();
}

function hasExternalFilters(cwd) {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', 'config', '--local', '--get-regexp', '^filter\\..*\\.(clean|process)$'], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'], env: gitEnvironment(),
  });
  if (result.error || ![0, 1].includes(result.status)) return null;
  return result.status === 0;
}

function samePath(a, b) {
  const left = path.resolve(a), right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function readAssignedCheckout(cwd) {
  try {
    const top = git(cwd, ['rev-parse', '--show-toplevel']);
    if (!top || !samePath(realpathSync(cwd), realpathSync(top))) return null;
    const repo = githubRemoteIdentity(git(cwd, ['config', '--local', '--get', 'remote.origin.url']));
    const branch = git(cwd, ['branch', '--show-current']);
    const head = git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const filters = hasExternalFilters(cwd);
    const status = filters === false ? git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']) : null;
    if (!repo || !branch || !/^[a-f0-9]{40}$/i.test(head || '')) return null;
    const aheadText = git(cwd, ['rev-list', '--count', '@{upstream}..HEAD']);
    const ahead = /^(0|[1-9]\d{0,4})$/.test(aheadText || '') ? Number(aheadText) : null;
    return { repo, branch, head: head.toLowerCase(), clean: status === null ? null : status === '', ahead };
  } catch {
    return null;
  }
}

// Compare a sender-reported checkpoint only with the receiving Twin's explicitly assigned,
// locally configured clone. This is read-only and never contacts GitHub or changes the checkout.
export function createHandoffGitVerifier(ctx) {
  const scope = ctx.twinScope || { mode: 'legacy' };
  let local, reason, loaded = false;
  function getLocal() {
    if (loaded) return { local, reason };
    loaded = true;
    if (scope.mode !== 'scoped') reason = 'No scoped Twin assignment is active.';
    else {
      const profiles = scope.profiles || [];
      const candidates = profiles.map((item) => (ctx.cfg.twin_profiles || []).find((profile) => profile.id === item.profile_id)).filter((item) => item?.github_repository);
      const profile = candidates.length === 1 ? candidates[0] : null;
      const assignment = profile?.github_repository;
      if (!assignment) reason = 'This Twin has no confirmed local repository assignment.';
      else {
        const grant = (scope.grants || []).find((item) => item.name === assignment.vault);
        if (!ctx.enabled.includes(assignment.vault) || !grant?.operations?.includes('read_note')) reason = 'This agent cannot read the assigned project vault.';
        else {
          let resolved;
          try { resolved = resolveGitHubScope(ctx.cfg, { profileId: profile.id, vaultName: assignment.vault }); }
          catch { reason = 'The Twin repository assignment is unavailable or invalid.'; }
          if (resolved) {
            local = readAssignedCheckout(resolved.assignment.path);
            if (!local) reason = 'The assigned local checkout could not be verified.';
          }
        }
      }
    }
    return { local, reason };
  }
  return (reported) => {
    const current = getLocal();
    if (!current.local) return { status: 'not_checked', reason: current.reason };
    const checks = {
      repository: current.local.repo === reported.repo.toLowerCase(),
      branch: current.local.branch === reported.branch,
      commit: current.local.head.startsWith(reported.head.toLowerCase()),
      working_tree: current.local.clean === null ? null : current.local.clean === !reported.dirty,
      ahead: current.local.ahead === null ? null : current.local.ahead === reported.ahead,
    };
    const values = Object.values(checks);
    const status = values.includes(false) ? 'mismatch' : values.includes(null) ? 'partial' : 'matched';
    return { status, source: 'same Twin assigned local clone; no network check', checks };
  };
}

export function verifyHandoffGitCheckpoint(ctx, reported) {
  return createHandoffGitVerifier(ctx)(reported);
}
