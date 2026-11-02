import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HASH = /^[a-f0-9]{64}$/i;
const KEY_ID = /^[a-f0-9]{16}$/;
const MAX_ENVELOPE_BYTES = 96 * 1024;
const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TRUSTED_UPDATE_KEYS = 4;
const RELEASE_HOSTS = new Set(['github.com']);
const PLATFORMS = new Set(['win32', 'darwin', 'linux']);
const ARCHES = new Set(['x64', 'arm64']);
const FORMATS = new Set(['exe', 'pkg', 'deb', 'tar.gz']);

function fail(message) { throw new Error(`Invalid BrainLink update manifest: ${message}`); }
function onlyKeys(value, allowed, label) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) fail(`${label} contains unsupported fields`);
}

function compareVersions(left, right) {
  const a = left.match(VERSION), b = right.match(VERSION);
  if (!a || !b) fail('versions must use numeric major.minor.patch format');
  const leftParts = a.slice(1).map(Number), rightParts = b.slice(1).map(Number);
  if ([...leftParts, ...rightParts].some((part) => !Number.isSafeInteger(part))) fail('version parts must be safe integers');
  for (let index = 1; index <= 3; index++) {
    const delta = leftParts[index - 1] - rightParts[index - 1];
    if (delta) return Math.sign(delta);
  }
  return 0;
}

function decodeBase64Url(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail(`${label} must be base64url text`);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) fail(`${label} is not canonical base64url`);
  return decoded;
}

export function isValidUtcTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/);
  if (!parts) return false;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  const [, year, month, day, hour, minute, second, fraction = ''] = parts;
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() + 1 === Number(month)
    && date.getUTCDate() === Number(day)
    && date.getUTCHours() === Number(hour)
    && date.getUTCMinutes() === Number(minute)
    && date.getUTCSeconds() === Number(second)
    && date.getUTCMilliseconds() === Number(fraction.padEnd(3, '0') || '0');
}

function validateAsset(asset, index, version) {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) fail(`asset ${index} must be an object`);
  onlyKeys(asset, ['platform', 'arch', 'format', 'url', 'sha256', 'size'], `asset ${index}`);
  const { platform, arch, format, url, sha256, size } = asset;
  if (!PLATFORMS.has(platform) || !ARCHES.has(arch) || !FORMATS.has(format)) fail(`asset ${index} has an unsupported platform, architecture, or format`);
  if (typeof url !== 'string') fail(`asset ${index} needs an HTTPS release URL`);
  let parsed;
  try { parsed = new URL(url); } catch { fail(`asset ${index} needs a valid HTTPS release URL`); }
  if (parsed.protocol !== 'https:' || !RELEASE_HOSTS.has(parsed.hostname) || parsed.username || parsed.password || parsed.port || parsed.hash) {
    fail(`asset ${index} URL must use an approved HTTPS GitHub release host`);
  }
  const prefix = `/iantsai886/brainlink/releases/download/v${version}/`;
  const filename = parsed.pathname.startsWith(prefix) ? parsed.pathname.slice(prefix.length) : '';
  const extension = { exe: '.exe', pkg: '.pkg', deb: '.deb', 'tar.gz': '.tar.gz' }[format];
  if (parsed.search || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,180}$/.test(filename) || !filename.endsWith(extension)) {
    fail(`asset ${index} must point to this version's BrainLink GitHub release asset`);
  }
  if (!HASH.test(String(sha256 || ''))) fail(`asset ${index} needs a SHA-256 checksum`);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_ASSET_BYTES) fail(`asset ${index} size must be between 1 byte and 2 GiB`);
  return { platform, arch, format, url: parsed.href, sha256: sha256.toLowerCase(), size };
}

