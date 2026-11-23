// Profile-scoped GitHub repository assignment. Fictional vaults, profiles, repositories and
// secrets only; every Git remote is a temporary local path. No real GitHub contact.
import test from 'node:test';
import { readSetupHtml } from './helpers/setup-html.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { normalize, validate, saveConfig, loadConfig } from '../src/config.mjs';
import { createContext } from '../src/core.mjs';
import {
  listGitHubShareCandidates, previewGitHubRepository, commitGitHubSelectedNotes, pushGitHubSelectedNotes,
  listGitHubPullCandidates, importGitHubSelectedNotes, githubAssignmentStatus,
  saveGitHubConflictCopies, testGitHubRepositoryAccess, cloneGitHubRepository,
} from '../src/sync/github-preview.mjs';
import { githubAssignmentProjection } from '../src/sync/github-assignment.mjs';
import { startSetup } from '../src/setup.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
const PROFILES = [
  { id: 'personal', mode: 'personal', vault: 'Personal Vault', remote: 'fictional-person/personal-brain' },
  { id: 'org', mode: 'organisation', vault: 'Org Vault', remote: 'fictional-org/org-brain' },
  { id: 'client_a', mode: 'client', vault: 'Client A Vault', remote: 'fictional-client-a/shared-brain' },
  { id: 'client_b', mode: 'client', vault: 'Client B Vault', remote: 'fictional-client-b/shared-brain' },
];
const canary = (p) => `CANARY_${p.id.toUpperCase()}_BODY_5513`;
const declaration = (p) => ({
  id: p.id, name: `${p.id} twin`, mode: p.mode, owner: 'fictional-owner',
  vaults: [{ name: p.vault, access: 'propose' }],
  source_policy: { private_default: true, provenance_required: true, session_capture: 'summary-proposal' },
  memory_policy: { working: true, semantic: true, procedural: true, episodic: true },
  allowed_actions: ['search', 'read_note'], agent_access: [],
});
const assignment = (f, p, extra = {}) => ({ remote: p.remote, path: f.repos[p.id], vault: p.vault, whole_vault: true, confirmed_at: '2026-10-25T00:00:00.000Z', ...extra });

