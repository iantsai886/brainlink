// Amber Ledger — Write-first append-only pre-capture store for Raw-to-Wiki intake.
// Every incoming capture is durably preserved before any extraction, grading, or propose_note
// runs, so downstream failures never lose raw inputs and retries are idempotent by sha256/capture_id.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { appHome } from './config.mjs';
import { nowTaipeiIso } from './rsi-gate.mjs';

export const AMBER_STATUSES = Object.freeze(['preserved', 'graded', 'filed', 'skipped', 'failed']);
const STATUS_SET = new Set(AMBER_STATUSES);

export function defaultAmberDir(env = process.env) {
  return path.join(appHome(env), 'amber');
}

function sha256Bytes(data) {
  return createHash('sha256').update(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')).digest('hex');
}

export async function readAmberEvents(ledgerDir = defaultAmberDir()) {
  const file = path.join(ledgerDir, 'amber-ledger.jsonl');
  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  return raw.split(/\r?\n/).filter((l) => l.trim()).map((l, idx) => {
    try { return JSON.parse(l); }
    catch { throw new Error(`Amber ledger damaged at line ${idx + 1}.`); }
  });
}

export async function listAmberCaptures({ ledgerDir = defaultAmberDir(), status, vaultScope } = {}) {
  if (status && !STATUS_SET.has(status)) {
    throw new Error(`Invalid Amber status "${status}". Allowed: ${AMBER_STATUSES.join(', ')}.`);
  }
  const events = await readAmberEvents(ledgerDir);
  const byId = new Map();
  for (const ev of events) {
    if (ev.event === 'status_change' && ev.capture_id && byId.has(ev.capture_id)) {
      const prev = byId.get(ev.capture_id);
      byId.set(ev.capture_id, {
        ...prev,
        status: ev.status,
        updated_at: ev.timestamp,
        ...(ev.error_reason !== undefined ? { error_reason: ev.error_reason } : {}),
        ...(ev.signal_score !== undefined ? { signal_score: ev.signal_score } : {}),
        ...(ev.proposal_ref !== undefined ? { proposal_ref: ev.proposal_ref } : {}),
      });
    } else if (ev.capture_id) {
      byId.set(ev.capture_id, {
        capture_id: ev.capture_id,
        captured_at: ev.captured_at,
        source_uri_or_path: ev.source_uri_or_path,
        sha256: ev.sha256,
        raw_ref: ev.raw_ref,
        vault_scope: ev.vault_scope,
        status: ev.status || 'preserved',
      });
    }
  }
  let rows = [...byId.values()];
  if (status) rows = rows.filter((r) => r.status === status);
  if (vaultScope) rows = rows.filter((r) => r.vault_scope === vaultScope);
  return rows;
}

// Write-first capture: persists raw content immutably (wx flag) and appends to amber-ledger.jsonl.
// Idempotent by sha256 + vault_scope: re-capturing identical bytes returns the existing entry.
export async function preserveAmberCapture({
  sourceUriOrPath,
  rawContent,
  rawRef = '',
  vaultScope = 'Brain',
  ledgerDir = defaultAmberDir(),
  now = new Date(),
}) {
  if (!sourceUriOrPath || !String(sourceUriOrPath).trim()) {
    throw new Error('preserveAmberCapture requires sourceUriOrPath.');
  }
  if (rawContent === undefined && !rawRef) {
    throw new Error('preserveAmberCapture requires rawContent or rawRef.');
  }
  const digest = rawContent !== undefined ? sha256Bytes(rawContent) : sha256Bytes(`${sourceUriOrPath}::${rawRef}`);

  const existing = (await listAmberCaptures({ ledgerDir })).find(
    (c) => c.sha256 === digest && c.vault_scope === vaultScope,
  );
  if (existing) {
    return { ...existing, duplicate: true };
  }

  await mkdir(ledgerDir, { recursive: true });
  let storedRef = rawRef;
  if (rawContent !== undefined) {
    const rawDir = path.join(ledgerDir, 'amber-raw');
    await mkdir(rawDir, { recursive: true });
    storedRef = path.join(rawDir, `${digest}.raw`);
    try {
      await writeFile(storedRef, Buffer.isBuffer(rawContent) ? rawContent : Buffer.from(String(rawContent), 'utf8'), { flag: 'wx' });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }

  const stamp = nowTaipeiIso(now);
  const entry = {
    event: 'capture',
    capture_id: `AMB-${stamp.slice(0, 10).replaceAll('-', '')}-${digest.slice(0, 12)}`,
    captured_at: stamp,
    source_uri_or_path: String(sourceUriOrPath).trim(),
    sha256: digest,
    raw_ref: storedRef,
    vault_scope: String(vaultScope || 'Brain').trim(),
    status: 'preserved',
  };

  await appendFile(path.join(ledgerDir, 'amber-ledger.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
  return { ...entry, duplicate: false };
}

export async function recordAmberStatus({
  captureId,
  status,
  errorReason = null,
  signalScore = null,
  proposalRef = null,
  ledgerDir = defaultAmberDir(),
  now = new Date(),
}) {
  if (!STATUS_SET.has(status)) {
    throw new Error(`Invalid Amber status "${status}". Allowed: ${AMBER_STATUSES.join(', ')}.`);
  }
  const rows = await listAmberCaptures({ ledgerDir });
  const existing = rows.find((r) => r.capture_id === captureId);
  if (!existing) throw new Error(`Amber capture "${captureId}" not found.`);

  const ev = {
    event: 'status_change',
    capture_id: captureId,
    timestamp: nowTaipeiIso(now),
    from_status: existing.status,
    status,
    ...(errorReason !== null ? { error_reason: String(errorReason).slice(0, 500) } : {}),
    ...(signalScore !== null ? { signal_score: signalScore } : {}),
    ...(proposalRef !== null ? { proposal_ref: String(proposalRef).slice(0, 300) } : {}),
  };
  await appendFile(path.join(ledgerDir, 'amber-ledger.jsonl'), JSON.stringify(ev) + '\n', 'utf8');
  return { ...existing, status, updated_at: ev.timestamp, ...(ev.error_reason ? { error_reason: ev.error_reason } : {}), ...(ev.signal_score !== undefined ? { signal_score: ev.signal_score } : {}), ...(ev.proposal_ref ? { proposal_ref: ev.proposal_ref } : {}) };
}

// End-to-end write-first intake pipeline:
// 1. Preserve raw capture before any downstream step runs.
// 2. Extract + grade (if either throws -> mark `failed`, raw capture stays intact & retryable).
// 3. Signal gate: low-signal entries -> `skipped` (never calls propose).
// 4. High-signal entries -> preview-gated `propose` -> `filed` (or `failed` on error).
export async function ingestWithAmberLedger({
  sourceUriOrPath,
  rawContent,
  vaultScope = 'Brain',
  ledgerDir = defaultAmberDir(),
  extract = async (text) => text,
  grade = async () => ({ pass: true, score: 1 }),
  propose = async () => ({ proposal_ref: 'preview-only', filed: false }),
  now = new Date(),
}) {
  // 1. Write-first preservation (idempotent by sha256)
  const captured = await preserveAmberCapture({ sourceUriOrPath, rawContent, vaultScope, ledgerDir, now });
  if (captured.status === 'filed' || captured.status === 'skipped') {
    return { ...captured, idempotent_noop: true };
  }

  const rawText = rawContent !== undefined
    ? (Buffer.isBuffer(rawContent) ? rawContent.toString('utf8') : String(rawContent))
    : await readFile(captured.raw_ref, 'utf8');

  // 2. Downstream extraction + grading with failure isolation
  let extracted;
  let gradeResult;
  try {
    extracted = await extract(rawText, captured);
    gradeResult = await grade(extracted, captured);
  } catch (err) {
    const failed = await recordAmberStatus({
      captureId: captured.capture_id,
      status: 'failed',
      errorReason: err?.message || 'extraction/grading failed',
      ledgerDir,
      now,
    });
    return { ...failed, ok: false };
  }

  // 3. Signal gate: low-signal captures never pollute 50 Knowledge or 60 Skills
  if (!gradeResult?.pass) {
    const skipped = await recordAmberStatus({
      captureId: captured.capture_id,
      status: 'skipped',
      signalScore: typeof gradeResult?.score === 'number' ? gradeResult.score : 0,
      errorReason: gradeResult?.reason || 'below signal threshold',
      ledgerDir,
      now,
    });
    return { ...skipped, ok: true };
  }

  await recordAmberStatus({
    captureId: captured.capture_id,
    status: 'graded',
    signalScore: typeof gradeResult?.score === 'number' ? gradeResult.score : 1,
    ledgerDir,
    now,
  });

  // 4. Preview-gated proposal / filing with failure isolation
  try {
    const proposal = await propose(extracted, captured);
    const finalStatus = proposal?.filed === true ? 'filed' : 'graded';
    const updated = await recordAmberStatus({
      captureId: captured.capture_id,
      status: finalStatus,
      proposalRef: proposal?.proposal_ref || proposal?.path || 'preview',
      ledgerDir,
      now,
    });
    return { ...updated, ok: true, proposal };
  } catch (err) {
    const failed = await recordAmberStatus({
      captureId: captured.capture_id,
      status: 'failed',
      errorReason: err?.message || 'proposal/filing failed',
      ledgerDir,
      now,
    });
    return { ...failed, ok: false };
  }
}
