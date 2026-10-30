import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { signUpdateManifest } from '../src/update-signing.mjs';
import { verifyUpdateManifest } from '../src/update-manifest.mjs';
import { createReleaseManifest } from '../scripts/sign-update-manifest.mjs';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const payload = {
  schema: 1,
  channel: 'stable',
  version: '1.2.9',
  published_at: '2026-10-30T11:00:00Z',
  assets: [
    { platform: 'win32', arch: 'x64', format: 'exe', url: 'https://github.com/iantsai886/brainlink/releases/download/v1.2.9/BrainLink-Setup-1.2.9.exe', sha256: 'a'.repeat(64), size: 1024 },
    { platform: 'darwin', arch: 'arm64', format: 'pkg', url: 'https://github.com/iantsai886/brainlink/releases/download/v1.2.9/BrainLink-1.2.9.pkg', sha256: 'b'.repeat(64), size: 2048 },
  ],
};

function fixture() {
  const pair = generateKeyPairSync('ed25519');
  const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const keyId = createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
  return { privatePem, publicPem, keyId };
}

test('signs a release payload that the shipped verifier accepts without exposing the private key', () => {
  const keys = fixture();
  const envelope = signUpdateManifest(payload, keys.privatePem, { now: NOW });
  assert.equal(envelope.key_id, keys.keyId);
  assert.equal(JSON.stringify(envelope).includes('PRIVATE KEY'), false);
  const verified = verifyUpdateManifest(envelope, keys.publicPem, { currentVersion: '1.2.8', platform: 'win32', arch: 'x64', now: NOW });
  assert.equal(verified.version, '1.2.9');
  assert.equal(verified.selected_asset.format, 'exe');
});

test('refuses unsupported keys and release payloads rejected by the runtime verifier', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => signUpdateManifest(payload, rsa, { now: NOW }), /requires an Ed25519/);
  assert.throws(() => signUpdateManifest({ ...payload, version: 'bad' }, fixture().privatePem, { now: NOW }), /version/);
  assert.throws(() => signUpdateManifest(null, fixture().privatePem, { now: NOW }), /JSON object/);
});

test('release CLI reads a protected key file, creates a new envelope and refuses overwrite', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brainlink-update-signing-'));
  const keys = fixture();
  const payloadPath = path.join(dir, 'payload.json');
  const privateKeyPath = path.join(dir, 'release-key.pem');
  const outputPath = path.join(dir, 'update-envelope.json');
  await writeFile(payloadPath, JSON.stringify(payload));
  await writeFile(privateKeyPath, keys.privatePem, { mode: 0o600 });
  const oversizedPayloadPath = path.join(dir, 'oversized.json');
  await writeFile(oversizedPayloadPath, ' '.repeat(100 * 1024));
  await assert.rejects(createReleaseManifest({ payloadPath: oversizedPayloadPath, privateKeyPath, outputPath: path.join(dir, 'oversized-envelope.json'), now: NOW }), /allowed file size/);
  if (process.platform !== 'win32') {
    const looseKeyPath = path.join(dir, 'loose-key.pem');
    await writeFile(looseKeyPath, keys.privatePem, { mode: 0o644 });
    await assert.rejects(createReleaseManifest({ payloadPath, privateKeyPath: looseKeyPath, outputPath: path.join(dir, 'must-not-exist.json'), now: NOW }), /owner/);
  }
  const result = await createReleaseManifest({ payloadPath, privateKeyPath, outputPath, now: NOW });
  assert.equal(result.version, '1.2.9');
  const envelopeText = await readFile(outputPath, 'utf8');
  assert.doesNotMatch(envelopeText, /PRIVATE KEY/);
  const verified = verifyUpdateManifest(JSON.parse(envelopeText), keys.publicPem, { currentVersion: '1.2.8', platform: 'darwin', arch: 'arm64', now: NOW });
  assert.equal(verified.selected_asset.format, 'pkg');
  await assert.rejects(createReleaseManifest({ payloadPath, privateKeyPath, outputPath, now: NOW }), { code: 'EEXIST' });

  const cliPayloadPath = path.join(dir, 'cli-payload.json');
  await writeFile(cliPayloadPath, JSON.stringify({ ...payload, published_at: new Date(Date.now() - 60_000).toISOString() }));
  const cliOutputPath = path.join(dir, 'cli-envelope.json');
  const cli = spawnSync(process.execPath, ['scripts/sign-update-manifest.mjs', '--payload', cliPayloadPath, '--key', privateKeyPath, '--out', cliOutputPath], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(verifyUpdateManifest(JSON.parse(await readFile(cliOutputPath, 'utf8')), keys.publicPem, { currentVersion: '1.2.8', platform: 'win32', arch: 'x64' }).version, '1.2.9');
  assert.match(cli.stdout, /Private key material was not written/);
});
