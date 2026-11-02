// User-invoked Raw-to-Wiki intake. It scans one explicitly selected folder, checks vault and
// path scope plus bounded frontmatter privacy before reading Markdown bodies, and records only
// opaque identifiers and outcomes in the local app-data journal.
import { appendFile, lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { appHome } from './config.mjs';
import { indexableHeader, isExcludedPath, isPrivateMeta, fmSaysPrivate, parseFrontmatter, safeJoin, vault, vaultRoot } from './core.mjs';
import { extractLinks } from './graph.mjs';
import { redactText } from './sessions/redact.mjs';
import { extractImageText, imageDimensions } from './ingestion/image-ocr.mjs';

const hash = (s) => createHash('sha256').update(Buffer.isBuffer(s) ? s : String(s)).digest('hex');
const MAX_NOTES = 5000;
const MAX_DEPTH = 32;
const MAX_NOTE_BYTES = 5 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_DRAFT_SOURCE_CHARS = 24_000;
const TEXT_SOURCE_FORMATS = new Set(['.md', '.txt', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.log', '.html', '.htm', '.pdf', '.docx', '.xlsx', '.pptx', '.png', '.jpg', '.jpeg', '.bmp']);
const PDF_WORKER_TIMEOUT_MS = 90_000;
const DOCX_WORKER_TIMEOUT_MS = 15_000;
const OFFICE_WORKER_TIMEOUT_MS = 15_000;
const HTML_WORKER_TIMEOUT_MS = 15_000;

function sourceExtension(rel) { return path.posix.extname(String(rel || '')).toLowerCase(); }

function isSupportedSource(rel) { return TEXT_SOURCE_FORMATS.has(sourceExtension(rel)); }

function decodeSourceText(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
  catch { throw new Error('This source is not valid UTF-8 text.'); }
  if (text.includes('\0')) throw new Error('This source contains binary data and cannot be read as text.');
  return text;
}

function extractPdfText(bytes) {
  if (!Buffer.from(bytes).subarray(0, 5).equals(Buffer.from('%PDF-'))) return Promise.reject(new Error('This file is not a valid PDF.'));
  const data = Uint8Array.from(bytes);
  const worker = new Worker(new URL('./ingestion/pdf-worker.mjs', import.meta.url), {
    workerData: data,
    transferList: [data.buffer],
    resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 24, stackSizeMb: 4 },
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      void worker.terminate();
      finish(reject, new Error('PDF extraction exceeded its time limit.'));
    }, PDF_WORKER_TIMEOUT_MS);
    timer.unref?.();
    worker.once('message', (result) => {
      if (result?.ok && typeof result.text === 'string') finish(resolve, result);
      else {
        const reason = result?.reason === 'no_text'
          ? 'This PDF has no readable text. If it is scanned, its pages may be blank, too faint, or outside the OCR page limit.'
          : result?.reason === 'page_limit'
            ? 'This PDF is over the 100-page extraction limit.'
            : 'This PDF could not be safely extracted.';
        finish(reject, new Error(reason));
      }
    });
    worker.once('error', () => finish(reject, new Error('This PDF could not be safely extracted.')));
    worker.once('exit', (code) => {
      if (!settled && code !== 0) finish(reject, new Error('This PDF could not be safely extracted.'));
      else if (!settled) finish(reject, new Error('PDF extraction ended without a result.'));
    });
  });
}

