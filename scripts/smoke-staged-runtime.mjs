#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const nodeArg = argument('--node');
const appArg = argument('--app');
const expectedVersion = argument('--version');
if (!nodeArg || !appArg || !expectedVersion || process.argv.includes('--help')) {
  console.log('Usage: node scripts/smoke-staged-runtime.mjs --node PATH --app PATH --version X.Y.Z');
  process.exit(nodeArg && appArg && expectedVersion ? 0 : 2);
}
const node = path.resolve(nodeArg);
const app = path.resolve(appArg);

const entry = path.join(app, 'bin', 'brainlink.mjs');
const actualVersion = execFileSync(node, [entry, '--version'], { encoding: 'utf8', timeout: 20_000 }).trim();
assert.equal(actualVersion, expectedVersion, 'staged runtime reports the expected version');
for (const skill of ['brainlink-cross-ai-handoff', 'brainlink-session-closeout', 'brainlink-graph-curation']) {
  const file = path.join(app, 'skills', skill, 'SKILL.md');
  await access(file);
}
await assert.rejects(access(path.join(app, 'ui', 'app', 'test')), 'development UI tests must not ship');
await access(path.join(app, 'src', 'ingestion', 'pdf-worker.mjs'));
await access(path.join(app, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs'));
await access(path.join(app, 'node_modules', '@napi-rs', 'canvas', 'package.json'));
await access(path.join(app, 'src', 'ingestion', 'docx-worker.mjs'));
await access(path.join(app, 'src', 'ingestion', 'office-worker.mjs'));
await access(path.join(app, 'src', 'ingestion', 'image-ocr.mjs'));
for (const lang of ['eng', 'por', 'chi_tra']) await access(path.join(app, 'src', 'ingestion', 'tessdata', `${lang}.traineddata.gz`));
await access(path.join(app, 'node_modules', 'mammoth', 'package.json'));
await access(path.join(app, 'node_modules', 'fflate', 'package.json'));
await access(path.join(app, 'node_modules', 'tesseract.js', 'package.json'));
await access(path.join(app, 'node_modules', 'tesseract.js-core', 'package.json'));
execFileSync(node, ['--input-type=module', '-e', "await import('./src/connectors.mjs'); await import('./src/update-manifest.mjs')"], {
  cwd: app,
  encoding: 'utf8',
  timeout: 20_000,
});
execFileSync(node, ['--input-type=module', '-e', "const mammoth = await import('mammoth'); if (typeof mammoth.default.extractRawText !== 'function') process.exit(2)"], {
  cwd: app,
  encoding: 'utf8',
  timeout: 20_000,
});
execFileSync(node, ['--input-type=module', '-e', "const zip = await import('fflate'); if (typeof zip.unzipSync !== 'function') process.exit(2)"], {
  cwd: app,
  encoding: 'utf8',
  timeout: 20_000,
});
execFileSync(node, ['--input-type=module', '-e', "const canvas = await import('@napi-rs/canvas'); if (typeof canvas.createCanvas !== 'function' || canvas.createCanvas(2, 2).width !== 2) process.exit(2)"], {
  cwd: app,
  encoding: 'utf8',
  timeout: 20_000,
});
execFileSync(node, ['--input-type=module', '-e', "const ocr = await import('tesseract.js'); if (typeof ocr.createWorker !== 'function') process.exit(2)"], {
  cwd: app,
  encoding: 'utf8',
  timeout: 20_000,
});
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ocrSmoke = path.join(root, 'scripts', 'smoke-installed-ocr.mjs');
const ocrFixtures = ['ocr-sample.png', 'ocr-portuguese.png', 'ocr-traditional-chinese.png'].map((file) => path.join(root, 'test', 'fixtures', file));
const ocrResult = execFileSync(node, [ocrSmoke, app, ...ocrFixtures], {
  cwd: root,
  encoding: 'utf8',
  timeout: 180_000,
});
process.stdout.write(ocrResult);

const smokeDataRoot = await mkdtemp(path.join(tmpdir(), 'brainlink-staged-smoke-'));
const resolvedRoot = path.resolve(smokeDataRoot);
const resolvedTemp = path.resolve(tmpdir()) + path.sep;
if (!resolvedRoot.startsWith(resolvedTemp)) throw new Error('Refusing to use a smoke-test folder outside the system temp directory.');
try {
const home = path.join(smokeDataRoot, 'home');
const vault = path.join(smokeDataRoot, 'vault');
await mkdir(path.join(vault, 'Private'), { recursive: true });
await writeFile(path.join(vault, 'Public.md'), '---\ntitle: Bluebird Public Roadmap\n---\nProject Bluebird migration budget: 420 credits. PUBLIC_CANARY_56381\n');
await writeFile(path.join(vault, 'Private', 'Hidden.md'), '---\ntitle: Bluebird Confidential Budget\nprivate: true\n---\nProject Bluebird migration budget: 900 credits. PRIVATE_CANARY_88420\n');

const env = {
  ...process.env,
  BRAINLINK_HOME: home,
  BRAINLINK_SEMANTIC: '0',
  HOME: home,
  USERPROFILE: home,
};
execFileSync(node, [entry, 'init', '--vault', vault, '--name', 'Fictional'], { env, encoding: 'utf8', timeout: 20_000 });
const child = spawn(node, [entry, 'serve'], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const replies = new Map();
let buffer = '';
let stderr = '';
let childClosed = false;
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    try {
      const response = JSON.parse(line);
      if (response.id !== undefined) replies.set(response.id, response);
    } catch { /* Non-JSON stdout is ignored; protocol output remains line-framed JSON-RPC. */ }
  }
});
child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
child.once('close', () => { childClosed = true; });

async function request(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (replies.has(message.id)) return replies.get(message.id);
    if (childClosed) throw new Error(`Packaged MCP process exited early: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for packaged MCP response ${message.id}: ${stderr}`);
}

try {
  const initialized = await request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.ok(initialized.result?.protocolVersion, 'packaged MCP server completes initialization');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  const response = await request({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'vault_search', arguments: { vault: 'Fictional', query: 'Bluebird migration budget' } },
  });
  assert.equal(response.error, undefined, JSON.stringify(response));
  const result = JSON.stringify(response.result);
  assert.match(result, /PUBLIC_CANARY_56381/, 'the public fictional note is searchable');
  assert.doesNotMatch(result, /PRIVATE_CANARY_88420/, 'the private fictional note is excluded before tool output');
  console.log('Staged runtime MCP and private-note smoke test passed.');
} finally {
  child.kill();
  if (!childClosed) await new Promise((resolve) => child.once('close', resolve));
  await rm(smokeDataRoot, { recursive: true, force: true });
}
} catch (error) {
  await rm(smokeDataRoot, { recursive: true, force: true });
  throw error;
}
