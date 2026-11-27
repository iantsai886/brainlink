#!/usr/bin/env node
// BrainLink RSI Promotion Gate CLI (`rsi-gate` / `brainlink rsi`).
// Exit codes: 0 = ok, 1 = refusal (rules not met), 2 = usage error.
import path from 'node:path';
import { appHome } from '../src/config.mjs';
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
  syncActiveSkills,
  RsiGateError,
  usageError,
} from '../src/rsi-gate.mjs';

const DEFAULT_SKILLS_DIR = process.env.RSI_SKILLS_DIR || 'G:\\My Drive\\Obsidian\\Brain\\60 Skills';
const DEFAULT_LOGS_DIR = process.env.RSI_LOGS_DIR || 'G:\\My Drive\\Obsidian\\Brain\\50 Knowledge\\_log';

const HELP = `rsi-gate — BrainLink RSI promotion gate & skill lifecycle CLI

Usage:
  rsi-gate list [--state draft|active|held|killed] [--skills-dir DIR] [--json]
  rsi-gate show <skill> [--skills-dir DIR] [--json]
  rsi-gate evaluate <skill> [--judge deterministic|claude|codex|gemini|auto] [--evidence-dir DIR] [--skills-dir DIR]
  rsi-gate promote <skill> --evidence <path> [--actor NAME] [--reason TEXT] [--sync-clients LIST]
  rsi-gate hold <skill> --reason <text> --condition <text> [--actor NAME]
  rsi-gate kill <skill> --reason <text> [--actor NAME]
  rsi-gate rollback <skill> [--actor NAME] [--reason TEXT] [--sync-clients LIST]
  rsi-gate audit [--since YYYY-MM-DD] [--audit-file FILE] [--json]
  rsi-gate caps --run-date YYYY-MM-DD [--logs-dir DIR]
  rsi-gate caps --precheck --run-date YYYY-MM-DD --cards N --skills M [--skills-dir DIR] [--max-drafts 20] [--demand-signal]
  rsi-gate sync [--clients antigravity,claude-code,codex,gemini,hermes] [--skills-dir DIR]

Exit codes: 0 ok, 1 refusal (rules not met), 2 usage error.`;