function validateOfficeArchive(bytes, requiredPart) {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) throw new Error('This is not a valid Office document.');
  const searchFrom = Math.max(0, buffer.length - 22 - 0xffff);
  let end = -1;
  for (let offset = buffer.length - 22; offset >= searchFrom; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      const commentLength = buffer.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === buffer.length) { end = offset; break; }
    }
  }
  if (end < 0) throw new Error('This Office archive is incomplete or unsupported.');
  const disk = buffer.readUInt16LE(end + 4);
  const centralDisk = buffer.readUInt16LE(end + 6);
  const diskEntries = buffer.readUInt16LE(end + 8);
  const entryCount = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralOffset = buffer.readUInt32LE(end + 16);
  if (disk || centralDisk || diskEntries !== entryCount || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff || entryCount > 2048 || centralOffset + centralSize > end) throw new Error('This Office archive uses an unsupported or unsafe ZIP layout.');
  let offset = centralOffset;
  let expandedBytes = 0;
  const names = new Set();
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > centralOffset + centralSize || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('This Office archive has a malformed directory.');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedBytes = buffer.readUInt32LE(offset + 20);
    const uncompressedBytes = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > centralOffset + centralSize || !nameLength || nameLength > 4096 || (flags & 1) || (method !== 0 && method !== 8) || compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff || uncompressedBytes > 20 * 1024 * 1024) throw new Error('This Office archive contains an unsupported or unsafe entry.');
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name.startsWith('/') || name.includes('\\') || name.split('/').some((part) => part === '..' || part === '.')) throw new Error('This Office archive contains an unsafe entry path.');
    if (names.has(name)) throw new Error('This Office archive contains duplicate entry names.');
    names.add(name);
    expandedBytes += uncompressedBytes;
    if (expandedBytes > 32 * 1024 * 1024) throw new Error('This Office archive expands beyond the 32 MB safety limit.');
    offset = entryEnd;
  }
  if (offset !== centralOffset + centralSize || !names.has(requiredPart)) throw new Error('This Office archive is missing its main document.');
}

function validateDocxArchive(bytes) { return validateOfficeArchive(bytes, 'word/document.xml'); }

function extractDocxText(bytes) {
  try { validateDocxArchive(bytes); }
  catch (error) { return Promise.reject(error); }
  const data = Uint8Array.from(bytes);
  const worker = new Worker(new URL('./ingestion/docx-worker.mjs', import.meta.url), {
    workerData: data,
    transferList: [data.buffer],
    resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 24, stackSizeMb: 4 },
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      void worker.terminate();
      finish(reject, new Error('DOCX extraction exceeded its time limit.'));
    }, DOCX_WORKER_TIMEOUT_MS);
    timer.unref?.();
    worker.once('message', (result) => {
      if (result?.ok && typeof result.text === 'string') finish(resolve, result);
      else {
        const reason = result?.reason === 'no_text' ? 'This DOCX has no readable text.' : 'This DOCX could not be safely extracted.';
        finish(reject, new Error(reason));
      }
    });
    worker.once('error', () => finish(reject, new Error('This DOCX could not be safely extracted.')));
    worker.once('exit', (code) => {
      if (!settled && code !== 0) finish(reject, new Error('This DOCX could not be safely extracted.'));
      else if (!settled) finish(reject, new Error('DOCX extraction ended without a result.'));
    });
  });
}

function extractOfficeText(bytes, extension) {
  const kind = extension === '.xlsx' ? 'xlsx' : 'pptx';
  try { validateOfficeArchive(bytes, kind === 'xlsx' ? 'xl/workbook.xml' : 'ppt/presentation.xml'); }
  catch (error) { return Promise.reject(error); }
  const data = Uint8Array.from(bytes);
  const worker = new Worker(new URL('./ingestion/office-worker.mjs', import.meta.url), {
    workerData: { data, kind }, transferList: [data.buffer],
    resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 24, stackSizeMb: 4 },
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => { void worker.terminate(); finish(reject, new Error('Office text extraction exceeded its time limit.')); }, OFFICE_WORKER_TIMEOUT_MS);
    timer.unref?.();
    worker.once('message', (result) => {
      if (result?.ok && typeof result.text === 'string') finish(resolve, result);
      else finish(reject, new Error(result?.reason === 'no_text' ? 'This Office file has no readable text.' : 'This Office file could not be safely extracted.'));
    });
    worker.once('error', () => finish(reject, new Error('This Office file could not be safely extracted.')));
    worker.once('exit', (code) => {
      if (!settled) finish(reject, new Error(code === 0 ? 'Office text extraction ended without a result.' : 'This Office file could not be safely extracted.'));
    });
  });
}

