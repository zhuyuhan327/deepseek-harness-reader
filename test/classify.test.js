import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyParagraphs, isTranslatable, looksLikeMath } from '../src/classify.js';

const paragraph = (id, page, box, text) => ({ id, page, box, text });

test('简短中文正文不会仅因没有英文字母被判成公式', () => {
  assert.equal(looksLikeMath('本文提出方法'), false);
  assert.deepEqual(classifyParagraphs([
    paragraph(1, 2, [.1, .2, .45, .23], '本文提出方法'),
  ]), ['text']);
});

test('分类：正文与图表注释翻译，页眉、公式、参考文献与图例跳过', () => {
  const paragraphs = [
    paragraph(1, 1, [0.2, 0.1, 0.8, 0.14], 'Self-diffusion for Solving Inverse Problems'),
    paragraph(2, 1, [0.3, 0.2, 0.45, 0.22], 'Guanxiong Luo'),
    paragraph(3, 1, [0.45, 0.25, 0.55, 0.27], 'Abstract'),
    paragraph(4, 1, [0.2, 0.3, 0.8, 0.6], 'We propose self-diffusion, a novel framework for solving inverse problems.'),
    paragraph(5, 1, [0.05, 0.69, 0.61, 0.72], 'arXiv:2510.21417v2 [cs.LG] 7 Dec 2025'),
    paragraph(6, 2, [0.18, 0.49, 0.82, 0.52], 'Figure 1: Demonstration of self-diffusion applied to inverse problems.'),
    paragraph(7, 2, [0.2, 0.5, 0.32, 0.515], 'L t,k = ∥A D θ ( x'),
    paragraph(8, 2, [0.2, 0.55, 0.8, 0.6], 'where A is the Moore-Penrose pseudoinverse of A, and z is arbitrary.'),
    paragraph(9, 3, [0.3, 0.02, 0.7, 0.035], 'Published as a conference paper at ICLR 2025'),
    paragraph(10, 4, [0.3, 0.02, 0.7, 0.035], 'Published as a conference paper at ICLR 2025'),
    paragraph(11, 5, [0.3, 0.02, 0.7, 0.035], 'Published as a conference paper at ICLR 2025'),
    paragraph(12, 10, [0.18, 0.53, 0.82, 0.57], 'References [1] Andrey N. Tikhonov and Vasiliy Y. Arsenin. Solutions.'),
    paragraph(13, 10, [0.18, 0.57, 0.82, 0.60], 'Sons, Washington, D.C.: John Wiley & Sons, New York, 1977.'),
    paragraph(14, 11, [0.18, 0.10, 0.82, 0.13], 'A Error Propagation under Ideal Denoiser Performance'),
    paragraph(15, 11, [0.18, 0.14, 0.82, 0.30], 'We follow the setup for self-diffusion described in Section 2.'),
    paragraph(16, 5, [0.2, 0.6, 0.8, 0.63], 'Table 2: Comparison of reconstruction quality across methods.'),
  ];
  assert.deepEqual(classifyParagraphs(paragraphs), [
    'heading', 'skip', 'heading', 'text', 'skip',
    'caption', 'formula', 'text',
    'skip', 'skip', 'skip',
    'skip', 'skip',
    'heading', 'text',
    'caption',
  ]);
});

test('数学行与普通句子的区分', () => {
  assert.equal(looksLikeMath('L t,k = ∥A D θ ( x + σ( t) ϵ t) − y∥'), true);
  assert.equal(looksLikeMath('x = A y + z null'), true);
  assert.equal(looksLikeMath('0.85 0.90 0.75 0.80 0.93'), true);
  assert.equal(looksLikeMath('where A is the Moore-Penrose pseudoinverse of A.'), false);
  assert.equal(looksLikeMath('The method improves PSNR by 2 dB on average.'), false);
  assert.equal(looksLikeMath('Let x = y + z.'), false);
  assert.equal(looksLikeMath('When θ ≤ 0, set x = 0.'), false);
  assert.equal(looksLikeMath('from O(N) to O(N'), true);
});

