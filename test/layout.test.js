import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyParagraphs } from '../src/classify.js';
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
    ['operator', { name: 'ABCDEF+CMEX10' }],
  ]);
  return {
    commonObjs: fonts,
    async getTextContent() { return { items, styles: {} }; },
    async getOperatorList() {
      return { fnArray: operators.map(([op]) => op), argsArray: operators.map(([, ...args]) => args) };
    },
  };
}

test('矢量绘制的图表会被识别为图形区域，图内标签不再视为正文', async () => {
  const operators = [];
  for (let index = 0; index < 16; index++) {
    operators.push([OPS.constructPath, OPS.fill, [], [100 + index * 4, 520 - index * 3, 130 + index * 4, 620 - index * 2]]);
  }
  const items = [run('axis label', 150, 200, 60)];
  const { paragraphs, regions } = await extractPageLayout(pdfjs, page(items, operators), viewport, 2);
  assert.equal(regions.filter(region => region.kind === 'figure').length >= 1, true);
  const figure = regions.find(region => region.kind === 'figure');
  const label = paragraphs.find(paragraph => paragraph.text.includes('axis label'));
  assert.ok(label);
  assert.ok(label.box[0] >= figure.box[0] && label.box[2] <= figure.box[2]);
});

test('图形附近的标题与短正文不会被扩大的图形区域吞掉', async () => {
  const operators = [[OPS.save], [OPS.transform, 180, 0, 0, 120, 100, 500],
    [OPS.paintImageXObject, 'img', 180, 120], [OPS.restore]];
  const { paragraphs, regions } = await extractPageLayout(pdfjs, page([
    run('3. Experiments', 100, 320, 150, 'bold'),
    run('The results are consistent.', 100, 334, 170),
  ], operators), viewport, 2);
  const figure = regions.find(region => region.kind === 'figure');
  assert.ok(figure);
  assert.ok(paragraphs.every(p => p.box[1] > figure.box[3]));
});

test('图形区域不会越过图注吸收后续行的行内上标', async () => {
  const operators = [[OPS.save], [OPS.transform, 180, 0, 0, 80, 100, 520],
    [OPS.paintImageXObject, 'img', 180, 80], [OPS.restore]];
  const items = [
    run('Table 3. Analysis of patch sampling for', 60, 294, 236),
    run('(i)', 234, 301, 10, 'math', 7),
    run('different values for the operator ', 60, 308, 163),
    run('R', 226, 308, 8, 'math'),
    run('ρ', 234, 309, 4, 'math', 6),
    run(' used in the model.', 246, 308, 80),
  ];
  const { paragraphs, regions } = await extractPageLayout(pdfjs, page(items, operators), viewport, 8);
  assert.equal(paragraphs.length, 1);
  const [caption] = paragraphs;
  assert.match(caption.text, /^Table 3\. Analysis.*different values for the operator Rρ\(i\) used in the model\.$/);
  assert.equal(caption.lines.length, 2);
  const [span] = caption.mathSpans;
  assert.equal(caption.text.slice(span.start, span.end), 'Rρ(i)');
  assert.equal(span.box[2], 244 / viewport.width);
  assert.ok(regions.find(r => r.kind === 'figure').box[3] < caption.box[1]);
});

test('双栏中靠近栏间的公式不会跨栏聚合', async () => {
  const items = [];
  for (const y of [80, 94, 108]) {
    items.push(run('The left column describes the method.', 60, y, 225));
    items.push(run('The right column describes the result.', 316, y, 225));
  }
  items.push(run('x = a', 220, 160, 65, 'math'), run('y = b', 316, 160, 65, 'math'),
    run('z = c', 400, 180, 45, 'math'));
  const { paragraphs } = await extractPageLayout(pdfjs, page(items), viewport, 2);
  const left = paragraphs.find(p => p.text.includes('x = a'));
  assert.ok(left);
  assert.ok(!left.text.includes('y = b') && !left.text.includes('z = c'));
  assert.ok(left.box[2] < .5);
});

test('连续公式行合并成一个公式块并保留各行的坐标', async () => {
  const items = [
    run('L(θ)', 90, 120, 40, 'math'),
    run('= E', 134, 120, 26, 'math'),
    run('q', 160, 120, 6, 'math'),
    run('[log p(x|z)]', 90, 132, 70, 'math'),
    run('+ KL', 90, 144, 34, 'math'),
  ];
  const { paragraphs } = await extractPageLayout(pdfjs, page(items), viewport, 2);
  assert.equal(paragraphs.length, 1);
  assert.equal(paragraphs[0].lines.length, 3);
  assert.deepEqual(paragraphs[0].mathSpans.map(span => span.baseline), [120 / 800, 132 / 800, 144 / 800]);
  assert.match(paragraphs[0].text, /log p\(x\|z\)/);
});

test('有正文隔开的两个公式块各自保留边界', async () => {
  const items = [
    run('x = P(y) + z', 60, 100, 110, 'math'),
    run('which extracts a patch from the source.', 60, 114, 205),
    run('y = D(x) − z', 60, 128, 110, 'math'),
  ];
  const { paragraphs } = await extractPageLayout(pdfjs, page(items), viewport, 3);
  assert.deepEqual(paragraphs.map(p => p.text), [
    'x = P(y) + z', 'which extracts a patch from the source.', 'y = D(x) − z',
  ]);
  assert.ok(paragraphs[0].box[3] < paragraphs[1].box[1]);
  assert.ok(paragraphs[1].box[3] < paragraphs[2].box[1]);
});

