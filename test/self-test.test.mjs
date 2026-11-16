// Setup self-test and replayable misses: read-only checks of a fictional configuration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { normalize, saveConfig } from '../src/config.mjs';
import { createContext } from '../src/core.mjs';
import { buildPack, scaffold, mergePack } from '../src/packs.mjs';
import { runSelfTest } from '../src/self-test.mjs';
import { createReplayMisses } from '../src/replay-misses.mjs';
import { startSetup } from '../src/setup.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'brainlink-selftest-'));
  const vaultPath = path.join(root, 'Fictional Co');
  await mkdir(vaultPath, { recursive: true });
  const built = buildPack('founder-os', { vaultName: 'Fictional Co', vaultPath, agentName: 'Chief of Staff' });
  await scaffold(vaultPath, built.scaffold);
  const cfg = normalize(mergePack(normalize({ timezone: 'Asia/Taipei' }), built));
  const env = { BRAINLINK_HOME: path.join(root, 'app'), BRAINLINK_SEMANTIC: '0' };
  return { root, vaultPath, cfg, env, ctx: () => createContext(cfg, { env, trustedLocal: true }) };
}

test('self-test flags template role notes, hidden rule notes, hidden folders and a missing mailbox without changing the vault', async () => {
  const f = await fixture();
  const fresh = await runSelfTest(f.ctx());
  assert.equal(fresh.ok, true, JSON.stringify(fresh.checks.filter((c) => c.status === 'fail')));
  assert.ok(fresh.checks.some((c) => c.id === 'role-notes' && c.status === 'warn' && /starter template/.test(c.message)), 'an unfilled Current Goal is reported');
  assert.ok(fresh.checks.some((c) => c.id === 'read-first' && c.status === 'pass'));
  assert.ok(fresh.checks.some((c) => c.id === 'mailbox' && c.status === 'pass'));

  await writeFile(path.join(f.vaultPath, 'Chief of Staff Office', 'Current Goal.md'), '# Current Goal\n\nShip the fictional launch by the end of the quarter with the two agreed pilot customers.\n');
  await mkdir(path.join(f.vaultPath, 'Front Door'));
  await writeFile(path.join(f.vaultPath, 'Front Door', 'Start.md'), '# Start\n\nFictional entry note.\n');
  await writeFile(path.join(f.vaultPath, '.brainlinkignore'), '.obsidian/\nFront Door/\n');
  f.cfg.vaults[0].read_first = ['AGENTS.md', 'Front Door/Start.md', 'Missing Rule.md'];
  f.cfg.handoff = { vault: 'Fictional Co', folder: 'No Such Mailbox' };
  const before = await readFile(path.join(f.vaultPath, 'AGENTS.md'), 'utf8');

  const r = await runSelfTest(f.ctx());
  assert.equal(r.ok, false);
  const find = (id, status, re) => r.checks.find((c) => c.id === id && c.status === status && re.test(c.message));
  assert.ok(find('read-first', 'fail', /Front Door\/Start\.md.*hidden from AIs/), 'a rule note inside an excluded folder is a failure');
  assert.ok(find('read-first', 'fail', /Missing Rule\.md.*does not exist/));
  assert.ok(find('excluded-notes', 'warn', /"Front Door\/" holds 1 note /), 'an excluded folder that holds notes is surfaced');
  assert.ok(!r.checks.some((c) => c.id === 'excluded-notes' && /\.obsidian/.test(c.message)), 'tool folders are not reported');
  assert.ok(find('mailbox', 'fail', /does not exist/));
  assert.ok(!r.checks.some((c) => c.id === 'role-notes' && c.status === 'warn'), 'a filled-in goal no longer warns');
  assert.equal(r.summary.pass + r.summary.warn + r.summary.fail, r.checks.length);
  assert.equal(await readFile(path.join(f.vaultPath, 'AGENTS.md'), 'utf8'), before, 'the self-test never writes');
});

