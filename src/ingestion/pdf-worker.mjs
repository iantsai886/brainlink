import { parentPort, workerData } from 'node:worker_threads';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const MAX_PAGES = 100;
const MAX_CHARS = 24_000;

try {
  const task = getDocument({
    data: new Uint8Array(workerData),
    isEvalSupported: false,
    stopAtErrors: true,
    useSystemFonts: true,
    disableFontFace: true,
  });
  const document = await task.promise;
  try {
    if (document.numPages > MAX_PAGES) throw new Error('page_limit');
    const chunks = [];
    let length = 0;
    let truncated = false;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        for (const item of content.items) {
          if (typeof item.str !== 'string' || !item.str) continue;
          const separator = item.hasEOL ? '\n' : ' ';
          const remaining = MAX_CHARS - length;
          if (remaining <= 0) { truncated = true; break; }
          const part = `${item.str}${separator}`.slice(0, remaining);
          chunks.push(part);
          length += part.length;
          if (part.length < item.str.length + separator.length) { truncated = true; break; }
        }
      } finally { page.cleanup(); }
      if (truncated) break;
    }
    const text = chunks.join('').trim();
    if (!text) throw new Error('no_text');
    parentPort.postMessage({ ok: true, text, truncated });
  } finally { await document.destroy(); }
} catch (error) {
  const reason = error?.message === 'page_limit' ? 'page_limit' : error?.message === 'no_text' ? 'no_text' : 'invalid';
  parentPort.postMessage({ ok: false, reason });
}
