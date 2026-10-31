import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { verifyUpdateManifest, UPDATE_MANIFEST_LIMITS } from './update-manifest.mjs';

const KEY_ID = /^[a-f0-9]{16}$/;

/**
 * Create a detached Ed25519 release envelope. The caller owns key storage;
 * this helper never writes, logs, or returns private key material.
 */
export function signUpdateManifest(payload, privateKeyInput, { now = Date.now() } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Update payload must be a JSON object.');
  let privateKey;
  try { privateKey = createPrivateKey(privateKeyInput); }
  catch { throw new Error('Update signing key could not be read as a private key.'); }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Update signing requires an Ed25519 private key.');

  const publicKey = createPublicKey(privateKey);
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const keyId = createHash('sha256').update(publicDer).digest('hex').slice(0, 16);
  if (!KEY_ID.test(keyId)) throw new Error('Could not derive the update signing key ID.');
  const bytes = Buffer.from(JSON.stringify(payload));
  if (!bytes.length || bytes.length > UPDATE_MANIFEST_LIMITS.maxEnvelopeBytes) throw new Error('Update payload is empty or too large.');

  const envelope = {
    schema: 1,
    key_id: keyId,
    payload: bytes.toString('base64url'),
    signature: sign(null, bytes, privateKey).toString('base64url'),
  };
  const firstAsset = Array.isArray(payload?.assets) ? payload.assets[0] : null;
  if (!firstAsset) throw new Error('Update payload must include at least one package.');
  // Run the exact shipped verifier before returning a signature. This checks all
  // assets and the whole payload, while selecting the first asset for local verification.
  verifyUpdateManifest(envelope, publicPem, {
    currentVersion: '0.0.0',
    channel: payload.channel,
    platform: firstAsset.platform,
    arch: firstAsset.arch,
    now,
  });
  return envelope;
}
