import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  listSkills,
  showSkill,
  evaluateSkill,
  promoteSkill,
  holdSkill,
  killSkill,
  rollbackSkill,
  readAuditLog,
  checkCapsFromLogs,
  precheckCaps,
  sameIdentity,
  syncActiveSkills,
} from '../src/rsi-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'rsi-gate.mjs');

async function makeSkill(skillsDir, name, overrides = {}) {
  const dir = path.join(skillsDir, name);
  await mkdir(dir, { recursive: true });
  const fm = {
    name,
    type: 'skill',
    description: overrides.description ?? `Use this when testing ${name}.`,
    date: overrides.date ?? '2026-11-26',
    owner: overrides.owner ?? 'Hermes',
    status: overrides.status ?? 'draft',
    version: overrides.version ?? '0.1',
    ai_platform: overrides.ai_platform ?? 'Hermes (DeepSeek)',
    agent_or_role: overrides.agent_or_role ?? 'Hermes',
    written_at: overrides.written_at ?? '2026-11-26T22:00:00+08:00',
    confidence: overrides.confidence ?? 'medium',
  };
  const yamlLines = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  const body = overrides.body ?? `\n# ${name}\n\n## When to use\n\nWhen verifying ${name}.\n\n## Steps\n\n1. Check input.\n2. Verify output.\n\n## Guardrails\n\n- Never store secrets.\n\n## Test card\n\nHand-run once, 2026-11-26: verified expected output.\n`;
  await writeFile(path.join(dir, 'SKILL.md'), `---\n${yamlLines}\n---\n${body}`, 'utf8');
  return path.join(dir, 'SKILL.md');
}