function validatePayload(payload, { currentVersion, channel, platform, arch, now }) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('payload must be an object');
  onlyKeys(payload, ['schema', 'channel', 'version', 'published_at', 'assets'], 'payload');
  if (payload.schema !== 1) fail('unsupported schema');
  if (!['stable', 'beta'].includes(payload.channel) || payload.channel !== channel) fail('channel does not match the requested update channel');
  if (typeof payload.version !== 'string' || !VERSION.test(payload.version)) fail('version must use numeric major.minor.patch format');
  if (compareVersions(payload.version, currentVersion) <= 0) fail('update is not newer than the installed version');
  if (!isValidUtcTimestamp(payload.published_at)) fail('published_at must be a real UTC ISO timestamp');
  if (Date.parse(payload.published_at) > now + 5 * 60 * 1000) fail('published_at is too far in the future');
  if (!Array.isArray(payload.assets) || payload.assets.length < 1 || payload.assets.length > 20) fail('assets must contain 1 to 20 entries');
  const assets = payload.assets.map((asset, index) => validateAsset(asset, index, payload.version));
  const unique = new Set(assets.map((asset) => `${asset.platform}/${asset.arch}/${asset.format}`));
  if (unique.size !== assets.length) fail('duplicate platform, architecture, and format asset');
  const selected = assets.find((asset) => asset.platform === platform && asset.arch === arch);
  if (!selected) fail(`no package is available for ${platform}/${arch}`);
  return { ...payload, assets, selected_asset: selected };
}

/**
 * Verify a detached Ed25519-signed release envelope without making network calls.
 * Envelope format: { schema: 1, key_id, payload: base64url(JSON bytes), signature: base64url }.
 * The caller must pin the public key and separately verify downloaded asset bytes before use.
 */
export function verifyUpdateManifest(envelope, publicKeyInput, options = {}) {
  const { currentVersion, channel = 'stable', platform = process.platform, arch = process.arch, now = Date.now() } = options;
  if (typeof currentVersion !== 'string' || !VERSION.test(currentVersion)) fail('currentVersion is required and must use numeric major.minor.patch format');
  if (!['stable', 'beta'].includes(channel)) fail('requested channel must be stable or beta');
  if (!PLATFORMS.has(platform) || !ARCHES.has(arch)) fail('unsupported local platform or architecture');
  const envelopeBytes = Buffer.byteLength(JSON.stringify(envelope ?? null));
  if (envelopeBytes > MAX_ENVELOPE_BYTES) fail('envelope is too large');
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope.schema !== 1) fail('unsupported envelope');
  onlyKeys(envelope, ['schema', 'key_id', 'payload', 'signature'], 'envelope');

  const configuredKeys = Array.isArray(publicKeyInput) ? publicKeyInput : [publicKeyInput];
  if (!configuredKeys.length || configuredKeys.length > MAX_TRUSTED_UPDATE_KEYS) fail(`pinned keyring must contain 1 to ${MAX_TRUSTED_UPDATE_KEYS} public keys`);
  const trustedKeys = new Map();
  for (const input of configuredKeys) {
    let publicKey;
    try { publicKey = createPublicKey(input); } catch { fail('pinned public key is invalid'); }
    if (publicKey.asymmetricKeyType !== 'ed25519') fail('pinned keys must be Ed25519');
    const keyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
    if (trustedKeys.has(keyId)) fail('pinned keyring contains a duplicate public key');
    trustedKeys.set(keyId, publicKey);
  }
  if (!KEY_ID.test(String(envelope.key_id || ''))) fail('signing key ID is invalid');
  const publicKey = trustedKeys.get(envelope.key_id);
  if (!publicKey) fail('signing key ID is not in the pinned keyring');

  const bytes = decodeBase64Url(envelope.payload, 'payload');
  if (bytes.length > MAX_ENVELOPE_BYTES) fail('signed payload is too large');
  const signature = decodeBase64Url(envelope.signature, 'signature');
  if (signature.length !== 64 || !verifySignature(null, bytes, publicKey, signature)) fail('signature verification failed');
  let text, payload;
  try { text = bytes.toString('utf8'); payload = JSON.parse(text); } catch { fail('signed payload is not valid JSON'); }
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail('signed payload must be valid UTF-8');
  if (JSON.stringify(payload) !== text) fail('signed payload must use canonical compact JSON');
  return validatePayload(payload, { currentVersion, channel, platform, arch, now });
}

export const UPDATE_MANIFEST_LIMITS = Object.freeze({ maxEnvelopeBytes: MAX_ENVELOPE_BYTES, maxAssetBytes: MAX_ASSET_BYTES, maxTrustedKeys: MAX_TRUSTED_UPDATE_KEYS, releaseHosts: [...RELEASE_HOSTS] });
