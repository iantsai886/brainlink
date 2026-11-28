// Memory-type classification, deterministic query-intent routing, and type-aware decay/scoring
// for BrainLink's 4 CoALA memory types: working, semantic, procedural, episodic.
// 100% deterministic (zero LLM calls on the hot path).

export const MEMORY_TYPES = Object.freeze(['working', 'semantic', 'procedural', 'episodic']);
const MEMORY_TYPE_SET = new Set(MEMORY_TYPES);

export const MEMORY_TYPE_LABELS = Object.freeze({
  working: Object.freeze({ key: 'working', label: 'Active Work', description: 'Handoffs, open loops, tasks, current work' }),
  semantic: Object.freeze({ key: 'semantic', label: 'Knowledge & Facts', description: 'Decisions, entities, preferences, concepts' }),
  procedural: Object.freeze({ key: 'procedural', label: 'Rules & How-Tos', description: 'SOPs, skills, runbooks, role manuals' }),
  episodic: Object.freeze({ key: 'episodic', label: 'History & Sessions', description: 'Meeting logs, past sessions, daily notes' }),
});

const NOTE_TYPE_ALIASES = Object.freeze({
  'operating-manual': 'procedural',
  'operations-manual': 'procedural',
  'role-manual': 'procedural',
  'agent-manual': 'procedural',
  procedure: 'procedural',
  'standard-operating-procedure': 'procedural',
  sop: 'procedural',
  runbook: 'procedural',
  skill: 'procedural',
  'agent-skill': 'procedural',
  'role-instructions': 'procedural',
  playbook: 'procedural',
  checklist: 'procedural',
  handoff: 'working',
  'handoff-request': 'working',
  task: 'working',
  'open-loop': 'working',
  'work-item': 'working',
  episode: 'episodic',
  'session-episode': 'episodic',
  'session-summary': 'episodic',
  'close-loop': 'episodic',
  daily: 'episodic',
  'daily-note': 'episodic',
  'meeting-note': 'episodic',
});

function normToken(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

export function classifyNoteMemoryType(rel = '', meta = {}, tags = null) {
  const explicit = String(meta?.memory_type ?? meta?.brainlink_memory_type ?? '').trim().toLowerCase();
  if (MEMORY_TYPE_SET.has(explicit)) return explicit;

  const noteType = normToken(meta?.type || meta?.note_type);
  if (NOTE_TYPE_ALIASES[noteType]) return NOTE_TYPE_ALIASES[noteType];

  const tagList = tags instanceof Set
    ? [...tags]
    : Array.isArray(meta?.tags)
      ? meta.tags.flat(Infinity)
      : String(meta?.tags || '').replace(/^\[|\]$/g, '').split(',');
  for (const raw of tagList) {
    const t = normToken(String(raw).replace(/^['"#]+|['"]+$/g, ''));
    if (NOTE_TYPE_ALIASES[t]) return NOTE_TYPE_ALIASES[t];
  }

  const p = String(rel || '').replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)(skills|procedures|runbooks|sops|playbooks|manuals|60\s+skills)\//.test(p)) return 'procedural';
  if (/(^|\/)(handoffs|tasks|open-loops|work-items)\//.test(p)) return 'working';
  if (/(^|\/)(sessions|episodes|daily|meetings|close-loops|journal)\//.test(p)) return 'episodic';

  return 'semantic';
}

const PROCEDURAL_INTENT = /\b(how\s+(do|to|should|can)|sop|runbook|procedure|checklist|workflow|playbook|guideline|skill|steps?\s+to|protocol)\b|怎麼做|怎么做|如何|流程|步驟|步骤|指南/i;
const EPISODIC_INTENT = /\b(yesterday|last\s+(week|month|session|meeting|time)|what\s+happened|meeting\s+notes?|session\s+(log|summary)|transcript|timeline|when\s+did\s+we|on\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b|昨天|上週|上周|上次|會議記錄|会议记录|發生了什麼|发生了什么|工作階段|会话/i;
const WORKING_INTENT = /\b(todo|to-do|pending|open\s+loops?|handoff|hand-off|next\s+steps?|in\s+progress|action\s+items?|follow[- ]?up|blocked|current\s+task)\b|待辦|待办|未完成|交接|下一步|進行中|进行中/i;
const SEMANTIC_INTENT = /\b(what\s+is|who\s+(is|owns)|definition|decision|decided|architecture|spec|specification|preference|pricing|profile|overview)\b|是什麼|是什么|決定|决定|架構|架构|偏好|規格|规格/i;

export function detectQueryMemoryIntent(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  if (PROCEDURAL_INTENT.test(q)) return 'procedural';
  if (WORKING_INTENT.test(q)) return 'working';
  if (EPISODIC_INTENT.test(q)) return 'episodic';
  if (SEMANTIC_INTENT.test(q)) return 'semantic';
  return null;
}

const CLOSED_WORKING_STATUS = /^(done|closed|completed|resolved|archived|cancelled|canceled)$/i;
const CANONICAL_STATUS = /^(canonical|verified|active|final|approved)$/i;
const UNREVIEWED_STATUS = /^(proposed|draft|unverified_draft)$/i;

export function memoryTypeScoreMultiplier({
  memoryType = 'semantic',
  intent = null,
  ageDays = 0,
  status = '',
  superseded = false,
  recentQuery = false,
} = {}) {
  const type = MEMORY_TYPE_SET.has(memoryType) ? memoryType : 'semantic';
  const days = Number.isFinite(ageDays) && ageDays > 0 ? ageDays : 0;
  const st = String(status || '').trim();
  const isUnreviewed = UNREVIEWED_STATUS.test(st);
  let mult = 1;

  // Deterministic query-intent alignment boost (capped at x1.10; never applied to proposed/draft notes).
  if (!isUnreviewed && intent && MEMORY_TYPE_SET.has(intent) && type === intent) {
    mult *= 1.10;
  }

  // Memory-type-specific lifecycle & decay curve.
  if (type === 'procedural') {
    // Authoritative rules/SOPs do not decay with age; only supersession demotes them.
    if (!isUnreviewed && CANONICAL_STATUS.test(st)) mult *= 1.05;
  } else if (type === 'semantic') {
    // Durable knowledge decays very slowly; canonical facts get a mild boost.
    if (!isUnreviewed && CANONICAL_STATUS.test(st)) mult *= 1.06;
    if (days > 365) mult *= Math.max(0.92, 1 - Math.min(0.08, ((days - 365) / 1825) * 0.08));
  } else if (type === 'episodic') {
    // Session logs & daily notes favor recency unless explicitly queried for history.
    if (intent !== 'episodic' && !recentQuery && days > 30) {
      mult *= Math.max(0.78, 1 - Math.min(0.22, ((days - 30) / 180) * 0.22));
    }
  } else if (type === 'working') {
    // Working handoffs/tasks decay rapidly once stale or closed.
    if (CLOSED_WORKING_STATUS.test(st)) {
      mult *= 0.55;
    } else if (!isUnreviewed && days <= 14) {
      mult *= 1.08;
    } else if (days > 30) {
      mult *= Math.max(0.72, 1 - Math.min(0.28, ((days - 30) / 90) * 0.28));
    }
  }

  if (superseded) mult *= 0.65;
  return +mult.toFixed(4);
}
