import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assembleFragments, complete, looksComplete, parseTranslations, protectMath,
  translationFragments, validateTranslation,
} from '../src/model.js';

test('正文和译文中的论文引用不会增加句子计数', () => {
  const source = 'Prior work (Chen et al. 2021; Hong et al. 2020; Jang et al. 2021; Ren et al. 2021) uses clean images. Noise is modeled, e.g. with Gaussian draws.';
  const translated = '先前工作（Chen et al. 2021；Hong et al. 2020；Jang et al. 2021；Ren et al. 2021）使用干净图像。噪声可用高斯采样建模。';
  assert.ok(looksComplete(source, translated));
  assert.equal(looksComplete('First sentence here. Second sentence follows. Third sentence ends.', '只译了第一句。'), false);
});

test('回填允许明确的等价标记拼写，并拒绝缺失、重复、换序和跨段标记', () => {
  const paragraph = { id: 3, text: 'The parameters σ and ϵ are used here [1].' };
  const { tokens } = protectMath(paragraph.text, [], paragraph.id);
  const [first, second, cite] = tokens.map(token => token.marker);
  const verified = validateTranslation(paragraph, `使用 ⟦M:3:0 与 【Ｍ：３：１】 两个参数 ${cite}。`, tokens);
  assert.equal(verified.text, '使用 σ 与 ϵ 两个参数 [1]。');
  assert.deepEqual(validateTranslation(paragraph, verified.text), verified);
  for (const output of [
    `使用参数 ${first} ${cite}。`,
    `使用参数 ${first} ${second} ${second} ${cite}。`,
    `使用参数 ${second} ${first} ${cite}。`,
    `使用参数 ⟦M:8:0⟧ ${second} ${cite}。`,
    `使用参数 ${first} ${second} ⟦M:3:2:0⟧。`,
  ]) assert.deepEqual(validateTranslation(paragraph, output, tokens), { reason: 'math' });
});

test('已经回填的公式可按译文语序重排，每个原始公式必须完整出现', () => {
  const paragraph = { id: 7, text: 'We estimate σ from ϵ. See [1].' };
  assert.equal(validateTranslation(paragraph, '从 ϵ 估计 σ。见 [1]。').text, '从 ϵ 估计 σ。见 [1]。');
  for (const text of ['估计 σ。见 [1]。', '从 ϵ ϵ 估计 σ。见 [1]。', '从 ϵ 估计 σ²。见 [1]。']) {
    assert.deepEqual(validateTranslation(paragraph, text), { reason: 'math' });
  }
  assert.deepEqual(validateTranslation({ id: 8, text: 'The equation x = 1 describes the result.' }, '方程 x = 1.5 描述结果。'), { reason: 'math' });
  assert.equal(validateTranslation({ id: 8, text: 'The network fθ estimates σi.' }, '网络 fθ 估计 σi。').text, '网络 fθ 估计 σi。');
});

test('拆开的 PDF 数学文本按完整公式复原，缩写中的字母不变成变量', () => {
  const text = 'For example, i.e., E [y] = E [x], with DMSE preserved.';
  const start = text.indexOf('=');
  const acronym = text.indexOf('DMSE');
  const paragraph = { id: 1, text, mathSpans: [{ start, end: start + 1 }, { start: start + 2, end: start + 3 }, { start: acronym, end: acronym + 1 }] };
  const { tokens } = protectMath(text, paragraph.mathSpans, paragraph.id);
  assert.deepEqual(tokens.map(token => token.value), ['E', 'y', '= E', 'x', 'DMSE']);
  assert.equal(validateTranslation(paragraph, '即 E [y] = E [x]，保留 DMSE。').text, '即 E [y] = E [x]，保留 DMSE。');
});

test('按片段翻译后本地拼回全部公式，不保存缺失片段或重复公式', () => {
  const paragraph = { id: 4, text: 'We use σ and ϵ to estimate the output [1].' };
  const fragments = translationFragments(paragraph);
  assert.deepEqual(fragments.paragraphs.map(part => part.text), ['We use', 'and', 'to estimate the output']);
  const translated = new Map([[1, '我们用'], [2, '和'], [3, '估计输出']]);
  assert.equal(assembleFragments(paragraph, fragments, translated).text, '我们用 σ 和 ϵ 估计输出 [1].');
  assert.deepEqual(assembleFragments(paragraph, fragments, new Map([[1, '我们用']])), { reason: 'missing' });
  translated.set(1, '我们用 σ');
  assert.deepEqual(assembleFragments(paragraph, fragments, translated), { reason: 'math' });
});

test('单段完整响应允许纯译文，保留编号译文的续行', () => {
  const single = [{ id: 12 }];
  const multiple = [...single, { id: 15 }];
  const options = { allowPlainText: true };
  const text = '[1] 提出了这种方法。';
  assert.equal(parseTranslations(text, single, options).values.get(12), text);
  assert.equal(parseTranslations(text, single).values.size, 0);
  assert.equal(parseTranslations(text, multiple, options).values.size, 0);
  for (const output of ['2. 另一段译文。', '{"2":"另一段译文。"}', '我无法翻译。', '{"12":"尚未结束']) {
    assert.equal(parseTranslations(output, single, options).values.size, 0);
  }
  const numbered = '12. 第一行。\n同一段的第二行。\n15. 另一段。';
  assert.equal(parseTranslations(numbered, multiple).values.get(12), '第一行。\n同一段的第二行。');
  const refusal = parseTranslations('{"12":"抱歉，我无法完成翻译。"}', single).values.get(12);
  assert.deepEqual(validateTranslation({ id: 12, text: 'A sentence about the method.' }, refusal), { reason: 'invalid' });
});

test('截断时保留已闭合的 JSON 值和前面的编号项，丢弃未结束的末项', () => {
  const batch = [{ id: 12 }, { id: 15 }];
  const options = { finished: false, allowPlainText: true };
  for (const output of ['12. 完整句子。\n15. 不完整的', '{"12":"完整句子。","15":"不完整的']) {
    const { values, missing } = parseTranslations(output, batch, options);
    assert.deepEqual([...values], [[12, '完整句子。']]);
    assert.deepEqual(missing, [15]);
  }
  for (const output of ['12. 这项方法解决', '这项方法解决']) {
    assert.deepEqual(parseTranslations(output, batch.slice(0, 1), options).missing, [12]);
  }
  assert.deepEqual(parseTranslations('2. 可能是第二项。\n1. 未完', [{ id: 2 }, { id: 5 }], options).missing, [2, 5]);
});

test('已取消的模型请求不会启动流', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled');
  controller.abort(reason);
  const llm = { stream() { assert.fail('模型不应收到已取消的请求'); } };
  await assert.rejects(complete(llm, {}, '', {}, 10, controller.signal), reason);
});

test('模型限流和额度耗尽保留不同错误代码', async () => {
  for (const code of ['RATE_LIMIT', 'QUOTA_EXHAUSTED']) {
    const llm = { async *stream() { yield { type: 'finish', reason: { kind: 'error', failure: { code } } }; } };
    await assert.rejects(complete(llm, {}, '', {}, 10, new AbortController().signal), {
      status: 429, code: code === 'RATE_LIMIT' ? 'RATE_LIMIT' : 'QUOTA',
    });
  }
});