test('replayable misses keep only weak or missing questions, skip private vaults, dedupe, replay and clear', async () => {
  const f = await fixture();
  const home = f.env.BRAINLINK_HOME;
  const misses = createReplayMisses({ home });
  assert.deepEqual(await misses.list(), []);
  assert.equal(await misses.record({ vault: 'Fictional Co', query: 'answered question', status: 'hits' }), false, 'good results are not stored');
  assert.equal(await misses.record({ vault: 'Fictional Co', query: 'secret question', status: 'not_in_brain', isPrivate: true }), false, 'private vaults are never recorded');
  assert.equal(await misses.record({ vault: 'Fictional Co', query: 'Where is the zebracorn launch checklist?', status: 'not_in_brain', source: 'ask' }), true);
  assert.equal(await misses.record({ vault: 'Fictional Co', query: '  where is the ZEBRACORN launch   checklist? ', status: 'weak' }), false, 'the same question is stored once');
  assert.equal((await misses.list()).length, 1);
  if (process.platform !== 'win32') assert.equal((await stat(misses.file)).mode & 0o077, 0, 'the list is readable by the owner only');

  const first = await misses.replay(f.ctx());
  assert.deepEqual([first.total, first.fixed], [1, 0]);
  await writeFile(path.join(f.vaultPath, 'Zebracorn launch checklist.md'), '---\nstatus: active\n---\n# Zebracorn launch checklist\n\nThe zebracorn launch checklist covers pricing review, the pilot customer briefing, the support handover and the launch day rota for the fictional team.\n');
  const second = await misses.replay(f.ctx());
  assert.equal(second.fixed, 1, JSON.stringify(second.results));
  assert.equal(second.results[0].top.path, 'Zebracorn launch checklist.md');
  assert.equal(await misses.markFixed(second.results[0].id, second.results[0].top.path), true);
  assert.equal((await misses.list())[0].fixed_by, second.results[0].top.path, 'the fixed miss stays available as a regression case');

  assert.deepEqual(await misses.clear(), { cleared: 1 });
  assert.deepEqual(await misses.list(), []);
  assert.equal(normalize({}).replay_misses.enabled, false, 'capture is off unless the owner turns it on');
  assert.equal(normalize({ replay_misses: { enabled: 'yes' } }).replay_misses.enabled, false);
});

