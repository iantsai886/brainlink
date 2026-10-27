// Offline, fixed-corpus evaluation for the built-in research discovery filter.
// It reads no vault, makes no network requests, and never changes discovery behavior.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { assessRelevance, hostileReason, DISCOVERY_METHOD_VERSION } from './rsi-discovery.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function validateDiscoveryFixture(fixture) {
  if (!fixture || fixture.schema !== 1 || fixture.id !== 'rsi-discovery-v1' || !Array.isArray(fixture.cases)
    || !Number.isInteger(fixture.minimum_cases) || fixture.minimum_cases < 1 || fixture.cases.length < fixture.minimum_cases) {
    throw new Error('Discovery evaluation fixture is invalid or too small.');
  }
  const ids = new Set();
  for (const item of fixture.cases) {
    if (!item || typeof item.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(item.id) || ids.has(item.id)
      || typeof item.signal !== 'string' || !item.signal.trim() || item.signal.length > 240
      || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 240
      || typeof item.summary !== 'string' || item.summary.length > 1200
      || typeof item.relevant !== 'boolean' || (item.hostile !== undefined && typeof item.hostile !== 'boolean')) {
      throw new Error('Discovery evaluation case is invalid.');
    }
    ids.add(item.id);
  }
  if (fixture.cases.filter((item) => item.relevant && !item.hostile).length < 1
    || fixture.cases.filter((item) => !item.relevant).length < 1) throw new Error('Discovery evaluation needs positive and negative examples.');
  return fixture;
}

export function evaluateDiscoveryFixture(fixture, fixtureBytes = Buffer.from(JSON.stringify(fixture))) {
  validateDiscoveryFixture(fixture);
  const benign = fixture.cases.filter((item) => !item.hostile);
  let tp = 0, fp = 0, fn = 0, tn = 0, hostileAccepted = 0;
  for (const item of fixture.cases) {
    const blocked = Boolean(hostileReason(item));
    const accepted = !blocked && Boolean(assessRelevance(item, [item.signal]));
    if (item.hostile && accepted) hostileAccepted++;
    if (item.hostile) continue;
    if (item.relevant && accepted) tp++;
    else if (item.relevant) fn++;
    else if (accepted) fp++;
    else tn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  const minimumMet = benign.length >= fixture.minimum_cases;
  const decision = hostileAccepted ? 'blocked_privacy'
    : !minimumMet ? 'needs_more_cases'
      : fp === 0 && fn === 0 ? 'no_discovery_errors_on_fixture'
        : 'review_discovery_errors';
  return {
    schema: 1,
    suite: fixture.id,
    fixture_sha256: hash(fixtureBytes),
    method_version: DISCOVERY_METHOD_VERSION,
    sample_count: benign.length,
    minimum_cases: fixture.minimum_cases,
    metrics: { precision: +precision.toFixed(3), recall: +recall.toFixed(3), f1: +f1.toFixed(3), true_positive: tp, false_positive: fp, false_negative: fn, true_negative: tn },
    guardrails: { hostile_entries_accepted: hostileAccepted },
    decision,
    limitations: ['Small synthetic fixture; not a market or production quality claim.', 'Labels and examples require independent human review.', 'The test does not measure user-specific relevance or source quality.', 'A clean score does not promote or change the live discovery method.'],
  };
}

export async function runDiscoveryEvaluation({ root = ROOT } = {}) {
  const fixtureBytes = await readFile(path.join(root, 'samples', 'evaluation', 'rsi-discovery-v1.json'));
  let fixture;
  try { fixture = JSON.parse(fixtureBytes.toString('utf8')); }
  catch { throw new Error('Discovery evaluation fixture is not valid JSON.'); }
  return evaluateDiscoveryFixture(fixture, fixtureBytes);
}
