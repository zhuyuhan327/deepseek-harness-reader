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

function recordingCanvas() {
  const events = [];
  const ctx = {
    save() {}, restore() {}, scale() {}, beginPath() {}, rect() {}, drawImage() {},
    clip(rule) { events.push({ type: 'clip', rule }); },
    fillRect() { events.push({ type: 'mask' }); },
    fillText(text, x, y) { events.push({ type: 'text', text, x, y, font: this.font, color: this.fillStyle }); },
    measureText(text) {
      const size = Number(this.font.match(/([\d.]+)px/)[1]);
      return { width: [...text].length * size, actualBoundingBoxAscent: size * .8, actualBoundingBoxDescent: size * .2 };
    },
  };
  return { canvas: { getContext: () => ctx }, events };
}

test('中文使用深色半粗体，原位的窄行与图形同高时保留完整译文', () => {
  const { canvas, events } = recordingCanvas();
  const page = { width: 200, height: 200 };
  const paragraph = { id: 1, kind: 'text', text: 'Explanation', box: [.1, .1, .9, .4],
    lines: [[.1, .1, .45, .16], [.1, .17, .89, .25]], style: { size: 10 } };
  const lines = paintTranslation(canvas, page, page, [paragraph], { 1: '这段中文\n后续译文可以使用整行宽度' },
    [{ kind: 'figure', box: [.55, .09, .95, .15] }]);
  assert.deepEqual(lines.map(({ text, size, paragraphId }) => [text, size, paragraphId]), [
    ['这段中文', 10, 1], ['后续译文可以使用整行宽度', 10, 1],
  ]);
  assert.equal(lines[0].y, 28);
  assert.ok(events.some(event => event.type === 'clip' && event.rule === 'evenodd'));
  for (const event of events.filter(event => event.type === 'text')) {
    assert.match(event.font, /^600 10px "Microsoft YaHei"/);
    assert.equal(event.color, '#000');
  }
});

test('相交的不同段落均绘制，遮盖原文不会擦掉已画出的中文', () => {
  const { canvas, events } = recordingCanvas();
  const page = { width: 200, height: 200 };
  const paragraphs = [
    { id: 1, kind: 'text', text: 'First', box: [.1, .1, .8, .4], style: { size: 10 } },
    { id: 2, kind: 'text', text: 'Second', box: [.2, .18, .65, .42], style: { size: 10 } },
    { id: 3, kind: 'text', text: 'A covered label', box: [.75, .2, .8, .26], style: { size: 10 } },
  ];
  const lines = paintTranslation(canvas, page, page, paragraphs, { 1: '译文一', 2: '译文二', 3: '图内文字' },
    [{ kind: 'figure', box: [.74, .15, .89, .3] }]);
  assert.deepEqual(lines.map(({ paragraphId }) => paragraphId), [1, 2]);
  assert.equal(events.filter(event => event.type === 'mask').length, 2);
  assert.ok(events.findLastIndex(event => event.type === 'mask') < events.findIndex(event => event.type === 'text'));
});
