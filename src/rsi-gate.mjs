// BrainLink RSI Promotion Gate & Closed-Loop Skill Lifecycle Engine.
// Enforces 4-state skill transitions (draft | active | held | killed), judge != author separation,
// append-only JSONL + hash-chained BrainLink RSI ledger logging, versioned rollback, caps + backlog
// circuit breaker, and atomic multi-client skill deployment via src/agent-skills.mjs.
import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { findSecrets } from './core.mjs';
import { createRsiLedger } from './rsi-ledger.mjs';
import { installAgentSkills } from './agent-skills.mjs';

export const STATES = Object.freeze(['draft', 'active', 'held', 'killed']);
const STATE_SET = new Set(STATES);

export const LEGAL_TRANSITIONS = Object.freeze({
  draft: new Set(['active', 'held', 'killed']),
  held: new Set(['active', 'draft', 'killed']),
  active: new Set(['held', 'killed', 'draft']), // draft via rollback only
  killed: new Set([]), // terminal; nothing is deleted, only superseded by a new skill
});

export const DEFAULT_MAX_CARDS = 5;
export const DEFAULT_MAX_SKILLS = 2;
export const DEFAULT_MAX_DRAFTS = 20;

export class RsiGateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RsiGateError';
    this.code = code; // 'RSI_REFUSAL' (exit 1) | 'RSI_USAGE' (exit 2)
    this.exitCode = code === 'RSI_USAGE' ? 2 : 1;
  }
}

export function refusal(message) {
  return new RsiGateError('RSI_REFUSAL', `REFUSED: ${message}`);
}

export function usageError(message) {
  return new RsiGateError('RSI_USAGE', `USAGE ERROR: ${message}`);
}

