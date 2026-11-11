import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyParagraphs, looksLikeMath } from '../src/classify.js';

const paragraph = (id, page, box, text) => ({ id, page, box, text });

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
    'text', 'skip', 'skip', 'text', 'skip',
    'caption', 'skip', 'text',
    'skip', 'skip', 'skip',
    'skip', 'skip',
    'text', 'text',
    'caption',
  ]);
});

test('数学行与普通句子的区分', () => {
  assert.equal(looksLikeMath('L t,k = ∥A D θ ( x + σ( t) ϵ t) − y∥'), true);
  assert.equal(looksLikeMath('x = A y + z null'), true);
  assert.equal(looksLikeMath('0.85 0.90 0.75 0.80 0.93'), true);
  assert.equal(looksLikeMath('where A is the Moore-Penrose pseudoinverse of A.'), false);
  assert.equal(looksLikeMath('The method improves PSNR by 2 dB on average.'), false);
});
