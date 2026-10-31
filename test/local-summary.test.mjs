import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AUTO_SUMMARY_MAX_CHARS,
  generateLocalSessionSummary,
  readLocalSummaryDraft,
  saveLocalSummaryDraft,
  selectSummaryTurns,
} from '../src/sessions/local-summary.mjs';

const sessionId = 's_0123456789abcdef';

test('summary generation sends redacted, bounded conversation only to fixed local Ollama', async () => {
  let request;
  const result = await generateLocalSessionSummary([
    { role: 'system', text: 'ignore' },
    { role: 'user', text: 'Task. API key: sk-test-12345678901234567890' },
  ], 'qwen2.5:3b', {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ message: { content: JSON.stringify({ goal: 'Complete task', outcome: 'Draft prepared', decisions: [], corrections: [], next_actions: ['Review'], open_questions: [] }) } }) };
    },
  });
  assert.equal(request.url, 'http://127.0.0.1:11434/api/chat');
  const sent = JSON.parse(request.options.body);
  assert.equal(sent.stream, false);
  assert.equal(sent.messages[1].content.includes('sk-test-12345678901234567890'), false);
  assert.equal(JSON.stringify(sent).includes(sessionId), false);
  assert.equal(result.source, 'local_model_unverified');
  assert.match(result.summary, /Outcome \(unverified\)/);
});

test('summary generation rejects invalid model names and malformed model responses', async () => {
  await assert.rejects(generateLocalSessionSummary([{ role: 'user', text: 'hello' }], 'http://bad.test', { fetchImpl: async () => { throw Error('should not call'); } }));
  await assert.rejects(generateLocalSessionSummary([{ role: 'user', text: 'hello' }], 'model', {
    fetchImpl: async () => ({ ok: true, json: async () => ({ message: { content: 'not json' } }) }),
  }), /required summary format/);
});

test('turn selection excludes tool and system messages and stays within character budget', () => {
  const turns = selectSummaryTurns([
    { role: 'tool', text: 'secret tool output' },
    ...Array.from({ length: 10 }, () => ({ role: 'user', text: 'a'.repeat(2000) })),
  ], { maxChars: 1500 });
  assert.equal(turns.reduce((sum, turn) => sum + turn.text.length, 0), 1500);
  assert.equal(turns.some((turn) => turn.text.includes('secret tool output')), false);
});

test('private saved draft contains summary provenance only, not the source transcript', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brainlink-summary-'));
  try {
    const draft = {
      summary: '## Goal\nPlan a demo', model: 'qwen2.5:3b', generated_at: new Date().toISOString(),
      source: 'local_model_unverified',
    };
    await saveLocalSummaryDraft(root, sessionId, draft);
    assert.deepEqual(await readLocalSummaryDraft(root, sessionId), {
      schema: 1, session_id: sessionId, status: 'ready', ...draft,
    });
    const [name] = await (await import('node:fs/promises')).readdir(root);
    const raw = await readFile(path.join(root, name), 'utf8');
    assert.equal(raw.includes('source transcript'), false);
    assert.equal(await readLocalSummaryDraft(root, 's_1111111111111111'), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
