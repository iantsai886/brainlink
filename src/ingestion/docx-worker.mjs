import { parentPort, workerData } from 'node:worker_threads';

const MAX_CHARS = 24_000;

try {
  let mammoth;
  try {
    ({ default: mammoth } = await import('mammoth'));
  } catch {
    parentPort.postMessage({ ok: false, reason: 'missing_dependency', package: 'mammoth' });
    process.exit(0);
  }
  const result = await mammoth.extractRawText({ buffer: Buffer.from(workerData) }, { externalFileAccess: false });
  const text = String(result.value || '').replace(/\r\n?/g, '\n');
  if (!text.trim()) throw new Error('no_text');
  parentPort.postMessage({ ok: true, text: text.slice(0, MAX_CHARS), truncated: text.length > MAX_CHARS });
} catch (error) {
  parentPort.postMessage({ ok: false, reason: error?.message === 'no_text' ? 'no_text' : 'invalid' });
}
