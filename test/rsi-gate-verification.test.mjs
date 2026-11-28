import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  VERIFICATION_TIERS,
  BLOCKING_TIERS,
  classifyVerificationTier,
  validateVerificationContract,
  runVerificationSuite,
  evaluateSkill,
  promoteSkill,
} from '../src/rsi-gate.mjs';

async function makeFixtureEnv() {
  const base = await mkdtemp(path.join(tmpdir(), 'brainlink-rsi-v2-'));
  const skillsDir = path.join(base, '60 Skills');
  const evidenceDir = path.join(base, 'evidence');
  const stateDir = path.join(base, 'state');
  await mkdir(path.join(skillsDir, 'demo-skill'), { recursive: true });
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(skillsDir, 'demo-skill', 'SKILL.md'), [
    '---',
    'name: "demo-skill"',
    'type: "skill"',
    'description: "Use this when verifying the 4-tier verification ladder."',
    'date: "2026-11-28"',
    'owner: "Hermes"',
    'status: "draft"',
    'version: "0.1"',
    'ai_platform: "Hermes (DeepSeek)"',
    'agent_or_role: "Hermes"',
    '---',
    '',
    '# demo-skill',
    '',
    '## When to use',
    'When verifying the 4-tier RSI contract.',
    '',
    '## Steps',
    '1. Run deterministic checks.',
    '2. Record evidence.',
    '',
    '## Guardrails',
    '- Never treat UNMEASURED as PASS.',
    '',
    '## Test card',
    'Hand-run once, 2026-11-28: verified expected output.',
    '',
  ].join('\n'), 'utf8');
  return { base, skillsDir, evidenceDir, stateDir, auditFile: path.join(stateDir, 'audit.jsonl') };
}

test('4-tier verification ladder exports exact tiers and allows only code tier on blocking path', () => {
  assert.deepEqual(VERIFICATION_TIERS, ['code', 'classifier', 'judge', 'human']);
  assert.deepEqual(BLOCKING_TIERS, ['code']);
  assert.equal(classifyVerificationTier('deterministic-rubric-v1', 'deterministic'), 'code');
  assert.equal(classifyVerificationTier('classifier', 'classifier'), 'classifier');
  assert.equal(classifyVerificationTier('claude-cli', 'cross-model-cli'), 'judge');
  assert.equal(classifyVerificationTier('human', 'human'), 'human');

  // Blocking promotion accepts code PASS
  const ok = validateVerificationContract({ verdict: 'PASS', judge: 'deterministic-rubric-v1', verification_tier: 'code' }, { blocking: true });
  assert.equal(ok.blocking_eligible, true);
  assert.equal(ok.provisional, false);

  // Blocking promotion refuses classifier, judge, and human tiers
  for (const tier of ['classifier', 'judge', 'human']) {
    assert.throws(
      () => validateVerificationContract({ verdict: 'PASS', judge: `${tier}-eval`, verification_tier: tier, calibrated_against_human: true }, { blocking: true }),
      (err) => err.code === 'RSI_REFUSAL' && /requires tier "code"/i.test(err.message),
      `expected blocking refusal for tier=${tier}`,
    );
  }
});

test('UNMEASURED is emitted on transport errors, malformed verdicts, and skipped checks — never PASS or FAIL, and refused at promotion', async () => {
  const env = await makeFixtureEnv();

  // 1. Transport error in judgeRunner emits UNMEASURED (not PASS, not FAIL)
  const errEv = await evaluateSkill({
    skill: 'demo-skill',
    skillsDir: env.skillsDir,
    evidenceDir: env.evidenceDir,
    judge: 'claude',
    judgeRunner: async () => { throw new Error('ETIMEDOUT: judge transport timeout'); },
  });
  assert.equal(errEv.verdict, 'UNMEASURED');
  assert.equal(errEv.verification_tier, 'judge');
  assert.equal(errEv.calibration_status, 'PROVISIONAL');
  assert.equal(errEv.provisional, true);

  // 2. Malformed verdict in judgeRunner emits UNMEASURED
  const badEv = await evaluateSkill({
    skill: 'demo-skill',
    skillsDir: env.skillsDir,
    evidenceDir: env.evidenceDir,
    judge: 'claude',
    judgeRunner: async () => ({ verdict: 'MAYBE', reason: 'not sure' }),
  });
  assert.equal(badEv.verdict, 'UNMEASURED');

  // 3. Promotion gate refuses UNMEASURED evidence (even if tier is code)
  const unmeasuredCodePath = path.join(env.evidenceDir, 'unmeasured-code.json');
  await writeFile(unmeasuredCodePath, JSON.stringify({
    skill: 'demo-skill',
    judge: 'deterministic-rubric-v1',
    verification_tier: 'code',
    verdict: 'UNMEASURED',
    unmeasured_reason: 'check skipped',
  }), 'utf8');
  await assert.rejects(
    () => promoteSkill({ skill: 'demo-skill', evidencePath: unmeasuredCodePath, skillsDir: env.skillsDir, auditFile: env.auditFile, stateDir: env.stateDir }),
    (err) => err.code === 'RSI_REFUSAL' && /UNMEASURED/i.test(err.message),
  );

  // 4. Suite with skipped check or throwing code check emits UNMEASURED (never PASS)
  const suiteRes = await runVerificationSuite({
    suiteId: 'unmeasured-suite',
    blocking: true,
    assertions: [
      { id: 'c1', tier: 'code', run: () => true },
      { id: 'c2', tier: 'code', skipped: true, skip_reason: 'fixture absent' },
      { id: 'c3', tier: 'code', run: () => { throw new Error('ECONNREFUSED'); } },
    ],
  });
  assert.equal(suiteRes.verdict, 'UNMEASURED');
  assert.equal(suiteRes.results[1].status, 'UNMEASURED');
  assert.equal(suiteRes.results[2].status, 'UNMEASURED');
});

