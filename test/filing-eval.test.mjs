import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalize, saveConfig } from '../src/config.mjs';
import { createContext } from '../src/core.mjs';
import { evaluateSessionFiling, validateFilingFixture } from '../src/sessions/filing-eval.mjs';

const execFileAsync = promisify(execFile);

test('filing RSI compares folder suggestions, abstentions and privacy without mutating routes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-filing-eval-'));
  const vaultPath = path.join(root, 'Company');
  for (const folder of ['Inbox', 'Projects', 'Private']) await mkdir(path.join(vaultPath, folder), { recursive: true });
  await writeFile(path.join(vaultPath, 'Projects', 'Bluebird Plan.md'), 'The fictional Bluebird plan lists rollout checkpoints, review owners, customer communication milestones and recovery criteria. Keep dated project decisions here and link approved work to the main project record.');
  await writeFile(path.join(vaultPath, 'Private', 'Secret Deal.md'), '---\nprivate: true\n---\nThe Bluebird secret deal has canary RSI_FILING_PRIVATE_CANARY.');
  const cfg = normalize({ vaults: [{ name: 'Company', path: vaultPath }] });
  const env = { BRAINLINK_HOME: path.join(root, 'app'), BRAINLINK_VAULTS: 'Company' };
  const ctx = createContext(cfg, { env });
  const fixture = { schema: 1, vault: 'Company', intake_folder: 'Inbox', cases: [
    { id: 'case_public', project: 'Bluebird', summary: 'Bluebird Plan records the rollout review.', expected_folder: 'Projects' },
    { id: 'case_private', project: 'Secret', summary: 'Secret Deal is discussed.', expected_folder: null, forbidden_folders: ['Private'] },
    { id: 'case_abstain', project: 'Unrelated', summary: 'Cactus telescope over a lunar origami workshop.', expected_folder: null },
  ] };
  const report = await evaluateSessionFiling(ctx, fixture, { minimumCases: 3 });
  assert.equal(report.case_count, 3);
  assert.equal(report.decision, 'eligible_for_review');
  assert.equal(report.baseline.accuracy, 0);
  assert.equal(report.candidate.accuracy, 1);
  assert.equal(report.candidate.precision, 1);
  assert.equal(report.candidate.coverage, 0.333);
  assert.equal(report.candidate.privacy_violations, 0);
  assert.match(report.fixture_sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(report), /RSI_FILING_PRIVATE_CANARY|Bluebird Plan\.md|Secret Deal|Cactus telescope|Projects/);
  assert.deepEqual(cfg.session_filing.projectFolders, {});
  const blocked = await evaluateSessionFiling(ctx, { ...fixture, cases: [
    { ...fixture.cases[0], forbidden_folders: ['Projects'] },
  ] }, { minimumCases: 1 });
  assert.equal(blocked.decision, 'blocked_privacy');
});

test('filing evaluator enforces enabled vault scope and validates labelled destinations', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-filing-eval-scope-'));
  const vaultPath = path.join(root, 'Vault');
  await mkdir(path.join(vaultPath, 'Inbox'), { recursive: true });
  const ctx = createContext(normalize({ vaults: [{ name: 'Company', path: vaultPath }] }), { env: { BRAINLINK_VAULTS: 'Other' } });
  const fixture = { schema: 1, vault: 'Company', intake_folder: 'Inbox', cases: [{ id: 'case_1', project: '', summary: 'No match.', expected_folder: null }] };
  await assert.rejects(evaluateSessionFiling(ctx, fixture), /not enabled/);
  assert.match(validateFilingFixture({ ...fixture, cases: [{ ...fixture.cases[0], expected_folder: '../outside' }] }).join('; '), /expected_folder/);
});

test('frozen filing RSI fixture improves over intake and emits aggregate-only evidence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-filing-rsi-frozen-'));
  const vaultPath = path.resolve('samples/evaluation/filing-vault');
  const fixturePath = path.resolve('samples/evaluation/filing-rsi-v1.json');
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const ctx = createContext(normalize({ vaults: [{ name: 'Acme Filing Eval', path: vaultPath }] }), {
    env: { BRAINLINK_HOME: path.join(root, 'app'), BRAINLINK_VAULTS: 'Acme Filing Eval' },
  });
  const report = await evaluateSessionFiling(ctx, fixture);
  assert.equal(report.case_count, 20);
  assert.ok(['eligible_for_review', 'no_demonstrated_gain'].includes(report.decision));
  assert.equal(report.candidate.privacy_violations, 0);
  assert.ok(report.candidate.accuracy > report.baseline.accuracy);
  assert.doesNotMatch(JSON.stringify(report), /RSI_FILING_PRIVATE_CANARY_42|Bluebird Strategy\.md|Private Acquisition Brief|filing-vault/);
});

test('corrected filing fixture treats historical-note exclusions as deliberate abstentions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-filing-rsi-v2-'));
  const vaultPath = path.resolve('samples/evaluation/filing-vault');
  const fixturePath = path.resolve('samples/evaluation/filing-rsi-v2.json');
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const ctx = createContext(normalize({ vaults: [{ name: fixture.vault, path: vaultPath }] }), {
    env: { BRAINLINK_HOME: path.join(root, 'app'), BRAINLINK_VAULTS: fixture.vault },
  });
  const report = await evaluateSessionFiling(ctx, fixture);
  assert.equal(report.case_count, 20);
  assert.equal(report.candidate.accuracy, 1);
  assert.equal(report.candidate.precision, 1);
  assert.equal(report.candidate.coverage, 0.8);
  assert.equal(report.candidate.privacy_violations, 0);
  assert.equal(report.candidate.cases[15].suggested, false);
  assert.equal(report.candidate.cases[15].correct, true);
  assert.equal(report.decision, 'eligible_for_review');
});

test('CLI filing evaluation prints aggregate evidence and never changes the fixture vault', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-filing-eval-cli-'));
  const home = path.join(root, 'home');
  const vaultPath = path.resolve('samples/evaluation/filing-vault');
  await saveConfig(normalize({ vaults: [{ name: 'Acme Filing Eval', path: vaultPath }] }), path.join(home, 'config.json'));
  const fixturePath = path.resolve('samples/evaluation/filing-rsi-v2.json');
  const { stdout } = await execFileAsync(process.execPath, [path.resolve('bin/brainlink.mjs'), 'eval-filing', '--fixture', fixturePath], {
    cwd: process.cwd(), env: { ...process.env, BRAINLINK_HOME: home, HOME: root },
  });
  const report = JSON.parse(stdout);
  assert.equal(report.case_count, 20);
  assert.doesNotMatch(stdout, /RSI_FILING_PRIVATE_CANARY_42|Bluebird Strategy\.md|Private Acquisition Brief/);
  assert.equal(report.decision, 'eligible_for_review');
});