test('独立优化方程保留原图，描述优化过程的正文照常翻译', () => {
  const paragraphs = [
    paragraph(1, 2, [0.53, 0.136, 0.87, 0.15], 'arg minE ∥fθ (y) − x∥2 = arg minE ∥fθ (y) − z∥2'),
    paragraph(2, 2, [0.89, 0.136, 0.91, 0.147], '(1)'),
    paragraph(3, 2, [0.52, 0.165, 0.88, 0.178], 'where fθ is the denoising network parameterized by θ.'),
    paragraph(4, 2, [0.52, 0.179, 0.91, 0.205], 'Both the arg min and arg max operators select the optimizer θ.'),
  ];
  assert.deepEqual(classifyParagraphs(paragraphs), ['formula', 'formula', 'text', 'text']);
});

test('与同一行的公式说明相连的 where 可翻译，孤立词和公式编号保留', () => {
  const style = { size: 10 };
  const paragraphs = [
    { ...paragraph(1, 4, [0.52, 0.530, 0.56, 0.542], 'where'), style },
    { ...paragraph(2, 4, [0.62, 0.530, 0.91, 0.543], 'Di(hϕ(y)) aligns with hϕ((y1 +y2)/2), dif-'), style, mathSpans: [{ start: 0, end: 9 }] },
    { ...paragraph(3, 4, [0.52, 0.600, 0.56, 0.612], 'where'), style },
    { ...paragraph(4, 4, [0.62, 0.600, 0.65, 0.612], '(3)'), style },
    { ...paragraph(5, 4, [0.52, 0.650, 0.56, 0.662], '(Huang'), style },
  ];
  assert.deepEqual(classifyParagraphs(paragraphs), ['text', 'text', 'skip', 'formula', 'skip']);
  const regions = [{ page: 4, kind: 'table', box: [0.61, 0.526, 0.92, 0.55] }];
  assert.deepEqual(classifyParagraphs(paragraphs.slice(0, 2), regions), ['skip', 'table']);
});

test('句首和公式变量拆成窄块时仍翻译句首', () => {
  const style = { size: 10 };
  const paragraphs = [
    { ...paragraph(1, 3, [0.52, 0.395, 0.58, 0.408], 'where R(i)'), style, mathSpans: [{ start: 6, end: 10 }] },
    { ...paragraph(2, 3, [0.60, 0.395, 0.90, 0.408], 'is a matrix that copies the center pixel of the'), style },
    { ...paragraph(3, 3, [0.52, 0.430, 0.58, 0.443], 'where R'), style },
    { ...paragraph(4, 3, [0.60, 0.430, 0.90, 0.443], 'is a matrix that copies the center pixel of the'), style },
  ];
  assert.deepEqual(classifyParagraphs(paragraphs), ['text', 'text', 'skip', 'text']);
});

test('下括号正下方的小字号注释和公式一起保留，邻栏正文可翻译', () => {
  const prose = { size: 10 };
  const small = { size: 7 };
  const paragraphs = [
    { ...paragraph(1, 3, [0.52, 0.313, 0.90, 0.343], 'Each patch is denoised using the following operator.'), style: prose },
    { ...paragraph(2, 3, [0.75, 0.342, 0.90, 0.370], '|X − {{zx(i)}}, t). (7)'), style: prose },
    { ...paragraph(3, 3, [0.74, 0.368, 0.85, 0.376], 'all other noisy patches'), style: small },
    { ...paragraph(4, 3, [0.12, 0.368, 0.24, 0.376], 'all other noisy patches'), style: small },
    { ...paragraph(5, 3, [0.52, 0.379, 0.90, 0.400], 'The output image is then assembled from the patches.'), style: prose },
  ];
  assert.deepEqual(classifyParagraphs(paragraphs), ['text', 'formula', 'formula', 'text', 'text']);
});

test('公式同行的编号注释保留，其他行上的括号短语仍可翻译', () => {
  const paragraphs = [
    paragraph(1, 3, [.133, .7386, .249, .752], 'xˆt ← D(xt, Y, t)'),
    paragraph(2, 3, [.326, .7393, .482, .7513], '(denoised signal), (3)'),
    paragraph(3, 3, [.326, .7710, .482, .7830], '(denoised signal), (3)'),
  ];
  assert.deepEqual(classifyParagraphs(paragraphs), ['formula', 'formula', 'text']);
});

