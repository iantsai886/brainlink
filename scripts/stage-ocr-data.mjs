#!/usr/bin/env node
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!destination) {
  console.error('Usage: node scripts/stage-ocr-data.mjs DESTINATION');
  process.exit(2);
}

const languages = ['eng', 'por', 'chi_tra'];
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const code of languages) {
  const packageDir = path.dirname(fileURLToPath(await import.meta.resolve(`@tesseract.js-data/${code}`)));
  const source = path.join(packageDir, '4.0.0_best_int', `${code}.traineddata.gz`);
  const bytes = await readFile(source);
  if (bytes.length < 100_000 || bytes.length > 4_000_000) throw new Error(`Unexpected OCR language data size: ${code}`);
  await copyFile(source, path.join(destination, `${code}.traineddata.gz`));
}
console.log(`Staged ${languages.length} offline OCR language packs (${(await Promise.all(languages.map(async (code) => (await stat(path.join(destination, `${code}.traineddata.gz`))).size))).reduce((sum, size) => sum + size, 0)} bytes).`);
