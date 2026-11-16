import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createContext } from '../src/core.mjs';
import { normalize } from '../src/config.mjs';
import { buildTidyBatch, tidyAppendBlock } from '../src/tidy.mjs';
import { startSetup } from '../src/setup.mjs';
import { estTokens } from '../src/sessions/tokens.mjs';

const longText = (topic) => `# ${topic}\n${Array.from({ length: 30 }, (_, i) => `The fictional ${topic.toLowerCase()} workflow shares reference terms about scheduling, dispatch, inventory, delivery, and customer coordination ${i}.`).join(' ')}`;

test('tidy suggestions use visible notes only, cap links, retain reasons and include deterministic conflicts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-tidy-'));
  const vault = path.join(root, 'Vault');
  await mkdir(path.join(vault, 'A'), { recursive: true });
  await mkdir(path.join(vault, 'B'), { recursive: true });
  await writeFile(path.join(vault, 'A', 'Source.md'), `${longText('Dispatch workflow')}\nUnique cobalt pallet barcode reconciliation details.`);
  await writeFile(path.join(vault, 'A', 'Broken.md'), `${longText('Broken reference')}\n\nSee [[target-note]].`);
  await writeFile(path.join(vault, 'B', 'Target Note.md'), `${longText('Target')}\nUnique cobalt pallet barcode reconciliation details.`);
  await writeFile(path.join(vault, 'A', 'Private target.md'), '---\nprivate: true\n---\n# Private target\nTIDY_PRIVATE_CANARY');
  await writeFile(path.join(vault, 'A', 'Duplicate.md'), longText('Shared title'));
  await writeFile(path.join(vault, 'B', 'Duplicate.md'), longText('Shared title'));
  const ctx = createContext(normalize({ vaults: [{ name: 'Shared', path: vault }] }), { env: { BRAINLINK_HOME: path.join(root, 'home'), BRAINLINK_SEMANTIC: '0' } });
  const result = await buildTidyBatch(ctx, 'Shared');
  assert.ok(result.items.some((item) => item.kind === 'link'));
  assert.ok(result.items.some((item) => item.kind === 'broken' && item.source.path === 'A/Broken.md' && item.target.path === 'B/Target Note.md'));
  assert.ok(result.items.some((item) => item.kind === 'conflict'));
  assert.ok(result.items.filter((item) => item.kind === 'link').every((item) => item.shared_terms.length > 0 && item.reason.includes('Shared terms')));
  const perSource = new Map();
  for (const item of result.items.filter((item) => item.kind === 'link')) perSource.set(item.source.path, (perSource.get(item.source.path) || 0) + 1);
  assert.ok([...perSource.values()].every((count) => count <= 3));
  assert.doesNotMatch(JSON.stringify(result), /TIDY_PRIVATE_CANARY|Private target\.md/);
  const block = tidyAppendBlock(result.items.filter((item) => item.kind === 'link').slice(0, 1));
  assert.match(block, /^\n\n## Related\n\n- \[\[/);
  assert.ok(estTokens(JSON.stringify(result)) < 1500);
});

test('tidy Setup batches preview exact append blocks, confirm append without replacement, and remember dismissals', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-tidy-ui-'));
  const vault = path.join(root, 'Vault');
  await mkdir(vault);
  const source = `${longText('Dispatch workflow')}\nUnique cobalt pallet barcode reconciliation details.`, target = `${longText('Dispatch reference')}\nUnique cobalt pallet barcode reconciliation details.`;
  await writeFile(path.join(vault, 'Source.md'), source);
  await writeFile(path.join(vault, 'Target.md'), target);
  const app = await startSetup({ env: { BRAINLINK_HOME: path.join(root, 'home'), BRAINLINK_SEMANTIC: '0' }, home: root, os: 'linux', port: 0, useCli: false });
  const base = `http://127.0.0.1:${app.port}`;
  const api = (route, body = {}) => fetch(base + route, { method: 'POST', headers: { 'X-BrainLink-Token': app.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((response) => response.json());
  try {
    await api('/api/vault', { path: vault, name: 'Shared', pack: 'simple', scaffold: false });
    const batch = await api('/api/tidy/generate', { vault: 'Shared' });
    const item = batch.items.find((entry) => entry.kind === 'link' && entry.source.path === 'Source.md' && entry.target.path === 'Target.md');
    assert.ok(item, JSON.stringify(batch));
    const preview = await api('/api/tidy/apply-preview', { batch_id: batch.batch_id, item_ids: [item.id] });
    assert.equal(preview.files.length, 1);
    assert.match(preview.files[0].append, /## Related/);
    assert.equal(await readFile(path.join(vault, 'Source.md'), 'utf8'), source);
    await writeFile(path.join(vault, 'Target.md'), `---\nprivate: true\n---\n${target}\nTIDY_CHANGED_PRIVATE_CANARY`);
    const refused = await api('/api/tidy/apply-confirm', { id: preview.id, confirm: true });
    assert.ok(refused.error, 'confirmation must recheck target visibility after the preview');
    assert.equal(await readFile(path.join(vault, 'Source.md'), 'utf8'), source, 'a newly private target must block the append');
    await writeFile(path.join(vault, 'Target.md'), target);
    const retryBatch = await api('/api/tidy/generate', { vault: 'Shared' });
    const retryItem = retryBatch.items.find((entry) => entry.kind === 'link' && entry.source.path === 'Source.md' && entry.target.path === 'Target.md');
    const retryPreview = await api('/api/tidy/apply-preview', { batch_id: retryBatch.batch_id, item_ids: [retryItem.id] });
    const saved = await api('/api/tidy/apply-confirm', { id: retryPreview.id, confirm: true });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const updated = await readFile(path.join(vault, 'Source.md'), 'utf8');
    assert.ok(updated.startsWith(source));
    assert.match(updated.slice(source.length), /## Related/);
    assert.equal(await readFile(path.join(vault, 'Target.md'), 'utf8'), target);
    const regenerated = await api('/api/tidy/generate', { vault: 'Shared' });
    assert.ok(!regenerated.items.some((entry) => entry.id === item.id));
  } finally { app.server.close(); }
});

test('tidy batch generation stays under 30 seconds and below 50 items on a 3,000-note vault', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bl-tidy-large-'));
  const vault = path.join(root, 'Vault');
  await mkdir(vault);
  await Promise.all(Array.from({ length: 3000 }, (_, i) => writeFile(path.join(vault, `Note-${String(i).padStart(4, '0')}.md`), longText(`dispatch topic ${i}`))));
  const ctx = createContext(normalize({ vaults: [{ name: 'Shared', path: vault }] }), { env: { BRAINLINK_HOME: path.join(root, 'home'), BRAINLINK_SEMANTIC: '0' } });
  const start = Date.now();
  const batch = await buildTidyBatch(ctx, 'Shared');
  const elapsed = Date.now() - start;
  assert.ok(batch.items.length <= 50);
  assert.ok(batch.more > 0);
  assert.ok(elapsed < 30_000, `batch took ${elapsed}ms`);
});
