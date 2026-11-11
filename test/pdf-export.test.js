import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildJpegPdf } from '../src/pdf-export.js';

const page = {
  width: 600, height: 800, jpegWidth: 1, jpegHeight: 1,
  bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
};

function readObjects(bytes) {
  const pdf = Buffer.from(bytes).toString('latin1');
  const offset = Number(pdf.match(/startxref\n(\d+)/)[1]);
  assert.equal(pdf.slice(offset, offset + 4), 'xref');
  const [, count, , ...entries] = pdf.slice(offset).split('\n');
  return entries.slice(0, Number(count.split(' ')[1]) - 1).map((entry, index) => {
    const start = Number(entry.slice(0, 10));
    const header = `${index + 1} 0 obj\n`;
    assert.equal(pdf.slice(start, start + header.length), header);
    return pdf.slice(start + header.length, pdf.indexOf('\nendobj', start));
  });
}

test('PDF 图片页面保留图像数据和页面尺寸', () => {
  const objects = readObjects(buildJpegPdf([page]));
  assert.equal(objects.length, 5);
  assert.match(objects[2], /\/MediaBox \[0 0 600\.00 800\.00\]/);
  assert.match(objects[3], /\/Im0 Do/);
  assert.ok(objects[4].includes(Buffer.from(page.bytes).toString('latin1')));
});

test('PDF 文字层保留中英公式并处理超过 255 个不同字符的页面', () => {
  const otherCharacters = Array.from({ length: 260 }, (_, index) => String.fromCodePoint(0x4e80 + index)).join('');
  const objects = readObjects(buildJpegPdf([{
    ...page,
    textLines: [
      { text: '中Aσ𝑥', x: 25, y: 50, size: 10, width: 40 },
      { text: otherCharacters, x: 25, y: 70, size: 10, width: 500 },
    ],
  }]));
  assert.match(objects[2], /\/Font << \/F0 \d+ 0 R \/F1 \d+ 0 R >>/);
  assert.match(objects[3], /3 Tr\n1\.000000 0 0 1 25\.00 750\.00 Tm\n\/F0 10\.00 Tf\n<01020304> Tj/);
  assert.match(objects[3], /\/F1 10\.00 Tf/);
  assert.match(objects[7], /<01> <4e2d>\n<02> <0041>\n<03> <03c3>\n<04> <d835dc65>/);
  assert.match(objects[9], /9 beginbfchar\n<01> <4f7b>/);
});
