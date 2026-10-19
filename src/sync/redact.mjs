// Pattern-based secret filter for anything that leaves the device (session index).
const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  [/\b(?:sk|pk|rk)-(?:[A-Za-z0-9_-]{2,}-)?[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:api-key]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs]|xapp)[-_][A-Za-z0-9_-]{10,}\b/g, '[REDACTED:token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED:api-key]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED:jwt]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [REDACTED:token]'],
  [/\b(password|passwd|pwd|secret|api[_-]?key|token|access[_-]?key)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2[REDACTED]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED:email]'],
  [/(^|[\s(])@[A-Za-z0-9_]{2,30}\b/g, '$1[REDACTED:handle]'],
];

export function redact(text) {
  if (typeof text !== 'string') return text;
  return RULES.reduce((t, [re, rep]) => t.replace(re, rep), text);
}

export function redactDeep(v) {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
}
