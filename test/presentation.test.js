import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paintTranslation } from '../src/presentation.js';

test('原位排版沿用标题字号，并从原页绘制匹配的数学字形', () => {
  const source = { width: 400, height: 400 };
  const draws = [];
  const painted = [];
  const ctx = {
    save() {}, restore() {}, scale() {}, fillRect() {},
    drawImage(...args) { draws.push(args); },
    fillText(text) { painted.push(text); },
    measureText(text) { return { width: [...text].length * 5, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2 }; },
  };
  const canvas = { getContext: () => ctx };
  const paragraph = {
    id: 1, kind: 'heading', box: [.1, .1, .9, .3], text: 'Variable xtrue',
    style: { size: 12, bold: true, align: 'center' },
    mathSpans: [{ start: 9, end: 14, box: [.3, .13, .37, .2], baseline: .18, size: 12 }],
  };
  const lines = paintTranslation(canvas, source, { width: 200, height: 200 },
    [paragraph], { 1: '变量 xtrue' });
  assert.equal(lines[0].text, '变量 xtrue');
  assert.equal(lines[0].size, 12);
  assert.ok(Math.abs(lines[0].x + lines[0].width / 2 - 100) < .001);
  assert.equal(draws.length, 2);
  assert.equal(draws[1][0], source);
  assert.deepEqual(painted, ['变', '量']);
});
