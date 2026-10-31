import test from 'node:test';
import assert from 'node:assert/strict';
import { runGitHubAutoSync } from '../src/sync/github-auto-sync.mjs';

const profile = { id: 'demo', github_repository: { remote: 'fictional/demo', path: 'C:/fictional/demo', vault: 'Demo', automatic_sync: { enabled: true, intervalHours: 6 } } };
function fixture(overrides = {}) {
  const calls = [];
  const operations = {
    pullCandidates: async () => { calls.push('pull-check'); return { files: [] }; },
    import: async (x) => { calls.push('import'); return { imported: x.paths, updated: [] }; },
    shareCandidates: async () => { calls.push('list-local'); return [{ path: 'Ideas/one.md' }]; },
    preview: async () => { calls.push('preview'); return { files: [{ path: 'Ideas/one.md', action: 'add' }] }; },
    commit: async () => { calls.push('commit'); return { committed: true, commit: 'abcdef0123456' }; },
    push: async () => { calls.push('push'); return { files: [{ path: 'Ideas/one.md' }] }; },
    saveState: async (state) => { calls.push(['save', structuredClone(state)]); },
    ...overrides,
  };
  return { calls, operations };
}

test('automatic GitHub sync refuses unless the profile is explicitly opted in', async () => {
  const f = fixture();
  await assert.rejects(runGitHubAutoSync({ profile: { ...profile, github_repository: { ...profile.github_repository, automatic_sync: { enabled: false, intervalHours: 6 } } }, operations: f.operations }), /not enabled/);
  assert.deepEqual(f.calls, []);
});

test('disabling sync during a run stops before the next vault or Git write', async () => {
  const f = fixture({ pullCandidates: async () => { f.calls.push('pull-check'); return { files: [{ path: 'Shared/remote.md', action: 'add' }] }; } });
  let enabled = true;
  const result = await runGitHubAutoSync({ ctx: {}, profile, operations: f.operations, isEnabled: async () => { const wasEnabled = enabled; enabled = false; return wasEnabled; } });
  assert.equal(result.report.ok, false);
  assert.ok(!f.calls.includes('import') && !f.calls.includes('commit') && !f.calls.includes('push'));
});

test('automatic sync imports only approved safe additions and pushes a reviewed scoped commit', async () => {
  const f = fixture({ pullCandidates: async () => { f.calls.push('pull-check'); return { files: [{ path: 'Shared/remote.md', action: 'add' }] }; } });
  const result = await runGitHubAutoSync({ ctx: {}, profile, operations: f.operations });
  assert.equal(result.report.ok, true);
  assert.equal(result.report.pulled, 1);
  assert.equal(result.report.pushed, 1);
  assert.deepEqual(f.calls.filter((x) => typeof x === 'string'), ['pull-check', 'import', 'list-local', 'preview', 'commit', 'push']);
  assert.deepEqual(result.state.demo, { cursorPath: 'Ideas/one.md' });
});

test('a remote conflict pauses before importing or publishing anything', async () => {
  const f = fixture({ pullCandidates: async () => { f.calls.push('pull-check'); return { files: [{ path: 'Shared/conflict.md', action: 'conflict' }] }; } });
  const result = await runGitHubAutoSync({ ctx: {}, profile, operations: f.operations });
  assert.equal(result.report.ok, false);
  assert.equal(result.report.conflicts, 1);
  assert.deepEqual(f.calls, ['pull-check']);
});

test('a local repository edit pauses without making a commit or pushing', async () => {
  const f = fixture({ preview: async () => ({ files: [{ path: 'Ideas/one.md', action: 'blocked_local_change' }] }) });
  const result = await runGitHubAutoSync({ ctx: {}, profile, operations: f.operations });
  assert.equal(result.report.ok, false);
  assert.match(result.report.error, /local changes/);
  assert.ok(!f.calls.includes('commit') && !f.calls.includes('push'));
});

test('an interrupted push saves and retries only the exact pending commit', async () => {
  let failPush = true;
  const f = fixture({ push: async ({ commit }) => { f.calls.push(['push', commit]); if (failPush) { failPush = false; throw new Error('temporary network error'); } return { files: [{ path: 'Ideas/one.md' }] }; } });
  const first = await runGitHubAutoSync({ ctx: {}, profile, operations: f.operations });
  assert.equal(first.report.ok, false);
  assert.equal(first.state.demo.pending.commit, 'abcdef0123456');
  f.calls.length = 0;
  f.operations.shareCandidates = async () => { f.calls.push('list-local'); return []; };
  const second = await runGitHubAutoSync({ ctx: {}, profile, state: first.state, operations: f.operations });
  assert.equal(second.report.ok, true);
  assert.deepEqual(f.calls.filter((x) => Array.isArray(x) && x[0] === 'push'), [['push', 'abcdef0123456']]);
  assert.ok(!f.calls.includes('commit'));
  assert.equal(second.state.demo.pending, undefined);
});