export async function runRsiGateCli(argv) {
  const cmd = argv[0];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP + '\n');
    return 0;
  }

  const flag = (name) => argv.includes(`--${name}`);
  const opt = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return dflt;
    const val = argv[i + 1];
    return val === undefined || val.startsWith('--') ? dflt : val;
  };
  const positional = (idx) => {
    const val = argv[idx];
    return !val || val.startsWith('--') ? '' : val;
  };

  const skillsDir = path.resolve(opt('skills-dir', DEFAULT_SKILLS_DIR));
  const logsDir = path.resolve(opt('logs-dir', DEFAULT_LOGS_DIR));
  const stateDir = path.resolve(opt('state-dir', path.join(appHome(), 'rsi-gate')));
  const evidenceDir = path.resolve(opt('evidence-dir', path.join(stateDir, 'evidence')));
  const auditFile = path.resolve(opt('audit-file', path.join(stateDir, 'rsi-gate-audit.jsonl')));
  const actor = opt('actor', 'Antigravity (Anna)');
  const asJson = flag('json');
  const syncClients = opt('sync-clients', '').split(',').map((s) => s.trim()).filter(Boolean);

  switch (cmd) {
    case 'list': {
      const state = opt('state', '');
      const rows = await listSkills({ skillsDir, state: state || undefined });
      if (asJson) {
        process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      } else {
        for (const r of rows) {
          process.stdout.write(`${r.status.padEnd(7)} ${r.date.padEnd(11)} ${r.skill}\n`);
        }
        process.stdout.write(`Total: ${rows.length}\n`);
      }
      return 0;
    }
    case 'show': {
      const skill = positional(1);
      if (!skill) throw usageError('show requires <skill>.');
      const info = await showSkill({ skill, skillsDir });
      if (asJson) {
        process.stdout.write(JSON.stringify(info, null, 2) + '\n');
      } else {
        process.stdout.write(`Skill:   ${info.skill}\nStatus:  ${info.status}\nDate:    ${info.date}\nAuthor:  ${info.author}\nVersion: ${info.version}\nPath:    ${info.path}\n`);
        if (info.frontmatter.judge) process.stdout.write(`Judge:   ${info.frontmatter.judge}\n`);
        if (info.frontmatter.status_reason) process.stdout.write(`Reason:  ${info.frontmatter.status_reason}\n`);
        if (info.frontmatter.evidence_path) process.stdout.write(`Evidence:${info.frontmatter.evidence_path}\n`);
      }
      return 0;
    }
    case 'evaluate': {
      const skill = positional(1);
      if (!skill) throw usageError('evaluate requires <skill>.');
      const judge = opt('judge', 'auto');
      const res = await evaluateSkill({ skill, skillsDir, evidenceDir, judge });
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      return res.verdict === 'PASS' ? 0 : 1;
    }
    case 'promote': {
      const skill = positional(1);
      if (!skill) throw usageError('promote requires <skill>.');
      const evidencePath = opt('evidence', '');
      const reason = opt('reason', '');
      const res = await promoteSkill({ skill, evidencePath, skillsDir, auditFile, stateDir, actor, reason, syncClients });
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      return 0;
    }
    case 'hold': {
      const skill = positional(1);
      if (!skill) throw usageError('hold requires <skill>.');
      const reason = opt('reason', '');
      const condition = opt('condition', '');
      const judge = opt('judge', 'none');
      const evidencePath = opt('evidence', '');
      const res = await holdSkill({ skill, reason, condition, skillsDir, auditFile, stateDir, actor, judge, evidencePath });
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      return 0;
    }
    case 'kill': {
      const skill = positional(1);
      if (!skill) throw usageError('kill requires <skill>.');
      const reason = opt('reason', '');
      const judge = opt('judge', 'none');
      const evidencePath = opt('evidence', '');
      const res = await killSkill({ skill, reason, skillsDir, auditFile, stateDir, actor, judge, evidencePath });
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      return 0;
    }
    case 'rollback': {
      const skill = positional(1);
      if (!skill) throw usageError('rollback requires <skill>.');
      const reason = opt('reason', 'Rollback to previous known-good version');
      const res = await rollbackSkill({ skill, skillsDir, auditFile, stateDir, actor, reason, syncClients });
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      return 0;
    }
    case 'audit': {
      const since = opt('since', '');
      const rows = await readAuditLog({ auditFile, since: since || undefined });
      if (asJson) {
        process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      } else {
        for (const r of rows) {
          process.stdout.write(`${r.timestamp} | ${r.skill} | ${r.from_state} -> ${r.to_state} | actor=${r.actor} | judge=${r.judge} | ${r.reason}\n`);
        }
      }
      return 0;
    }
    case 'caps': {
      const runDate = opt('run-date', '');
      const maxCards = Number(opt('max-cards', '5'));
      const maxSkills = Number(opt('max-skills', '2'));
      if (flag('precheck')) {
        const cards = opt('cards', '');
        const skills = opt('skills', '');
        const maxDrafts = Number(opt('max-drafts', '20'));
        const demandSignal = flag('demand-signal');
        const checkSkillsDir = argv.includes('--skills-dir') ? skillsDir : undefined;
        const res = await precheckCaps({ runDate, cards, skills, skillsDir: checkSkillsDir, maxCards, maxSkills, maxDrafts, demandSignal });
        process.stdout.write(res.reason + '\n');
        return res.pass ? 0 : 1;
      }
      const report = await checkCapsFromLogs({ runDate, logsDir, maxCards, maxSkills });
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return report.pass ? 0 : 1;
    }
    case 'sync': {
      const clients = opt('clients', 'antigravity').split(',').map((s) => s.trim()).filter(Boolean);
      const res = await syncActiveSkills({ skillsDir, clients, stateDir });
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      return 0;
    }
    default:
      throw usageError(`Unknown command "${cmd}". Run "rsi-gate help" for usage.`);
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('bin', 'rsi-gate.mjs'));
if (isDirect) {
  runRsiGateCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      if (err instanceof RsiGateError) {
        process.stderr.write(err.message + '\n');
        process.exit(err.exitCode);
      }
      process.stderr.write(`rsi-gate: ${err?.message || err}\n`);
      process.exit(1);
    },
  );
}