async function fixture({ assign = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-profile-gh-'));
  const f = { root, repos: {}, vaults: {} };
  for (const p of PROFILES) {
    const vault = path.join(root, p.id, 'vault');
    const repo = path.join(root, p.id, 'repo');
    await mkdir(path.join(vault, 'Shared'), { recursive: true });
    await mkdir(path.join(vault, 'Outside'), { recursive: true });
    await mkdir(repo, { recursive: true });
    await writeFile(path.join(vault, 'Shared', 'Note.md'), `---\ntitle: ${p.id} shared\n---\n${canary(p)}\n`);
    await writeFile(path.join(vault, 'Outside', 'Other.md'), `---\ntitle: ${p.id} outside\n---\nOUTSIDE_${p.id.toUpperCase()}_8820\n`);
    git(repo, 'init', '--quiet');
    git(repo, 'remote', 'add', 'origin', `https://github.com/${p.remote}.git`);
    git(repo, 'config', 'user.name', 'BrainLink Test');
    git(repo, 'config', 'user.email', 'brainlink-test@example.invalid');
    f.repos[p.id] = await (await import('node:fs/promises')).realpath(repo);
    f.vaults[p.id] = vault;
  }
  const cfg = normalize({
    version: 2,
    vaults: PROFILES.map((p) => ({ name: p.vault, path: f.vaults[p.id] })),
    twin_profiles: PROFILES.map((p) => ({ ...declaration(p), ...(assign ? { github_repository: assignment(f, p) } : {}) })),
  });
  f.cfg = cfg;
  f.ctx = createContext(cfg, { env: { BRAINLINK_SEMANTIC: '0' }, trustedLocal: true });
  return f;
}
const withCfg = (f, mutate) => {
  const cfg = structuredClone(f.cfg);
  mutate(cfg);
  return { cfg, ctx: createContext(cfg, { env: { BRAINLINK_SEMANTIC: '0' }, trustedLocal: true }) };
};
const P = Object.fromEntries(PROFILES.map((p) => [p.id, p]));

test('each profile lists only its own assigned vault and sees only its own assignment', async () => {
  const f = await fixture();
  assert.deepEqual(validate(f.cfg), []);
  for (const p of PROFILES) {
    const notes = await listGitHubShareCandidates(f.ctx, p.vault, p.id);
    assert.deepEqual(notes.map((n) => n.path), ['Outside/Other.md', 'Shared/Note.md']);
    const output = JSON.stringify(notes);
    for (const other of PROFILES.filter((o) => o.id !== p.id)) assert.doesNotMatch(output, new RegExp(`${other.id}|${canary(other)}`));
    assert.doesNotMatch(output, new RegExp(canary(p)));
  }
  const projection = githubAssignmentProjection(f.cfg);
  assert.deepEqual(projection.map((x) => [x.profile_id, x.assignment.remote, x.assignment.vault, x.status]), PROFILES.map((p) => [p.id, p.remote, p.vault, 'assigned']));
  assert.doesNotMatch(JSON.stringify(projection), /token|password|https?:/i);
});

test('Personal, Organisation, Client A and Client B cannot use another profile\'s vault or repository', async () => {
  const f = await fixture();
  for (const a of PROFILES) for (const b of PROFILES) {
    if (a.id === b.id) continue;
    // a's profile against b's vault
    await assert.rejects(listGitHubShareCandidates(f.ctx, b.vault, a.id), /not assigned to the selected profile/);
    await assert.rejects(previewGitHubRepository({ ctx: f.ctx, repoPath: f.repos[a.id], vaultName: b.vault, paths: ['Shared/Note.md'], profileId: a.id }), /not assigned to the selected profile/);
    // a's profile against b's clone
    await assert.rejects(previewGitHubRepository({ ctx: f.ctx, repoPath: f.repos[b.id], vaultName: a.vault, paths: ['Shared/Note.md'], profileId: a.id }), /not the one assigned/);
    await assert.rejects(commitGitHubSelectedNotes({ ctx: f.ctx, repoPath: f.repos[b.id], vaultName: a.vault, paths: ['Shared/Note.md'], profileId: a.id }), /not the one assigned/);
    await assert.rejects(listGitHubPullCandidates({ ctx: f.ctx, repoPath: f.repos[b.id], vaultName: a.vault, profileId: a.id }), /not the one assigned/);
    await assert.rejects(saveGitHubConflictCopies({ ctx: f.ctx, repoPath: f.repos[b.id], vaultName: a.vault, paths: ['Shared/Note.md'], profileId: a.id }), /not the one assigned/);
  }
  for (const p of PROFILES) assert.equal(git(f.repos[p.id], 'status', '--porcelain'), '');
});

test('config refuses a repository, clone or vault shared by two profiles', async () => {
  const f = await fixture();
  const sameRemote = withCfg(f, (cfg) => { cfg.twin_profiles[1].github_repository.remote = P.personal.remote; });
  assert.match(validate(sameRemote.cfg).join('; '), /repository may be assigned to only one/);
  const samePath = withCfg(f, (cfg) => { cfg.twin_profiles[2].github_repository.path = f.repos.client_b; cfg.twin_profiles[2].github_repository.remote = P.client_b.remote.replace('client-b', 'client-a'); });
  assert.match(validate(samePath.cfg).join('; '), /clone may be assigned to only one/);
  const sharedVault = withCfg(f, (cfg) => { cfg.twin_profiles[1].vaults.push({ name: P.personal.vault, access: 'read' }); });
  assert.match(validate(sharedVault.cfg).join('; '), /owner is ambiguous/);
  // Two profiles pointing at one repo is also refused at use time even if the config was not validated.
  const unvalidated = withCfg(f, (cfg) => { cfg.twin_profiles[1].github_repository = { ...cfg.twin_profiles[0].github_repository, vault: P.org.vault }; });
  await assert.rejects(listGitHubShareCandidates(unvalidated.ctx, P.org.vault, 'org'), /assignment is invalid/);
});

test('missing, malformed, credential-bearing, stale and mismatched assignments fail closed without leaking notes', async () => {
  const f = await fixture();
  const attempts = (ctx, p, repoPath = f.repos[p.id]) => [
    () => listGitHubShareCandidates(ctx, p.vault, p.id),
    () => previewGitHubRepository({ ctx, repoPath, vaultName: p.vault, paths: ['Shared/Note.md'], profileId: p.id }),
    () => commitGitHubSelectedNotes({ ctx, repoPath, vaultName: p.vault, paths: ['Shared/Note.md'], profileId: p.id }),
    () => pushGitHubSelectedNotes({ ctx, repoPath, vaultName: p.vault, paths: ['Shared/Note.md'], commit: 'deadbee', profileId: p.id }),
    () => listGitHubPullCandidates({ ctx, repoPath, vaultName: p.vault, profileId: p.id }),
    () => importGitHubSelectedNotes({ ctx, repoPath, vaultName: p.vault, paths: ['Shared/Note.md'], profileId: p.id }),
  ];
  const expectAllFail = async (ctx, p, pattern, repoPath) => {
    for (const run of attempts(ctx, p, repoPath)) {
      await assert.rejects(run(), (error) => {
        assert.match(error.message, pattern);
        assert.doesNotMatch(error.message, new RegExp(`${canary(p)}|ghp_|fictional-secret`));
        return true;
      });
    }
  };
  const p = P.client_a;
  // missing assignment, missing profile id, unknown profile, legacy unassigned
  const missing = withCfg(f, (cfg) => { delete cfg.twin_profiles[2].github_repository; });
  await expectAllFail(missing.ctx, p, /no confirmed GitHub repository/);
  await assert.rejects(listGitHubShareCandidates(f.ctx, p.vault, ''), /Choose a Twin profile/);
  await assert.rejects(listGitHubShareCandidates(f.ctx, p.vault, 'nobody'), /existing Twin profile/);
  // malformed: credential/url field, relative path, bad remote, unknown vault
  for (const mutate of [
    (a) => { a.token = 'fictional-secret-token'; },
    (a) => { a.url = 'https://user:ghp_012345678901234567890123456789012345@github.com/x/y.git'; },
    (a) => { a.path = 'relative/clone'; },
    (a) => { a.remote = 'https://user:fictional-secret@github.com/fictional/repo'; },
    (a) => { a.vault = 'No Such Vault'; },
    (a) => { delete a.confirmed_at; },
    (a) => { a.folders = ['../escape']; },
    (a) => { a.folders = ['Shared']; a.whole_vault = true; },
  ]) {
    const bad = withCfg(f, (cfg) => mutate(cfg.twin_profiles[2].github_repository));
    assert.notEqual(validate(bad.cfg).length, 0);
    await expectAllFail(bad.ctx, p, /assignment is invalid|not assigned to the selected profile/);
  }
  // credential-bearing origin set after assignment (stale/mismatch): refused before any git operation or note listing
  git(f.repos.client_a, 'remote', 'set-url', 'origin', 'https://user:fictional-secret@github.com/fictional-client-a/shared-brain.git');
  await expectAllFail(f.ctx, p, /unavailable or no longer matches/);
  // origin now points at a different repository
  git(f.repos.client_a, 'remote', 'set-url', 'origin', `https://github.com/${P.client_b.remote}.git`);
  await expectAllFail(f.ctx, p, /unavailable or no longer matches/);
  git(f.repos.client_a, 'remote', 'set-url', 'origin', `https://github.com/${P.client_a.remote}.git`);
  assert.equal((await listGitHubShareCandidates(f.ctx, p.vault, p.id)).length, 2, 'restoring the matching origin restores access');
  // stale: clone folder removed
  await rm(f.repos.client_a, { recursive: true, force: true });
  await expectAllFail(f.ctx, p, /unavailable or no longer matches/, undefined);
  const status = await githubAssignmentStatus(f.cfg);
  assert.equal(status.find((x) => x.profile_id === 'client_a').status, 'stale');
  assert.equal(status.find((x) => x.profile_id === 'org').status, 'assigned');
});

test('a receipt from one profile cannot be pushed under another profile', async () => {
  const f = await fixture();
  const p = P.client_a;
  const bare = path.join(f.root, 'remote.git');
  await mkdir(bare, { recursive: true });
  git(bare, 'init', '--bare', '--quiet');
  const repo = f.repos.client_a;
  git(repo, 'switch', '-c', 'main');
  git(repo, 'commit', '--allow-empty', '-m', 'fixture baseline');
  git(repo, 'config', `url.${pathToFileURL(bare).href}.insteadOf`, `https://github.com/${p.remote}.git`);
  git(repo, 'push', '--set-upstream', 'origin', 'main');
  const local = await commitGitHubSelectedNotes({ ctx: f.ctx, repoPath: repo, vaultName: p.vault, paths: ['Shared/Note.md'], profileId: p.id });
  assert.match(git(repo, 'log', '-1', '--format=%B'), /BrainLink-Profile: client_a/);
  // The same clone and vault are later reassigned to a different profile id; the old receipt is refused.
  const reassigned = withCfg(f, (cfg) => { cfg.twin_profiles[2].id = 'client_a2'; });
  await assert.rejects(pushGitHubSelectedNotes({ ctx: reassigned.ctx, repoPath: repo, vaultName: p.vault, paths: ['Shared/Note.md'], commit: local.commit, profileId: 'client_a2' }), /belongs to a different profile/);
  // Another profile's own clone cannot push this receipt either.
  await assert.rejects(pushGitHubSelectedNotes({ ctx: f.ctx, repoPath: repo, vaultName: P.client_b.vault, paths: ['Shared/Note.md'], commit: local.commit, profileId: 'client_b' }), /not the one assigned/);
  const before = execFileSync('git', [`--git-dir=${bare}`, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  assert.equal(git(repo, 'rev-parse', `${local.commit}^`), before, 'nothing was pushed by the refused attempts');
  const pushed = await pushGitHubSelectedNotes({ ctx: f.ctx, repoPath: repo, vaultName: p.vault, paths: ['Shared/Note.md'], commit: local.commit, profileId: p.id });
  assert.equal(pushed.pushed, true);
});

test('folder allowlist limits listing, preview, commit and remote import to the assigned folders', async () => {
  const f = await fixture();
  const p = P.org;
  const scoped = withCfg(f, (cfg) => { cfg.twin_profiles[1].github_repository.folders = ['Shared']; cfg.twin_profiles[1].github_repository.whole_vault = false; });
  assert.deepEqual(validate(scoped.cfg), []);
  assert.deepEqual((await listGitHubShareCandidates(scoped.ctx, p.vault, p.id)).map((n) => n.path), ['Shared/Note.md']);
  await assert.rejects(previewGitHubRepository({ ctx: scoped.ctx, repoPath: f.repos.org, vaultName: p.vault, paths: ['Outside/Other.md'], profileId: p.id }), /unavailable for sharing/);
  await assert.rejects(commitGitHubSelectedNotes({ ctx: scoped.ctx, repoPath: f.repos.org, vaultName: p.vault, paths: ['Outside/Other.md'], profileId: p.id }), /unavailable for sharing/);
  assert.equal((await previewGitHubRepository({ ctx: scoped.ctx, repoPath: f.repos.org, vaultName: p.vault, paths: ['Shared/Note.md'], profileId: p.id })).files[0].action, 'add');

  // Remote notes outside the allowlist are neither listed nor imported.
  const bare = path.join(f.root, 'org-remote.git');
  await mkdir(bare, { recursive: true });
  git(bare, 'init', '--bare', '--quiet');
  const repo = f.repos.org;
  await mkdir(path.join(repo, 'BrainLink', 'notes', 'Shared'), { recursive: true });
  await mkdir(path.join(repo, 'BrainLink', 'notes', 'Hidden'), { recursive: true });
  await writeFile(path.join(repo, 'BrainLink', 'notes', 'Shared', 'Remote.md'), 'Allowed remote note\n');
  await writeFile(path.join(repo, 'BrainLink', 'notes', 'Hidden', 'Remote.md'), 'OUT_OF_SCOPE_REMOTE_CANARY_3391\n');
  git(repo, 'switch', '-c', 'main');
  git(repo, 'add', '--', 'BrainLink/notes');
  git(repo, 'commit', '-m', 'remote notes');
  git(repo, 'config', `url.${pathToFileURL(bare).href}.insteadOf`, `https://github.com/${p.remote}.git`);
  git(repo, 'push', '--set-upstream', 'origin', 'main');
  const pull = await listGitHubPullCandidates({ ctx: scoped.ctx, repoPath: repo, vaultName: p.vault, profileId: p.id });
  assert.deepEqual(pull.files.map((x) => x.path), ['Shared/Remote.md']);
  assert.doesNotMatch(JSON.stringify(pull), /OUT_OF_SCOPE_REMOTE_CANARY_3391|Hidden/);
  await assert.rejects(importGitHubSelectedNotes({ ctx: scoped.ctx, repoPath: repo, vaultName: p.vault, paths: ['Hidden/Remote.md'], profileId: p.id }), /unavailable or failed privacy checks/);
  const imported = await importGitHubSelectedNotes({ ctx: scoped.ctx, repoPath: repo, vaultName: p.vault, paths: ['Shared/Remote.md'], profileId: p.id });
  assert.deepEqual(imported.imported, ['Shared/Remote.md']);
  assert.equal(await readFile(path.join(f.vaults.org, 'Hidden', 'Remote.md'), 'utf8').then(() => true, () => false), false);
});

test('legacy configs load unchanged and fail closed until an owner confirms a Twin profile assignment', async () => {
  const f = await fixture({ assign: false });
  const file = path.join(f.root, 'config.json');
  await saveConfig(f.cfg, file);
  const loaded = await loadConfig(file);
  assert.deepEqual(loaded.twin_profiles, f.cfg.twin_profiles, 'profile records round-trip without data loss');
  assert.ok(loaded.twin_profiles.every((profile) => !('github_repository' in profile)));
  assert.ok(githubAssignmentProjection(loaded).every((x) => x.status === 'unassigned' && x.assignment === null));
  // Profiles exist but nothing is confirmed: every operation refuses.
  await assert.rejects(listGitHubShareCandidates(f.ctx, P.org.vault, 'org'), /no confirmed GitHub repository/);
  await assert.rejects(listGitHubShareCandidates(f.ctx, P.org.vault, ''), /Choose a Twin profile/);
  // No profiles configured means BrainLink cannot classify the data owner. Every operation
  // must fail before reading notes, opening a repository, or mutating local/remote state.
  const legacy = createContext(normalize({ vaults: [{ name: P.org.vault, path: f.vaults.org }] }), { env: { BRAINLINK_SEMANTIC: '0' } });
  const noOwner = /Create a Personal, Organisation, or Client Twin profile/;
  await assert.rejects(listGitHubShareCandidates(legacy, P.org.vault), noOwner);
  await assert.rejects(previewGitHubRepository({ ctx: legacy, repoPath: f.repos.org, vaultName: P.org.vault, paths: ['Shared/Note.md'] }), noOwner);
  await assert.rejects(commitGitHubSelectedNotes({ ctx: legacy, repoPath: f.repos.org, vaultName: P.org.vault, paths: ['Shared/Note.md'] }), noOwner);
  await assert.rejects(pushGitHubSelectedNotes({ ctx: legacy, repoPath: f.repos.org, vaultName: P.org.vault, paths: ['Shared/Note.md'], commit: 'deadbee' }), noOwner);
  await assert.rejects(listGitHubPullCandidates({ ctx: legacy, repoPath: f.repos.org, vaultName: P.org.vault }), noOwner);
  await assert.rejects(importGitHubSelectedNotes({ ctx: legacy, repoPath: f.repos.org, vaultName: P.org.vault, paths: ['Shared/Note.md'] }), noOwner);
  await assert.rejects(saveGitHubConflictCopies({ ctx: legacy, repoPath: f.repos.org, vaultName: P.org.vault, paths: ['Shared/Note.md'] }), noOwner);
  await assert.rejects(listGitHubShareCandidates(legacy, P.org.vault, 'org'), /Create a Personal, Organisation, or Client Twin profile/);
});

test('GitHub access test is read-only, uses saved non-interactive Git auth, and hides credential errors', async () => {
  const f = await fixture({ assign: false });
  const bare = path.join(f.root, 'github-access-check.git');
  await mkdir(bare, { recursive: true });
  git(bare, 'init', '--bare', '--quiet');
  const repo = f.repos.org;
  git(repo, 'config', 'user.name', 'BrainLink Test');
  git(repo, 'config', 'user.email', 'brainlink-test@example.invalid');
  await writeFile(path.join(repo, 'README.md'), 'fictional public test fixture\n');
  git(repo, 'switch', '-c', 'main');
  git(repo, 'add', '--', 'README.md');
  git(repo, 'commit', '-m', 'fictional test repository');
  git(repo, 'config', `url.${pathToFileURL(bare).href}.insteadOf`, `https://github.com/${P.org.remote}.git`);
  git(repo, 'push', '--set-upstream', 'origin', 'main');
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const input = { profile_id: 'org', vault: P.org.vault, repository: repo, folders: ['Shared'], whole_vault: false };
  const result = await testGitHubRepositoryAccess(f.cfg, input);
  assert.deepEqual(result, { ok: true, remote: P.org.remote, head_found: true });
  assert.equal(f.cfg.twin_profiles.find((p) => p.id === 'org').github_repository, undefined, 'checking access does not save the profile assignment');

  let checkedOptions;
  await assert.rejects(testGitHubRepositoryAccess(f.cfg, input, { runGit: async (_command, args, options) => {
    assert.deepEqual(args.slice(-3), ['--symref', 'origin', 'HEAD']);
    checkedOptions = options;
    throw new Error('fatal: https://user:ghp_FAKE_SECRET@github.com/private/repo.git denied');
  } }), (error) => {
    assert.match(error.message, /check the internet connection and Git sign-in/i);
    assert.doesNotMatch(error.message, /ghp_FAKE_SECRET|github\.com\/private/i);
    return true;
  });
  assert.equal(checkedOptions.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(checkedOptions.env.GCM_INTERACTIVE, 'never');
  assert.equal(checkedOptions.timeout, 30_000);
});

test('managed GitHub clone checks out only BrainLink notes and never overwrites existing data', async () => {
  const f = await fixture({ assign: false });
  const bare = path.join(f.root, 'new-device-remote.git');
  const seed = path.join(f.root, 'remote-seed');
  const home = path.join(f.root, 'new-device-home');
  await mkdir(bare, { recursive: true });
  await mkdir(seed, { recursive: true });
  await mkdir(home, { recursive: true });
  git(bare, 'init', '--bare', '--quiet');
  git(bare, 'config', 'uploadpack.allowFilter', 'true');
  git(seed, 'init', '--quiet');
  git(seed, 'config', 'user.name', 'BrainLink Test');
  git(seed, 'config', 'user.email', 'brainlink-test@example.invalid');
  await mkdir(path.join(seed, 'BrainLink', 'notes', 'Shared'), { recursive: true });
  await writeFile(path.join(seed, 'README.md'), 'This file must not be checked out.\n');
  await writeFile(path.join(seed, 'BrainLink', 'notes', 'Shared', 'Knowledge.md'), 'A fictional shared note.\n');
  git(seed, 'add', '--', 'README.md', 'BrainLink/notes');
  git(seed, 'commit', '-m', 'fictional shared notes');
  git(seed, 'branch', '-M', 'main');
  git(seed, 'remote', 'add', 'origin', bare);
  git(seed, 'push', '--set-upstream', 'origin', 'main');
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const remote = `https://github.com/${P.org.remote}.git`;
  const env = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${pathToFileURL(bare).href}.insteadOf`,
    GIT_CONFIG_VALUE_0: remote,
  };
  const result = await cloneGitHubRepository({ ownerRepo: P.org.remote, home, reservedPaths: [f.vaults.org] }, { env });
  assert.equal(result.ok, true);
  assert.equal(result.remote, P.org.remote);
  assert.equal(result.sparse_folder, 'BrainLink/notes');
  assert.match(await readFile(path.join(result.path, 'BrainLink', 'notes', 'Shared', 'Knowledge.md'), 'utf8'), /^A fictional shared note\.\r?\n$/);
  await assert.rejects(readFile(path.join(result.path, 'README.md')), { code: 'ENOENT' }, 'files outside the notes subtree are not checked out');
  assert.equal(git(result.path, 'status', '--porcelain'), '');
  assert.equal(f.cfg.twin_profiles.find((profile) => profile.id === 'org').github_repository, undefined, 'cloning does not assign or publish the repository');
  const before = await readFile(path.join(result.path, 'BrainLink', 'notes', 'Shared', 'Knowledge.md'), 'utf8');
  await assert.rejects(cloneGitHubRepository({ ownerRepo: 'https://user:secret@github.com/fictional-org/org-brain', home, reservedPaths: [] }), /owner\/repository/);
  await assert.rejects(cloneGitHubRepository({ ownerRepo: P.org.remote, home: f.vaults.org, reservedPaths: [f.vaults.org] }), /overlaps a vault/);
  assert.equal(await readFile(path.join(result.path, 'BrainLink', 'notes', 'Shared', 'Knowledge.md'), 'utf8'), before, 'refused clone requests leave the first clone untouched');

  const emptyBare = path.join(f.root, 'empty-remote.git');
  await mkdir(emptyBare, { recursive: true });
  git(emptyBare, 'init', '--bare', '--quiet');
  const emptyRemote = 'https://github.com/fictional-org/empty-brain.git';
  const empty = await cloneGitHubRepository({ ownerRepo: 'fictional-org/empty-brain', home, reservedPaths: [f.vaults.org] }, {
    env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${pathToFileURL(emptyBare).href}.insteadOf`, GIT_CONFIG_VALUE_0: emptyRemote },
  });
  assert.equal(empty.head_found, false, 'an empty GitHub repository is connected without fabricating a branch or note');
});

test('Setup API: assignments need review plus an exact confirmation, are exclusive, and expose no URLs or credentials', async () => {
  const f = await fixture({ assign: false });
  const home = path.join(f.root, 'app-home');
  await mkdir(home, { recursive: true });
  const file = path.join(home, 'config.json');
  await saveConfig(f.cfg, file);
  const env = { BRAINLINK_HOME: home, HOME: home, BRAINLINK_SEMANTIC: '0' };
  const app = await startSetup({ env, home, os: 'linux', port: 0, useCli: false, pickGitHubRepository: async () => f.repos.org });
  const post = async (route, body, token = app.token) => {
    const response = await fetch(`http://127.0.0.1:${app.port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': token }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const org = { profile_id: 'org', vault: P.org.vault, repository: f.repos.org, whole_vault: true };
  try {
    assert.equal((await post('/api/github/assignment/pick-repository', {}, 'wrong')).status, 401);
    const picked = await post('/api/github/assignment/pick-repository', {});
    assert.equal(picked.status, 200);
    assert.equal(picked.body.path, f.repos.org);
    assert.equal((await post('/api/github/assignment/inspect', org, 'wrong')).status, 401);
    assert.equal((await post('/api/github/assignment/test-access', org, 'wrong')).status, 401, 'the remote access check requires the Setup token');
    assert.equal((await post('/api/github/repository/clone', { remote: P.org.remote, profile_id: 'org', vault: P.org.vault }, 'wrong')).status, 401, 'repository clone requires the Setup token');
    assert.notEqual((await post('/api/github/repository/clone', { remote: P.org.remote, profile_id: 'client_a', vault: P.org.vault })).status, 200, 'a profile cannot clone for a vault it does not own');
    assert.equal((await post('/api/github/assignment/set', { ...org, confirm_remote: P.org.remote }, 'wrong')).status, 401);
    // Before confirmation, a normal operation is refused.
    assert.notEqual((await post('/api/github/share-candidates', { vault: P.org.vault, profile_id: 'org' })).status, 200);
    const inspected = await post('/api/github/assignment/inspect', org);
    assert.equal(inspected.status, 200);
    assert.equal(inspected.body.remote, P.org.remote);
    assert.deepEqual(inspected.body.blocked, []);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).twin_profiles[1].github_repository, undefined, 'inspect never writes config');
    // Wrong or missing confirmation does not assign.
    assert.notEqual((await post('/api/github/assignment/set', { ...org, confirm_remote: 'someone/else' })).status, 200);
    assert.notEqual((await post('/api/github/assignment/set', org)).status, 200);
    const noScope = await post('/api/github/assignment/inspect', { ...org, whole_vault: false });
    assert.match(noScope.body.blocked.join(' '), /specific folders or explicitly confirm/);
    const bothScopes = await post('/api/github/assignment/inspect', { ...org, folders: ['Shared'], whole_vault: true });
    assert.match(bothScopes.body.blocked.join(' '), /not both/);
    const set = await post('/api/github/assignment/set', { ...org, folders: ['Shared'], whole_vault: false, confirm_remote: P.org.remote });
    assert.equal(set.status, 200);
    const saved = JSON.parse(await readFile(file, 'utf8')).twin_profiles[1].github_repository;
    assert.deepEqual(Object.keys(saved).sort(), ['confirmed_at', 'folders', 'path', 'remote', 'vault', 'whole_vault']);
    assert.equal(saved.remote, P.org.remote);
    const candidates = await post('/api/github/share-candidates', { vault: P.org.vault, profile_id: 'org' });
    assert.equal(candidates.status, 200);
    assert.deepEqual(candidates.body.notes.map((n) => n.path), ['Shared/Note.md']);
    assert.notEqual((await post('/api/github/automatic-sync', { profile_id: 'org', enabled: true, intervalHours: 6 })).status, 200, 'automatic publication needs a separate explicit opt-in');
    const enabledAuto = await post('/api/github/automatic-sync', { profile_id: 'org', enabled: true, intervalHours: 6, confirm: true, confirm_profile_id: 'org' });
    assert.equal(enabledAuto.status, 200);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).twin_profiles[1].github_repository.automatic_sync.enabled, true);
    assert.notEqual((await post('/api/github/automatic-sync', { profile_id: 'org', enabled: true, intervalHours: 2, confirm: true, confirm_profile_id: 'org' })).status, 200, 'unsupported intervals are refused');
    assert.equal((await post('/api/github/automatic-sync', { profile_id: 'org', enabled: false, intervalHours: 6 })).status, 200);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).twin_profiles[1].github_repository.automatic_sync.enabled, false);
    assert.notEqual((await post('/api/github/save-conflict-copies', { profile_id: 'client_a', vault: P.org.vault, repository: f.repos.org, paths: ['Shared/Note.md'] })).status, 200);
    // Another profile cannot take over the same clone/repository, nor use this one's vault.
    const takeover = await post('/api/github/assignment/inspect', { profile_id: 'client_a', vault: P.client_a.vault, repository: f.repos.org });
    assert.match(takeover.body.blocked.join(' '), /already assigned to another profile/);
    assert.notEqual((await post('/api/github/assignment/set', { profile_id: 'client_a', vault: P.client_a.vault, repository: f.repos.org, confirm_remote: P.org.remote })).status, 200);
    assert.notEqual((await post('/api/github/share-candidates', { vault: P.org.vault, profile_id: 'client_a' })).status, 200);
    // A credential-bearing origin is rejected at review time without echoing it.
    git(f.repos.client_a, 'remote', 'set-url', 'origin', 'https://user:ghp_012345678901234567890123456789012345@github.com/fictional-client-a/shared-brain.git');
    const leaky = await post('/api/github/assignment/inspect', { profile_id: 'client_a', vault: P.client_a.vault, repository: f.repos.client_a });
    assert.notEqual(leaky.status, 200);
    assert.doesNotMatch(JSON.stringify(leaky.body), /ghp_|user:/);
    // State shows declarations only.
    const state = await (await fetch(`http://127.0.0.1:${app.port}/api/state`, { headers: { 'X-BrainLink-Token': app.token } })).json();
    const ga = state.github_assignments;
    assert.equal(ga.find((x) => x.profile_id === 'org').status, 'assigned');
    assert.equal(ga.find((x) => x.profile_id === 'client_a').status, 'unassigned');
    assert.doesNotMatch(JSON.stringify(ga), /token|password|https?:|ghp_/i);
    // Clearing returns the profile to fail-closed.
    assert.equal((await post('/api/github/assignment/clear', { profile_id: 'org' })).status, 200);
    assert.notEqual((await post('/api/github/share-candidates', { vault: P.org.vault, profile_id: 'org' })).status, 200);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).twin_profiles[1].github_repository, undefined);
  } finally { app.server.close(); }
});