test('judge-tier evals are labeled PROVISIONAL until human-calibrated and require a failing adversarial fixture', async () => {
  // Missing adversarial fixture is refused
  await assert.rejects(
    () => runVerificationSuite({
      suiteId: 'no-adv',
      assertions: [{ id: 'j1', tier: 'judge', prompt: 'eval' }],
      adversarialFixtures: [],
      judgeRunner: async () => ({ verdict: 'PASS', reason: 'ok' }),
    }),
    (err) => err.code === 'RSI_REFUSAL' && /adversarial fixture/i.test(err.message),
  );

  // Judge that passes a known-bad adversarial fixture invalidates the suite run
  const invalidated = await runVerificationSuite({
    suiteId: 'rubber-stamp-judge',
    assertions: [{ id: 'j1', tier: 'judge', kind: 'good' }],
    adversarialFixtures: [{ id: 'known-bad-1', kind: 'bad' }],
    judgeRunner: async () => ({ verdict: 'PASS', reason: 'rubber stamp' }),
  });
  assert.equal(invalidated.suite_valid, false);
  assert.equal(invalidated.verdict, 'FAIL');
  assert.match(invalidated.invalidated_reason, /invalidated/i);
  assert.equal(invalidated.calibration_status, 'PROVISIONAL');
  assert.equal(invalidated.provisional, true);

  // Judge that properly fails the adversarial fixture and passes the real case stays PROVISIONAL until calibrated
  const provisionalPass = await runVerificationSuite({
    suiteId: 'honest-judge',
    assertions: [{ id: 'j1', tier: 'judge', kind: 'good' }],
    adversarialFixtures: [{ id: 'known-bad-1', kind: 'bad' }],
    judgeRunner: async (item) => item.kind === 'bad'
      ? { verdict: 'FAIL', reason: 'caught bad fixture' }
      : { verdict: 'PASS', reason: 'good case passed' },
  });
  assert.equal(provisionalPass.suite_valid, true);
  assert.equal(provisionalPass.verdict, 'PASS');
  assert.equal(provisionalPass.calibration_status, 'PROVISIONAL');
  assert.equal(provisionalPass.provisional, true);

  // Calibrated judge flips calibration_status to CALIBRATED (still non-blocking)
  const calibratedPass = await runVerificationSuite({
    suiteId: 'calibrated-judge',
    calibratedAgainstHuman: true,
    assertions: [{ id: 'j1', tier: 'judge', kind: 'good' }],
    adversarialFixtures: [{ id: 'known-bad-1', kind: 'bad' }],
    judgeRunner: async (item) => item.kind === 'bad'
      ? { verdict: 'FAIL', reason: 'caught bad fixture' }
      : { verdict: 'PASS', reason: 'good case passed' },
  });
  assert.equal(calibratedPass.calibration_status, 'CALIBRATED');
  assert.equal(calibratedPass.provisional, false);

  // Blocking suite rejects judge-tier assertions outright
  await assert.rejects(
    () => runVerificationSuite({
      suiteId: 'blocking-judge-attempt',
      blocking: true,
      assertions: [{ id: 'j1', tier: 'judge', kind: 'good' }],
      adversarialFixtures: [{ id: 'known-bad-1', kind: 'bad' }],
      judgeRunner: async () => ({ verdict: 'PASS' }),
    }),
    (err) => err.code === 'RSI_REFUSAL' && /only "code" tier/i.test(err.message),
  );
});
