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

test('A sentence beginning at the right edge wraps back to its own column', async () => {
  const items = [
    run('Image restoration with patch priors.', 60, 100, 205, 'bold'),
    run('One', 275, 100, 14),
    run('way to model patch priors is to fit a Gaussian mixture.', 60, 112, 229),
  ];
  const { paragraphs } = await extractPageLayout(pdfjs, page(items), viewport, 3);
  assert.deepEqual(paragraphs.map(p => p.text), [
    'Image restoration with patch priors.', 'One way to model patch priors is to fit a Gaussian mixture.',
  ]);
});

test('A numbered section stays separate from the bold run-in heading below it', async () => {
  const items = [
    run('4.2. Applications', 60, 80, 130, 'bold', 11),
    run('Image retargeting.', 60, 96, 105, 'bold'),
    run('We show retargeting results.', 176, 96, 114),
  ];
  const { paragraphs } = await extractPageLayout(pdfjs, page(items), viewport, 7);
  assert.deepEqual(paragraphs.map(p => p.text), ['4.2. Applications', 'Image retargeting.', 'We show retargeting results.']);
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

test('A short prose continuation stays with its paragraph before raised formula scripts', async () => {
  const preceding = 'We weight the patches before they are reassembled into an';
  const items = [
    run(preceding, 60, 100, 220),
    run('∑', 99, 106, 10, 'math'),
    run('image as', 60, 113, 35),
    run('x = y', 138, 113, 28, 'math'),
  ];
  const { paragraphs } = await extractPageLayout(pdfjs, page(items), viewport, 6);
  assert.equal(paragraphs[0].text, preceding + ' image as');
  assert.equal(paragraphs[0].lines.length, 2);
  assert.deepEqual(paragraphs.slice(1).map(p => p.text), ['∑', 'x = y']);
});

test('Raised formula scripts keep a short phrase separate when the preceding sentence already ended', async () => {
  const preceding = 'The calculation determines the patch weights.';
  const items = [
    run(preceding, 60, 100, 220),
    run('∑', 99, 106, 10, 'math'),
    run('image as', 60, 113, 35),
    run('x = y', 138, 113, 28, 'math'),
  ];
  const { paragraphs } = await extractPageLayout(pdfjs, page(items), viewport, 6);
  assert.deepEqual(paragraphs.map(p => p.text), [preceding, '∑', 'image as', 'x = y']);
});

test('An adjacent raised index becomes part of the same source crop as its variable', async () => {
  const items = [
    run('The clean patch is estimated from a noisy', 60, 100, 220),
    run('(i)', 102, 106.5, 12, 'math', 7),
    run('patch ', 60, 113, 30),
    run('x', 94, 113, 8, 'math'),
  ];
  const { paragraphs } = await extractPageLayout(pdfjs, page(items), viewport, 3);
  assert.equal(paragraphs.length, 1);
  const [body] = paragraphs;
  assert.match(body.text, /noisy patch x\(i\)$/);
  assert.equal(body.text.slice(body.mathSpans[0].start, body.mathSpans[0].end), 'x(i)');
  assert.equal(body.mathSpans[0].box[2], 114 / viewport.width);
});

test('A prose clause after a displayed equation joins its wrapped continuation', async () => {
  const items = [
    run('X = {x(1), x(2)}', 60, 100, 115, 'math'),
    run('= {x(N)}', 176, 100, 70, 'math'),
    run(', where ', 246, 100, 35),
    run('P(i)', 285, 100, 20, 'math'),
    run('is a matrix that extracts a patch from the image.', 60, 112, 245),
  ];
  const { paragraphs } = await extractPageLayout(pdfjs, page(items), viewport, 3);
  assert.deepEqual(paragraphs.map(p => p.text), [
    'X = {x(1), x(2)}= {x(N)}', ', where P(i) is a matrix that extracts a patch from the image.',
  ]);
  assert.equal(paragraphs[0].box[2], 246 / viewport.width);
  assert.equal(paragraphs[1].lines[0][0], 246 / viewport.width);
  assert.equal(paragraphs[1].text.slice(paragraphs[1].mathSpans[0].start, paragraphs[1].mathSpans[0].end), 'P(i)');
});

test('An equation continuation keeps its preceding formula and nearby scripts in place', async () => {
  const items = [
    run(', σ', 180, 100, 13, 'math'),
    run('I)', 197, 100, 12, 'math'),
    run('. As', 209, 100, 17),
    run('σ', 229, 100, 6, 'math'),
    run('→', 238, 100, 10, 'math'),
    run('0', 251, 100, 5),
    run(', Equa-', 256, 100, 29),
    run('j=1', 140, 103, 17, 'math', 7),
    run('tion 2 converges to the exact prior probability.', 60, 114, 225),
  ];
  const { paragraphs } = await extractPageLayout(pdfjs, page(items), viewport, 3);
  assert.deepEqual(paragraphs.map(p => p.text), [', σ I)', 'j=1', '. As σ → 0, Equa-tion 2 converges to the exact prior probability.']);
  const [span] = paragraphs[2].mathSpans;
  assert.equal(paragraphs[2].text.slice(span.start, span.end), 'σ → 0');
  assert.equal(span.box[2], 256 / viewport.width);
});

test('A clause after inline math stays in its existing prose paragraph', async () => {
  const items = [
    run('We model the input as ', 60, 100, 106),
    run('X = ', 168, 100, 22, 'math'),
    run('P(x)', 192, 100, 20, 'math'),
    run(', where ', 212, 100, 36),
    run('P(i)', 252, 100, 20, 'math'),
    run('is a matrix that extracts a patch from the image.', 60, 112, 212),
  ];
  const { paragraphs } = await extractPageLayout(pdfjs, page(items), viewport, 3);
  assert.equal(paragraphs.length, 1);
  assert.match(paragraphs[0].text, /^We model the input as X = P\(x\), where P\(i\) is a matrix/);
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

test('A ruled table does not absorb a same-baseline heading in the other column', async () => {
  const items = [
    run('3.6. Implementation Details', 60, 115, 130, 'bold'),
    run('The implementation is described here.', 60, 128, 180),
  ];
  for (const [index, y] of [115, 128, 141].entries()) {
    items.push(run(`Method ${index + 1}`, 322, y, 48));
    items.push(run('21.23', 425, y, 28));
    items.push(run('0.8314', 499, y, 32));
  }
  const rules = [[OPS.constructPath, OPS.fill, [], [310, 695, 560, 695.3]],
    [OPS.constructPath, OPS.fill, [], [310, 649, 560, 649.3]]];
  const { paragraphs, regions } = await extractPageLayout(pdfjs, page(items, rules), viewport, 6);
  const heading = paragraphs.find(p => p.text === '3.6. Implementation Details');
  assert.ok(heading);
  assert.deepEqual(regions.map(r => r.kind), ['table']);
  assert.ok(regions[0].box[0] > heading.box[2]);
});
