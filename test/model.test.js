import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assembleFragments, complete, looksComplete, parseTranslations, protectMath, routeFor, selectEvidence,
  translationFragments, validateTranslation,
} from '../src/model.js';

test('正文和译文中的论文引用不会增加句子计数', () => {
  const source = 'Prior work (Chen et al. 2021; Hong et al. 2020; Jang et al. 2021; Ren et al. 2021) uses clean images. Noise is modeled, e.g. with Gaussian draws.';
  const translated = '先前工作（Chen et al. 2021；Hong et al. 2020；Jang et al. 2021；Ren et al. 2021）使用干净图像。噪声可用高斯采样建模。';
  assert.ok(looksComplete(source, translated));
  assert.equal(looksComplete('First sentence here. Second sentence follows. Third sentence ends.', '只译了第一句。'), false);
});

test('完整保留带小数点的章节编号，比较级中的冠词仍可翻译', () => {
  const paragraph = { id: 541, text: 'See Sec. S3.5 and Sec. S3.5.1. We achieve a >1000× speedup with η = 1.' };
  const protectedText = protectMath(paragraph.text, [], paragraph.id);
  assert.deepEqual(protectedText.tokens.map(token => token.value), ['S3.5', 'S3.5.1', '>1000×', 'η = 1']);
  assert.equal(validateTranslation(paragraph, paragraph.text).text, paragraph.text);
  assert.equal(validateTranslation(paragraph, '见第 S3.5 节及第 S3.5.1 节。在 η = 1 时实现 >1000× 加速。').reason, undefined);
  assert.equal(validateTranslation(paragraph, protectedText.text, protectedText.tokens).text, paragraph.text);
  assert.equal(validateTranslation(paragraph, '见第 S3.6 节及第 S3.5.1 节。在 η = 1 时实现 >1000× 加速。').reason, 'math');
  assert.deepEqual(protectMath('The parameter a >1000 is constrained.').tokens.map(token => token.value), ['a >1000']);
});

test('根据上下文保留变量 I、a 和 A，冠词与第一人称照常翻译', () => {
  const paragraph = { id: 1, text: 'The identity matrix I and a scalar a are fixed. I report a result. We then use I and a to compute the output.' };
  const prepared = protectMath(paragraph.text, [], paragraph.id);
  assert.deepEqual(prepared.tokens.map(token => token.value), ['I', 'a', 'I', 'a']);
  assert.match(prepared.text, /I report a result/);
  assert.match(prepared.text, /and a scalar/);
  assert.equal(validateTranslation(paragraph, prepared.text, prepared.tokens).text, paragraph.text);
  assert.equal(validateTranslation(paragraph, '固定单位矩阵 I 和标量 a。我报告结果，再用 I 和 a 计算输出。').reason, undefined);
  assert.equal(validateTranslation(paragraph, '固定单位矩阵 I 和 a scalar。我报告结果，再用 I 计算输出。').reason, 'math');
  assert.equal(validateTranslation({ id: 1, text: 'The scalar a is fixed.' }, '我们固定 a scalar。').reason, 'math');
  assert.deepEqual(protectMath('Set a variable name and let a parameter update. I set a goal.').tokens, []);
  assert.deepEqual(protectMath('The matrix A is fixed. A >1000× speedup was achieved.').tokens.map(token => token.value), ['A', '>1000×']);
  assert.deepEqual(protectMath('We use a and b to compute E[a].').tokens.map(token => token.value), ['a', 'b', 'E', 'a']);
});

