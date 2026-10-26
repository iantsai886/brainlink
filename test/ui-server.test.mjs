// UI server: localhost-only, per-launch token required on every /api/rpc call; static app files
// and the generated boot script are served; a store call round-trips end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { serveUi } from '../src/ui-server.mjs';
import { createFolderHost } from '../src/host.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function withServer(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bl-ui-'));
  const host = await createFolderHost({ name: 'Demo', folder: path.join(dir, 'vault'), configFile: path.join(dir, 'config.json') });
  const s = await serveUi({ host, port: 0 });
  try { await fn(s); } finally { s.server.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('ui-server: binds 127.0.0.1 and issues a per-launch token in the URL', async () => {
  await withServer((s) => {
    assert.equal(s.server.address().address, '127.0.0.1');
    assert.match(s.url, /\?t=[A-Za-z0-9_-]{20,}/);
  });
});

test('ui-server: /api/rpc rejects a missing or wrong token', async () => {
  await withServer(async (s) => {
    const r1 = await fetch(`http://127.0.0.1:${s.port}/api/rpc`, { method: 'POST', body: '{}' });
    assert.equal(r1.status, 401);
    const r2 = await fetch(`http://127.0.0.1:${s.port}/api/rpc`, { method: 'POST', headers: { 'X-BrainLink-Token': 'wrong-token-wrong-token-x' }, body: '{}' });
    assert.equal(r2.status, 401);
  });
});

test('ui-server: /api/rpc with the right token calls through to the real store', async () => {
  await withServer(async (s) => {
    const call = (target, method, args = []) => fetch(`http://127.0.0.1:${s.port}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BrainLink-Token': s.token }, body: JSON.stringify({ target, method, args }) }).then((r) => r.json());
    const w = await call('store', 'write', [{ vault: 'Demo', path: 'A.md', body: 'hi', frontmatter: {} }, { expected_etag: '' }]);
    assert.match(w.result.id, /^n_/);
    const n = await call('store', 'read', [w.result.id]);
    assert.equal(n.result.body, 'hi');
  });
});

test('ui-server: serves the page and the app\'s own unmodified static files', async () => {
  await withServer(async (s) => {
    const page = await fetch(`http://127.0.0.1:${s.port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /boot\.js/);
    const boot = await fetch(`http://127.0.0.1:${s.port}/boot.js`);
    assert.match(await boot.text(), /brainlinkHost/);
    const appJs = await fetch(`http://127.0.0.1:${s.port}/app/app.mjs`);
    assert.equal(appJs.status, 200);
    assert.match(await appJs.text(), /startApp/);
    const traversal = await fetch(`http://127.0.0.1:${s.port}/app/../../package.json`);
    assert.notEqual(traversal.status, 200);
  });
});
