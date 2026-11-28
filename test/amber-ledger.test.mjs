import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  preserveAmberCapture,
  listAmberCaptures,
  ingestWithAmberLedger,
} from '../src/amber-ledger.mjs';

test('Amber Ledger preserves raw capture before downstream extraction/filing failures and supports idempotent retry', async () => {
  const ledgerDir = await mkdtemp(path.join(tmpdir(), 'brainlink-amber-'));
  const rawBody = 'Important raw meeting transcript about Q4 pricing guardrails.';

  // 1. Simulate downstream extraction crash — raw capture MUST already be preserved on disk
  const failed1 = await ingestWithAmberLedger({
    sourceUriOrPath: 'Inbox/meeting-2026-11-28.txt',
    rawContent: rawBody,
    vaultScope: 'Brain',
    ledgerDir,
    extract: async () => { throw new Error('OCR worker crashed'); },
  });
  assert.equal(failed1.ok, false);
  assert.equal(failed1.status, 'failed');
  assert.match(failed1.error_reason, /OCR worker crashed/);
  assert.equal(await readFile(failed1.raw_ref, 'utf8'), rawBody);

  // 2. Retry same content by sha256 — idempotent capture_id, now extraction succeeds but propose throws
  let proposeCalls = 0;
  const failed2 = await ingestWithAmberLedger({
    sourceUriOrPath: 'Inbox/meeting-2026-11-28.txt',
    rawContent: rawBody,
    vaultScope: 'Brain',
    ledgerDir,
    extract: async (txt) => txt,
    grade: async () => ({ pass: true, score: 0.9 }),
    propose: async () => { proposeCalls++; throw new Error('disk full during propose_note'); },
  });
  assert.equal(failed2.capture_id, failed1.capture_id);
  assert.equal(failed2.status, 'failed');
  assert.equal(proposeCalls, 1);
  assert.equal(await readFile(failed2.raw_ref, 'utf8'), rawBody);

  // 3. Final retry succeeds and files cleanly
  const filed = await ingestWithAmberLedger({
    sourceUriOrPath: 'Inbox/meeting-2026-11-28.txt',
    rawContent: rawBody,
    vaultScope: 'Brain',
    ledgerDir,
    extract: async (txt) => txt,
    grade: async () => ({ pass: true, score: 0.92 }),
    propose: async () => ({ filed: true, proposal_ref: '50 Knowledge/Q4 Pricing Guardrails.md' }),
  });
  assert.equal(filed.capture_id, failed1.capture_id);
  assert.equal(filed.status, 'filed');
  assert.equal(filed.proposal_ref, '50 Knowledge/Q4 Pricing Guardrails.md');

  // 4. Subsequent re-ingest of same sha256 is an idempotent no-op (never re-proposes)
  let extraPropose = 0;
  const noop = await ingestWithAmberLedger({
    sourceUriOrPath: 'Inbox/meeting-2026-11-28.txt',
    rawContent: rawBody,
    vaultScope: 'Brain',
    ledgerDir,
    propose: async () => { extraPropose++; return { filed: true }; },
  });
  assert.equal(noop.idempotent_noop, true);
  assert.equal(extraPropose, 0);

  const all = await listAmberCaptures({ ledgerDir });
  assert.equal(all.length, 1);
});

test('Amber Ledger signal gate marks low-signal captures as skipped without calling propose_note', async () => {
  const ledgerDir = await mkdtemp(path.join(tmpdir(), 'brainlink-amber-gate-'));
  let proposeCalled = false;

  const res = await ingestWithAmberLedger({
    sourceUriOrPath: 'Inbox/noise.txt',
    rawContent: 'ok thanks',
    vaultScope: 'Brain',
    ledgerDir,
    grade: async () => ({ pass: false, score: 0.1, reason: 'low signal chatter' }),
    propose: async () => { proposeCalled = true; return { filed: true }; },
  });

  assert.equal(res.status, 'skipped');
  assert.equal(proposeCalled, false);
  const raw = await readFile(res.raw_ref, 'utf8');
  assert.equal(raw, 'ok thanks');

  // Direct preserveAmberCapture idempotency check
  const dup = await preserveAmberCapture({
    sourceUriOrPath: 'Inbox/noise.txt',
    rawContent: 'ok thanks',
    vaultScope: 'Brain',
    ledgerDir,
  });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.capture_id, res.capture_id);
});