export function nowTaipeiIso(date = new Date()) {
  const ms = date.getTime() + 8 * 3600 * 1000;
  const shifted = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}+08:00`;
}

export function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const IDENTITY_FAMILIES = [
  { family: 'hermes', pattern: /\b(hermes|deepseek)\b/i },
  { family: 'claude', pattern: /\b(claude|anthropic)\b/i },
  { family: 'codex', pattern: /\b(codex|chatgpt|openai)\b/i },
  { family: 'gemini', pattern: /\b(gemini|antigravity|neon|google)\b/i },
  { family: 'grok', pattern: /\b(grok|paulo|xai)\b/i },
  { family: 'deterministic', pattern: /\b(deterministic|rubric)\b/i },
];

export function identityFamily(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  for (const entry of IDENTITY_FAMILIES) {
    if (entry.pattern.test(raw)) return entry.family;
  }
  return raw.replace(/[^a-z0-9]+/g, ' ').trim();
}

export function sameIdentity(author, judge) {
  const a = String(author || '').trim().toLowerCase();
  const j = String(judge || '').trim().toLowerCase();
  if (!a || !j) return false;
  if (a === j) return true;
  const fa = identityFamily(a);
  const fj = identityFamily(j);
  return Boolean(fa && fj && fa === fj);
}

export function splitFrontmatter(raw) {
  const normalized = raw.replace(/\r\n/g, '\n');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  if (!normalized.startsWith('---\n')) {
    throw refusal('SKILL.md is missing YAML frontmatter (must start with ---).');
  }
  const endIdx = normalized.indexOf('\n---\n', 4);
  const endAlt = endIdx >= 0 ? endIdx : normalized.indexOf('\n---', 4);
  if (endAlt < 0) {
    throw refusal('SKILL.md has unterminated YAML frontmatter.');
  }
  const fmText = normalized.slice(4, endAlt);
  const afterFence = endIdx >= 0 ? endIdx + 5 : endAlt + 4;
  const body = normalized.slice(afterFence);
  const doc = parseDocument(fmText, { uniqueKeys: false });
  if (doc.errors.length) {
    throw refusal(`SKILL.md YAML frontmatter parse error: ${doc.errors[0].message}`);
  }
  const data = doc.toJS() || {};
  return { data, body, eol, fmText };
}

export function renderFrontmatter(data, body, eol = '\n') {
  const yamlOut = stringify(data, { lineWidth: 0 }).trimEnd();
  const content = `---\n${yamlOut}\n---\n${body}`;
  return eol === '\r\n' ? content.replace(/\n/g, '\r\n') : content;
}

function skillFilePath(skillsDir, skill) {
  if (!skill || !/^[a-z0-9][a-z0-9-]*$/i.test(skill)) {
    throw usageError(`Invalid skill name "${skill}". Expected kebab-case folder name.`);
  }
  return path.join(skillsDir, skill, 'SKILL.md');
}

export async function showSkill({ skill, skillsDir }) {
  const filePath = skillFilePath(skillsDir, skill);
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    throw refusal(`Skill "${skill}" not found at ${filePath}.`);
  }
  const { data, body } = splitFrontmatter(raw);
  const status = String(data.status || 'draft').trim().toLowerCase();
  const authors = [data.ai_platform, data.owner, data.agent_or_role].filter(Boolean).map(String);
  return {
    skill,
    path: filePath,
    status,
    date: data.date ? String(data.date) : '',
    version: data.version ? String(data.version) : '0.1',
    author: authors[0] || 'unknown',
    authors,
    frontmatter: data,
    body,
    sha256: sha256Text(raw),
  };
}

export async function listSkills({ skillsDir, state } = {}) {
  if (state && !STATE_SET.has(state)) {
    throw usageError(`Invalid --state "${state}". Allowed: ${STATES.join(', ')}.`);
  }
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    throw refusal(`Skills directory not found: ${skillsDir}`);
  }
  const out = [];
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const filePath = path.join(skillsDir, entry.name, 'SKILL.md');
    try {
      const raw = await readFile(filePath, 'utf8');
      const { data } = splitFrontmatter(raw);
      const st = String(data.status || 'draft').trim().toLowerCase();
      if (state && st !== state) continue;
      out.push({
        skill: entry.name,
        status: st,
        date: data.date ? String(data.date) : '',
        owner: data.owner ? String(data.owner) : '',
        ai_platform: data.ai_platform ? String(data.ai_platform) : '',
        judge: data.judge ? String(data.judge) : '',
        status_reason: data.status_reason ? String(data.status_reason) : '',
        path: filePath,
      });
    } catch {
      // Skip non-skill folders (e.g. .git or folders without SKILL.md)
    }
  }
  return out;
}

function extractSection(body, headingRegex) {
  const lines = body.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRegex.test(lines[i].trim())) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return '';
  const collected = [];
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i].trim())) break;
    collected.push(lines[i]);
  }
  return collected.join('\n').trim();
}

function runDeterministicRubric(info) {
  const checks = [];
  const fm = info.frontmatter;

  const check = (id, pass, detail) => checks.push({ id, pass: Boolean(pass), detail });

  check('frontmatter_name_matches_dir', fm.name === info.skill, `frontmatter.name="${fm.name}" vs dir="${info.skill}"`);
  check('description_present', typeof fm.description === 'string' && fm.description.trim().length >= 12, 'non-empty description (>= 12 chars)');
  check('no_secrets_detected', findSecrets(info.body + '\n' + JSON.stringify(fm)).length === 0, 'no API keys/tokens/credentials');

  const whenSec = extractSection(info.body, /^##\s+(when to use|trigger|purpose)/i);
  const stepsSec = extractSection(info.body, /^##\s+(steps|procedure|workflow|how)/i);
  const guardSec = extractSection(info.body, /^##\s+(guardrails|rules|constraints|safety|limits)/i);
  const testSec = extractSection(info.body, /^##\s+(test card|verification|acceptance|evaluation)/i);

  check('when_to_use_present', whenSec.length >= 15, `length=${whenSec.length}`);
  check('steps_actionable', stepsSec.length >= 25 && (/(?:^|\n)\s*(?:1\.|-|\*)\s+/.test(stepsSec)), `length=${stepsSec.length}`);
  check('guardrails_present', guardSec.length >= 15, `length=${guardSec.length}`);
  check('test_card_present', testSec.length >= 15, `length=${testSec.length}`);

  // Check if test card describes an actual executed run (not merely "Not yet run" or future-tense "How it will be tested")
  const explicitlyNotRun = /\bnot\s+yet\s+run\b/i.test(testSec);
  const hasExecutedRun = !explicitlyNotRun && /\b(hand-run|run\s+by\s+hand|ran\s+(?:once|on|against|steps)|verified\s+(?:on|expected|against|with)|observed|reproduced|returned\s+http\s+\d{3}|exit\s+code\s+\d+)\b/i.test(testSec);
  check('test_card_exercised', hasExecutedRun, hasExecutedRun ? 'test card records an actual executed run' : 'test card has no executed run yet (future-tense or not yet run)');

  // Optional machine-checkable command in frontmatter (`test_command`)
  if (typeof fm.test_command === 'string' && fm.test_command.trim()) {
    const cmdRes = spawnSync(fm.test_command, { shell: true, encoding: 'utf8', timeout: 30000 });
    check('test_command_exit_0', cmdRes.status === 0, `exit=${cmdRes.status}`);
  }

  const failed = checks.filter((c) => !c.pass);
  return {
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    judge: 'deterministic-rubric-v1',
    judge_type: 'deterministic',
    checks,
    what_judge_ran: `Deterministic rubric (${checks.length} checks: frontmatter, secret scan, actionable steps, guardrails, test-card evidence${fm.test_command ? ', test_command' : ''}); ${checks.length - failed.length}/${checks.length} passed.`,
    summary: failed.length === 0
      ? `Passed all ${checks.length} deterministic rubric checks.`
      : `Failed ${failed.length} check(s): ${failed.map((f) => f.id).join(', ')}.`,
  };
}

function findAvailableCrossModelCli(authors, preferred) {
  const candidates = preferred && preferred !== 'auto'
    ? [preferred]
    : ['claude', 'codex', 'gemini'];

  for (const cli of candidates) {
    if (authors.some((a) => sameIdentity(a, cli))) continue;
    const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [cli], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim()) {
      return cli;
    }
  }
  return null;
}

function runCrossModelJudge(info, cliName) {
  const prompt = [
    'You are an independent RSI skill evaluator. Judge != author is strictly enforced.',
    'Evaluate the following skill and its Test card. Reply with ONLY valid JSON:',
    '{"verdict":"PASS"|"FAIL","reason":"one concise sentence","what_was_tested":"one concise sentence"}',
    'FAIL if the skill is vague prose without actionable steps, lacks guardrails, or its Test card has no concrete verification.',
    '---',
    `Skill: ${info.skill}`,
    info.body.slice(0, 6000),
  ].join('\n');

  let args;
  if (cliName === 'claude') args = ['-p', prompt];
  else if (cliName === 'codex') args = ['exec', prompt];
  else args = ['-p', prompt];

  const res = spawnSync(cliName, args, { encoding: 'utf8', timeout: 60000, shell: process.platform === 'win32' });
  if (res.error || res.status !== 0) {
    throw refusal(`Cross-model judge CLI "${cliName}" failed (exit ${res.status ?? 'error'}): ${(res.stderr || res.error?.message || '').trim().slice(0, 200)}`);
  }
  const rawOut = (res.stdout || '').trim();
  const match = rawOut.match(/\{[\s\S]*\}/);
  if (!match) {
    throw refusal(`Cross-model judge "${cliName}" did not return parseable JSON.`);
  }
  const parsed = JSON.parse(match[0]);
  const verdict = String(parsed.verdict || '').toUpperCase();
  if (verdict !== 'PASS' && verdict !== 'FAIL') {
    throw refusal(`Cross-model judge "${cliName}" returned invalid verdict "${parsed.verdict}".`);
  }
  return {
    verdict,
    judge: `${cliName}-cli`,
    judge_type: 'cross-model-cli',
    checks: [],
    what_judge_ran: parsed.what_was_tested || `Cross-model CLI evaluation via ${cliName}`,
    summary: parsed.reason || `${cliName} returned ${verdict}`,
  };
}

export async function evaluateSkill({ skill, skillsDir, evidenceDir, judge = 'auto', now = new Date() }) {
  const info = await showSkill({ skill, skillsDir });
  let result;

  if (judge === 'deterministic') {
    result = runDeterministicRubric(info);
  } else if (['claude', 'codex', 'gemini'].includes(judge)) {
    if (info.authors.some((a) => sameIdentity(a, judge))) {
      throw refusal(`Judge "${judge}" matches skill author (${info.authors.join(', ')}). Judge != author is enforced in code.`);
    }
    const cli = findAvailableCrossModelCli(info.authors, judge);
    if (!cli) {
      throw refusal(`Requested cross-model judge "${judge}" is not available on PATH. Unjudged draft stays draft.`);
    }
    result = runCrossModelJudge(info, cli);
  } else if (judge === 'auto') {
    // Run deterministic rubric first; if it passes and a cross-model CLI is requested explicitly, caller uses --judge <cli>.
    result = runDeterministicRubric(info);
  } else {
    throw usageError(`Unknown --judge "${judge}". Allowed: deterministic, claude, codex, gemini, auto.`);
  }

  // Double-check judge != author in code before emitting evidence
  if (info.authors.some((a) => sameIdentity(a, result.judge))) {
    throw refusal(`Judge "${result.judge}" matches skill author (${info.authors.join(', ')}). Judge != author is enforced in code.`);
  }

  await mkdir(evidenceDir, { recursive: true });
  const stamp = nowTaipeiIso(now);
  const fileStamp = stamp.slice(0, 19).replace(/[:T]/g, '-');
  const evidencePath = path.join(evidenceDir, `${skill}-${fileStamp}.json`);

  const record = {
    schema: 1,
    skill,
    skill_sha256: info.sha256,
    skill_author: info.author,
    skill_authors: info.authors,
    evaluated_at: stamp,
    judge: result.judge,
    judge_type: result.judge_type,
    verdict: result.verdict,
    summary: result.summary,
    what_judge_ran: result.what_judge_ran,
    checks: result.checks,
  };
  await writeFile(evidencePath, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return { ...record, evidence_path: evidencePath };
}

async function appendAuditAndLedger({ auditFile, stateDir, entry }) {
  await mkdir(path.dirname(auditFile), { recursive: true });
  await appendFile(auditFile, JSON.stringify(entry) + '\n', 'utf8');
  if (stateDir) {
    try {
      const ledger = createRsiLedger({ home: stateDir });
      const key = sha256Text(JSON.stringify(entry));
      await ledger.appendRsiEvidence('skill_state_change', {
        skill: entry.skill,
        from_state: entry.from_state,
        to_state: entry.to_state,
        actor: entry.actor,
        judge: entry.judge,
        timestamp: entry.timestamp,
      }, key);
    } catch {
      // Never block audit JSONL if optional BrainLink ledger mirror is unavailable
    }
  }
}

async function saveSnapshot(skillsDir, skill, label, rawContent, stamp) {
  const histDir = path.join(skillsDir, skill, '.rsi-history');
  await mkdir(histDir, { recursive: true });
  const safeStamp = stamp.slice(0, 19).replace(/[:T]/g, '-');
  const snapPath = path.join(histDir, `${safeStamp}-${label}.SKILL.md`);
  await writeFile(snapPath, rawContent, 'utf8');
  return snapPath;
}

export async function promoteSkill({
  skill,
  evidencePath,
  skillsDir,
  auditFile,
  stateDir,
  actor = 'Antigravity (Anna)',
  reason = '',
  syncClients = [],
  home = homedir(),
  now = new Date(),
}) {
  if (!evidencePath) {
    throw refusal('promote requires --evidence <path> pointing to a passing evaluation evidence file.');
  }
  const info = await showSkill({ skill, skillsDir });
  if (info.status === 'killed') {
    throw refusal(`Skill "${skill}" is in terminal state "killed" and cannot be promoted.`);
  }
  if (!LEGAL_TRANSITIONS[info.status]?.has('active')) {
    throw refusal(`Illegal transition: cannot promote "${skill}" from "${info.status}" to "active".`);
  }

  let ev;
  try {
    ev = JSON.parse(await readFile(evidencePath, 'utf8'));
  } catch {
    throw refusal(`Evidence file could not be read or parsed as JSON: ${evidencePath}`);
  }
  if (ev.skill && ev.skill !== skill) {
    throw refusal(`Evidence file is for skill "${ev.skill}", not "${skill}".`);
  }
  if (String(ev.verdict || '').toUpperCase() !== 'PASS') {
    throw refusal(`Evidence verdict is "${ev.verdict || 'MISSING'}"; promote requires verdict PASS.`);
  }
  if (!ev.judge || typeof ev.judge !== 'string' || !ev.judge.trim()) {
    throw refusal('Evidence file is missing judge identity.');
  }
  if (info.authors.some((a) => sameIdentity(a, ev.judge))) {
    throw refusal(`Judge "${ev.judge}" matches author (${info.authors.join(', ')}). Judge != author is enforced in code.`);
  }

  const rawBefore = await readFile(info.path, 'utf8');
  const { data, body, eol } = splitFrontmatter(rawBefore);
  const stamp = nowTaipeiIso(now);

  // Save pre-promotion snapshot for rollback
  const snapshotBefore = await saveSnapshot(skillsDir, skill, `pre-active-from-${info.status}`, rawBefore, stamp);

  const finalReason = reason || ev.summary || `Promoted with PASS evidence from ${ev.judge}`;
  data.status = 'active';
  data.status_reason = finalReason;
  data.status_changed_at = stamp;
  data.status_changed_by = actor;
  data.judge = ev.judge;
  data.evidence_path = evidencePath;

  const rawAfter = renderFrontmatter(data, body, eol);
  await writeFile(info.path, rawAfter, 'utf8');

  const auditEntry = {
    timestamp: stamp,
    skill,
    from_state: info.status,
    to_state: 'active',
    actor,
    judge: ev.judge,
    evidence_path: evidencePath,
    reason: finalReason,
    snapshot_before: snapshotBefore,
    sha256_before: sha256Text(rawBefore),
    sha256_after: sha256Text(rawAfter),
  };
  await appendAuditAndLedger({ auditFile, stateDir, entry: auditEntry });

  let syncResult = null;
  if (syncClients.length) {
    syncResult = await syncActiveSkills({ skillsDir, clients: syncClients, stateDir, home });
  }
  return { ...auditEntry, sync: syncResult };
}

export async function holdSkill({
  skill,
  reason,
  condition,
  skillsDir,
  auditFile,
  stateDir,
  actor = 'Antigravity (Anna)',
  judge = 'none',
  evidencePath = '',
  now = new Date(),
}) {
  if (!reason || !String(reason).trim()) throw usageError('hold requires --reason <text>.');
  if (!condition || !String(condition).trim()) throw usageError('hold requires --condition <text>.');

  const info = await showSkill({ skill, skillsDir });
  if (info.status === 'killed') {
    throw refusal(`Skill "${skill}" is in terminal state "killed" and cannot be held.`);
  }
  if (!LEGAL_TRANSITIONS[info.status]?.has('held')) {
    throw refusal(`Illegal transition: cannot hold "${skill}" from "${info.status}".`);
  }

  const rawBefore = await readFile(info.path, 'utf8');
  const { data, body, eol } = splitFrontmatter(rawBefore);
  const stamp = nowTaipeiIso(now);
  const fullReason = `${reason.trim()} [condition: ${condition.trim()}]`;

  data.status = 'held';
  data.status_reason = fullReason;
  data.status_changed_at = stamp;
  data.status_changed_by = actor;
  data.judge = judge;
  data.evidence_path = evidencePath;

  const rawAfter = renderFrontmatter(data, body, eol);
  await writeFile(info.path, rawAfter, 'utf8');

  const auditEntry = {
    timestamp: stamp,
    skill,
    from_state: info.status,
    to_state: 'held',
    actor,
    judge,
    evidence_path: evidencePath,
    reason: fullReason,
    sha256_before: sha256Text(rawBefore),
    sha256_after: sha256Text(rawAfter),
  };
  await appendAuditAndLedger({ auditFile, stateDir, entry: auditEntry });
  return auditEntry;
}

export async function killSkill({
  skill,
  reason,
  skillsDir,
  auditFile,
  stateDir,
  actor = 'Antigravity (Anna)',
  judge = 'none',
  evidencePath = '',
  now = new Date(),
}) {
  if (!reason || !String(reason).trim()) throw usageError('kill requires --reason <text>.');

  const info = await showSkill({ skill, skillsDir });
  if (info.status === 'killed') {
    throw refusal(`Skill "${skill}" is already "killed".`);
  }
  if (!LEGAL_TRANSITIONS[info.status]?.has('killed')) {
    throw refusal(`Illegal transition: cannot kill "${skill}" from "${info.status}".`);
  }

  const rawBefore = await readFile(info.path, 'utf8');
  const { data, body, eol } = splitFrontmatter(rawBefore);
  const stamp = nowTaipeiIso(now);

  await saveSnapshot(skillsDir, skill, `pre-killed-from-${info.status}`, rawBefore, stamp);

  data.status = 'killed';
  data.status_reason = reason.trim();
  data.status_changed_at = stamp;
  data.status_changed_by = actor;
  data.judge = judge;
  data.evidence_path = evidencePath;

  const rawAfter = renderFrontmatter(data, body, eol);
  await writeFile(info.path, rawAfter, 'utf8');

  const auditEntry = {
    timestamp: stamp,
    skill,
    from_state: info.status,
    to_state: 'killed',
    actor,
    judge,
    evidence_path: evidencePath,
    reason: reason.trim(),
    sha256_before: sha256Text(rawBefore),
    sha256_after: sha256Text(rawAfter),
  };
  await appendAuditAndLedger({ auditFile, stateDir, entry: auditEntry });
  return auditEntry;
}

export async function rollbackSkill({
  skill,
  skillsDir,
  auditFile,
  stateDir,
  actor = 'Antigravity (Anna)',
  reason = 'Rollback to previous known-good version',
  syncClients = [],
  home = homedir(),
  now = new Date(),
}) {
  const info = await showSkill({ skill, skillsDir });
  if (info.status !== 'active') {
    throw refusal(`rollback only applies to "active" skills; "${skill}" is "${info.status}".`);
  }

  const histDir = path.join(skillsDir, skill, '.rsi-history');
  let snapshots = [];
  try {
    snapshots = (await readdir(histDir))
      .filter((f) => f.endsWith('.SKILL.md') && !f.includes('superseded-active'))
      .sort();
  } catch {
    snapshots = [];
  }
  if (!snapshots.length) {
    throw refusal(`No previous version snapshot found in ${histDir} to roll back "${skill}".`);
  }

  const latestPrev = path.join(histDir, snapshots[snapshots.length - 1]);
  const rawBefore = await readFile(info.path, 'utf8');
  const prevRaw = await readFile(latestPrev, 'utf8');
  const stamp = nowTaipeiIso(now);

  // Keep the superseded active version in history — nothing is ever deleted
  const supersededPath = await saveSnapshot(skillsDir, skill, 'superseded-active', rawBefore, stamp);

  const { data: prevData, body: prevBody, eol } = splitFrontmatter(prevRaw);
  const restoredState = String(prevData.status || 'draft').trim().toLowerCase();
  prevData.status_reason = `Rolled back from active: ${reason}`;
  prevData.status_changed_at = stamp;
  prevData.status_changed_by = actor;

  const restoredRaw = renderFrontmatter(prevData, prevBody, eol);
  await writeFile(info.path, restoredRaw, 'utf8');

  const auditEntry = {
    timestamp: stamp,
    skill,
    from_state: 'active',
    to_state: restoredState,
    actor,
    judge: info.frontmatter.judge || 'none',
    evidence_path: supersededPath,
    reason,
    restored_from: latestPrev,
    superseded_snapshot: supersededPath,
    sha256_before: sha256Text(rawBefore),
    sha256_after: sha256Text(restoredRaw),
  };
  await appendAuditAndLedger({ auditFile, stateDir, entry: auditEntry });

  let syncResult = null;
  if (syncClients.length) {
    syncResult = await syncActiveSkills({ skillsDir, clients: syncClients, stateDir, home });
  }
  return { ...auditEntry, sync: syncResult };
}

export async function readAuditLog({ auditFile, since } = {}) {
  let raw;
  try {
    raw = await readFile(auditFile, 'utf8');
  } catch {
    return [];
  }
  const rows = raw.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  if (!since) return rows;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw usageError(`Invalid --since "${since}". Expected YYYY-MM-DD.`);
  }
  return rows.filter((r) => String(r.timestamp || '').slice(0, 10) >= since);
}

export async function checkCapsFromLogs({
  runDate,
  logsDir,
  maxCards = DEFAULT_MAX_CARDS,
  maxSkills = DEFAULT_MAX_SKILLS,
}) {
  if (!runDate || !/^\d{4}-\d{2}-\d{2}$/.test(runDate)) {
    throw usageError('caps requires --run-date YYYY-MM-DD.');
  }
  const logFile = path.join(logsDir, `${runDate}.md`);
  let raw;
  try {
    raw = await readFile(logFile, 'utf8');
  } catch {
    throw refusal(`Distill log not found for ${runDate}: ${logFile}`);
  }

  const runs = [];
  const countRegex = /Counts:\s*(\d+)\s+cards?,\s*(\d+)\s+(?:draft\s+)?skills?/gi;
  let m;
  let idx = 1;
  while ((m = countRegex.exec(raw)) !== null) {
    const cards = Number(m[1]);
    const skills = Number(m[2]);
    const pass = cards <= maxCards && skills <= maxSkills;
    runs.push({
      run: idx++,
      cards,
      skills,
      max_cards: maxCards,
      max_skills: maxSkills,
      pass,
      reason: pass
        ? `OK (${cards}/${maxCards} cards, ${skills}/${maxSkills} skills)`
        : `CAP OVERRUN: ${cards} cards (max ${maxCards}), ${skills} skills (max ${maxSkills})`,
    });
  }

  if (!runs.length) {
    // Fallback: count bullet items directly
    const cards = (raw.match(/^- \[card\]/gm) || []).length;
    const skills = (raw.match(/^- \[skill\]/gm) || []).length;
    const pass = cards <= maxCards && skills <= maxSkills;
    runs.push({
      run: 1,
      cards,
      skills,
      max_cards: maxCards,
      max_skills: maxSkills,
      pass,
      reason: pass
        ? `OK (${cards}/${maxCards} cards, ${skills}/${maxSkills} skills)`
        : `CAP OVERRUN: ${cards} cards (max ${maxCards}), ${skills} skills (max ${maxSkills})`,
    });
  }

  const allPass = runs.every((r) => r.pass);
  return {
    run_date: runDate,
    log_file: logFile,
    max_cards: maxCards,
    max_skills: maxSkills,
    pass: allPass,
    runs,
  };
}

export async function precheckCaps({
  runDate,
  cards,
  skills,
  skillsDir,
  maxCards = DEFAULT_MAX_CARDS,
  maxSkills = DEFAULT_MAX_SKILLS,
  maxDrafts = DEFAULT_MAX_DRAFTS,
  demandSignal = false,
}) {
  if (!runDate || !/^\d{4}-\d{2}-\d{2}$/.test(runDate)) {
    throw usageError('caps --precheck requires --run-date YYYY-MM-DD.');
  }
  const c = Number(cards);
  const s = Number(skills);
  if (!Number.isInteger(c) || c < 0 || !Number.isInteger(s) || s < 0) {
    throw usageError('caps --precheck requires non-negative integer --cards N and --skills M.');
  }
  if (c > maxCards) {
    return {
      pass: false,
      run_date: runDate,
      reason: `REFUSED: card cap exceeded (${c} > ${maxCards}) for ${runDate}.`,
    };
  }
  if (s > maxSkills) {
    return {
      pass: false,
      run_date: runDate,
      reason: `REFUSED: skill cap exceeded (${s} > ${maxSkills}) for ${runDate}.`,
    };
  }
  if (skillsDir && s > 0 && !demandSignal) {
    const drafts = await listSkills({ skillsDir, state: 'draft' });
    if (drafts.length > maxDrafts) {
      return {
        pass: false,
        run_date: runDate,
        draft_backlog: drafts.length,
        reason: `REFUSED: backlog circuit breaker active (${drafts.length} unjudged drafts > max ${maxDrafts}); triage drafts or pass --demand-signal.`,
      };
    }
  }
  return {
    pass: true,
    run_date: runDate,
    reason: `OK: ${c}/${maxCards} cards, ${s}/${maxSkills} skills permitted for ${runDate}.`,
  };
}

export async function syncActiveSkills({ skillsDir, clients = ['antigravity'], stateDir, home = homedir(), env = process.env }) {
  const active = await listSkills({ skillsDir, state: 'active' });
  const stageRoot = await mkdtemp(path.join(tmpdir(), 'brainlink-active-skills-'));
  try {
    for (const item of active) {
      const destDir = path.join(stageRoot, item.skill);
      await mkdir(destDir, { recursive: true });
      await cp(item.path, path.join(destDir, 'SKILL.md'));
    }
    const results = [];
    if (active.length > 0) {
      for (const client of clients) {
        const res = await installAgentSkills({ client, sourceRoot: stageRoot, stateDir, home, env });
        results.push({ client, ...res });
      }
    }
    return { active_count: active.length, active_skills: active.map((a) => a.skill), results };
  } finally {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
  }
}
