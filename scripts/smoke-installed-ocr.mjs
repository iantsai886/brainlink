#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const app = process.argv[2] ? path.resolve(process.argv[2]) : null;
const images = process.argv.slice(3).map((image) => path.resolve(image));
if (!app || images.length < 1) throw new Error('Usage: node smoke-installed-ocr.mjs INSTALLED_APP IMAGE_FIXTURE...');
const ocrModule = path.join(app, 'src', 'ingestion', 'image-ocr.mjs');
const { extractImageText } = await import(pathToFileURL(ocrModule).href).catch(async (error) => {
  // The Windows installer stages the OCR module beside the other app source files.
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return import(pathToFileURL(path.join(app, 'src', 'image-ocr.mjs')).href);
});
const { readFile } = await import('node:fs/promises');
const expectations = new Map([
  ['ocr-sample.png', /BRAINLINK OCR TEST 123/i],
  ['ocr-portuguese.png', /AÇÃO E INFORMAÇÃO/i],
  ['ocr-traditional-chinese.png', /腦\s*連\s*結\s*測試/u],
]);
for (const image of images) {
  const expected = expectations.get(path.basename(image));
  if (!expected) throw new Error(`No OCR expectation is defined for ${path.basename(image)}.`);
  const result = await extractImageText(await readFile(image));
  assert.match(result.text, expected, `${path.basename(image)} should be recognized by installed OCR`);
  console.log(`PASS: installed local OCR recognized ${path.basename(image)}.`);
}
