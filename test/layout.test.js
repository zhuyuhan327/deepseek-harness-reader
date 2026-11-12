import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractPageLayout } from '../src/layout.js';

const viewport = { width: 600, height: 800, scale: 1, transform: [1, 0, 0, -1, 0, 800] };
const OPS = {
  save: 1, restore: 2, transform: 3, paintFormXObjectBegin: 4, paintFormXObjectEnd: 5,
  paintImageXObject: 6, constructPath: 7, fill: 8, endPath: 9,
};
const pdfjs = {
  OPS,
  Util: {
    transform([a, b, c, d, e, f], [g, h, i, j, k, l]) {
      return [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f];
    },
  },
};

function run(str, x, y, width, fontName = 'regular', size = 10) {
  return { str, width, fontName, transform: [size, 0, 0, size, x, viewport.height - y] };
}

function page(items, operators = []) {
  const fonts = new Map([
    ['regular', { name: 'ABCDEF+NimbusRomNo9L-Regu' }],
    ['bold', { name: 'ABCDEF+NimbusRomNo9L-Medi' }],
    ['math', { name: 'ABCDEF+CMMI10' }],
  ]);
  return {
    commonObjs: fonts,
    async getTextContent() { return { items, styles: {} }; },
    async getOperatorList() {
      return { fnArray: operators.map(([op]) => op), argsArray: operators.map(([, ...args]) => args) };
    },
  };
}

test('PDF layout reads each column in order beneath a spanning heading', async () => {
  const items = [run('A study with two columns', 178, 45, 240, 'bold', 18)];
  for (const [index, y] of [85, 98, 111].entries()) {
    items.push(run(`Left column prose continues in line ${index + 1}.`, 60, y, 224));
    items.push(run(`Right column prose continues in line ${index + 1}.`, 316, y + 1, 224));
  }
  items.push(run('tail.', 316, 124, 18));
  const { paragraphs } = await extractPageLayout(pdfjs, page(items), viewport, 2);
  assert.equal(paragraphs.length, 3);
  assert.equal(paragraphs[0].style.bold, true);
  assert.equal(paragraphs[0].style.align, 'center');
  assert.match(paragraphs[1].text, /^Left.*Left.*Left/);
  assert.match(paragraphs[2].text, /^Right.*Right.*Right.*tail\.$/);
  assert.equal(paragraphs[1].lines.length, 3);
  assert.equal(paragraphs[2].lines.length, 4);
});

test('PDF layout rejoins justified citation words with the continuation in the same column', async () => {
  const items = [
    run('The left column keeps its own preceding sentence.', 60, 78, 228),
    run('The left column must stay separate from the citation.', 60, 90, 256),
    run('The left column continues in reading order here.', 60, 102, 228),
    run('The left column has more preceding text below.', 60, 114, 228),
    run('A separate introductory statement ends here.', 316, 78, 228),
    run('Neighbor2Neighbor', 326, 90, 78),
    run('(Huang', 413.6, 90, 28),
    run('et', 451.2, 90, 7),
    run('al.', 467.8, 90, 9),
    run('2021)', 486.4, 90, 22),
    run('extends', 518, 90, 26),
    run('Noise2Noise by enabling training on single noisy images.', 316, 102, 228),
    run('Its network learns from individual noisy images.', 316, 114, 228),
  ];
  const { paragraphs } = await extractPageLayout(pdfjs, page(items), viewport, 2);
  const merged = paragraphs.find(paragraph => paragraph.text.includes('Neighbor2Neighbor'));
  assert.ok(merged);
  assert.match(merged.text, /^Neighbor2Neighbor \(Huang et al\. 2021\) extends Noise2Noise by enabling training/);
  assert.equal(merged.lines.length, 3);
});

test('PDF layout retains the full caption and marks inline scripts as math', async () => {
  const items = [
    run('Figure 2: Calculate ', 40, 84, 81),
    run('x', 121, 84, 6, 'bold'),
    run('true', 127, 80, 15, 'regular', 7),
    run('t', 127, 86, 3, 'math', 7),
    run(', then compare the result', 143, 84, 100),
    run('with the reference measurement.', 40, 96, 152),
  ];
  const { paragraphs } = await extractPageLayout(pdfjs, page(items), viewport, 1);
  assert.equal(paragraphs.length, 1);
  const [caption] = paragraphs;
  assert.equal(caption.text, 'Figure 2: Calculate xtruet, then compare the result with the reference measurement.');
  assert.deepEqual(caption.mathSpans.map(({ start, end }) => caption.text.slice(start, end)), ['xtruet']);
  assert.equal(caption.mathSpans[0].box[0], 121 / viewport.width);
  assert.equal(caption.lines.length, 2);
});

test('A raised root joins its formula on the next baseline instead of overlapping the previous line', async () => {
  const items = [
    run('Use the following form of the noise schedule', 40, 90, 235),
    run('defined by σ = ', 40, 102, 99),
    run('√', 139, 94.5, 8, 'math'),
    run('1 − α', 147, 102, 34, 'math'),
    run(', where α is fixed.', 182, 102, 110),
  ];
  const { paragraphs } = await extractPageLayout(pdfjs, page(items), viewport, 1);
  assert.equal(paragraphs.length, 1);
  assert.match(paragraphs[0].text, /defined by σ = √1 − α,/);
  assert.deepEqual(paragraphs[0].mathSpans.map(span => paragraphs[0].text.slice(span.start, span.end)), ['√1 − α']);
});

test('PDF layout transforms and clips images inside nested form XObjects', async () => {
  const ops = [
    [OPS.save], [OPS.transform, 1, 0, 0, 1, 70, 300],
    [OPS.paintFormXObjectBegin, [1, 0, 0, 1, 10, 20], [0, 0, 140, 80]],
    [OPS.paintFormXObjectBegin, [1, 0, 0, 1, 5, 5], [0, 0, 200, 100]],
    [OPS.transform, 180, 0, 0, 120, 0, 0], [OPS.paintImageXObject, 'img', 180, 120],
    [OPS.paintFormXObjectEnd], [OPS.paintFormXObjectEnd], [OPS.restore],
  ];
  const { regions } = await extractPageLayout(pdfjs, page([], ops), viewport, 1);
  assert.deepEqual(regions.map(region => region.kind), ['figure']);
  const [left, top, right, bottom] = regions[0].box;
  assert.ok(left < 85 / 600 && left > 82 / 600);
  assert.ok(top < .5 && top > .496);
  assert.ok(right > 220 / 600 && right < 223 / 600);
  assert.ok(bottom > 475 / 800 && bottom < 478 / 800);
});

test('PDF layout bounds a numeric table without including the caption or surrounding prose', async () => {
  const items = [run('Table 1: Results by model', 62, 90, 130)];
  for (const [index, y] of [112, 125, 138].entries()) {
    items.push(run(`Method ${index + 1}`, 62, y, 44));
    items.push(run('21.23', 190, y, 27));
    items.push(run('0.8314', 270, y, 31));
  }
  items.push(run('After the table we continue discussing how the models compare.', 62, 153, 290));
  const rules = [[OPS.constructPath, OPS.fill, [], [60, 696, 306, 696.3]],
    [OPS.constructPath, OPS.fill, [], [60, 654, 306, 654.3]]];
  const { paragraphs, regions } = await extractPageLayout(pdfjs, page(items, rules), viewport, 1);
  assert.equal(regions.length, 1);
  assert.equal(regions[0].kind, 'table');
  assert.ok(regions[0].box[1] > paragraphs[0].box[3]);
  assert.ok(regions[0].box[3] < paragraphs.at(-1).box[3]);
});