function extractHtmlText(bytes) {
  const data = Uint8Array.from(bytes);
  const worker = new Worker(new URL('./ingestion/html-worker.mjs', import.meta.url), {
    workerData: data, transferList: [data.buffer],
    resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 24, stackSizeMb: 4 },
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => { void worker.terminate(); finish(reject, new Error('HTML extraction exceeded its time limit.')); }, HTML_WORKER_TIMEOUT_MS);
    timer.unref?.();
    worker.once('message', (result) => {
      if (result?.ok && typeof result.text === 'string') finish(resolve, result);
      else finish(reject, new Error(result?.reason === 'no_text' ? 'This HTML file has no readable text.' : 'This HTML file could not be safely extracted.'));
    });
    worker.once('error', () => finish(reject, new Error('This HTML file could not be safely extracted.')));
    worker.once('exit', (code) => {
      if (!settled) finish(reject, new Error(code === 0 ? 'HTML extraction ended without a result.' : 'This HTML file could not be safely extracted.'));
    });
  });
}

function selectedFolder(value) {
  const folder = String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const parts = folder.split('/');
  if (!folder || folder.length > 240 || parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.') || /[:*?"<>|]/.test(p))) {
    throw new Error('Choose one existing, visible folder inside the selected vault. The vault root is not scanned.');
  }
  return { folder, parts };
}

async function checkedFolder(ctx, vaultName, requested) {
  const v = vault(ctx, vaultName);
  if (v.private) throw new Error('Raw-to-Wiki intake is unavailable for a private vault.');
  const { folder, parts } = selectedFolder(requested);
  const root = vaultRoot(ctx, vaultName);
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('The selected vault root is not a regular directory.');
  const realRoot = await realpath(root);
  if (await isExcludedPath(root, folder)) throw new Error('The selected folder is hidden or excluded by this vault.');
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const st = await lstat(current);
    if (st.isSymbolicLink()) throw new Error('The selected folder contains a symlink; intake stopped.');
    if (!st.isDirectory()) throw new Error('The selected folder does not exist.');
  }
  const realFolder = await realpath(current);
  const rel = path.relative(realRoot, realFolder);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || await isExcludedPath(root, rel.split(path.sep).join('/'))) throw new Error('The selected folder resolves outside its vault or into an excluded area.');
  return { v, root, realRoot, folder, full: current };
}

function scopeId(ctx, vaultName, root) {
  return hash(`${path.resolve(root)}\0${vaultName}\0${ctx.twinScope?.profile_id || 'unscoped'}`);
}

function sourceId(scope, rel) { return hash(`${scope}\0${rel}`); }

// Common OS/editor metadata and temporary files are never useful knowledge sources.
// Keep this list explicit so we do not accidentally exclude user dotfiles wholesale.
function isOsMetadataPath(rel) {
  return rel.split(/[\\/]/).some((name) =>
    name.startsWith('.') ||
    name.startsWith('._') ||
    name.startsWith('~$') ||
    /^(?:\.DS_Store|Thumbs\.db|ehthumbs\.db|desktop\.ini|Icon\r)$/i.test(name)
  );
}

