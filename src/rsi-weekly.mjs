// BrainLink RSI retrieval miss and weekly benchmark evidence; backed by the existing RSI ledger.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRsiLedger } from './rsi-ledger.mjs';
import { evaluateRetrieval } from './retrieval-eval.mjs';
import { findSecrets } from './core.mjs';

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fixes = new Set(['file_missing_fact', 'replace_stale_note', 'add_link', 'add_index_entry', 'other']);
const results = new Set(['found', 'not_found', 'stale']);
const normalized = value => value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
const dayPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?([+-]\d{2}:\d{2})$/;
const validDate = value => typeof value === 'string' && dayPattern.test(value) && !Number.isNaN(Date.parse(value));
const validWeek = value => {
  if (typeof value !== 'string' || !/^(\d{4})-W(\d{2})$/.test(value)) return false;
  const [, y, w] = value.match(/^(\d{4})-W(\d{2})$/);
  const d = new Date(Date.UTC(Number(y), 0, 4));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + (Number(w) - 1) * 7);
  return isoWeek(d) === value;
};
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const year = d.getUTCFullYear(), start = new Date(Date.UTC(year, 0, 1));
  return `${year}-W${String(Math.ceil(((d - start) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}
export const taipeiWeek = value => {
  const date = new Date(value);
  return isoWeek(new Date(date.getTime() + 8 * 3600000));
};
export function validateMiss(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('Miss must be an object.');
  if (!validDate(m.date)) throw new Error('date must be valid ISO +08:00 with seconds.');
  for (const k of ['profile', 'agent', 'question']) if (typeof m[k] !== 'string' || !m[k].trim() || m[k].length > (k === 'question' ? 500 : 100)) throw new Error(`Invalid ${k}.`);
  if (!results.has(m.result)) throw new Error('Invalid result.');
  if (!Number.isFinite(m.seconds) || m.seconds < 0 || m.seconds > 86400) throw new Error('Invalid seconds.');
  if (!fixes.has(m.fix_needed)) throw new Error('Invalid fix_needed.');
  let fixed_by;
  if (m.fixed_by !== undefined) {
    const f = m.fixed_by;
    if (!f || typeof f !== 'object' || Array.isArray(f) || typeof f.agent !== 'string' || !f.agent.trim() || f.agent.length > 100 || !validDate(f.date) || typeof f.note !== 'string' || !f.note.trim() || f.note.length > 500) throw new Error('Invalid fixed_by.');
    fixed_by = { agent: f.agent.trim(), date: f.date, note: f.note.trim() };
  }
  if (findSecrets(JSON.stringify({ ...m, question: m.question })).length || /<(?:script|iframe)\b/i.test(m.question)) throw new Error('Miss contains sensitive content.');
  const out = { date: m.date, profile: m.profile.trim(), agent: m.agent.trim(), question_sha256: sha(normalized(m.question)), result: m.result, seconds: m.seconds, fix_needed: m.fix_needed, ...(fixed_by ? { fixed_by } : {}) };
  if (findSecrets(JSON.stringify(out)).length || /<(?:script|iframe)\b/i.test(JSON.stringify(out))) throw new Error('Miss contains sensitive content.');
  return out;
}
export function createRsiWeekly({ home, now = () => new Date() }) {
  const ledger = createRsiLedger({ home, now });
  return {
    async addMiss(input) {
      const miss = validateMiss(input);
      const key = sha(miss);
      return { ...await ledger.appendRsiEvidence('retrieval_miss', miss, key), key };
    },
    async listMisses(profile, week) {
      if (typeof profile !== 'string' || !profile.trim()) throw new Error('A profile is required to keep Personal, Organisation and Client evidence separate.');
      const all = await ledger.listRsiEvidence('retrieval_miss');
      return all.filter(m => m.profile === profile && (!week || taipeiWeek(m.date) === week)).map(m => ({ ...m, week: taipeiWeek(m.date) }));
    },
    async aggregateMisses(profile, week) {
      const misses = await this.listMisses(profile, week), by_week = {}, by_fix_needed = {}, groups = {};
      for (const m of misses) {
        by_week[m.week] = (by_week[m.week] || 0) + 1;
        by_fix_needed[m.fix_needed] = (by_fix_needed[m.fix_needed] || 0) + 1;
        (groups[m.question_sha256] ||= []).push(m.key);
      }
      return { total: misses.length, by_week, by_fix_needed, groups };
    },
    async importMarkdown(file) {
      const raw = await readFile(file, 'utf8');
      const lines = raw.split(/\r?\n/).filter(line => /^\|/.test(line.trim()));
      const expected = ['date', 'profile', 'agent', 'question', 'result (found/not found/stale)', 'seconds', 'fix needed', 'fixed by'];
      if (!lines.length || JSON.stringify(lines[0].split('|').slice(1, -1).map(s => s.trim().toLowerCase())) !== JSON.stringify(expected)) throw new Error('Unexpected miss-log Markdown columns.');
      let added = 0, skipped = 0;
      for (const line of lines.slice(1)) {
        const cells = line.split('|').slice(1, -1).map(s => s.trim());
        if (cells.every(v => /^:?-+:?$/.test(v))) continue;
        if (cells.length !== 8) throw new Error('Invalid Markdown miss row.');
        const [date, profile, agent, question, result, seconds, fix, fixed] = cells;
        const fixNames = { 'file missing fact': 'file_missing_fact', 'replace stale note': 'replace_stale_note', 'add link': 'add_link', 'add 00 index entry': 'add_index_entry', other: 'other' };
        const normalizedResult = { 'not found': 'not_found', found: 'found', stale: 'stale' }[result.toLowerCase()];
        const dateValue = /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00+08:00` : date;
        let fixed_by;
        if (fixed) {
          const parts = fixed.split(/\s*;\s*/);
          if (parts.length !== 3) throw new Error('fixed by must be agent; ISO date; note.');
          fixed_by = { agent: parts[0], date: /^\d{4}-\d{2}-\d{2}$/.test(parts[1]) ? `${parts[1]}T00:00:00+08:00` : parts[1], note: parts[2] };
        }
        const outcome = await this.addMiss({ date: dateValue, profile, agent, question, result: normalizedResult, seconds: Number(seconds), fix_needed: fixNames[fix.toLowerCase()] || fix, ...(fixed_by ? { fixed_by } : {}) });
        if (outcome.added) added++; else skipped++;
      }
      return { added, skipped };
    },
    async runBenchmark({ ctx, fixture, fixtureBytes, week = taipeiWeek(now().toISOString()) }) {
      if (!validWeek(week) || fixture.schema !== 2 || fixture.cases?.length !== 20) throw new Error('Weekly benchmark requires a schema-2 fixture of exactly 20 cases and valid week.');
      const report = await evaluateRetrieval(ctx, fixture, { fixtureBytes });
      const score = report.baseline.task_success.count / 20;
      const evidence = { week, fixture_sha256: report.fixture_sha256, evaluator_version: report.evaluator_version, case_count: 20, first_try_correct: { count: report.baseline.task_success.count, total: 20, percent: +(100 * score).toFixed(1) }, privacy_violations: report.baseline.privacy_violations, failed_case_count: report.baseline.failures.length };
      const saved = await ledger.appendRsiEvidence('weekly_benchmark', evidence, sha({ week, fixture_sha256: evidence.fixture_sha256, evaluator_version: evidence.evaluator_version }));
      return { ...evidence, recorded: saved.added };
    },
    async benchmarkReport(weeks = 8) {
      if (!Number.isInteger(weeks) || weeks < 1 || weeks > 104) throw new Error('weeks must be 1–104.');
      const all = await ledger.listRsiEvidence('weekly_benchmark');
      const byWeek = new Map();
      for (const run of all) byWeek.set(run.week, run);
      const selected = [...byWeek.values()].sort((a,b) => a.week.localeCompare(b.week)).slice(-weeks);
      return selected.map((run, i) => ({ ...run, delta_pp: i ? +(run.first_try_correct.percent - selected[i-1].first_try_correct.percent).toFixed(1) : null }));
    },
  };
}
