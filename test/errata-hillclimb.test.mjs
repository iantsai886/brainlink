import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendErrata, listErrata, triageErrata, runHillClimbFromErrata } from '../src/errata.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'brainlink.mjs');

test('errata ledger is strictly append-only and preserves verbatim_text without invention', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainlink-errata-'));
  const file = path.join(dir, 'errata.jsonl');

  const exactText = '  Connect to Anna failed — vault G:\\My Drive\\Obsidian\\Brain showed MISSING!!  ';
  const e1 = await appendErrata({
    session_id: 'sess-001',
    ai_platform: 'ChatGPT Codex',
    agent: 'Codex',
    kind: 'bug',
    verbatim_text: exactText,
    context_refs: ['bin/brainlink.mjs:220'],
  }, { file });

  // Exact verbatim text preserved character-for-character
  assert.equal(e1.verbatim_text, exactText);
  assert.equal(e1.status, 'open');

  // Zero-invention guard: rejects fabricated rating/tags at capture time
  await assert.rejects(
    () => appendErrata({ kind: 'bug', verbatim_text: 'broken', rating: 5 }, { file }),
    /Zero-invention/i,
  );
  await assert.rejects(
    () => appendErrata({ kind: 'miss', verbatim_text: 'missed', tags: ['fabricated'] }, { file }),
    /Zero-invention/i,
  );

  // Append-only triage: original line 1 stays byte-identical, new status_change line appended
  const line1Before = (await readFile(file, 'utf8')).trim().split(/\r?\n/)[0];
  const triaged = await triageErrata({ id: e1.id, status: 'triaged', note: 'Reproduced in sandbox', file });
  assert.equal(triaged.status, 'triaged');
  assert.equal(triaged.verbatim_text, exactText);

  const rawLines = (await readFile(file, 'utf8')).trim().split(/\r?\n/);
  assert.equal(rawLines.length, 2);
  assert.equal(rawLines[0], line1Before);

  const openList = await listErrata({ file, status: 'open' });
  assert.equal(openList.length, 0);
  const triagedList = await listErrata({ file, status: 'triaged' });
  assert.equal(triagedList.length, 1);
  assert.equal(triagedList[0].verbatim_text, exactText);
});

test('runHillClimbFromErrata enforces strict --budget cutoff, plateau stop, and records every attempt in RSI ledger', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainlink-hillclimb-'));
  const errataFile = path.join(dir, 'errata.jsonl');
  const stateDir = path.join(dir, 'state');

  for (let i = 1; i <= 5; i++) {
    await appendErrata({ kind: 'miss', verbatim_text: `Real miss #${i}`, ai_platform: 'Claude', agent: 'Anna' }, { file: errataFile });
  }
  // Praise entries should not trigger hillclimb fixes
  await appendErrata({ kind: 'praise', verbatim_text: 'Worked great!', ai_platform: 'Claude', agent: 'Anna' }, { file: errataFile });

  // 1. Strict budget cutoff at 2 even though 5 open misses exist
  let calls = 0;
  const budgetRes = await runHillClimbFromErrata({
    errataFile,
    budget: 2,
    maxNoImprove: 5,
    stateDir,
    evaluateCandidate: async (item) => {
      calls++;
      return { status: 'MEASURED', score: calls * 0.25, candidate_id: `cand-${item.id}`, reason: 'improved' };
    },
  });
  assert.equal(calls, 2);
  assert.equal(budgetRes.attempted, 2);
  assert.equal(budgetRes.stop_reason, 'budget_exhausted');
  assert.equal(budgetRes.best_candidate.score, 0.5);

  // 2. Plateau stop when no improvement for maxNoImprove consecutive attempts
  let plateauCalls = 0;
  const plateauRes = await runHillClimbFromErrata({
    errataFile,
    budget: 5,
    maxNoImprove: 2,
    stateDir,
    evaluateCandidate: async () => {
      plateauCalls++;
      return { status: 'MEASURED', score: plateauCalls === 1 ? 0.6 : 0.4, reason: 'flat' };
    },
  });
  assert.equal(plateauCalls, 3); // 1 improvement + 2 non-improving => plateau
  assert.equal(plateauRes.stop_reason, 'plateau');
  assert.equal(plateauRes.best_candidate.score, 0.6);

  // 3. CLI smoke: brainlink errata add|list|triage and brainlink rsi --from-errata --budget 2
  const cliErrata = path.join(dir, 'cli-errata.jsonl');
  const addRun = spawnSync(process.execPath, [BIN, 'errata', 'add', '--kind', 'complaint', '--text', 'Exact user wording', '--file', cliErrata], { encoding: 'utf8' });
  assert.equal(addRun.status, 0, addRun.stderr);
  const added = JSON.parse(addRun.stdout);
  assert.equal(added.verbatim_text, 'Exact user wording');

  const hcRun = spawnSync(process.execPath, [BIN, 'rsi', '--from-errata', '--errata-file', cliErrata, '--budget', '2', '--state-dir', stateDir], { encoding: 'utf8' });
  assert.equal(hcRun.status, 0, hcRun.stderr);
  const hcOut = JSON.parse(hcRun.stdout);
  assert.equal(hcOut.attempted, 1);
  assert.equal(hcOut.attempts[0].status, 'UNMEASURED');
});