async function readEligible(full, root, realRoot, rel, { includeBody = false } = {}) {
  if (isOsMetadataPath(rel)) return null;
  if (await isExcludedPath(root, rel)) return null;
  const before = await lstat(full);
  if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_NOTE_BYTES) return null;
  const extension = sourceExtension(rel);
  if (!isSupportedSource(rel)) return null;
  const real = await realpath(full);
  const relReal = path.relative(realRoot, real);
  if (relReal === '..' || relReal.startsWith(`..${path.sep}`) || path.isAbsolute(relReal) || await isExcludedPath(root, relReal.split(path.sep).join('/'))) return null;

  const fh = await open(full, 'r');
  try {
    const opened = await fh.stat();
    if (!opened.isFile() || opened.size !== before.size || (opened.ino && before.ino && opened.ino !== before.ino) || (opened.dev && before.dev && opened.dev !== before.dev)) return null;
    if (extension === '.md') {
      const header = Buffer.alloc(Math.min(opened.size, MAX_HEADER_BYTES));
      const { bytesRead } = await fh.read(header, 0, header.length, 0);
      if (!indexableHeader(header.subarray(0, bytesRead).toString('utf8'), opened.size, bytesRead)) return null;
    }
    // Scope and .brainlinkignore exclusions were checked before opening the source. Markdown
    // additionally requires a bounded frontmatter privacy check before its body is read.
    const bytes = await fh.readFile();
    let raw;
    if (extension === '.pdf') raw = includeBody ? await extractPdfText(bytes) : { text: '' };
    else if (extension === '.docx') {
      validateDocxArchive(bytes);
      raw = includeBody ? await extractDocxText(bytes) : { text: '' };
    } else if (extension === '.xlsx' || extension === '.pptx') raw = includeBody ? await extractOfficeText(bytes, extension) : { text: '' };
    else if (extension === '.html' || extension === '.htm') raw = includeBody ? await extractHtmlText(bytes) : { text: '' };
    else if (['.png', '.jpg', '.jpeg', '.bmp'].includes(extension)) {
      imageDimensions(bytes, extension);
      raw = includeBody ? await extractImageText(bytes) : { text: '' };
    }
    else raw = { text: decodeSourceText(bytes) };
    const after = await fh.stat();
    const pathAfter = await lstat(full);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || pathAfter.isSymbolicLink() || (pathAfter.ino && opened.ino && pathAfter.ino !== opened.ino)) return null;
    let body = raw.text;
    if (extension === '.md') {
      const { meta, body: markdownBody, frontmatter } = parseFrontmatter(raw.text);
      if (isPrivateMeta(meta) || fmSaysPrivate(frontmatter) || meta.generated_by === 'brainlink') return null;
      body = markdownBody;
    }
    const imageBase64 = includeBody && ['.png', '.jpg', '.jpeg'].includes(extension) ? bytes.toString('base64') : undefined;
    return { rel, title: path.posix.basename(rel).slice(0, -extension.length), format: extension.slice(1), revision: hash(bytes), updated_at: new Date(after.mtimeMs).toISOString(), ...(includeBody ? { body, body_truncated: raw.truncated === true, ...(imageBase64 ? { image_base64: imageBase64 } : {}) } : {}) };
  } finally { await fh.close(); }
}

async function sourcesInFolder(ctx, vaultName, folderInfo) {
  const out = [];
  let visited = 0, skipped = 0, truncated = false;
  async function visit(dir, relDir, depth = 0) {
    if (truncated) return;
    if (depth > MAX_DEPTH) { skipped++; return; }
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (truncated) return;
      if (++visited > MAX_NOTES) { truncated = true; return; }
      const rel = `${relDir}/${entry.name}`;
      if (isOsMetadataPath(rel)) { skipped++; continue; }
      if (await isExcludedPath(folderInfo.root, rel)) { skipped++; continue; }
      const full = path.join(dir, entry.name);
      const st = await lstat(full).catch(() => null);
      if (!st || st.isSymbolicLink()) { skipped++; continue; }
      if (st.isDirectory()) { await visit(full, rel, depth + 1); continue; }
      if (!st.isFile()) continue;
      if (!isSupportedSource(rel)) { skipped++; continue; }
      const source = await readEligible(full, folderInfo.root, folderInfo.realRoot, rel).catch(() => null);
      if (source) out.push(source); else skipped++;
    }
  }
  await visit(folderInfo.full, folderInfo.folder);
  return { sources: out, scanned: visited, skipped, truncated };
}

function journalPath(ctx, scope) { return path.join(appHome(ctx.env), 'ingestion', `${scope}.jsonl`); }