async function makeEnv() {
  const base = await mkdtemp(path.join(tmpdir(), 'brainlink-rsi-gate-'));
  const skillsDir = path.join(base, '60 Skills');
  const logsDir = path.join(base, '50 Knowledge', '_log');
  const evidenceDir = path.join(base, 'evidence');
  const stateDir = path.join(base, 'state');
  await mkdir(skillsDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  return { base, skillsDir, logsDir, evidenceDir, stateDir, auditFile: path.join(stateDir, 'rsi-gate-audit.jsonl') };
}

test('sameIdentity detects exact, case-insensitive, and same-model-family judge == author collisions', () => {
  assert.equal(sameIdentity('Hermes (DeepSeek)', 'hermes'), true);
  assert.equal(sameIdentity('Claude Code', 'claude'), true);
  assert.equal(sameIdentity('ChatGPT Codex', 'codex'), true);
  assert.equal(sameIdentity('Gemini', 'gemini-cli'), true);
  assert.equal(sameIdentity('Hermes (DeepSeek)', 'claude'), false);
  assert.equal(sameIdentity('Hermes (DeepSeek)', 'deterministic-rubric-v1'), false);
});

test('promote REFUSES without evidence file and REFUSES when judge == author', async () => {
  const env = await makeEnv();
  await makeSkill(env.skillsDir, 'alpha-check', { ai_platform: 'Hermes (DeepSeek)', owner: 'Hermes' });

  // 1. Refuse without evidence
  await assert.rejects(
    () => promoteSkill({ skill: 'alpha-check', skillsDir: env.skillsDir, auditFile: env.auditFile, stateDir: env.stateDir, actor: 'Anna' }),
    (err) => err.code === 'RSI_REFUSAL' && /evidence/i.test(err.message),
  );

  // 2. Refuse when evidence verdict is FAIL
  const failEv = path.join(env.evidenceDir, 'alpha-fail.json');
  await writeFile(failEv, JSON.stringify({
    skill: 'alpha-check',
    verdict: 'FAIL',
    judge: 'claude-cli',
    evaluated_at: '2026-11-27T17:00:00+08:00',
    summary: 'Failed deterministic check',
  }), 'utf8');
  await assert.rejects(
    () => promoteSkill({ skill: 'alpha-check', evidencePath: failEv, skillsDir: env.skillsDir, auditFile: env.auditFile, stateDir: env.stateDir, actor: 'Anna' }),
    (err) => err.code === 'RSI_REFUSAL' && /PASS/i.test(err.message),
  );

  // 3. Refuse when judge == author (same identity/family)
  const selfEv = path.join(env.evidenceDir, 'alpha-self.json');
  await writeFile(selfEv, JSON.stringify({
    skill: 'alpha-check',
    verdict: 'PASS',
    judge: 'Hermes (DeepSeek)',
    evaluated_at: '2026-11-27T17:00:00+08:00',
    summary: 'Self-judged pass',
  }), 'utf8');
  await assert.rejects(
    () => promoteSkill({ skill: 'alpha-check', evidencePath: selfEv, skillsDir: env.skillsDir, auditFile: env.auditFile, stateDir: env.stateDir, actor: 'Anna' }),
    (err) => err.code === 'RSI_REFUSAL' && /judge.*author/i.test(err.message),
  );

  // Skill must remain draft
  const after = await showSkill({ skill: 'alpha-check', skillsDir: env.skillsDir });
  assert.equal(after.status, 'draft');
});

test('evaluate -> promote -> audit -> rollback preserves body, appends JSONL, and keeps both versions', async () => {
  const env = await makeEnv();
  const skillPath = await makeSkill(env.skillsDir, 'beta-guard', { ai_platform: 'Hermes (DeepSeek)', version: '0.1' });
  const originalBody = (await readFile(skillPath, 'utf8')).split('\n---\n')[1];

  // Evaluate with deterministic rubric (judge != author)
  const evalResult = await evaluateSkill({
    skill: 'beta-guard',
    skillsDir: env.skillsDir,
    evidenceDir: env.evidenceDir,
    judge: 'deterministic',
  });
  assert.equal(evalResult.verdict, 'PASS');
  assert.equal(evalResult.judge, 'deterministic-rubric-v1');

  // Promote with passing evidence
  const promo = await promoteSkill({
    skill: 'beta-guard',
    evidencePath: evalResult.evidence_path,
    skillsDir: env.skillsDir,
    auditFile: env.auditFile,
    stateDir: env.stateDir,
    actor: 'Antigravity (Anna)',
    reason: 'Passed deterministic evaluation',
  });
  assert.equal(promo.from_state, 'draft');
  assert.equal(promo.to_state, 'active');

  const promotedRaw = await readFile(skillPath, 'utf8');
  assert.equal(promotedRaw.split('\n---\n')[1], originalBody, 'Skill body must never be rewritten');
  const shown = await showSkill({ skill: 'beta-guard', skillsDir: env.skillsDir });
  assert.equal(shown.status, 'active');
  assert.equal(shown.frontmatter.judge, 'deterministic-rubric-v1');
  assert.equal(shown.frontmatter.evidence_path, evalResult.evidence_path);
  assert.match(shown.frontmatter.status_changed_at, /\+08:00$/);

  // Rollback restores previous version and keeps the superseded active version in .rsi-history
  const rb = await rollbackSkill({
    skill: 'beta-guard',
    skillsDir: env.skillsDir,
    auditFile: env.auditFile,
    stateDir: env.stateDir,
    actor: 'Antigravity (Anna)',
    reason: 'Verified rollback test',
  });
  assert.equal(rb.from_state, 'active');
  assert.equal(rb.to_state, 'draft');
  assert.ok(rb.superseded_snapshot, 'Superseded active snapshot must be retained');
  const historyFiles = await readdir(path.join(env.skillsDir, 'beta-guard', '.rsi-history'));
  assert.ok(historyFiles.length >= 2, 'Both pre-promotion and superseded active snapshots must exist');

  // Audit log is append-only with 2 lines (promote + rollback)
  const lines = await readAuditLog({ auditFile: env.auditFile });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].to_state, 'active');
  assert.equal(lines[1].to_state, 'draft');
  assert.match(lines[0].timestamp, /\+08:00$/);
});

test('hold, kill, and illegal transitions are enforced strictly', async () => {
  const env = await makeEnv();
  await makeSkill(env.skillsDir, 'gamma-rule');

  // Hold requires both reason and condition
  await assert.rejects(
    () => holdSkill({ skill: 'gamma-rule', reason: 'Needs fixture', condition: '', skillsDir: env.skillsDir, auditFile: env.auditFile, stateDir: env.stateDir, actor: 'Anna' }),
    (err) => err.code === 'RSI_USAGE' || err.code === 'RSI_REFUSAL',
  );

  const held = await holdSkill({
    skill: 'gamma-rule',
    reason: 'Waiting on real fixture',
    condition: 'Run once against live inbox',
    skillsDir: env.skillsDir,
    auditFile: env.auditFile,
    stateDir: env.stateDir,
    actor: 'Anna',
  });
  assert.equal(held.to_state, 'held');

  const killed = await killSkill({
    skill: 'gamma-rule',
    reason: 'Duplicate of existing guardrail',
    skillsDir: env.skillsDir,
    auditFile: env.auditFile,
    stateDir: env.stateDir,
    actor: 'Anna',
  });
  assert.equal(killed.to_state, 'killed');

  // Killed is terminal: cannot promote or hold a killed skill
  const fakeEv = path.join(env.evidenceDir, 'gamma-pass.json');
  await writeFile(fakeEv, JSON.stringify({ skill: 'gamma-rule', verdict: 'PASS', judge: 'claude-cli', evaluated_at: '2026-11-27T17:00:00+08:00' }), 'utf8');
  await assert.rejects(
    () => promoteSkill({ skill: 'gamma-rule', evidencePath: fakeEv, skillsDir: env.skillsDir, auditFile: env.auditFile, stateDir: env.stateDir, actor: 'Anna' }),
    (err) => err.code === 'RSI_REFUSAL' && /killed/i.test(err.message),
  );
});

