import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize, saveConfig } from '../src/config.mjs';
import { createContext, searchWithVerdict } from '../src/core.mjs';
import { startSetup } from '../src/setup.mjs';
import {
  MEMORY_TYPES,
  MEMORY_TYPE_LABELS,
  classifyNoteMemoryType,
  detectQueryMemoryIntent,
  memoryTypeScoreMultiplier,
} from '../src/memory-ranking.mjs';

const tmp = (name) => mkdtemp(path.join(tmpdir(), `brainlink-memrank-${name}-`));

test('memory-ranking classifies notes across all 4 CoALA memory types deterministically', () => {
  assert.deepEqual(MEMORY_TYPES, ['working', 'semantic', 'procedural', 'episodic']);
  assert.equal(MEMORY_TYPE_LABELS.procedural.label, 'Rules & How-Tos');
  assert.equal(classifyNoteMemoryType('Notes/Deploy.md', { memory_type: 'procedural' }), 'procedural');
  assert.equal(classifyNoteMemoryType('Notes/SOP.md', { type: 'runbook' }), 'procedural');
  assert.equal(classifyNoteMemoryType('60 Skills/Release.md', {}), 'procedural');
  assert.equal(classifyNoteMemoryType('Handoffs/Next.md', {}), 'working');
  assert.equal(classifyNoteMemoryType('Notes/Item.md', { tags: ['open-loop'] }), 'working');
  assert.equal(classifyNoteMemoryType('Sessions/2026-11-20.md', {}), 'episodic');
  assert.equal(classifyNoteMemoryType('Notes/Architecture.md', {}), 'semantic');
});

test('memory-ranking detects deterministic query intent in English and Chinese', () => {
  assert.equal(detectQueryMemoryIntent('How do we deploy the release checklist?'), 'procedural');
  assert.equal(detectQueryMemoryIntent('部署流程和規範怎麼做'), 'procedural');
  assert.equal(detectQueryMemoryIntent('What happened in last week meeting notes?'), 'episodic');
  assert.equal(detectQueryMemoryIntent('昨天會議記錄發生了什麼'), 'episodic');
  assert.equal(detectQueryMemoryIntent('What pending handoff tasks are open?'), 'working');
  assert.equal(detectQueryMemoryIntent('目前的待辦交接下一步'), 'working');
  assert.equal(detectQueryMemoryIntent('What is our pricing architecture decision?'), 'semantic');
  assert.equal(detectQueryMemoryIntent('zephyr'), null);
});

test('memory-ranking applies type-specific decay: procedural never decays, closed working decays fast', () => {
  const oldSop = memoryTypeScoreMultiplier({ memoryType: 'procedural', intent: 'procedural', ageDays: 730, status: 'canonical' });
  const oldEpisode = memoryTypeScoreMultiplier({ memoryType: 'episodic', intent: 'procedural', ageDays: 365 });
  assert.ok(oldSop > oldEpisode * 1.4, `expected old SOP (${oldSop}) to significantly outrank old episode (${oldEpisode})`);

  const activeWork = memoryTypeScoreMultiplier({ memoryType: 'working', intent: 'working', ageDays: 2, status: 'open' });
  const closedWork = memoryTypeScoreMultiplier({ memoryType: 'working', intent: 'working', ageDays: 2, status: 'done' });
  assert.ok(activeWork > closedWork * 1.8, `expected active work (${activeWork}) to outrank closed work (${closedWork})`);
});

test('searchWithVerdict boosts procedural SOP on how-to queries and supports explicit memory_type filtering', async () => {
  const dir = await tmp('vault');
  const home = await tmp('home');
  await mkdir(path.join(dir, '60 Skills'), { recursive: true });
  await mkdir(path.join(dir, 'Sessions'), { recursive: true });
  await mkdir(path.join(dir, 'Handoffs'), { recursive: true });
  await mkdir(home, { recursive: true });

  await writeFile(path.join(dir, '60 Skills', 'Release Runbook.md'), [
    '---',
    'memory_type: procedural',
    'status: canonical',
    'date: 2024-01-15',
    '---',
    '# Release Runbook',
    'Standard release procedure for deploying BrainLink builds safely with checksum verification.',
  ].join('\n'));

  await writeFile(path.join(dir, 'Sessions', '2026-02-01 Release Chat.md'), [
    '---',
    'memory_type: episodic',
    'date: 2026-02-01',
    '---',
    '# Release Chat',
    'We briefly mentioned release procedure for deploying BrainLink builds safely with checksum verification.',
  ].join('\n'));

  await writeFile(path.join(dir, 'Handoffs', 'Open Release Task.md'), [
    '---',
    'memory_type: working',
    'status: open',
    'date: 2026-11-27',
    '---',
    '# Open Release Task',
    'Pending handoff: verify release checksum before upload.',
  ].join('\n'));

  const cfg = normalize({ vaults: [{ name: 'Brain', path: dir }] });
  const ctx = createContext(cfg, { env: { BRAINLINK_HOME: home, BRAINLINK_SEMANTIC: 'off' }, trustedLocal: true });

  const howTo = await searchWithVerdict(ctx, 'Brain', 'How do we run the release procedure checksum', { limit: 3 });
  assert.equal(howTo.memory_intent, 'procedural');
  assert.equal(howTo.results[0].path, '60 Skills/Release Runbook.md');
  assert.equal(howTo.results[0].memory_type, 'procedural');

  const onlyWorking = await searchWithVerdict(ctx, 'Brain', 'release checksum', { limit: 5, memory_type: 'working' });
  assert.equal(onlyWorking.memory_type_filter, 'working');
  assert.equal(onlyWorking.results.length, 1);
  assert.equal(onlyWorking.results[0].path, 'Handoffs/Open Release Task.md');

  // Verify POST /api/ask respects memory_type filter too
  await saveConfig(cfg, path.join(home, 'config.json'));
  const setup = await startSetup({
    env: { BRAINLINK_HOME: home, BRAINLINK_SEMANTIC: 'off' },
    home: await tmp('user'),
    os: 'win32',
    port: 0,
    openUrl: null,
    useCli: false,
  });
  try {
    const res = await fetch(`http://127.0.0.1:${setup.port}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': setup.token },
      body: JSON.stringify({ vault: 'Brain', query: 'release checksum', memory_type: 'episodic' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sources.length, 1);
    assert.equal(body.sources[0].memory_type, 'episodic');
    assert.equal(body.sources[0].path, 'Sessions/2026-02-01 Release Chat.md');
  } finally {
    setup.server.close();
  }
});
