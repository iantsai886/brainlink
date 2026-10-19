// Offline licence keys: BL1.<base64url JSON payload>.<base64url Ed25519 signature>.
// The app ships only the public key; keys are issued with tools/license-issue.mjs.
import { createPublicKey, verify } from 'node:crypto';
import { PUBLIC_KEY_PEM } from './license-key.mjs';

export const PLANS = {
  free: { writes: false, agents: false, http: false, maxVaults: 1, maxConnections: 2 },
  trial: { writes: true, agents: true, http: true, maxVaults: Infinity, maxConnections: Infinity },
  personal: { writes: true, agents: true, http: true, maxVaults: Infinity, maxConnections: Infinity },
  team: { writes: true, agents: true, http: true, maxVaults: Infinity, maxConnections: Infinity },
};

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function canonicalPayload(p) {
  return JSON.stringify({ v: 1, email: p.email, plan: p.plan, seats: p.seats ?? 1, issued: p.issued, expires: p.expires ?? null, updates_until: p.updates_until ?? null, id: p.id });
}

export function encodeKey(payloadJson, signature) {
  return `BL1.${b64u(payloadJson)}.${b64u(signature)}`;
}

// Returns { valid, plan, email, expires, updates_until, reason }. Never throws.
export function verifyLicense(key, { publicKeyPem = PUBLIC_KEY_PEM, now = new Date() } = {}) {
  if (!key) return { valid: false, plan: 'free', reason: 'no licence key' };
  const m = String(key).trim().match(/^BL1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!m) return { valid: false, plan: 'free', reason: 'not a BrainLink licence key' };
  let payload;
  try {
    const json = Buffer.from(m[1], 'base64url').toString('utf8');
    if (!verify(null, Buffer.from(json), createPublicKey(publicKeyPem), Buffer.from(m[2], 'base64url'))) return { valid: false, plan: 'free', reason: 'signature does not match' };
    payload = JSON.parse(json);
  } catch { return { valid: false, plan: 'free', reason: 'damaged licence key' }; }
  if (!PLANS[payload.plan] || payload.plan === 'free') return { valid: false, plan: 'free', reason: `unknown plan ${payload.plan}` };
  if (payload.expires && new Date(payload.expires) < now) return { valid: false, plan: 'free', email: payload.email, expires: payload.expires, reason: `${payload.plan} licence expired ${payload.expires}` };
  return { valid: true, plan: payload.plan, email: payload.email, seats: payload.seats, expires: payload.expires, updates_until: payload.updates_until, id: payload.id };
}

export function planFeatures(license) {
  return { plan: license?.valid ? license.plan : 'free', ...PLANS[license?.valid ? license.plan : 'free'] };
}

export const TRIAL_DAYS = 14;

// Starts the built-in trial the first time a vault is added with no licence key yet; a no-op once
// a key is set or the trial has already started. Shared by Setup's quickStart and `brainlink init`
// so both paths grant the same trial.
export function startTrial(cfg) {
  if (!cfg.license && !cfg.trial_started) cfg.trial_started = new Date().toISOString();
  return cfg;
}

// The licence in force: a valid key, else the built-in trial that starts at first setup, else free.
export function effectiveLicense(cfg, { now = new Date(), publicKeyPem } = {}) {
  const key = verifyLicense(cfg?.license, publicKeyPem ? { publicKeyPem, now } : { now });
  if (key.valid || cfg?.license) return key;
  if (cfg?.trial_started) {
    const ends = new Date(new Date(cfg.trial_started).getTime() + TRIAL_DAYS * 86400e3);
    const expires = ends.toISOString().slice(0, 10);
    if (ends > now) return { valid: true, plan: 'trial', email: null, expires, builtin: true, days_left: Math.ceil((ends - now) / 86400e3) };
    return { valid: false, plan: 'free', expires, reason: `free trial ended ${expires}` };
  }
  return key;
}
