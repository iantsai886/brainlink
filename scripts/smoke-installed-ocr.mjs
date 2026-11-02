#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const app = process.argv[2] ? path.resolve(process.argv[2]) : null;
const image = process.argv[3] ? path.resolve(process.argv[3]) : null;
if (!app || !image) throw new Error('Usage: node smoke-installed-ocr.mjs INSTALLED_APP IMAGE_FIXTURE');
const ocrModule = path.join(app, 'src', 'ingestion', 'image-ocr.mjs');
const { extractImageText } = await import(pathToFileURL(ocrModule).href).catch(async (error) => {
  // The Windows installer stages the OCR module beside the other app source files.
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return import(pathToFileURL(path.join(app, 'src', 'image-ocr.mjs')).href);
});
const { readFile } = await import('node:fs/promises');
const result = await extractImageText(await readFile(image));
assert.match(result.text, /BRAINLINK OCR TEST 123/i);
console.log('PASS: installed local OCR read the English fixture using bundled OCR language data.');
