import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { startSetup } from '../src/setup.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const keyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
const payload = {
  schema: 1, channel: 'stable', version: '1.2.9', published_at: '2026-10-28T11:00:00Z',
  assets: [{ platform: 'linux', arch: 'x64', format: 'deb', url: 'https://github.com/iantsai886/brainlink/releases/download/v1.2.9/brainlink_1.2.9_amd64.deb', sha256: 'b'.repeat(64), size: 1024 }],
};
const bytes = Buffer.from(JSON.stringify(payload));
const envelope = { schema: 1, key_id: keyId, payload: bytes.toString('base64url'), signature: sign(null, bytes, privateKey).toString('base64url') };

test('Setup update check requires its local token and returns only signed release metadata', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'brainlink-update-api-'));
  const app = await startSetup({
    env: { BRAINLINK_HOME: path.join(home, 'app'), HOME: home }, home, os: 'linux', arch: 'x64', useCli: false,
    updatePublicKey: publicPem,
    updateFetch: async () => new Response(JSON.stringify(envelope), { headers: { 'content-type': 'application/json' } }),
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
    assert.equal(result.asset.sha256, 'b'.repeat(64));
    assert.equal(JSON.stringify(result).includes('signature'), false);
  } finally { app.server.close(); }
});
