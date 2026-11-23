import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { verifyUpdateManifest } from '../src/update-manifest.mjs';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const keyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);

function payload(overrides = {}) {
  return {
    schema: 1,
    channel: 'stable',
    version: '1.2.9',
    published_at: '2026-10-28T11:00:00Z',
    assets: [
      { platform: 'win32', arch: 'x64', format: 'exe', url: 'https://github.com/iantsai886/brainlink/releases/download/v1.2.9/BrainLink-Setup-1.2.9.exe', sha256: 'a'.repeat(64), size: 1024 },
      { platform: 'darwin', arch: 'arm64', format: 'pkg', url: 'https://github.com/iantsai886/brainlink/releases/download/v1.2.9/BrainLink-1.2.9.pkg', sha256: 'b'.repeat(64), size: 2048 },
    ],
    ...overrides,
  };
}

function envelopeFor(value, { raw } = {}) {
  const bytes = Buffer.from(raw ?? JSON.stringify(value));
  return { schema: 1, key_id: keyId, payload: bytes.toString('base64url'), signature: sign(null, bytes, privateKey).toString('base64url') };
}

function verify(value = payload(), options = {}) {
  return verifyUpdateManifest(envelopeFor(value), publicPem, { currentVersion: '1.2.8', platform: 'win32', arch: 'x64', now: NOW, ...options });
}

test('verifies a signed update and selects the matching OS package', () => {
  const result = verify();
  assert.equal(result.version, '1.2.9');
  assert.equal(result.selected_asset.format, 'exe');
  assert.equal(result.selected_asset.size, 1024);
  assert.equal(result.selected_asset.sha256, 'a'.repeat(64));
});

test('rejects a changed payload, wrong pinned key, or mismatched key ID', () => {
  const envelope = envelopeFor(payload());
  envelope.payload = Buffer.from(JSON.stringify(payload({ version: '1.3.0' }))).toString('base64url');
  assert.throws(() => verifyUpdateManifest(envelope, publicPem, { currentVersion: '1.2.8', platform: 'win32', arch: 'x64', now: NOW }), /signature verification failed/);
  const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => verifyUpdateManifest(envelopeFor(payload()), other, { currentVersion: '1.2.8', platform: 'win32', arch: 'x64', now: NOW }), /key ID/);
  const wrongId = envelopeFor(payload());
  wrongId.key_id = '0'.repeat(16);
  assert.throws(() => verifyUpdateManifest(wrongId, publicPem, { currentVersion: '1.2.8', platform: 'win32', arch: 'x64', now: NOW }), /key ID/);
});

test('pinned keyring supports an overlap rotation and rejects unpinned or duplicate keys', () => {
  const nextPair = generateKeyPairSync('ed25519');
  const nextPrivate = nextPair.privateKey;
  const nextPublicPem = nextPair.publicKey.export({ type: 'spki', format: 'pem' });
  const nextKeyId = createHash('sha256').update(nextPair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
  const oldEnvelope = envelopeFor(payload());
  const bytes = Buffer.from(JSON.stringify(payload()));
  const nextEnvelope = { schema: 1, key_id: nextKeyId, payload: bytes.toString('base64url'), signature: sign(null, bytes, nextPrivate).toString('base64url') };
  const options = { currentVersion: '1.2.8', platform: 'win32', arch: 'x64', now: NOW };
  assert.equal(verifyUpdateManifest(oldEnvelope, [publicPem, nextPublicPem], options).version, '1.2.9');
  assert.equal(verifyUpdateManifest(nextEnvelope, [publicPem, nextPublicPem], options).version, '1.2.9');
  assert.throws(() => verifyUpdateManifest(nextEnvelope, [publicPem], options), /not in the pinned keyring/);
  assert.throws(() => verifyUpdateManifest(nextEnvelope, [nextPublicPem, nextPublicPem], options), /duplicate/);
  assert.throws(() => verifyUpdateManifest(nextEnvelope, Array(5).fill(nextPublicPem), options), /1 to 4/);
});

test('rejects downgrade, wrong channel, future publication time, and a missing platform package', () => {
  assert.throws(() => verify(payload({ version: '1.2.8' })), /not newer/);
  assert.throws(() => verify(payload({ channel: 'beta' })), /channel/);
  assert.throws(() => verify(payload({ published_at: '2026-10-29T00:00:00Z' })), /future/);
  assert.throws(() => verify(payload({ assets: [payload().assets[1]] })), /no package/);
});

test('rejects impossible UTC calendar dates and clock values', () => {
  for (const published_at of [
    '2026-02-31T11:00:00Z',
    '2026-13-01T11:00:00Z',
    '2026-10-28T24:00:00Z',
    '2026-10-28T11:60:00Z',
    '2026-10-28T11:00:60Z',
  ]) assert.throws(() => verify(payload({ published_at })), /real UTC ISO timestamp/);
});

test('rejects non-GitHub URLs, wrong release versions, weak hashes, and unsafe sizes', () => {
  const base = payload();
  for (const asset of [
    { ...base.assets[0], url: 'http://github.com/iantsai886/brainlink/releases/download/v1.2.9/a.exe' },
    { ...base.assets[0], url: 'https://example.com/iantsai886/brainlink/releases/download/v1.2.9/a.exe' },
    { ...base.assets[0], url: 'https://github.com/iantsai886/brainlink/releases/download/v1.2.8/a.exe' },
    { ...base.assets[0], url: 'https://github.com/another-owner/other-project/releases/download/v1.2.9/a.exe' },
    { ...base.assets[0], url: 'https://github.com/iantsai886/brainlink/releases/download/v1.2.9/%2e%2e.exe' },
    { ...base.assets[0], url: 'https://github.com/iantsai886/brainlink/releases/download/v1.2.9/a.exe?redirect=elsewhere' },
    { ...base.assets[0], url: 'https://github.com/iantsai886/brainlink/releases/download/v1.2.9/a.pkg' },
    { ...base.assets[0], sha256: 'not-a-hash' },
    { ...base.assets[0], size: 0 },
    { ...base.assets[0], size: 3 * 1024 * 1024 * 1024 },
  ]) assert.throws(() => verify(payload({ assets: [asset] })), /asset 0/);
});

test('rejects duplicate and unknown manifest fields and non-canonical signed JSON', () => {
  const duplicate = payload({ assets: [...payload().assets, payload().assets[0]] });
  assert.throws(() => verify(duplicate), /duplicate/);
  assert.throws(() => verify(payload({ unsigned_extension: true })), /unsupported fields/);
  assert.throws(() => verifyUpdateManifest(envelopeFor(payload(), { raw: JSON.stringify(payload(), null, 2) }), publicPem,
    { currentVersion: '1.2.8', platform: 'win32', arch: 'x64', now: NOW }), /canonical compact JSON/);
});
