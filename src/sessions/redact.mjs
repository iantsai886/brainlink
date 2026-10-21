// Secret filter for imported and logged sessions. Builds on the sync filter (src/sync/redact.mjs,
// owned by sync) so there is one rule list to tune; adds the few rules sessions also need.
import { redact as syncRedact } from '../sync/redact.mjs';

const EXTRA = [
  // Env/config assignments whose NAME says secret: FOO_API_KEY=..., DB_PASSWORD: "...", export X_TOKEN=...
  [/\b([A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?))(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"']+)/g, '$1$2[REDACTED]'],
  // URLs with user:password@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, '$1[REDACTED]@'],
  // Card / account-like numbers: 13–19 digits, optionally grouped by spaces or dashes.
  [/(?<![\d.])(?:\d[ -]?){12,18}\d(?![\d.])/g, '[REDACTED:number]'],
];

export function redactText(text) {
  if (typeof text !== 'string' || !text) return text;
  let t = EXTRA.slice(0, 2).reduce((s, [re, rep]) => s.replace(re, rep), text);
  t = syncRedact(t);
  return t.replace(EXTRA[2][0], EXTRA[2][1]);
}