test('caps checks Distill logs without editing and precheck enforces 5/2 limits + backlog circuit breaker', async () => {
  const env = await makeEnv();
  const overrunLog = path.join(env.logsDir, '2026-11-24.md');
  await writeFile(overrunLog, `# 2026-11-24 Distill log\n\n## Run 55\nCounts: 10 cards, 3 draft skills, 0 duplicates.\n`, 'utf8');
  const okLog = path.join(env.logsDir, '2026-11-26.md');
  await writeFile(okLog, `# 2026-11-26 Distill log\n\n## Run 59\nCounts: 4 cards, 1 draft skill, 0 duplicates.\n`, 'utf8');

  const failReport = await checkCapsFromLogs({ runDate: '2026-11-24', logsDir: env.logsDir });
  assert.equal(failReport.pass, false);
  assert.equal(failReport.runs[0].cards, 10);
  assert.equal(failReport.runs[0].skills, 3);

  const passReport = await checkCapsFromLogs({ runDate: '2026-11-26', logsDir: env.logsDir });
  assert.equal(passReport.pass, true);

  // Precheck refuses 6th card or 3rd skill
  const pCardFail = await precheckCaps({ runDate: '2026-11-27', cards: 6, skills: 1 });
  assert.equal(pCardFail.pass, false);
  assert.match(pCardFail.reason, /card/i);

  const pSkillFail = await precheckCaps({ runDate: '2026-11-27', cards: 3, skills: 3 });
  assert.equal(pSkillFail.pass, false);
  assert.match(pSkillFail.reason, /skill/i);

  // Backlog circuit breaker refuses new external draft skill when unjudged drafts > maxDrafts
  await makeSkill(env.skillsDir, 'd1');
  await makeSkill(env.skillsDir, 'd2');
  await makeSkill(env.skillsDir, 'd3');
  const pBacklogFail = await precheckCaps({ runDate: '2026-11-27', cards: 2, skills: 1, skillsDir: env.skillsDir, maxDrafts: 2 });
  assert.equal(pBacklogFail.pass, false);
  assert.match(pBacklogFail.reason, /backlog|circuit breaker/i);

  // Demand-signal override allows 1 skill even when backlog is above external cap
  const pDemandOk = await precheckCaps({ runDate: '2026-11-27', cards: 2, skills: 1, skillsDir: env.skillsDir, maxDrafts: 2, demandSignal: true });
  assert.equal(pDemandOk.pass, true);
});

test('syncActiveSkills deploys ONLY active skills via BrainLink agent-skills and removes rolled-back skills', async () => {
  const env = await makeEnv();
  const fakeHome = path.join(env.base, 'home');
  await mkdir(fakeHome, { recursive: true });
  await makeSkill(env.skillsDir, 'live-skill', { status: 'active' });
  await makeSkill(env.skillsDir, 'draft-skill', { status: 'draft' });

  const synced = await syncActiveSkills({
    skillsDir: env.skillsDir,
    clients: ['antigravity'],
    stateDir: env.stateDir,
    home: fakeHome,
  });
  assert.equal(synced.active_count, 1);
  const installedDir = path.join(fakeHome, '.gemini', 'config', 'skills');
  const installed = await readdir(installedDir);
  assert.deepEqual(installed, ['live-skill']);
});

test('CLI exit codes: 0 ok, 1 refusal, 2 usage error', async () => {
  const env = await makeEnv();
  await makeSkill(env.skillsDir, 'cli-skill');

  // Usage error -> exit 2
  const usageRes = spawnSync(process.execPath, [CLI, 'unknown-cmd'], { encoding: 'utf8' });
  assert.equal(usageRes.status, 2);

  // Refusal (promote without evidence) -> exit 1
  const refuseRes = spawnSync(process.execPath, [CLI, 'promote', 'cli-skill', '--skills-dir', env.skillsDir, '--state-dir', env.stateDir], { encoding: 'utf8' });
  assert.equal(refuseRes.status, 1);
  assert.match(refuseRes.stderr + refuseRes.stdout, /REFUSED|evidence/i);

  // List -> exit 0
  const okRes = spawnSync(process.execPath, [CLI, 'list', '--state', 'draft', '--skills-dir', env.skillsDir], { encoding: 'utf8' });
  assert.equal(okRes.status, 0);
  assert.match(okRes.stdout, /cli-skill/);
});
