// Read-only, trace-first observability for Iango's Hermes sidecar.
// NEVER mutates Hermes config, schedules, or state (uses only readFile/readdir/stat).
// Judges run health from actual execution traces — never exit codes alone — and
// verifies persona/soul loading FIRST at the top of every report.
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { nowTaipeiIso } from './rsi-gate.mjs';

export const OWNER_LAYERS = Object.freeze([
  'policy/config',
  'approval-allowlist',
  'vault/mcp-connectivity',
  'upstream-hermes',
]);

export function defaultHermesHome(env = process.env, osPlatform = process.platform, home = homedir()) {
  if (env.HERMES_HOME) return env.HERMES_HOME;
  if (osPlatform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'hermes');
  }
  return path.join(home, '.hermes');
}

export function attributeFailureOwner(events, personaStatus) {
  const joined = events.map((e) => `${e.type || ''} ${e.error || ''} ${e.reason || ''} ${e.message || ''}`).join(' ');
  if (personaStatus === 'BLOCKED' || /\b(approval|allowlist|not allowlisted|permission denied by allowlist|blocked by approval)\b/i.test(joined)) {
    return personaStatus === 'BLOCKED' && /\b(policy|config|soul|persona)\b/i.test(joined)
      ? 'policy/config'
      : 'approval-allowlist';
  }
  if (personaStatus === 'MISSING' || /\b(persona|soul\.md|instructions? missing|policy|config error|invalid config)\b/i.test(joined)) {
    return 'policy/config';
  }
  if (/\b(mcp|econnrefused|vault.*missing|token.*unassigned|brainlink|stdio.*closed|socket hang up)\b/i.test(joined)) {
    return 'vault/mcp-connectivity';
  }
  return 'upstream-hermes';
}

export function analyzeHermesTrace(events, { expectedPersona = '', sessionId = 'unknown', traceFile = '' } = {}) {
  const list = Array.isArray(events) ? events : [];
  if (list.length === 0) {
    return {
      session_id: sessionId,
      trace_file: traceFile,
      persona_status: 'UNMEASURED',
      persona_loaded: null,
      persona_alert: 'UNMEASURED: empty trace — cannot verify whether persona/soul loaded.',
      exit_code: null,
      health: 'UNMEASURED',
      silent_exit0_failure: false,
      owner_layer: null,
      failures: [{ kind: 'empty_trace', message: 'Trace file contained 0 events.', owner_layer: 'upstream-hermes' }],
      event_count: 0,
    };
  }

  let personaStatus = 'MISSING';
  let personaLoaded = null;
  let personaReason = '';
  let exitCode = null;
  const failures = [];

  for (const ev of list) {
    const type = String(ev.type || ev.event || '').toLowerCase();
    const msg = String(ev.message || ev.error || ev.reason || '');

    if (typeof ev.exit_code === 'number') exitCode = ev.exit_code;

    // Persona / soul detection
    if (type === 'persona_loaded' || type === 'soul_loaded' || (type === 'system_prompt' && ev.loaded === true)) {
      const name = String(ev.persona || ev.name || ev.file || 'loaded').trim();
      if (!expectedPersona || name.toLowerCase().includes(expectedPersona.toLowerCase())) {
        personaStatus = 'LOADED';
        personaLoaded = name;
      } else {
        personaStatus = 'MISSING';
        personaReason = `Loaded "${name}" instead of expected persona "${expectedPersona}".`;
      }
    } else if (type === 'persona_blocked' || type === 'policy_blocked' || (type === 'persona_load_failed' && /block|deny|policy|allowlist/i.test(msg))) {
      personaStatus = 'BLOCKED';
      personaReason = msg || 'Persona loading was blocked by policy.';
    } else if (type === 'persona_missing' || type === 'persona_load_failed') {
      if (personaStatus !== 'BLOCKED') {
        personaStatus = 'MISSING';
        personaReason = msg || 'Persona/soul instructions did not load.';
      }
    }

    // Failure events in trace (regardless of exit code)
    if (type.includes('error') || type.includes('fail') || type.includes('blocked') || type.includes('denied') || ev.ok === false || ev.status === 'error' || ev.status === 'blocked') {
      const owner = attributeFailureOwner([ev], type.includes('blocked') ? 'BLOCKED' : personaStatus);
      failures.push({
        kind: type || 'trace_error',
        message: msg || `Event "${type}" failed`,
        owner_layer: owner,
      });
    }
  }

  if (personaStatus === 'MISSING' && !failures.some((f) => /persona/i.test(f.kind))) {
    failures.unshift({
      kind: 'persona_missing',
      message: personaReason || `Expected persona${expectedPersona ? ` "${expectedPersona}"` : ''} did not load in trace.`,
      owner_layer: 'policy/config',
    });
  } else if (personaStatus === 'BLOCKED' && !failures.some((f) => /persona|policy/i.test(f.kind))) {
    failures.unshift({
      kind: 'persona_blocked',
      message: personaReason || 'Persona loading was blocked.',
      owner_layer: attributeFailureOwner(list, 'BLOCKED'),
    });
  }

  if (exitCode !== null && exitCode !== 0 && failures.length === 0) {
    failures.push({
      kind: 'nonzero_exit',
      message: `Process exited with code ${exitCode}.`,
      owner_layer: 'upstream-hermes',
    });
  }

  const healthy = personaStatus === 'LOADED' && failures.length === 0 && (exitCode === null || exitCode === 0);
  const silentExit0Failure = exitCode === 0 && !healthy;
  const primaryOwner = healthy ? null : (failures[0]?.owner_layer || attributeFailureOwner(list, personaStatus));
  const personaAlert = personaStatus === 'LOADED'
    ? null
    : `${personaStatus}: ${personaReason || 'Expected persona/soul instructions did not load.'}`;

  return {
    session_id: sessionId,
    trace_file: traceFile,
    persona_status: personaStatus,
    persona_loaded: personaLoaded,
    persona_alert: personaAlert,
    exit_code: exitCode,
    health: healthy ? 'HEALTHY' : 'FAILED',
    silent_exit0_failure: silentExit0Failure,
    owner_layer: primaryOwner,
    failures,
    event_count: list.length,
  };
}

