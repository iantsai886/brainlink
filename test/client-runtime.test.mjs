import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compareClientStartToConfig, inspectClaudeDesktopRuntime } from '../src/client-runtime.mjs';

test('client runtime detects when the oldest process predates the saved configuration', () => {
  const configTime = Date.parse('2026-10-30T20:38:00.000Z');
  assert.deepEqual(compareClientStartToConfig([
    '2026-10-30T20:16:00.000Z',
    '2026-10-30T20:40:00.000Z',
  ], configTime), { status: 'running', started_before_config: true });
});

test('client runtime does not recommend a restart when all processes began after configuration', () => {
  const configTime = Date.parse('2026-10-30T20:38:00.000Z');
  assert.deepEqual(compareClientStartToConfig(['2026-10-30T20:40:00.000Z'], configTime), {
    status: 'running', started_before_config: false,
  });
});

test('client runtime returns unknown for missing or invalid process timestamps', () => {
  assert.deepEqual(compareClientStartToConfig([], 123), { status: 'unknown', started_before_config: null });
  assert.deepEqual(compareClientStartToConfig(['not a date'], 123), { status: 'unknown', started_before_config: null });
});

test('Windows Claude runtime reports that the app is closed when no process is present', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'brainlink-claude-runtime-'));
  const configPath = path.join(folder, 'claude_desktop_config.json');
  try {
    await writeFile(configPath, '{}');
    const result = await inspectClaudeDesktopRuntime({ os: 'win32', configPath, readStartTimes: async () => [] });
    assert.deepEqual(result, { status: 'not_running', started_before_config: null });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
