import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { startSetup } from '../src/setup.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const keyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
const packageBytes = Buffer.from('fictional signed package bytes');
const payload = {
  schema: 1, channel: 'stable', version: '1.2.9', published_at: '2026-10-28T11:00:00Z',
  assets: [{ platform: 'linux', arch: 'x64', format: 'deb', url: 'https://github.com/iantsai886/brainlink/releases/download/v1.2.9/brainlink_1.2.9_amd64.deb', sha256: createHash('sha256').update(packageBytes).digest('hex'), size: packageBytes.length }],
};
const bytes = Buffer.from(JSON.stringify(payload));
const envelope = { schema: 1, key_id: keyId, payload: bytes.toString('base64url'), signature: sign(null, bytes, privateKey).toString('base64url') };

test('Setup update check requires its local token and returns only signed release metadata', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'brainlink-update-api-'));
  const app = await startSetup({
    env: { BRAINLINK_HOME: path.join(home, 'app'), HOME: home }, home, os: 'linux', arch: 'x64', useCli: false,
    updatePublicKey: publicPem,
    updateTempRoot: home,
    updateFetch: async (url) => url.includes('/releases/download/')
      ? new Response(packageBytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(packageBytes.length) } })
      : new Response(JSON.stringify(envelope), { headers: { 'content-type': 'application/json' } }),
  });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    assert.equal((await fetch(`${base}/api/updates/check`)).status, 401);
    const response = await fetch(`${base}/api/updates/check`, { headers: { 'X-BrainLink-Token': app.token } });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, 'available');
    assert.equal(result.version, '1.2.9');
    assert.equal(result.asset.format, 'deb');
    assert.equal(result.asset.sha256, payload.assets[0].sha256);
    assert.equal(JSON.stringify(result).includes('signature'), false);

    const unauthorizedDownload = await fetch(`${base}/api/updates/download`, { method: 'POST' });
    assert.equal(unauthorizedDownload.status, 401);
    const preparedResponse = await fetch(`${base}/api/updates/download`, { method: 'POST', headers: { 'X-BrainLink-Token': app.token, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(preparedResponse.status, 200);
    const prepared = await preparedResponse.json();
    assert.equal(prepared.status, 'ready');
    assert.equal(prepared.sha256, payload.assets[0].sha256);
    const fileUrl = new URL(prepared.download_url, base);
    fileUrl.searchParams.set('t', 'wrong-token');
    assert.equal((await fetch(fileUrl)).status, 401, 'a bad local token must not consume the one-time download ticket');
    const file = await fetch(new URL(prepared.download_url, base));
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-disposition'), 'attachment; filename="brainlink_1.2.9_amd64.deb"');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), packageBytes);
    for (let attempt = 0; attempt < 50 && (await readdir(home)).some((name) => name.startsWith('brainlink-update-')); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual((await readdir(home)).filter((name) => name.startsWith('brainlink-update-')), [], 'successful downloads are removed after serving');
    assert.equal((await fetch(new URL(prepared.download_url, base))).status, 404, 'the download ticket can be used only once');
  } finally { app.server.close(); }
});
