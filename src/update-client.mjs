import { verifyUpdateManifest, UPDATE_MANIFEST_LIMITS } from './update-manifest.mjs';

const MANIFEST_URL = 'https://github.com/iantsai886/brainlink/releases/latest/download/brainlink-update.json';
const TIMEOUT_MS = 12_000;
const REDIRECT_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);

function trustedReleaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Release service returned an invalid redirect.'); }
  if (url.protocol !== 'https:' || !REDIRECT_HOSTS.has(url.hostname) || url.username || url.password || url.port || url.hash) {
    throw new Error('Release service redirected outside the approved GitHub hosts.');
  }
  return url.href;
}

async function fetchManifest(fetchImpl, signal) {
  let url = MANIFEST_URL;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers?.get?.('location');
    if (!location || redirects === 3) throw new Error('Release service returned too many redirects.');
    url = trustedReleaseUrl(new URL(location, url).href);
  }
  throw new Error('Release service returned too many redirects.');
}

async function readBoundedJson(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Update manifest is larger than the allowed limit.');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error('Update manifest is larger than the allowed limit.');
    return JSON.parse(text);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('Update manifest is larger than the allowed limit.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock?.(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Fetch and verify the fixed BrainLink release manifest. No package is downloaded or installed. */
export async function checkForUpdate({ publicKey, currentVersion, platform = process.platform, arch = process.arch, channel = 'stable', fetchImpl = fetch, now = Date.now() }) {
  if (!publicKey) return { status: 'unavailable', reason: 'publisher_key_not_configured', current_version: currentVersion };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchManifest(fetchImpl, controller.signal);
    if (!response.ok) throw new Error(`Release service returned HTTP ${response.status}.`);
    const contentType = response.headers?.get?.('content-type') || '';
    if (!/^application\/(?:json|octet-stream)(?:;|$)/i.test(contentType)) throw new Error('Release service returned an unexpected content type.');
    const envelope = await readBoundedJson(response, UPDATE_MANIFEST_LIMITS.maxEnvelopeBytes);
    const verified = verifyUpdateManifest(envelope, publicKey, { currentVersion, platform, arch, channel, now });
    return {
      status: 'available',
      current_version: currentVersion,
      version: verified.version,
      published_at: verified.published_at,
      asset: verified.selected_asset,
    };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Update check timed out. Try again later.');
    throw new Error(`Could not verify BrainLink updates: ${error.message || String(error)}`);
  } finally { clearTimeout(timer); }
}

export const UPDATE_MANIFEST_URL = MANIFEST_URL;