async function latestEvents(file) {
  const latest = new Map();
  const raw = await readFile(file, 'utf8').catch((e) => e.code === 'ENOENT' ? '' : Promise.reject(e));
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    const event = JSON.parse(line);
    if (typeof event.source_id === 'string' && typeof event.revision === 'string') latest.set(event.source_id, event);
  }
  return latest;
}

export async function ingestionQueue(ctx, vaultName, folder, { limit = 50 } = {}) {
  const folderInfo = await checkedFolder(ctx, vaultName, folder);
  const scope = scopeId(ctx, vaultName, folderInfo.root);
  const { sources, scanned, skipped, truncated } = await sourcesInFolder(ctx, vaultName, folderInfo);
  const events = await latestEvents(journalPath(ctx, scope));
  const pending = sources.filter((s) => events.get(sourceId(scope, s.rel))?.revision !== s.revision)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const cap = Math.max(1, Math.min(100, Number(limit) || 50));
  const candidates = pending.slice(0, cap)
    .map((s) => ({ source_id: sourceId(scope, s.rel), revision: s.revision, path: s.rel, title: s.title, updated_at: s.updated_at }));
  return { ok: true, vault: vaultName, folder: folderInfo.folder, candidates, queued_total: pending.length, scanned, skipped, truncated, limited: pending.length > cap, next: 'Read each selected source with ingestion_read_source. Draft linked knowledge with propose_note and show its preview. After a linked note is saved, record filed; otherwise record skipped. Source files are never changed.' };
}

