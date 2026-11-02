import { createRequire } from 'node:module';
import { access, copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorker } from 'tesseract.js';
import { appHome } from '../app-home.mjs';

const require = createRequire(import.meta.url);
const LANGUAGE_CODES = ['eng', 'por', 'chi_tra'];
const MAX_PIXELS = 24_000_000;
const MAX_DIMENSION = 10_000;
const MAX_OUTPUT = 24_000;
const OCR_TIMEOUT_MS = 60_000;
const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
let preparedData;

function invalidImage() { throw new Error('This image is not a supported or safe PNG, JPEG, or BMP file.'); }

export function imageDimensions(bytes, extension) {
  const data = Buffer.from(bytes);
  let width = 0, height = 0;
  if (extension === '.png') {
    if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || data.toString('ascii', 12, 16) !== 'IHDR') invalidImage();
    width = data.readUInt32BE(16); height = data.readUInt32BE(20);
  } else if (extension === '.bmp') {
    if (data.length < 54 || data.toString('ascii', 0, 2) !== 'BM' || data.readUInt32LE(14) < 40) invalidImage();
    width = data.readInt32LE(18); height = Math.abs(data.readInt32LE(22));
  } else if (extension === '.jpg' || extension === '.jpeg') {
    if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) invalidImage();
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 0xff) invalidImage();
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) invalidImage();
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) invalidImage();
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 7) invalidImage();
        height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  } else invalidImage();
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) invalidImage();
  return { width, height };
}

async function languageDirectory() {
  const bundled = path.join(SOURCE_DIR, 'tessdata');
  try {
    await Promise.all(LANGUAGE_CODES.map((code) => access(path.join(bundled, `${code}.traineddata.gz`))));
    return bundled;
  } catch { /* Development checkout uses the pinned language packages below. */ }

  if (!preparedData) preparedData = (async () => {
    const destination = path.join(appHome(), 'ocr', 'tessdata');
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const code of LANGUAGE_CODES) {
      const packageEntry = require.resolve(`@tesseract.js-data/${code}`);
      const source = path.join(path.dirname(packageEntry), '4.0.0_best_int', `${code}.traineddata.gz`);
      const target = path.join(destination, `${code}.traineddata.gz`);
      const sourceSize = (await stat(source)).size;
      const targetSize = await stat(target).then((s) => s.size).catch(() => -1);
      if (targetSize === sourceSize) continue;
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await copyFile(source, temporary);
        await rename(temporary, target).catch(async (error) => {
          if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
          const winnerSize = await stat(target).then((s) => s.size).catch(() => -1);
          if (winnerSize !== sourceSize) throw error;
        });
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    }
    return destination;
  })().catch((error) => { preparedData = undefined; throw error; });
  return preparedData;
}

export async function extractImageText(bytes) {
  let worker;
  let timedOut = false;
  let timer;
  try {
    const languages = LANGUAGE_CODES.join('+');
    const operation = (async () => {
      worker = await createWorker(languages, 1, { langPath: await languageDirectory(), gzip: true, cacheMethod: 'none' });
      if (timedOut) { await worker.terminate(); worker = undefined; throw new Error('Image OCR exceeded its time limit.'); }
      const result = await worker.recognize(Buffer.from(bytes));
      const text = String(result?.data?.text || '').trim();
      if (!text) throw new Error('This image has no readable text.');
      return { text: text.slice(0, MAX_OUTPUT), truncated: text.length > MAX_OUTPUT };
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        void worker?.terminate();
        reject(new Error('Image OCR exceeded its time limit.'));
      }, OCR_TIMEOUT_MS);
      timer.unref?.();
    });
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
    await worker?.terminate().catch(() => {});
  }
}
