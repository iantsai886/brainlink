// Keep the multi-language OCR worker checks in their own test process. The main
// BrainLink integration file also exercises OCR during multi-format ingestion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractImageText, imageDimensions } from '../src/ingestion/image-ocr.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('image OCR checks PNG/JPEG/BMP type and pixel bounds before reading image text', async () => {
  const png = await readFile(path.join(ROOT, 'test', 'fixtures', 'ocr-sample.png'));
  assert.deepEqual(imageDimensions(png, '.png'), { width: 1000, height: 180 });
  assert.throws(() => imageDimensions(png, '.jpg'), /supported or safe/);
  const oversized = Buffer.from(png);
  oversized.writeUInt32BE(10_000, 16); oversized.writeUInt32BE(10_000, 20);
  assert.throws(() => imageDimensions(oversized, '.png'), /supported or safe/);
});

test('offline OCR recognizes fictional English Portuguese and Traditional Chinese fixtures', async () => {
  const fixtures = [
    ['ocr-sample.png', /BRAINLINK OCR TEST 123/i],
    ['ocr-portuguese.png', /AÇÃO E INFORMAÇÃO/i],
    ['ocr-traditional-chinese.png', /腦\s*連\s*結\s*測試/u],
  ];
  for (const [file, expected] of fixtures) {
    const result = await extractImageText(await readFile(path.join(ROOT, 'test', 'fixtures', file)));
    assert.match(result.text, expected, `${file} should be recognized by its bundled language data`);
    assert.equal(result.truncated, false);
  }
});