test('公式变量的撇号、组合重音和上下标与字母一起保护', () => {
  const paragraph = { id: 2, text: "Use x′, y', ᾱ, 𝑦̂, x¹⁄₂ and r̅ₜ with fθˆ(y), ‖z‖₂ and x->y." };
  const prepared = protectMath(paragraph.text, [], paragraph.id);
  assert.deepEqual(prepared.tokens.map(token => token.value), ["x′", "y'", 'ᾱ', '𝑦̂', 'x¹⁄₂', 'r̅ₜ', 'fθˆ(y)', '‖z‖₂', 'x->y']);
  assert.equal(validateTranslation(paragraph, prepared.text, prepared.tokens).text, paragraph.text);
  assert.equal(validateTranslation(paragraph, paragraph.text.replace('ᾱ', 'α')).reason, 'math');
  assert.equal(validateTranslation({ id: 2, text: 'Use x with the result.' }, '在结果中使用 x′。').reason, 'math');
  assert.deepEqual(protectMath('The approach(see other notes) works, e.g on p. 1.').tokens, []);
  assert.deepEqual(protectMath('Use x-y or a-b; see Fig. A1.').tokens.map(token => token.value), ['x-y', 'a-b', 'A1']);
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

test('原文中的等价占位符拼写保留字面值，公式延伸为新符号时拒绝保存', () => {
  const paragraph = { id: 1, text: 'Use 【Ｍ：１：０】 and [MM:1:0] with x = σ and y = 1.' };
  const protectedText = protectMath(paragraph.text, [], paragraph.id);
  assert.deepEqual(protectedText.tokens.map(token => token.value), ['【Ｍ：１：０】', '[MM:1:0]', 'x = σ', 'y = 1']);
  assert.ok(protectedText.tokens.every(token => token.marker.startsWith('⟦MMM:')));
  assert.equal(validateTranslation(paragraph, protectedText.text, protectedText.tokens).text, paragraph.text);
  for (const changed of ['x = σ²', 'y = 1e-5']) {
    const source = paragraph.text.replace(changed.startsWith('x') ? 'x = σ' : 'y = 1', changed);
    assert.deepEqual(validateTranslation(paragraph, source), { reason: 'math' });
  }
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
  assert.deepEqual(parseTranslations('{"2":"可能是第二项。","1":"未完', [{ id: 2 }, { id: 5 }], options).missing, [2, 5]);
  assert.deepEqual([...parseTranslations('{"translations":{"12":"完整句子。","15":"未完', batch, options).values], [[12, '完整句子。']]);
  assert.deepEqual(parseTranslations('{"metadata":{"12":"注释并非译文。"},"15":"未完', batch, options).missing, [12, 15]);
});

test('重复或无法明确映射的段落编号不会覆盖译文', () => {
  const batch = [{ id: 2 }, { id: 5 }];
  for (const output of [
    '{"2":"第一份","2":"第二份","5":"正确的译文"}',
    '{"translations":{"段落2":"第一份","2":"第二份","5":"正确的译文"}}',
    '[{"id":2,"text":"第一份"},{"id":2,"text":"第二份"},{"id":5,"text":"正确的译文"}]',
    '[{"id":2,"index":1,"text":"编号冲突"},{"id":5,"text":"正确的译文"}]',
    '2. 第一份\n2. 第二份\n5. 正确的译文',
    '{"第 7 页第 2 段":"页码和段落编号并存","5":"正确的译文"}',
  ]) {
    const { values, missing } = parseTranslations(output, batch);
    assert.deepEqual([...values], [[5, '正确的译文']]);
    assert.deepEqual(missing, [2]);
  }
  assert.equal(parseTranslations('{"id":5,"translation":"正确的译文"}', [{ id: 5 }]).values.get(5), '正确的译文');
});

test('已取消的模型请求不会启动流', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled');
  controller.abort(reason);
  const llm = { stream() { assert.fail('模型不应收到已取消的请求'); } };
  await assert.rejects(complete(llm, {}, '', {}, 10, controller.signal), reason);
});

test('模型迭代器的读取和关闭均不响应信号时仍可取消请求', { timeout: 1_000 }, async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const closed = Promise.withResolvers();
  const pending = new Promise(() => {});
  const llm = { stream: () => ({
    [Symbol.asyncIterator]() { return this; },
    next() { started.resolve(); return pending; },
    return() { closed.resolve(); return pending; },
  }) };
  const request = complete(llm, {}, '', {}, 10, controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(request, { code: 'ABORTED' });
  await closed.promise;
});

test('所选模型的列表或推理设置暂不可读时不会悄悄切换提供方', async () => {
  for (const unavailable of ['list', 'info']) {
    const providers = [];
    const llm = {
      listProviders: () => [{ id: 'chosen' }, { id: 'deepseek-account' }],
      async listModels(provider) {
        providers.push(provider);
        if (unavailable === 'list') throw new Error('temporarily unavailable');
        return [{ id: 'model', inputModalities: ['text'] }];
      },
      async resolveModelInfo() { throw new Error('temporarily unavailable'); },
    };
    await assert.rejects(routeFor(llm, { provider: 'chosen', model: 'model' }), { code: 'MODEL_INFO' });
    assert.deepEqual(providers, ['chosen']);
  }
});

test('超过证据剩余容量的长段落不阻塞后续短段落', () => {
  const paragraphs = Array.from({ length: 5 }, (_, index) => ({ id: index + 1, page: 1, text: 'x'.repeat(2400) }));
  paragraphs.push({ id: 6, page: 2, text: 'Short evidence.' });
  assert.deepEqual(selectEvidence({ paragraphs }, {}, 'method', 1).map(excerpt => excerpt.id), [1, 2, 3, 4, 6]);
});

test('模型限流和额度耗尽保留不同错误代码', async () => {
  for (const code of ['RATE_LIMIT', 'QUOTA_EXHAUSTED']) {
    const llm = { async *stream() { yield { type: 'finish', reason: { kind: 'error', failure: { code } } }; } };
    await assert.rejects(complete(llm, {}, '', {}, 10, new AbortController().signal), {
      status: 429, code: code === 'RATE_LIMIT' ? 'RATE_LIMIT' : 'QUOTA',
    });
  }
});