test('小字号下括号标签保留各自的边界', async () => {
  const items = [
    run('We introduce the restoration model in this section.', 60, 72, 215),
    run('The method separates noise from each observed patch.', 60, 86, 218),
    run('We denoise each patch with the equation below.', 60, 100, 210),
    run('| {z }x ← D(x), |X − {{zx(i)}}, t). (7)', 60, 114, 210, 'math'),
    run('denoised patch', 66, 124, 45, 'regular', 7),
    run('patch to be denoised', 125, 124, 52, 'regular', 7),
    run('all other noisy patches', 190, 124, 55, 'regular', 7),
  ];
  const { paragraphs } = await extractPageLayout(pdfjs, page(items), viewport, 3);
  assert.deepEqual(paragraphs.filter(p => p.style.size === 7).map(p => p.text), [
    'denoised patch', 'patch to be denoised', 'all other noisy patches',
  ]);
});

test('多行公式的同行编号注释不会并入下一行正文', async () => {
  const items = [
    run('+ σ(t − 1) + c(t − 1)ϵt', 96, 640, 170, 'math'),
    run('t ← t − 1', 87, 655, 40, 'math'),
    run('(update timestep).', 198, 655, 72),
    run('(6)', 283, 655, 12),
    run('where c(t − 1) modifies the amount of sampling stochasticity.', 58, 675, 237),
  ];
  const { paragraphs } = await extractPageLayout(pdfjs, page(items), viewport, 3);
  assert.deepEqual(classifyParagraphs(paragraphs), ['formula', 'formula', 'text']);
  assert.equal(paragraphs[1].text, '(update timestep). (6)');
  assert.match(paragraphs[2].text, /^where c\(t − 1\)/);
  assert.ok(paragraphs[2].box[1] > paragraphs[1].box[3]);
});

test('同一基线的断行碎片会合并成一个段落', async () => {
  const items = [
    run('achieve state-of-the-art perfor-', 100, 100, 180),
    run('mance on single images.', 300, 100, 120),
  ];
  const { paragraphs } = await extractPageLayout(pdfjs, page(items), viewport, 2);
  assert.equal(paragraphs.length, 1);
  assert.equal(paragraphs[0].text, 'achieve state-of-the-art perfor-mance on single images.');
});

test('符号字体提取出的 NUL 字符会被清理', async () => {
  const items = [run('y = f\u0000(x) works.', 100, 120, 140)];
  const { paragraphs } = await extractPageLayout(pdfjs, page(items), viewport, 2);
  assert.equal(paragraphs[0].text.includes('\u0000'), false);
  assert.match(paragraphs[0].text, /works\./);
});

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

test('A displaced large operator stays with its equation when it overlaps a short word above', async () => {
  const items = [
    run('We center a mixture ', 60, 100, 102),
    run('component ', 163, 100, 50),
    run('at each patch:', 215, 100, 58),
    run('P', 166, 105, 10, 'operator'),
    run('p(x) =', 122, 112, 38, 'math'),
    run('p(x; y)', 181, 112, 43, 'math'),
  ];
  const { paragraphs } = await extractPageLayout(pdfjs, page(items), viewport, 3);
  assert.equal(paragraphs[0].text, 'We center a mixture component at each patch:');
  assert.ok(paragraphs.slice(1).some(p => p.text.includes('P')));
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

test('A raised index stays attached when a citation follows on the same baseline', async () => {
  const items = [
    run('The clean patch is estimated from a noisy', 60, 100, 220),
    run('(i)', 102, 106.5, 12, 'math', 7),
    run('patch ', 60, 113, 30),
    run('x', 94, 113, 8, 'math'),
    run('[74]. Further optimization is possible.', 118, 113, 164),
  ];
  const { paragraphs } = await extractPageLayout(pdfjs, page(items), viewport, 3);
  assert.equal(paragraphs.length, 1);
  const [body] = paragraphs;
  assert.match(body.text, /patch x\(i\) \[74\]\. Further optimization/);
  const [span] = body.mathSpans;
  assert.equal(body.text.slice(span.start, span.end), 'x(i)');
  assert.equal(span.box[2], 114 / viewport.width);
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

test('An arrow assignment after prose uses its original formula bounds', async () => {
  const phrase = 'The output image is then assembled as';
  const items = [
    run(phrase, 60, 100, 153),
    run('x', 215, 100, 6, 'math'),
    run('←', 223, 100, 10, 'math'),
    run('R', 236, 100, 8, 'math'),
    run('(i)', 244, 94, 10, 'math', 7),
  ];
  const { paragraphs } = await extractPageLayout(pdfjs, page(items), viewport, 3);
  const prose = paragraphs.find(p => p.text === phrase);
  const formula = paragraphs.find(p => p.text.includes('←'));
  assert.ok(prose && formula);
  assert.equal(prose.box[2], 213 / viewport.width);
  assert.equal(formula.box[0], 215 / viewport.width);
  assert.equal(prose.mathSpans, undefined);
  const inlineItems = [...items.slice(0, -1), run('for each patch.', 247, 100, 70)];
  const { paragraphs: inline } = await extractPageLayout(pdfjs, page(inlineItems), viewport, 3);
  assert.equal(inline.length, 1);
  assert.match(inline[0].text, /^The output image.*←.*for each patch\.$/);
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