// Structural checks only: they prove the Setup page is wired to reset and bind state per profile,
// not that a browser run behaved correctly (no desktop-UI validation has been done).
test('Setup UI parses and clears selections, receipts and pending confirmations when the profile changes', async () => {
  const html = await readSetupHtml();
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0);
  for (const code of scripts) assert.doesNotThrow(() => new vm.Script(code));
  const reset = /function githubResetState\(\) \{([\s\S]*?)\n\}/.exec(html)?.[1] || '';
  for (const piece of ['githubCandidates = []', 'githubPullCandidates = []', 'githubInspected = null', 'renderGitHubCandidates()', "$('github-result').hidden = true"]) assert.ok(reset.includes(piece), `reset must include ${piece}`);
  assert.match(html, /renderGitHubCandidates\(\) \{[\s\S]*?githubPendingPush = null; \$\('github-push'\)\.hidden = true/);
  assert.match(html, /e\.target\.id === 'github-profile'\) \{ \$\('github-repository'\)\.value = ''; \$\('github-assign-folders'\)\.value = ''; \$\('github-assign-whole-vault'\)\.checked = false; githubResetState\(\)/);
  assert.match(html, /githubAssignInput = \(\) => \(\{[\s\S]*whole_vault: \$\('github-assign-whole-vault'\)\.checked/);
  assert.match(html, /githubPendingPush = r\.committed \? \{ commit: r\.commit, paths: r\.committed_paths \|\| paths, profile: githubProfileId\(\) \}/);
  assert.match(html, /githubPendingPush\.profile !== githubProfileId\(\)/);
  assert.match(html, /id="github-no-profiles" class="notice" data-i18n="github\.noProfiles" hidden/);
  assert.match(html, /id="github-repository-pick" data-i18n="github\.repositoryBrowse"/);
  assert.match(html, /id="github-assign-test" data-i18n="github\.accessTest" hidden/);
  assert.match(html, /id="github-clone-remote" class="mono" data-i18n-placeholder="github\.cloneRemotePlaceholder"/);
  assert.match(html, /github-clone'\)\.onclick = async \(\) => \{[\s\S]*?\/api\/github\/repository\/clone[\s\S]*?result\.path[\s\S]*?invalidateGitHubAssignmentReview\(\)/);
  assert.match(html, /github-assign-test'\)\.onclick = async \(\) => \{[\s\S]*?\/api\/github\/assignment\/test-access[\s\S]*?github\.accessOk[\s\S]*?github\.accessEmpty/);
  assert.match(html, /function invalidateGitHubAssignmentReview\(\)[\s\S]*?\$\('github-assign-test'\)\.hidden = true/);
  assert.match(html, /github-repository-pick'\)\.onclick = \(\) => act\(async \(\) => \{[\s\S]*?\/api\/github\/assignment\/pick-repository[\s\S]*?window\.promptForFolder\(\)[\s\S]*?githubInspected = null/);
  assert.match(html, /if \(!list\.length\) \{[\s\S]*?\$\('github-load'\)\.disabled = true;[\s\S]*?\$\('github-pull-check'\)\.disabled = true;/);
  for (const route of ['share-candidates', 'preview', 'commit-selected', 'push-selected', 'pull-candidates', 'import-selected']) {
    assert.match(html, new RegExp(`/api/github/${route}'[^\\n]*profile_id: githubProfileId\\(\\)`), `${route} must send the selected profile`);
  }
  for (const locale of ['en', 'zh-TW', 'pt']) {
    const catalog = JSON.parse(await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'locales', `${locale}.json`), 'utf8'));
    for (const key of ['github.accessTest', 'github.accessTesting', 'github.accessOk', 'github.accessEmpty', 'github.accessFailed']) assert.ok(catalog[key], `${locale} ${key}`);
    for (const key of ['github.cloneHint', 'github.cloneRemote', 'github.cloneRemotePlaceholder', 'github.cloneButton', 'github.cloneChooseProfile', 'github.cloneConfirm', 'github.cloneRunning', 'github.cloneDone', 'github.cloneEmpty', 'github.cloneFailed']) assert.ok(catalog[key], `${locale} ${key}`);
  }
});