// Re-read one exact queue item only after the same folder, vault and privacy checks pass.
// The caller sends this text only to BrainLink's fixed loopback Ollama endpoint.
export async function readIngestionSource(ctx, vaultName, folder, { source_id, revision } = {}) {
  const folderInfo = await checkedFolder(ctx, vaultName, folder);
  if (typeof source_id !== 'string' || !/^[a-f0-9]{64}$/.test(source_id) || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw new Error('Choose a current source from the scan queue.');
  const scope = scopeId(ctx, vaultName, folderInfo.root);
  const prior = (await latestEvents(journalPath(ctx, scope))).get(source_id);
  if (prior?.revision === revision) throw new Error('This source revision was already reviewed. Refresh the queue for changed sources.');
  const { sources } = await sourcesInFolder(ctx, vaultName, folderInfo);
  const queued = sources.find((item) => sourceId(scope, item.rel) === source_id);
  if (!queued || queued.revision !== revision) throw new Error('This source changed or is no longer available. Refresh the queue and review it again.');
  const source = await readEligible(safeJoin(folderInfo.root, queued.rel), folderInfo.root, folderInfo.realRoot, queued.rel, { includeBody: true });
  if (!source || source.revision !== revision) throw new Error('This source changed during review. Refresh the queue and review it again.');
  return { ...source, source_id, vault: vaultName, folder: folderInfo.folder, body: redactText(source.body).slice(0, MAX_DRAFT_SOURCE_CHARS), body_truncated: source.body_truncated === true || source.body.length > MAX_DRAFT_SOURCE_CHARS };
}

export async function recordIngestion(ctx, vaultName, folder, { source_id, revision, outcome, knowledge_path } = {}) {
  if (ctx.readOnly) throw new Error('This connection is read-only.');
  const folderInfo = await checkedFolder(ctx, vaultName, folder);
  const v = folderInfo.v;
  if (v.writes === 'off') throw new Error(`Vault "${vaultName}" does not allow writes.`);
  if (!['filed', 'skipped'].includes(outcome)) throw new Error('outcome must be filed or skipped.');
  if (typeof source_id !== 'string' || !/^[a-f0-9]{64}$/.test(source_id) || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw new Error('Choose a current source from ingestion_queue.');

  const scope = scopeId(ctx, vaultName, folderInfo.root);
  const { sources } = await sourcesInFolder(ctx, vaultName, folderInfo);
  const source = sources.find((s) => sourceId(scope, s.rel) === source_id);
  if (!source || source.revision !== revision) throw new Error('This source changed or is no longer available. Refresh the queue and review it again.');

  let destinationId = null;
  if (outcome === 'filed') {
    const dest = String(knowledge_path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!dest || dest.split('/').some((p) => !p || p === '.' || p === '..' || p.startsWith('.')) || !/\.md$/i.test(dest)) throw new Error('A saved Markdown knowledge_path is required for filed.');
    if (dest === source.rel || dest.startsWith(`${folderInfo.folder}/`)) throw new Error('The knowledge note must be outside the selected Raw folder.');
    if (await isExcludedPath(folderInfo.root, dest)) throw new Error('The knowledge note is hidden or excluded.');
    const full = safeJoin(folderInfo.root, dest);
    let component = folderInfo.root;
    const components = dest.split('/');
    for (let i = 0; i < components.length; i++) {
      component = path.join(component, components[i]);
      const partStat = await lstat(component);
      if (partStat.isSymbolicLink() || (i < components.length - 1 && !partStat.isDirectory())) throw new Error('The knowledge note path contains an unsafe link or folder.');
    }
    const st = await lstat(full);
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_NOTE_BYTES) throw new Error('The saved knowledge note is not a regular Markdown file.');
    const real = await realpath(full);
    const relativeReal = path.relative(folderInfo.realRoot, real);
    if (relativeReal === '..' || relativeReal.startsWith(`..${path.sep}`) || path.isAbsolute(relativeReal) || await isExcludedPath(folderInfo.root, relativeReal.split(path.sep).join('/'))) throw new Error('The knowledge note resolves outside its vault or into an excluded area.');
    const fh = await open(full, 'r');
    let raw;
    try {
      const opened = await fh.stat();
      if (!opened.isFile() || (opened.ino && st.ino && opened.ino !== st.ino)) throw new Error('The knowledge note changed during review.');
      const header = Buffer.alloc(Math.min(opened.size, MAX_HEADER_BYTES));
      const { bytesRead } = await fh.read(header, 0, header.length, 0);
      if (!indexableHeader(header.subarray(0, bytesRead).toString('utf8'), opened.size, bytesRead)) throw new Error('The knowledge note is private or has malformed frontmatter.');
      raw = await fh.readFile('utf8');
      const after = await fh.stat();
      const pathAfter = await lstat(full);
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || pathAfter.isSymbolicLink() || (pathAfter.ino && opened.ino && pathAfter.ino !== opened.ino)) throw new Error('The knowledge note changed during review.');
    } finally { await fh.close(); }
    const { meta, body, frontmatter } = parseFrontmatter(raw);
    if (isPrivateMeta(meta) || fmSaysPrivate(frontmatter)) throw new Error('The knowledge note is private.');
    const targets = extractLinks(body).map((x) => x.replace(/^\.\//, '').replace(/\.md$/i, '').toLowerCase());
    const sourcePath = source.rel.replace(/\.md$/i, '').toLowerCase();
    const sourceTitle = source.title.toLowerCase();
    if (!targets.some((target) => target === sourcePath || target === sourceTitle)) throw new Error('The saved knowledge note must link to the source note.');
    destinationId = hash(`${scope}\0${dest}`);
  }

  const sourceStillCurrent = await readEligible(safeJoin(folderInfo.root, source.rel), folderInfo.root, folderInfo.realRoot, source.rel).catch(() => null);
  if (!sourceStillCurrent || sourceStillCurrent.revision !== revision) throw new Error('This source changed during review. Refresh the queue and review it again.');

  const event = { at: new Date().toISOString(), scope, source_id, revision, outcome, destination_id: destinationId, actor: String(ctx.platform || 'unknown').slice(0, 80) };
  const file = journalPath(ctx, scope);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(event) + '\n', { flag: 'a' });
  return { ok: true, recorded: true, outcome, source_id, next: 'This local receipt contains no note title, path, body, or prompt.' };
}