export async function inspectHermesTraces({
  hermesHome = defaultHermesHome(),
  traceDir = '',
  expectedPersona = '',
  limit = 20,
  now = new Date(),
} = {}) {
  const dir = traceDir || path.join(hermesHome, 'traces');
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        schema: 1,
        checked_at: nowTaipeiIso(now),
        read_only: true,
        trace_dir: dir,
        overall_health: 'UNMEASURED',
        persona_alerts: ['UNMEASURED: Hermes trace directory not found; cannot verify persona loading.'],
        sessions_inspected: 0,
        healthy_count: 0,
        failed_count: 0,
        unmeasured_count: 1,
        sessions: [],
      };
    }
    throw err;
  }

  const files = entries
    .filter((e) => e.isFile() && /\.(jsonl|ndjson|json)$/i.test(e.name))
    .map((e) => e.name)
    .sort()
    .slice(-Math.max(1, Number(limit) || 20));

  const sessions = [];
  for (const name of files) {
    const full = path.join(dir, name);
    const raw = await readFile(full, 'utf8');
    let events = [];
    if (name.endsWith('.json')) {
      const parsed = JSON.parse(raw);
      events = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.events) ? parsed.events : [parsed]);
    } else {
      events = raw.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
    }
    sessions.push(analyzeHermesTrace(events, {
      expectedPersona,
      sessionId: name.replace(/\.(jsonl|ndjson|json)$/i, ''),
      traceFile: full,
    }));
  }

  const personaAlerts = sessions
    .filter((s) => s.persona_status !== 'LOADED')
    .map((s) => `[${s.session_id}] ${s.persona_alert || s.persona_status}`);

  const healthyCount = sessions.filter((s) => s.health === 'HEALTHY').length;
  const failedCount = sessions.filter((s) => s.health === 'FAILED').length;
  const unmeasuredCount = sessions.filter((s) => s.health === 'UNMEASURED').length;
  const overallHealth = sessions.length === 0
    ? 'UNMEASURED'
    : failedCount > 0 ? 'FAILED' : unmeasuredCount > 0 ? 'UNMEASURED' : 'HEALTHY';

  return {
    schema: 1,
    checked_at: nowTaipeiIso(now),
    read_only: true,
    trace_dir: dir,
    overall_health: overallHealth,
    // Persona/soul verification is always surfaced FIRST at the top of the report.
    persona_alerts: personaAlerts,
    sessions_inspected: sessions.length,
    healthy_count: healthyCount,
    failed_count: failedCount,
    unmeasured_count: unmeasuredCount,
    sessions,
  };
}

export function formatHermesReport(report, mode = 'status') {
  const lines = [`Hermes Sidecar (${mode}) — ${report.overall_health} [read-only]`];
  if (report.persona_alerts.length > 0) {
    lines.push('PERSONA / SOUL ALERTS (checked first):');
    for (const alert of report.persona_alerts) lines.push(`  ! ${alert}`);
  } else if (report.sessions_inspected > 0) {
    lines.push(`PERSONA / SOUL: verified LOADED across ${report.sessions_inspected} session(s).`);
  }
  for (const s of report.sessions) {
    const tag = s.silent_exit0_failure ? `${s.health} (silent exit-0 failure)` : s.health;
    lines.push(`  ${s.session_id}: ${tag} | persona=${s.persona_status}${s.owner_layer ? ` | owner=${s.owner_layer}` : ''}`);
    if (mode !== 'status') {
      for (const f of s.failures) lines.push(`    - [${f.owner_layer}] ${f.kind}: ${f.message}`);
    }
  }
  return lines.join('\n');
}