test('标题按字号与粗体识别，正文与图注仍按原规则分类', () => {
  const p = (id, box, text, style) => ({ id, page: 1, box, text, ...(style ? { style } : {}) });
  const paragraphs = [
    p(1, [0.2, 0.1, 0.8, 0.14], 'Self-diffusion for Solving Inverse Problems', { size: 14.3, bold: true, align: 'center' }),
    p(2, [0.45, 0.17, 0.55, 0.19], 'Abstract', { size: 14.3, bold: true, align: 'left' }),
    p(3, [0.18, 0.2, 0.82, 0.4], 'We propose a novel framework for solving inverse problems in imaging.', { size: 10, bold: false, align: 'left' }),
    p(4, [0.18, 0.45, 0.82, 0.5], 'Figure 1: Demonstration of self-diffusion applied to inverse problems.', { size: 10, bold: false, align: 'left' }),
    p(5, [0.18, 0.55, 0.82, 0.58], 'where A is a known forward operator and x is the unknown solution.', { size: 10, bold: false, align: 'left' }),
  ];
  assert.deepEqual(classifyParagraphs(paragraphs), ['heading', 'heading', 'text', 'caption', 'text']);
});

test('同一行正文前的粗体短标题可翻译，孤立的粗体图例保留', () => {
  const style = { size: 10, fontFamily: 'serif' };
  const paragraphs = [
    { ...paragraph(1, 7, [0.52, 0.72, 0.63, 0.733], 'Symmetrization.'), style: { ...style, bold: true } },
    { ...paragraph(2, 7, [0.65, 0.72, 0.90, 0.765], 'We add constraints during the diffusion process.'),
      lines: [[0.65, 0.72, 0.90, 0.733], [0.52, 0.735, 0.90, 0.75]], style },
    { ...paragraph(3, 7, [0.52, 0.80, 0.63, 0.813], 'Symmetrization.'), style: { ...style, bold: true } },
  ];
  assert.deepEqual(classifyParagraphs(paragraphs), ['heading', 'text', 'skip']);
});

test('布局区域识别图中文字和表格单元，图表注释及区域外正文照常翻译', () => {
  const paragraphs = [
    paragraph(1, 4, [0.14, 0.21, 0.28, 0.23], 'Ground truth'),
    paragraph(2, 4, [0.14, 0.32, 0.65, 0.35], 'Figure 2: Results on the test images.'),
    paragraph(3, 4, [0.14, 0.38, 0.65, 0.41], 'Figure 2 shows the reconstruction quality.'),
    paragraph(4, 4, [0.17, 0.52, 0.22, 0.54], 'PSNR'),
    paragraph(5, 4, [0.18, 0.59, 0.65, 0.62], 'Table II. Image reconstruction results.'),
    paragraph(6, 4, [0.18, 0.72, 0.65, 0.75], 'DDRM 23.5 0.68 0.18'),
    paragraph(7, 4, [0.18, 0.79, 0.65, 0.82], 'x = A y + z'),
    paragraph(8, 5, [0.14, 0.21, 0.65, 0.23], 'The method uses a better image prior.'),
  ];
  const regions = [
    { page: 4, kind: 'figure', box: [0.12, 0.18, 0.75, 0.36] },
    { page: 4, kind: 'table', box: [0.12, 0.46, 0.75, 0.58] },
  ];
  const kinds = classifyParagraphs(paragraphs, regions);
  assert.deepEqual(kinds, ['figure', 'caption', 'text', 'table', 'caption', 'table', 'formula', 'text']);
  assert.deepEqual(kinds.map(kind => isTranslatable(kind)), [false, true, true, false, true, false, false, true]);
  assert.equal(isTranslatable(undefined), true);
  assert.equal(isTranslatable('skip'), false);
});

test('页码范围首段保持正文，跨页重复正文保留，页眉按位置过滤', () => {
  const pages = [2, 3, 4];
  const paragraphs = pages.flatMap((page, index) => [
    paragraph(index * 3 + 1, page, [0.14, 0.08, 0.66, 0.10], 'Under review as a conference paper at ICLR 2025'),
    paragraph(index * 3 + 2, page, [0.14, 0.32, 0.66, 0.36], 'The method retains the original sample'),
    paragraph(index * 3 + 3, page, [0.14, 0.38, 0.66, 0.42], 'We compare PSNR SSIM and LPIPS'),
  ]);
  assert.deepEqual(classifyParagraphs(paragraphs), ['skip', 'text', 'text', 'skip', 'text', 'text', 'skip', 'text', 'text']);
  assert.deepEqual(classifyParagraphs([paragraphs[1]]), ['text']);
});

