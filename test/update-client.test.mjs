import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { checkForUpdate, UPDATE_MANIFEST_URL } from '../src/update-client.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const keyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
const payload = {
  schema: 1, channel: 'stable', version: '1.2.9', published_at: '2026-10-28T11:00:00Z',
  assets: [{ platform: 'win32', arch: 'x64', format: 'exe', url: 'https://github.com/iantsai886/brainlink/releases/download/v1.2.9/BrainLink-Setup-1.2.9.exe', sha256: 'a'.repeat(64), size: 1024 }],
};
const bytes = Buffer.from(JSON.stringify(payload));
const envelope = { schema: 1, key_id: keyId, payload: bytes.toString('base64url'), signature: sign(null, bytes, privateKey).toString('base64url') };
const response = (body, { type = 'application/json', status = 200, length, location } = {}) => new Response(body, { status, headers: { 'content-type': type, ...(length ? { 'content-length': String(length) } : {}), ...(location ? { location } : {}) } });
const options = { publicKey: publicPem, currentVersion: '1.2.8', platform: 'win32', arch: 'x64', now: Date.parse('2026-10-28T12:00:00Z') };

test('checks only the fixed release URL and reports a verified matching package', async () => {
  let calls = 0;
  const result = await checkForUpdate({ ...options, fetchImpl: async (url, init) => {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    if (calls++ === 0) {
      assert.equal(url, UPDATE_MANIFEST_URL);
      return response('', { status: 302, location: 'https://release-assets.githubusercontent.com/brainlink-update.json' });
    }
    assert.equal(url, 'https://release-assets.githubusercontent.com/brainlink-update.json');
    return response(JSON.stringify(envelope));
  } });
  assert.equal(result.status, 'available');
  assert.equal(result.version, '1.2.9');
  assert.equal(result.asset.sha256, 'a'.repeat(64));
});

test('does not contact the network when this build has no publisher key', async () => {
  let called = false;
  const result = await checkForUpdate({ ...options, publicKey: '', fetchImpl: async () => { called = true; } });
  assert.equal(result.status, 'unavailable');
  assert.equal(called, false);
});

test('rejects untrusted redirects, a forged manifest, unexpected type, HTTP failure, and oversized body', async () => {
  const forged = { ...envelope, signature: Buffer.alloc(64).toString('base64url') };
  await assert.rejects(checkForUpdate({ ...options, fetchImpl: async () => response('', { status: 302, location: 'http://127.0.0.1/private' }) }), /outside the approved GitHub hosts/);
  let call = 0;
  await assert.rejects(checkForUpdate({ ...options, fetchImpl: async () => ++call === 1
    ? response('', { status: 302, location: 'https://objects.githubusercontent.com/brainlink-update.json' })
    : response(JSON.stringify(forged)) }), /signature verification failed/);
  await assert.rejects(checkForUpdate({ ...options, fetchImpl: async () => response('{}', { type: 'text/html' }) }), /unexpected content type/);
  await assert.rejects(checkForUpdate({ ...options, fetchImpl: async () => response('{}', { status: 503 }) }), /HTTP 503/);
  await assert.rejects(checkForUpdate({ ...options, fetchImpl: async () => response('{}', { length: 100_000 }) }), /larger than the allowed limit/);
});
