import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentBodySize, expectedOverlays, pageOverlays, paintTranslation } from '../src/presentation.js';

test('原位排版沿用标题字号，并从原页绘制匹配的数学字形', () => {
  const source = { width: 400, height: 400 };
  const draws = [];
  const painted = [];
  const ctx = {
    save() {}, restore() {}, scale() {}, fillRect() {}, beginPath() {}, rect() {}, clip() {}, strokeText() {},
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
  assert.deepEqual(painted, ['变量 ']);
});

function recordingCanvas() {
  const events = [];
  const ctx = {
    save() {}, restore() {}, scale() {}, beginPath() {}, rect() {},
    drawImage(...args) { events.push({ type: 'image', args }); },
    clip(rule) { events.push({ type: 'clip', rule }); },
    strokeText(text, x, y) { events.push({ type: 'stroke', text, x, y, weight: this.lineWidth }); },
    fillRect() { events.push({ type: 'mask' }); },
    fillText(text, x, y) { events.push({ type: 'text', text, x, y, font: this.font, color: this.fillStyle }); },
    measureText(text) {
      const size = Number(this.font.match(/([\d.]+)px/)[1]);
      return { width: [...text].length * size, actualBoundingBoxAscent: size * .8, actualBoundingBoxDescent: size * .2 };
    },
  };
  return { canvas: { getContext: () => ctx }, events };
}

test('中文使用清晰的黑色常规字重，原位的窄行与图形同高时保留完整译文', () => {
  const { canvas, events } = recordingCanvas();
  const page = { width: 200, height: 200 };
  const paragraph = { id: 1, kind: 'text', text: 'Explanation', box: [.1, .1, .9, .4],
    lines: [[.1, .1, .45, .16], [.1, .17, .89, .25]], style: { size: 10 } };
  const lines = paintTranslation(canvas, page, page, [paragraph], { 1: '这段中文\n后续译文可以使用整行宽度' },
    [{ kind: 'figure', box: [.55, .09, .95, .15] }]);
  assert.deepEqual(lines.map(({ text, size, paragraphId }) => [text, size, paragraphId]), [
    ['这段中文', 10, 1], ['后续译文可以使用整行宽度', 10, 1],
  ]);
  assert.ok(lines[0].y > 28 && lines[0].y < 28.5, '加深笔画也计入顶部留白');
  assert.ok(events.some(event => event.type === 'clip' && event.rule === 'evenodd'));
  for (const event of events.filter(event => event.type === 'text')) {
    assert.match(event.font, /^400 10px "Microsoft YaHei"/);
    assert.equal(event.color, '#000');
  }
  assert.ok(events.some(event => event.type === 'stroke' && event.weight === .25));
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
  assert.ok(events.filter(event => event.type === 'mask').length >= 2);
  assert.ok(events.findLastIndex(event => event.type === 'mask') < events.findIndex(event => event.type === 'text'));
});

test('正文以全篇字号为基准，利用紧邻留白保持字号并避开公式', () => {
  const { canvas } = recordingCanvas();
  const page = { width: 200, height: 200 };
  const paragraph = { id: 1, kind: 'text', text: 'Short source line', box: [.1, .1, .3, .145],
    style: { size: 8, align: 'center' } };
  const formula = { id: 2, kind: 'formula', text: 'α = β', box: [.1, .17, .3, .22], style: { size: 20 } };
  const bodySize = documentBodySize([
    { kind: 'text', style: { size: 9.96 }, text: 'Body text in the other column of this paper.' },
    { kind: 'heading', style: { size: 20 }, text: 'A descriptive title written in a larger face.' },
  ]);
  assert.equal(bodySize, 10);
  const [line] = paintTranslation(canvas, page, page, [paragraph, formula], { 1: '正文' }, [], bodySize);
  assert.equal(line.size, bodySize);
  assert.equal(line.x, 20);
  assert.ok(line.y + 2 < formula.box[1] * page.height);
});

test('与其他原文块相交的行内公式改用数学字体绘制', () => {
  const { canvas, events } = recordingCanvas();
  const page = { width: 200, height: 200 };
  const paragraph = { id: 1, kind: 'text', text: 'Let x', box: [.1, .1, .95, .3],
    mathSpans: [{ start: 4, end: 5, box: [.71, .12, .75, .2], baseline: .17, size: 10 }] };
  const formula = { id: 2, kind: 'formula', text: 'y = 1', box: [.7, .12, .76, .2] };
  const lines = paintTranslation(canvas, page, page, [paragraph, formula], { 1: '变量 x' });
  assert.equal(lines[0].text, '变量 x');
  assert.equal(events.filter(event => event.type === 'image').length, 1);
  assert.match(events.find(event => event.type === 'text' && event.text === 'x').font, /Cambria Math/);
});

test('版面数据异常的段落不会中断整页绘制', () => {
  const { canvas, events } = recordingCanvas();
  const page = { width: 200, height: 200 };
  const paragraphs = [
    { id: 1, kind: 'text', text: 'Broken', box: [0.1, 0.1, NaN, 0.2], style: { size: 10 } },
    { id: 2, kind: 'text', text: 'Fine', box: [0.1, 0.3, 0.6, 0.36], style: { size: 10 } },
    { id: 3, kind: 'text', text: 'Missing box', box: null },
    { id: 4, kind: 'formula', text: 'Bad formula', box: undefined },
  ];
  const drawn = paintTranslation(canvas, page, page, paragraphs, { 1: '损坏', 2: '正常', 3: '缺少位置' });
  assert.deepEqual(drawn.map(line => line.paragraphId), [2]);
  assert.deepEqual(expectedOverlays(paragraphs, { 1: '损坏', 2: '正常', 3: '缺少位置' }).map(p => p.id), [1, 2, 3]);
  assert.ok(events.some(event => event.type === 'text' && event.text === '正常'));
});

test('极窄区域不会把长正文变成微小边注或跨栏段落', () => {
  const { canvas, events } = recordingCanvas();
  const page = { width: 200, height: 200 };
  const paragraph = { id: 1, kind: 'text', text: 'An extremely narrow region', box: [.1, .1, .18, .13],
    style: { size: 5.5 } };
  const lines = paintTranslation(canvas, page, page, [paragraph], { 1: '这是一段需要完整保存的译文'.repeat(3) });
  assert.deepEqual(lines, []);
  assert.ok(!events.some(event => event.type === 'text' || event.type === 'mask'));
  assert.equal(expectedOverlays([paragraph], { 1: '这是一段需要完整保存的译文'.repeat(3) }).length, 1);
});

test('图形遮挡的图注仍需报告未排版，重叠的同文副本只计一次', () => {
  const caption = { id: 1, kind: 'caption', text: 'Figure 1. An overview.', box: [.2, .58, .8, .62] };
  const body = { id: 3, kind: 'text', text: 'The explanation continues here.', box: [.2, .7, .8, .8] };
  const paragraphs = [caption, { ...caption, id: 2 }, body];
  const translations = { 1: '图 1。概览。', 2: '图 1。概览。', 3: '正文继续说明。' };
  const regions = [{ kind: 'figure', box: [.1, .2, .9, .65] }];
  assert.deepEqual(expectedOverlays(paragraphs, translations).map(p => p.id), [1, 3]);
  assert.deepEqual(pageOverlays(paragraphs, translations, regions).map(p => p.id), [3]);
});

test('与公式重叠的正文仍会输出译文，不再从导出中消失', () => {
  const { canvas } = recordingCanvas();
  const page = { width: 200, height: 200 };
  const text = { id: 1, kind: 'text', text: 'where x is the value', box: [0.1, 0.1, 0.6, 0.2], style: { size: 10 } };
  const formula = { id: 2, kind: 'formula', text: 'L = a + b', box: [0.12, 0.11, 0.58, 0.19] };
  const lines = paintTranslation(canvas, page, page, [text, formula], { 1: '其中 x 是该值' });
  assert.equal(lines.length > 0, true);
  assert.equal(lines[0].paragraphId, 1);
  assert.ok(lines.every(line => [line.x, line.y, line.width, line.size].every(Number.isFinite)));
});

test('拥挤页面不能绕过公式保护或把正文移进页脚', () => {
  const { canvas, events } = recordingCanvas();
  const page = { width: 200, height: 200 };
  const paragraph = { id: 1, kind: 'text', text: 'Crowded source block', box: [0.1, 0.1, 0.2, 0.14], style: { size: 10 } };
  const blocker = { id: 2, kind: 'formula', text: 'x = y', box: [0, 0, 1, 0.88] };
  const lines = paintTranslation(canvas, page, page, [paragraph, blocker], { 1: '这是一段较长的中文译文，需要完整显示在页面留白区中。' });
  assert.deepEqual(lines, []);
  assert.ok(!events.some(event => event.type === 'text' || event.type === 'mask'));
});

test('重复绘制不修改源坐标，保留无法排版的邻段与公式', () => {
  const page = { width: 200, height: 200 };
  const paragraphs = [
    { id: 1, kind: 'text', text: 'First paragraph', box: [.1, .1, .45, .16] },
    { id: 2, kind: 'formula', text: 'x = y', box: [.1, .18, .45, .25] },
    { id: 3, kind: 'text', text: 'Next paragraph', box: [.1, .27, .45, .33] },
    { id: 4, kind: 'text', text: 'Other column', box: [.55, .1, .9, .33] },
  ];
  const original = structuredClone(paragraphs);
  const translations = { 1: '第一段译文', 3: '下一段译文', 4: '右栏译文' };
  const first = paintTranslation(recordingCanvas().canvas, page, page, paragraphs, translations);
  const second = paintTranslation(recordingCanvas().canvas, page, page, paragraphs, translations);
  assert.deepEqual(paragraphs, original);
  assert.deepEqual(second, first);
  for (const line of first) {
    assert.ok(line.size >= 7);
    assert.ok(line.x >= 20 && line.x + line.width <= 180);
    assert.ok(line.y >= 0 && line.y <= 200);
    if (line.paragraphId === 1) assert.ok(line.y + line.size * .2 <= 36);
  }
});

test('按实际汉字墨迹高度计算行距，避免高字形上下接触', () => {
  const { canvas } = recordingCanvas();
  const ctx = canvas.getContext('2d');
  const measure = ctx.measureText;
  ctx.measureText = function(text) {
    const value = measure.call(this, text);
    return text.includes('高') ? { ...value, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 3 } : value;
  };
  const page = { width: 200, height: 200 };
  const paragraph = { id: 1, kind: 'text', text: 'Two tall lines', box: [.1, .1, .8, .4] };
  const lines = paintTranslation(canvas, page, page, [paragraph], { 1: '高\n高' });
  assert.equal(lines.length, 2);
  assert.ok(lines[0].y >= 32.125);
  assert.ok(lines[1].y - lines[0].y >= 15.25);
});

test('公式变量及下标不会为塞入窄栏而从中间断开', () => {
  const { canvas } = recordingCanvas();
  const page = { width: 200, height: 200 };
  const text = 'x_123456789';
  const paragraph = { id: 1, kind: 'text', text, box: [.1, .1, .18, .8],
    mathSpans: [{ start: 0, end: text.length, box: [.1, .1, .18, .2] }] };
  assert.deepEqual(paintTranslation(canvas, page, page, [paragraph], { 1: text }), []);
});
