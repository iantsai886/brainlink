// Append-only verbatim Errata JSONL ledger + budgeted HillClimb RSI loop.
// Zero-invention capture rule: verbatim_text is stored in the user's exact words
// with no AI paraphrasing and no fabricated ratings/tags at capture time.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { appHome } from './config.mjs';
import { findSecrets } from './core.mjs';
import { createRsiLedger } from './rsi-ledger.mjs';
import { nowTaipeiIso, refusal, usageError } from './rsi-gate.mjs';

export const ERRATA_KINDS = Object.freeze(['complaint', 'bug', 'miss', 'feature', 'praise']);
export const ERRATA_STATUSES = Object.freeze(['open', 'triaged', 'resolved']);
const KIND_SET = new Set(ERRATA_KINDS);
const STATUS_SET = new Set(ERRATA_STATUSES);
const FORBIDDEN_CAPTURE_KEYS = new Set(['rating', 'ratings', 'score', 'severity_score', 'tags', 'ai_summary', 'paraphrase']);

export function defaultErrataPath(env = process.env) {
  return path.join(appHome(env), 'errata.jsonl');
}

function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export async function appendErrata(input, { file = defaultErrataPath(), now = new Date() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw usageError('errata entry must be an object.');
  }
  for (const forbidden of Object.keys(input)) {
    if (FORBIDDEN_CAPTURE_KEYS.has(forbidden)) {
      throw refusal(`Zero-invention capture rule: "${forbidden}" cannot be fabricated at errata capture time.`);
    }
  }
  const kind = String(input.kind || '').trim().toLowerCase();
  if (!KIND_SET.has(kind)) {
    throw usageError(`Invalid errata kind "${input.kind}". Allowed: ${ERRATA_KINDS.join(', ')}.`);
  }
  if (typeof input.verbatim_text !== 'string' || input.verbatim_text.trim().length === 0) {
    throw usageError('errata requires non-empty verbatim_text in the user\'s exact words.');
  }
  if (findSecrets(input.verbatim_text).length > 0) {
    throw refusal('Potential secret detected in errata verbatim_text; remove it before recording.');
  }
  const contextRefs = Array.isArray(input.context_refs)
    ? input.context_refs.map((r) => String(r)).filter(Boolean).slice(0, 20)
    : [];

  const entry = {
    event: 'capture',
    id: `ERR-${nowTaipeiIso(now).slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8)}`,
    timestamp: nowTaipeiIso(now),
    session_id: String(input.session_id || '').trim(),
    ai_platform: String(input.ai_platform || 'unknown').trim(),
    agent: String(input.agent || 'unknown').trim(),
    kind,
    // Exact verbatim preservation: never trim, rewrite, or paraphrase.
    verbatim_text: input.verbatim_text,
    context_refs: contextRefs,
    status: 'open',
  };

  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

export async function readErrataRaw(file = defaultErrataPath()) {
  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  return raw.split(/\r?\n/).filter((l) => l.trim()).map((line, idx) => {
    try { return JSON.parse(line); }
    catch { throw refusal(`Errata ledger damaged at line ${idx + 1}.`); }
  });
}

export async function listErrata({ file = defaultErrataPath(), status, kind } = {}) {
  if (status && !STATUS_SET.has(status)) {
    throw usageError(`Invalid status "${status}". Allowed: ${ERRATA_STATUSES.join(', ')}.`);
  }
  if (kind && !KIND_SET.has(kind)) {
    throw usageError(`Invalid kind "${kind}". Allowed: ${ERRATA_KINDS.join(', ')}.`);
  }
  const events = await readErrataRaw(file);
  const byId = new Map();
  for (const ev of events) {
    if (ev.event === 'status_change' && ev.id && byId.has(ev.id)) {
      const prev = byId.get(ev.id);
      byId.set(ev.id, {
        ...prev,
        status: ev.status,
        updated_at: ev.timestamp,
        ...(ev.note ? { triage_note: ev.note } : {}),
      });
    } else if (ev.id) {
      byId.set(ev.id, {
        id: ev.id,
        timestamp: ev.timestamp,
        session_id: ev.session_id || '',
        ai_platform: ev.ai_platform || 'unknown',
        agent: ev.agent || 'unknown',
        kind: ev.kind,
        verbatim_text: ev.verbatim_text,
        context_refs: Array.isArray(ev.context_refs) ? ev.context_refs : [],
        status: ev.status || 'open',
      });
    }
  }
  let rows = [...byId.values()];
  if (status) rows = rows.filter((r) => r.status === status);
  if (kind) rows = rows.filter((r) => r.kind === kind);
  return rows;
}

export async function triageErrata({ id, status, note = '', file = defaultErrataPath(), now = new Date() } = {}) {
  if (!id || !String(id).trim()) throw usageError('triage requires an errata <id>.');
  if (!STATUS_SET.has(status)) throw usageError(`Invalid status "${status}". Allowed: ${ERRATA_STATUSES.join(', ')}.`);
  const rows = await listErrata({ file });
  const existing = rows.find((r) => r.id === id);
  if (!existing) throw refusal(`Errata entry "${id}" not found in ${file}.`);
  if (note && findSecrets(note).length > 0) {
    throw refusal('Potential secret detected in triage note.');
  }
  const ev = {
    event: 'status_change',
    id,
    timestamp: nowTaipeiIso(now),
    from_status: existing.status,
    status,
    ...(note ? { note: String(note).trim().slice(0, 500) } : {}),
  };
  await appendFile(file, JSON.stringify(ev) + '\n', 'utf8');
  return { ...existing, status, updated_at: ev.timestamp, ...(ev.note ? { triage_note: ev.note } : {}) };
}

// Budgeted HillClimb RSI loop driven strictly by real open errata entries (never invented drafts).
// Runs at most `budget` bounded candidate experiments, stops on budget exhaustion or plateau,
// and records every attempt in the append-only BrainLink RSI ledger before any promotion proposal.
export async function runHillClimbFromErrata({
  errataFile = defaultErrataPath(),
  budget = 3,
  maxNoImprove = 2,
  evaluateCandidate = null,
  stateDir = path.join(appHome(), 'rsi-gate'),
  now = new Date(),
} = {}) {
  const maxBudget = Number(budget);
  if (!Number.isInteger(maxBudget) || maxBudget < 1 || maxBudget > 50) {
    throw usageError('HillClimb requires an integer --budget between 1 and 50.');
  }
  const plateauLimit = Math.max(1, Number(maxNoImprove) || 2);

  const openItems = await listErrata({ file: errataFile, status: 'open' });
  const actionable = openItems.filter((item) => item.kind !== 'praise');
  if (actionable.length === 0) {
    return {
      schema: 1,
      run_at: nowTaipeiIso(now),
      source: 'errata',
      errata_file: errataFile,
      budget: maxBudget,
      attempted: 0,
      stop_reason: 'queue_empty',
      best_candidate: null,
      attempts: [],
    };
  }

  const ledger = stateDir ? createRsiLedger({ home: stateDir }) : null;
  const attempts = [];
  let bestScore = -Infinity;
  let bestCandidate = null;
  let noImproveStreak = 0;
  let stopReason = 'queue_empty';

  for (let i = 0; i < actionable.length; i++) {
    if (attempts.length >= maxBudget) {
      stopReason = 'budget_exhausted';
      break;
    }
    const item = actionable[i];
    const attemptIndex = attempts.length + 1;
    let evalResult;
    if (typeof evaluateCandidate === 'function') {
      try {
        evalResult = await evaluateCandidate(item, { attempt: attemptIndex, bestScore });
      } catch (err) {
        evalResult = { status: 'UNMEASURED', score: null, reason: err?.message || 'candidate eval error' };
      }
    } else {
      // Deterministic dry evaluation when no external evaluator is supplied (no-LLM hot path).
      evalResult = {
        status: 'UNMEASURED',
        score: null,
        candidate_id: `cand-${item.id}`,
        reason: 'No held-out evaluator provided; recorded as UNMEASURED.',
      };
    }

    const score = typeof evalResult?.score === 'number' && Number.isFinite(evalResult.score) ? evalResult.score : null;
    const status = String(evalResult?.status || (score !== null ? 'MEASURED' : 'UNMEASURED')).toUpperCase();
    const improved = status !== 'UNMEASURED' && score !== null && score > bestScore;

    if (improved) {
      bestScore = score;
      noImproveStreak = 0;
      bestCandidate = {
        errata_id: item.id,
        candidate_id: evalResult.candidate_id || `cand-${item.id}`,
        score,
        kind: item.kind,
      };
    } else {
      noImproveStreak++;
    }

    const attemptRecord = {
      attempt: attemptIndex,
      errata_id: item.id,
      errata_kind: item.kind,
      candidate_id: evalResult?.candidate_id || `cand-${item.id}`,
      status,
      score,
      improved,
      reason: String(evalResult?.reason || ''),
      timestamp: nowTaipeiIso(now),
    };
    attempts.push(attemptRecord);

    if (ledger) {
      try {
        await ledger.appendRsiEvidence('hillclimb_attempt', {
          attempt: attemptRecord.attempt,
          errata_id: attemptRecord.errata_id,
          candidate_id: attemptRecord.candidate_id,
          status: attemptRecord.status,
          score: attemptRecord.score,
          improved: attemptRecord.improved,
        }, sha256(JSON.stringify(attemptRecord)));
      } catch {
        // Never fail hillclimb on optional ledger mirror error
      }
    }

    if (attempts.length >= maxBudget) {
      stopReason = 'budget_exhausted';
      break;
    }
    if (noImproveStreak >= plateauLimit) {
      stopReason = 'plateau';
      break;
    }
  }

  return {
    schema: 1,
    run_at: nowTaipeiIso(now),
    source: 'errata',
    errata_file: errataFile,
    budget: maxBudget,
    attempted: attempts.length,
    stop_reason: stopReason,
    best_candidate: bestCandidate,
    attempts,
  };
}