test('Teach a miss previews, confirms one new note, replays it and records the exact fixed path', async () => {
  const f = await fixture();
  const appHome = f.env.BRAINLINK_HOME;
  const home = path.join(f.root, 'user');
  const privateCanary = 'F1_PRIVATE_NOTE_MUST_NEVER_APPEAR';
  await writeFile(path.join(f.vaultPath, 'Private fixture.md'), `---\nprivate: true\n---\n# Private fixture\n\n${privateCanary}\n`);
  await saveConfig(f.cfg, path.join(appHome, 'config.json'));
  const misses = createReplayMisses({ home: appHome });
  await misses.record({ vault: 'Fictional Co', query: 'Where is the zebracorn launch checklist?', status: 'not_in_brain', source: 'ask' });
  const miss = (await misses.list())[0];
  const app = await startSetup({ env: f.env, home, os: 'linux', port: 0, useCli: false });
  const call = async (body) => fetch(`http://127.0.0.1:${app.port}/api/replay-misses/teach`, {
    method: 'POST', headers: { 'X-BrainLink-Token': app.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const answer = 'The zebracorn launch checklist covers pricing review, the pilot customer briefing, the support handover and the launch day rota for the fictional team.';
    const previewResponse = await call({ miss_id: miss.id, title: 'Zebracorn launch checklist', answer });
    assert.equal(previewResponse.status, 200, await previewResponse.clone().text());
    const preview = await previewResponse.json();
    assert.equal(preview.written, false);
    assert.ok(preview.preview_id);
    assert.ok(preview.destination.startsWith(`Fictional Co/${f.cfg.vaults[0].intake_folder}/`));
    assert.match(preview.preview, /status: active/);
    assert.match(preview.preview, /confidence: "verified"/);
    assert.match(preview.preview, /source: "owner answer to a recorded miss"/);
    assert.doesNotMatch(JSON.stringify(preview), new RegExp(privateCanary), 'private note content is not used in the preview or related-note suggestions');
    const notePath = path.join(f.vaultPath, preview.destination.slice('Fictional Co/'.length));
    assert.equal(await stat(notePath).then(() => true, () => false), false, 'preview creates no file');

    const secretPreview = await call({ miss_id: miss.id, title: 'Secret answer', answer: 'Use this key sk-abcdefghijklmnopqrstuvwxyz123456 to sign in.' });
    assert.equal(secretPreview.status, 400);
    assert.doesNotMatch(await secretPreview.text(), /sk-abcdefghijklmnopqrstuvwxyz123456/);
    const missingPreviewConfirmation = await call({ miss_id: miss.id, title: 'Zebracorn launch checklist', answer, confirm: true });
    assert.equal(missingPreviewConfirmation.status, 400, 'saving requires the preview receipt');
    assert.equal(await stat(notePath).then(() => true, () => false), false);

    const savedResponse = await call({ miss_id: miss.id, title: 'Zebracorn launch checklist', answer, preview_id: preview.preview_id, confirm: true });
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    assert.equal(saved.written, true);
    assert.equal(saved.replay.status, 'hits');
    assert.equal(saved.replay.top.path, preview.destination.slice('Fictional Co/'.length));
    assert.equal(saved.fixed_by, saved.path);
    const savedText = await readFile(notePath, 'utf8');
    assert.match(savedText, /The zebracorn launch checklist covers pricing review/);
    assert.equal((await readdir(path.dirname(notePath))).filter((name) => name.includes('Zebracorn launch checklist')).length, 1);
    assert.equal((await misses.get(miss.id)).fixed_by, saved.path);
    assert.equal(await stat(path.join(appHome, 'rsi', 'rsi-ledger.jsonl')).then(() => true, () => false), false, 'answer text is not written to the RSI ledger');

    const visible = await fetch(`http://127.0.0.1:${app.port}/api/replay-misses`, { headers: { 'X-BrainLink-Token': app.token } }).then((r) => r.json());
    assert.equal(visible.count, 1);
    assert.equal(visible.items[0].fixed_by, saved.path);
  } finally { app.server.close(); }
});

test('a replay miss becomes invisible and cannot be taught after its vault is made private', async () => {
  const f = await fixture();
  await saveConfig(f.cfg, path.join(f.env.BRAINLINK_HOME, 'config.json'));
  const misses = createReplayMisses({ home: f.env.BRAINLINK_HOME });
  await misses.record({ vault: 'Fictional Co', query: 'FICTIONAL_PRIVATE_MISS_CANARY', status: 'not_in_brain' });
  const miss = (await misses.list())[0];
  const app = await startSetup({ env: f.env, home: path.join(f.root, 'user'), os: 'linux', port: 0, useCli: false });
  const get = () => fetch(`http://127.0.0.1:${app.port}/api/replay-misses`, { headers: { 'X-BrainLink-Token': app.token } });
  try {
    const current = await (await import('../src/config.mjs')).loadConfig(path.join(f.env.BRAINLINK_HOME, 'config.json'));
    current.vaults[0].private = true;
    await saveConfig(current, path.join(f.env.BRAINLINK_HOME, 'config.json'));
    const listed = await get();
    assert.equal(listed.status, 200);
    assert.doesNotMatch(await listed.text(), /FICTIONAL_PRIVATE_MISS_CANARY|Fictional Co/);
    const taught = await fetch(`http://127.0.0.1:${app.port}/api/replay-misses/teach`, {
      method: 'POST', headers: { 'X-BrainLink-Token': app.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ miss_id: miss.id, title: 'Private answer', answer: 'Fictional private information.' }),
    });
    assert.equal(taught.status, 400);
    assert.doesNotMatch(await taught.text(), /FICTIONAL_PRIVATE_MISS_CANARY|Fictional Co/);
  } finally { app.server.close(); }
});
