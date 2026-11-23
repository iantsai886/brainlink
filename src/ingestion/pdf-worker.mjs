import { parentPort, workerData } from 'node:worker_threads';
import { extractImageTexts } from './image-ocr.mjs';

const MAX_PAGES = 100;
const MAX_CHARS = 24_000;
const MAX_OCR_PAGES = 10;
const MAX_OCR_PIXELS = 4_000_000;
const MAX_OCR_DIMENSION = 2_500;

function pageTextFrom(items, remaining) {
  const chunks = [];
  let length = 0;
  let truncated = false;
  for (const item of items) {
    if (typeof item.str !== 'string' || !item.str) continue;
    const separator = item.hasEOL ? '\n' : ' ';
    const available = remaining - length;
    if (available <= 0) { truncated = true; break; }
    const part = `${item.str}${separator}`.slice(0, available);
    chunks.push(part);
    length += part.length;
    if (part.length < item.str.length + separator.length) { truncated = true; break; }
  }
  return { text: chunks.join('').trim(), truncated };
}

try {
  let getDocument;
  try {
    ({ getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs'));
  } catch {
    parentPort.postMessage({ ok: false, reason: 'missing_dependency', package: 'pdfjs-dist' });
    process.exit(0);
  }
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
    const pages = [];
    const scannedPages = [];
    let length = 0;
    let truncated = false;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const extracted = pageTextFrom(content.items, MAX_CHARS - length);
        if (extracted.text) {
          pages.push({ text: extracted.text });
          length += extracted.text.length;
          if (extracted.truncated) { truncated = true; break; }
        } else if (scannedPages.length < MAX_OCR_PAGES) {
          const unscaled = page.getViewport({ scale: 1 });
          const scale = Math.min(
            2,
            MAX_OCR_DIMENSION / unscaled.width,
            MAX_OCR_DIMENSION / unscaled.height,
            Math.sqrt(MAX_OCR_PIXELS / (unscaled.width * unscaled.height)),
          );
          const viewport = page.getViewport({ scale });
          const width = Math.max(1, Math.ceil(viewport.width));
          const height = Math.max(1, Math.ceil(viewport.height));
          const canvasFactory = document.canvasFactory;
          const canvasAndContext = canvasFactory.create(width, height);
          try {
            await page.render({ canvasContext: canvasAndContext.context, viewport }).promise;
            const imageIndex = scannedPages.length;
            scannedPages.push(canvasAndContext.canvas.toBuffer('image/png'));
            pages.push({ imageIndex });
          } finally { canvasFactory.destroy(canvasAndContext); }
        } else {
          pages.push({ text: '' });
          truncated = true;
        }
      } finally { page.cleanup(); }
      if (truncated) break;
    }

    if (!pages.some((page) => page.text || Number.isInteger(page.imageIndex))) throw new Error('no_text');
    const ocr = scannedPages.length ? await extractImageTexts(scannedPages) : [];
    const chunks = [];
    length = 0;
    for (const page of pages) {
      const pageText = Number.isInteger(page.imageIndex) ? ocr[page.imageIndex]?.text || '' : page.text || '';
      if (!pageText) continue;
      const separator = chunks.length ? '\n' : '';
      const remaining = MAX_CHARS - length - separator.length;
      if (remaining <= 0) { truncated = true; break; }
      const chunk = pageText.slice(0, remaining);
      chunks.push(`${separator}${chunk}`);
      length += separator.length + chunk.length;
      if (chunk.length < pageText.length || (Number.isInteger(page.imageIndex) && ocr[page.imageIndex]?.truncated)) truncated = true;
      if (length >= MAX_CHARS) { truncated = true; break; }
    }
    if (pages.some((page) => !page.text && !Number.isInteger(page.imageIndex))) truncated = true;
    const text = chunks.join('').trim();
    if (!text) throw new Error('no_text');
    parentPort.postMessage({ ok: true, text, truncated });
  } finally { await document.destroy(); }
} catch (error) {
  const reason = error?.message === 'page_limit' ? 'page_limit' : error?.message === 'no_text' ? 'no_text' : 'invalid';
  parentPort.postMessage({ ok: false, reason });
}
