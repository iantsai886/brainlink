#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const app = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!app) throw new Error('Usage: node scripts/smoke-installed-html.mjs INSTALLED_APP');
const tempRoot = await mkdtemp(path.join(tmpdir(), 'brainlink-html-smoke-'));
const resolvedRoot = path.resolve(tempRoot);
if (!resolvedRoot.startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error('Refusing to use a smoke-test folder outside the system temp directory.');
try {
  const vault = path.join(tempRoot, 'fictional-vault');
  const raw = path.join(vault, 'Raw');
  const home = path.join(tempRoot, 'brainlink-home');
  await mkdir(raw, { recursive: true });
  await writeFile(path.join(raw, 'page.html'), '<!doctype html><html><head><title>Staged HTML &amp; safety</title><script>HTML_SCRIPT_CANARY</script></head><body><main><h1>HTML_VISIBLE_CANARY</h1><p>Saved text &amp; entities.</p><div hidden>HTML_HIDDEN_CANARY</div><span style="display:none">HTML_STYLE_CANARY</span></main></body></html>');
  const fromApp = (file) => import(pathToFileURL(path.join(app, 'src', file)).href);
  const [{ emptyConfig }, { createContext }, { ingestionQueue, readIngestionSource }] = await Promise.all([
    fromApp('config.mjs'), fromApp('core.mjs'), fromApp('ingestion.mjs'),
  ]);
  const config = emptyConfig();
  config.vaults = [{ name: 'Fictional HTML', path: vault, private: false, writes: 'on' }];
  const ctx = createContext(config, { env: { ...process.env, BRAINLINK_HOME: home, BRAINLINK_SEMANTIC: '0' }, trustedLocal: true });
  const queue = await ingestionQueue(ctx, 'Fictional HTML', 'Raw');
  assert.equal(queue.candidates.length, 1, 'the staged app should queue the selected HTML source: ' + JSON.stringify(queue));
  const source = await readIngestionSource(ctx, 'Fictional HTML', 'Raw', queue.candidates[0]);
  assert.match(source.body, /Staged HTML & safety/);
  assert.match(source.body, /HTML_VISIBLE_CANARY/);
  assert.match(source.body, /Saved text & entities/);
  assert.doesNotMatch(source.body, /HTML_SCRIPT_CANARY|HTML_HIDDEN_CANARY|HTML_STYLE_CANARY/);
  console.log('PASS: installed HTML extraction kept visible text and omitted script and hidden content.');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