test('首页的两段开放获取水印完整保留，正文同样的措辞仍可翻译', () => {
  const disclaimer = 'Except for this watermark, it is identical to the accepted version; the final published version of the proceedings is available on IEEE Xplore.';
  const paragraphs = [
    paragraph(1, 1, [0.22, 0.005, 0.78, 0.016], 'This CVPR paper is the Open Access version, provided by the Computer Vision Foundation.'),
    paragraph(2, 1, [0.27, 0.019, 0.73, 0.045], disclaimer),
    paragraph(3, 2, [0.11, 0.29, 0.43, 0.35], disclaimer),
  ];
  assert.deepEqual(classifyParagraphs(paragraphs), ['skip', 'skip', 'text']);
});

test('文中编号引文可翻译，参考文献之后的多级附录恢复翻译', () => {
  const paragraphs = [
    paragraph(1, 8, [0.15, 0.10, 0.82, 0.13], '[1] introduced the estimator used in our experiments.'),
    paragraph(2, 8, [0.15, 0.30, 0.82, 0.33], '4.2 References'),
    paragraph(3, 8, [0.15, 0.34, 0.82, 0.37], '[1] Author. An Estimator. (2023).'),
    paragraph(4, 9, [0.15, 0.10, 0.82, 0.13], 'A.1 Error Propagation'),
    paragraph(5, 9, [0.15, 0.14, 0.82, 0.17], 'The error depends on the denoising model.'),
  ];
  assert.deepEqual(classifyParagraphs(paragraphs), ['text', 'skip', 'skip', 'heading', 'text']);
});

test('粗体附录编号拆成独立文本块时仍退出参考文献，并保留编号正文', () => {
  const paragraphs = [
    paragraph(1, 8, [0.15, 0.30, 0.82, 0.33], 'References'),
    { ...paragraph(5, 9, [0.15, 0.10, 0.17, 0.12], 'A'), style: { bold: true, size: 12 } },
    { ...paragraph(4, 9, [0.19, 0.10, 0.82, 0.12], 'Error Propagation'), style: { bold: true, size: 12 } },
    paragraph(3, 9, [0.15, 0.14, 0.82, 0.17], '1. We establish the equation x = y + z'),
  ];
  assert.deepEqual(classifyParagraphs(paragraphs), ['skip', 'skip', 'heading', 'text']);
});

test('纯符号与公式碎片不会被当作正文翻译', () => {
  for (const value of ['1 n', 'i y2 i 2', 'n i=1 f✓(y1)', '2 ✓ ✓ (1)']) {
    assert.equal(looksLikeMath(value), true, value);
  }
  assert.equal(looksLikeMath('3 Method'), false);
  const paragraphs = [
    paragraph(1, 2, [0.5, 0.1, 0.6, 0.12], '1 n'),
    paragraph(2, 2, [0.5, 0.13, 0.9, 0.2], 'A net-work is then trained to minimize the empirical risk'),
  ];
  assert.deepEqual(classifyParagraphs(paragraphs), ['formula', 'text']);
});

test('会议页脚与出版信息不会被翻译', () => {
  const paragraphs = [
    paragraph(1, 1, [0.18, 0.93, 0.63, 0.94], '36th Conference on Neural Information Processing Systems (NeurIPS 2022).'),
    paragraph(2, 1, [0.18, 0.9, 0.83, 0.92], 'We conclude the section with the main results of the experiment.'),
  ];
  assert.deepEqual(classifyParagraphs(paragraphs), ['skip', 'text']);
});

test('与正文同行的标题不会吞掉后面的正文', () => {
  const paragraphs = [
    paragraph(1, 4, [0.52, 0.69, 0.91, 0.72], '4.1 Implementation Details Datasets for Synthetic Experiments. We use the Kodak24 dataset.'),
    { ...paragraph(2, 4, [0.52, 0.69, 0.91, 0.72], '4.1 Implementation Details Datasets for Synthetic Experiments. We use the Kodak24 dataset.'),
      style: { bold: true, size: 10.9 } },
    paragraph(3, 4, [0.52, 0.14, 0.84, 0.15], '3.3 Gap Refinement Denoising Network'),
  ];
  assert.deepEqual(classifyParagraphs(paragraphs), ['text', 'text', 'heading']);
});
