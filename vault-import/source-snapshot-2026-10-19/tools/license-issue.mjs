#!/usr/bin/env node
// Vendor-side licence tool. NOT shipped in the installer.
//   node tools/license-issue.mjs keygen  [--out DIR]       create the Ed25519 issuer keypair
//   node tools/license-issue.mjs issue --email x@y --plan personal|trial|team [--days N] [--updates-days 365] [--seats N] [--key FILE]
// Wire `issue` to the Lemon Squeezy / Paddle "order created" webhook to email keys on purchase.
import { generateKeyPairSync, createPrivateKey, sign, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalPayload, encodeKey } from '../src/license.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i === -1 ? dflt : args[i + 1]; };
const DEFAULT_DIR = path.join(homedir(), '.brainlink-issuer');

export function issue(privateKeyPem, { email, plan, days, updatesDays = 365, seats = 1, now = new Date() }) {
  const addDays = (n) => new Date(now.getTime() + n * 86400e3).toISOString().slice(0, 10);
  const json = canonicalPayload({ email, plan, seats: Number(seats), issued: now.toISOString().slice(0, 10), expires: days ? addDays(Number(days)) : null, updates_until: addDays(Number(updatesDays)), id: randomUUID() });
  return encodeKey(json, sign(null, Buffer.from(json), createPrivateKey(privateKeyPem)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = args[0];
  if (cmd === 'keygen') {
    const dir = opt('out', DEFAULT_DIR);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, 'issuer-private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    await writeFile(path.join(dir, 'issuer-public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
    console.log(`Keypair written to ${dir}. Paste issuer-public.pem into src/license-key.mjs. Back up issuer-private.pem offline; never commit or ship it.`);
  } else if (cmd === 'issue') {
    const email = opt('email'), plan = opt('plan', 'personal');
    if (!email) { console.error('--email is required'); process.exit(1); }
    const pem = await readFile(opt('key', path.join(DEFAULT_DIR, 'issuer-private.pem')), 'utf8');
    const days = opt('days', plan === 'trial' ? '14' : (plan === 'team' ? '31' : null));
    console.log(issue(pem, { email, plan, days, updatesDays: opt('updates-days', 365), seats: opt('seats', 1) }));
  } else {
    console.error('usage: license-issue.mjs keygen | issue --email E --plan personal|trial|team [--days N]');
    process.exit(1);
  }
}
