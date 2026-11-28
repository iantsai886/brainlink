import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectHermesTraces, formatHermesReport } from '../src/hermes-observe.mjs';

test('Hermes trace-first observability detects healthy run, silent exit-0 missing persona, blocked policy, and MCP failures without mutating files', async () => {
  const traceDir = await mkdtemp(path.join(tmpdir(), 'brainlink-hermes-traces-'));

  // 1. Healthy run
  await writeFile(path.join(traceDir, '01-healthy.jsonl'), [
    JSON.stringify({ type: 'persona_loaded', persona: 'Anna (SOUL.md)' }),
    JSON.stringify({ type: 'tool_call', tool: 'vault_search', ok: true }),
    JSON.stringify({ type: 'session_end', exit_code: 0 }),
  ].join('\n') + '\n', 'utf8');

  // 2. Silent exit-0 failure with missing persona
  await writeFile(path.join(traceDir, '02-silent-missing-persona.jsonl'), [
    JSON.stringify({ type: 'tool_call', tool: 'vault_search', ok: true }),
    JSON.stringify({ type: 'session_end', exit_code: 0 }),
  ].join('\n') + '\n', 'utf8');

  // 3. Blocked policy / allowlist failure
  await writeFile(path.join(traceDir, '03-blocked-policy.jsonl'), [
    JSON.stringify({ type: 'persona_loaded', persona: 'Anna (SOUL.md)' }),
    JSON.stringify({ type: 'tool_blocked', message: 'Command blocked by approval allowlist', ok: false }),
    JSON.stringify({ type: 'session_end', exit_code: 1 }),
  ].join('\n') + '\n', 'utf8');

  // 4. Vault / MCP connectivity failure
  await writeFile(path.join(traceDir, '04-mcp-down.jsonl'), [
    JSON.stringify({ type: 'persona_loaded', persona: 'Anna (SOUL.md)' }),
    JSON.stringify({ type: 'tool_error', error: 'MCP ECONNREFUSED connecting to BrainLink', ok: false }),
    JSON.stringify({ type: 'session_end', exit_code: 1 }),
  ].join('\n') + '\n', 'utf8');

  const filesBefore = (await readdir(traceDir)).sort();
  const report = await inspectHermesTraces({ traceDir, expectedPersona: 'Anna' });
  const filesAfter = (await readdir(traceDir)).sort();

  // Strictly read-only
  assert.deepEqual(filesAfter, filesBefore);
  assert.equal(report.read_only, true);
  assert.equal(report.sessions_inspected, 4);
  assert.equal(report.healthy_count, 1);
  assert.equal(report.failed_count, 3);
  assert.equal(report.overall_health, 'FAILED');

  // Persona alert is flagged at top of report for silent exit-0 missing persona
  assert.equal(report.persona_alerts.length, 1);
  assert.match(report.persona_alerts[0], /02-silent-missing-persona/);

  const s1 = report.sessions.find((s) => s.session_id === '01-healthy');
  assert.equal(s1.health, 'HEALTHY');
  assert.equal(s1.persona_status, 'LOADED');

  const s2 = report.sessions.find((s) => s.session_id === '02-silent-missing-persona');
  assert.equal(s2.health, 'FAILED');
  assert.equal(s2.silent_exit0_failure, true);
  assert.equal(s2.persona_status, 'MISSING');
  assert.equal(s2.owner_layer, 'policy/config');

  const s3 = report.sessions.find((s) => s.session_id === '03-blocked-policy');
  assert.equal(s3.health, 'FAILED');
  assert.equal(s3.owner_layer, 'approval-allowlist');

  const s4 = report.sessions.find((s) => s.session_id === '04-mcp-down');
  assert.equal(s4.health, 'FAILED');
  assert.equal(s4.owner_layer, 'vault/mcp-connectivity');

  const formatted = formatHermesReport(report, 'triage');
  assert.match(formatted, /PERSONA \/ SOUL ALERTS/);
  assert.match(formatted, /silent exit-0 failure/);
});

test('Hermes observability reports UNMEASURED when trace directory is missing (never fake green)', async () => {
  const missingDir = path.join(tmpdir(), 'brainlink-hermes-nonexistent-' + Date.now());
  const report = await inspectHermesTraces({ traceDir: missingDir });
  assert.equal(report.overall_health, 'UNMEASURED');
  assert.equal(report.healthy_count, 0);
  assert.ok(report.persona_alerts.length > 0);
});
