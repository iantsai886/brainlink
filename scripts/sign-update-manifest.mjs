#!/usr/bin/env node
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { signUpdateManifest } from '../src/update-signing.mjs';
import { UPDATE_MANIFEST_LIMITS } from '../src/update-manifest.mjs';

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!['--payload', '--key', '--out'].includes(key) || values[key]) throw new Error('Use --payload FILE --key PRIVATE_KEY_FILE --out ENVELOPE_FILE.');
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`A file path is required after ${key}.`);
    values[key] = value;
  }
  if (!values['--payload'] || !values['--key'] || !values['--out']) throw new Error('Use --payload FILE --key PRIVATE_KEY_FILE --out ENVELOPE_FILE.');
  return values;
}

async function regularFile(file, label, { privateKey = false, maxBytes = Infinity } = {}) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file, not a link.`);
  if (info.size > maxBytes) throw new Error(`${label} exceeds the allowed file size.`);
  if (privateKey && info.size > 64 * 1024) throw new Error('Private signing key file is larger than the allowed limit.');
  if (privateKey && process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('On Unix, restrict the private signing key file to its owner (for example chmod 600).');
}

export async function createReleaseManifest({ payloadPath, privateKeyPath, outputPath, now = Date.now() }) {
  await regularFile(payloadPath, 'Payload', { maxBytes: UPDATE_MANIFEST_LIMITS.maxEnvelopeBytes });
  await regularFile(privateKeyPath, 'Private signing key', { privateKey: true });
  const [payloadText, privateKey] = await Promise.all([readFile(payloadPath, 'utf8'), readFile(privateKeyPath)]);
  let payload;
  try { payload = JSON.parse(payloadText); }
  catch { throw new Error('Release payload is not valid JSON.'); }
  const envelope = signUpdateManifest(payload, privateKey, { now });
  const out = path.resolve(outputPath);
  // Refuse overwrite so a release operator cannot silently replace a reviewed envelope.
  await writeFile(out, `${JSON.stringify(envelope)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  return { path: out, version: payload.version, key_id: envelope.key_id };
}

async function main(argv) {
  try {
    const args = argumentsFrom(argv);
    const result = await createReleaseManifest({
      payloadPath: args['--payload'], privateKeyPath: args['--key'], outputPath: args['--out'],
    });
    process.stdout.write(`Signed update manifest created for ${result.version} (key ${result.key_id}).\n`);
    process.stdout.write('Private key material was not written to the manifest. Verify the envelope with the public key before publishing.\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main(process.argv.slice(2));
