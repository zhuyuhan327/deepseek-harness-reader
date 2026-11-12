import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createReader } from '../src/host.js';
import { looksComplete, parseTranslations, protectMath, restoreMath, restoreMathTolerant } from '../src/model.js';

const origin = 'http://127.0.0.1:8767';

function defaultReply(data) {
  if (!data.paragraphs) return '结果见论文第 1 页。';
  return JSON.stringify(Object.fromEntries(data.paragraphs.map(p => [p.id, `第 ${p.id} 段的译文`])));
}

function model() {
  const calls = [];
  const requests = [];
  let failAt = -1;
  let reply = null;
  const llm = {
    listProviders: () => [{ id: 'deepseek-account' }, { id: 'api-key' }],
    listModels: async provider => {
      if (provider !== 'deepseek-account') return [];
      return [
        { id: 'test-flash', inputModalities: ['text'] },
        { id: 'test-pro', inputModalities: ['text'] },
      ];
    },
    resolveModelInfo: async (provider, model) => ({
      reasoning: { efforts: [{ id: 'off', name: '关闭' }, { id: 'high', name: '高' }] },
    }),
    async *stream(options) {
      assert.equal(options.provider, 'deepseek-account');
      assert.deepEqual(options.tools, []);
      requests.push({ provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort });
      const data = JSON.parse(options.messages[0].content[0].text);
      calls.push(data);
      if (calls.length === failAt) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'NETWORK' } } };
        return;
      }
      const text = reply ? reply(data, calls.length - 1) : defaultReply(data);
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  return {
    llm, calls, requests,
    failOn(call) { failAt = call; },
    setReply(fn) { reply = fn; },
  };
}

async function harness(t) {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-quiet-reader-test-'));
  const root = join(temp, 'library');
  const config = join(temp, 'profile', 'papers');
  await mkdir(root);
  const workspaceIds = new Map();
  let workspaceId;
  const fake = model();
  const ctx = {
    llm: fake.llm,
    workspaceRegistry: {
      async create(path, title) {
        if (!workspaceIds.has(path)) workspaceIds.set(path, { id: `workspace-${workspaceIds.size + 1}`, path, title });
        return workspaceIds.get(path);
      },
      list: () => [...workspaceIds.values()],
    },
  };
  let reader = createReader(ctx, config);
  t.after(async () => {
    reader.dispose();
    await rm(temp, { recursive: true, force: true });
  });

  async function request(action, id, body, extra = {}) {
    const url = new URL('/api/dsh-quiet-reader', origin);
    url.searchParams.set('action', action);
    if (id) url.searchParams.set('id', id);
    if (workspaceId) url.searchParams.set('workspaceId', workspaceId);
    const headers = { 'x-quiet-reader': '1', ...extra };
    const response = await reader.fetch(new Request(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
    }));
    return { status: response.status, value: await response.json() };
  }

  async function upload(title, count = 18, texts = null) {
    const form = new FormData();
    form.set('pdf', new File([`%PDF-1.7\n${title}\n%%EOF`], 'paper.pdf'));
    form.set('document', JSON.stringify({
      title,
      pages: [{ width: 612, height: 792 }],
      paragraphs: Array.from({ length: count }, (_, index) => ({
        id: index + 1, page: 1, box: [0.1, 0.1, 0.9, 0.15],
        ...(typeof texts?.[index] === 'object' ? texts[index] : {
          text: texts?.[index] ?? `${title}: section ${index + 1} describes the experimental method.`,
        }),
      })),
    }));
    const result = await request('import', null, form);
    assert.equal(result.status, 201, JSON.stringify(result.value));
    return result.value;
  }

  async function until(id, status) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const { value } = await request('detail', id);
      if (value.status === status) return value;
      if (value.status === 'error' && status !== 'error') assert.fail(value.error);
      await delay(15);
    }
    assert.fail(`文献未达到状态 ${status}`);
  }

  const selection = await request('workspace', null, { folder: root });
  assert.equal(selection.status, 200);
  workspaceId = selection.value.workspace.id;
  async function paperPath(id) {
    const name = (await readdir(root)).find(entry => entry.endsWith(`-${id}`));
    assert.ok(name);
    return join(root, name);
  }
  return {
    ...fake, request, upload, until, workspaceIds, paperPath,
    restart() {
      reader.dispose();
      reader = createReader(ctx, config);
    },
  };
}

test('自动翻译在断网后保存已完成批次，重启后仅发送剩余段落', async t => {
  const host = await harness(t);
  host.failOn(2);
  const paper = await host.upload('Network recovery', 30);
  const interrupted = await host.until(paper.id, 'error');
  assert.equal(interrupted.translated, 14);

  host.restart();
  const { value: saved } = await host.request('detail', paper.id);
  assert.equal(saved.translated, 14);
  assert.equal(saved.status, 'pending');
  assert.equal((await host.request('translate', paper.id, {})).status, 202);
  const complete = await host.until(paper.id, 'complete');
  assert.equal(complete.translated, 30);
  assert.equal(complete.translations[1], saved.translations[1]);
  assert.deepEqual(host.calls.slice(2).flatMap(call => call.paragraphs.map(p => p.id)),
    Array.from({ length: 16 }, (_, index) => index + 15));
});

test('重复导入复用工作区，论文问答只读取当前文献', async t => {
  const host = await harness(t);
  const first = await host.upload('Article alpha');
  await host.until(first.id, 'complete');
  const duplicate = await host.upload('Article alpha');
  assert.equal(duplicate.workspaceId, first.workspaceId);
  const second = await host.upload('Article beta');
  await host.until(second.id, 'complete');
  assert.equal(host.workspaceIds.size, 1);
  assert.equal(first.workspaceId, second.workspaceId);

  const answer = await host.request('ask', second.id, {
    question: '方法是什么？', page: 1, selectedId: 3,
  });
  assert.equal(answer.status, 200);
  const input = host.calls.at(-1);
  assert.equal(input.excerpts[0].id, 3);
  assert.ok(input.excerpts.every(excerpt => excerpt.text.startsWith('Article beta:')));
  const { value: reopened } = await host.request('detail', second.id);
  assert.equal(reopened.history.length, 1);
  assert.equal((await host.request('detail', first.id)).value.history.length, 0);
});

test('重导同一 PDF 的其他页保留既有段落编号与译文', async t => {
  const host = await harness(t);
  const upload = async (first, layoutVersion) => {
    const form = new FormData();
    form.set('pdf', new File(['%PDF-1.7\nPage range fixture\n%%EOF'], 'range.pdf'));
    form.set('document', JSON.stringify({
      title: 'Page range fixture',
      layoutVersion,
      pages: Array.from({ length: 2 }, () => ({ width: 612, height: 792 })),
      range: { first, last: first },
      regions: [{ page: first, kind: 'formula', box: [.20, .4, .5, .45] }],
      paragraphs: [{
        id: 1, page: first, box: [.1, .2, .9, .25], lines: [[.1, .2, .8, .24]],
        text: first === 1 ? 'The first section describes experimental methods.' : 'The next section presents research findings.',
      }],
    }));
    const result = await host.request('import', null, form);
    assert.equal(result.status, 201);
    return result.value;
  };
  const first = await upload(1);
  const saved = await host.until(first.id, 'complete');
  const reanalyzed = await upload(1, 16);
  assert.deepEqual(reanalyzed.layoutPages, [1]);
  assert.deepEqual(reanalyzed.translations, saved.translations);
  assert.deepEqual(reanalyzed.regions.map(region => region.kind), ['formula']);

  const second = await upload(2, 16);
  assert.equal(second.id, first.id);
  assert.equal(second.workspaceId, first.workspaceId);
  assert.deepEqual(second.range, { first: 2, last: 2 });
  assert.deepEqual(second.paragraphs.map(({ id, page }) => [id, page]), [[2, 2]]);
  assert.deepEqual(second.translations, {});
  await host.request('translate', second.id, {});
  assert.equal((await host.until(second.id, 'complete')).translated, 1);

  const reopened = await upload(1, 16);
  assert.deepEqual(reopened.translations, saved.translations);
  assert.equal(host.calls.length, 2);
});

test('译文解析容忍围栏、前后缀、嵌套、数组、截断与编号列表', () => {
  const batch = [{ id: 1, text: 'a' }, { id: 2, text: 'b' }, { id: 3, text: 'c' }];
  const size = output => parseTranslations(output, batch).values.size;

  assert.equal(size('{"1":"甲","2":"乙","3":"丙"}'), 3);
  assert.equal(size('以下是译文：\n```json\n{"1":"甲","2":"乙","3":"丙"}\n```\n希望有帮助。'), 3);
  assert.equal(size('译文：{"1":"甲","2":"乙","3":"丙"} 完毕'), 3);
  assert.equal(size('{"translations":{"1":"甲","2":"乙","3":"丙"}}'), 3);
  assert.equal(size('["甲","乙","丙"]'), 3);
  assert.equal(size('1. 甲\n2. 乙\n3. 丙'), 3);
  assert.equal(size('{"1":"甲","2":"乙","9":"多余的段落"}'), 2);
  // Bare numeric keys and keys decorated with a label both resolve to the id.
  assert.equal(size('{1:"甲",2:"乙",3:"丙"}'), 3);
  assert.equal(size('{"段落1":"甲","段落2":"乙","段落3":"丙"}'), 3);
  // A truncated object keeps every complete pair before the cut.
  assert.equal(size('{"1":"甲","2":"乙","3":"丙'), 2);
  // A corrupted value is treated as missing so it can be asked for again.
  assert.equal(size('{"1":"甲","2":"乙\uFFFD丙","3":"丙"}'), 2);
  // Raw newlines inside a value are repaired instead of failing the batch.
  assert.equal(size('{"1":"第一行\n第二行","2":"乙","3":"丙"}'), 3);
  // Nothing usable at all is reported as missing, never as a partial fake.
  const empty = parseTranslations('抱歉，我无法完成这个请求。', batch);
  assert.equal(empty.values.size, 0);
  assert.deepEqual(empty.missing, [1, 2, 3]);
});

test('模型把译文包在解释和代码围栏里时仍能完成全文翻译', async t => {
  const host = await harness(t);
  host.setReply(data => {
    const json = defaultReply(data);
    return '好的，以下是本批译文：\n```json\n' + json + '\n```\n如需调整请告诉我。';
  });
  const paper = await host.upload('Fenced JSON');
  const complete = await host.until(paper.id, 'complete');
  assert.equal(complete.status, 'complete');
  assert.equal(complete.translations[1], '第 1 段的译文');
});

test('有歧义的顺序编号不会把译文写给其他段落', () => {
  const batch = [{ id: 2 }, { id: 5 }];
  for (const output of [
    '{"1":"甲","2":"乙"}',
    '{"1":"甲","2":"乙","3":"未完',
    '1. 甲\n2. 乙',
    '["乙"]',
  ]) {
    const { values, missing } = parseTranslations(output, batch);
    assert.equal(values.size, 0);
    assert.deepEqual(missing, [2, 5]);
  }
  assert.deepEqual([...parseTranslations('{"2":"甲","5":"乙"}', batch).values], [[2, '甲'], [5, '乙']]);
  assert.deepEqual([...parseTranslations('{"1":"甲","2":"乙"}', [{ id: 4 }, { id: 5 }]).values], [[4, '甲'], [5, '乙']]);
  const oversized = '译'.repeat(12_001);
  assert.equal(parseTranslations(`{"2":"${oversized}","5":"未完`, batch).values.size, 0);
});

test('译文被截断时先保存可用段落，再补齐剩余段落', async t => {
  const host = await harness(t);
  let first = true;
  host.setReply(data => {
    const json = defaultReply(data);
    if (first) {
      first = false;
      return json.slice(0, Math.floor(json.length * 0.6));
    }
    return json;
  });
  const paper = await host.upload('Truncated JSON', 20);
  const complete = await host.until(paper.id, 'complete');
  assert.equal(complete.translated, 20);
  assert.ok(host.calls.length > 1);
});

test('符号、数字与单字母段落标记为跳过，不提交给模型也不覆盖原文', async t => {
  const host = await harness(t);
  const paper = await host.upload('Symbols', 6, ['∗', 't', '13', 'Introduction to the method', 'σ', 'true']);
  const complete = await host.until(paper.id, 'complete');
  assert.equal(complete.expected, 2);
  assert.equal(complete.translated, 2);
  assert.equal(complete.translations[1], undefined);
  assert.equal(complete.translations[2], undefined);
  assert.equal(complete.translations[4], '第 4 段的译文');
  const sent = host.calls.flatMap(call => call.paragraphs.map(paragraph => paragraph.id));
  assert.ok(!sent.includes(1) && !sent.includes(2) && !sent.includes(3) && !sent.includes(5));
  assert.ok(sent.includes(4));
});

test('含替换字符的旧译文会被丢弃并在继续时重新翻译', async t => {
  const host = await harness(t);
  const paper = await host.upload('Corrupted answer', 3);
  await host.until(paper.id, 'complete');
  const path = join(await host.paperPath(paper.id), 'translations.json');
  const translations = JSON.parse(await readFile(path, 'utf8'));
  translations[2] = '第 2 段\uFFFD的译文';
  await writeFile(path, JSON.stringify(translations));

  const broken = (await host.request('detail', paper.id)).value;
  assert.equal(broken.translated, 2);
  assert.equal(broken.status, 'pending');
  assert.equal((await host.request('translate', paper.id, {})).status, 202);
  const fixed = await host.until(paper.id, 'complete');
  assert.equal(fixed.translations[2], '第 2 段的译文');
});

test('公式占位符保护与回填', () => {
  const source = 'Use ⟦M:7:0⟧ in the original text, and solve xᵢ = σ² + 10⁻³ [1, 2].';
  const { text, tokens } = protectMath(source, [], 7);
  assert.deepEqual(tokens.map(token => token.value), ['⟦M:7:0⟧', 'xᵢ = σ² + 10⁻³', '[1, 2]']);
  assert.ok(tokens.every(token => !source.includes(token.marker)));
  assert.equal(restoreMath(text, tokens), source);
  const markers = tokens.map(token => token.marker);
  assert.equal(restoreMath(markers.slice(1).join(' '), tokens), null);
  assert.equal(restoreMath(markers.toReversed().join(' '), tokens), null);
  assert.equal(restoreMath([...markers, markers[0]].join(' '), tokens), null);
  assert.equal(restoreMath(text.replace(markers[0], '[0]'), tokens), null);
  assert.equal(restoreMath(protectMath(source, [], 8).text, tokens), null);
});

test('简洁但完整的译文不会被误判为截断', () => {
  const source = 'where the second term acts as a regularizer, discouraging the network from fitting sharp, high-frequency fluctuations. The derivation of this expansion is provided in section C.1.';
  const translated = '其中第二项充当正则化项，抑制网络拟合尖锐的高频波动。此展开的推导见第 C.1 节。';
  assert.equal(looksComplete(source, translated), true);
  // A clipped answer that starts mid-formula is still rejected.
  assert.equal(looksComplete(source, '= 1 e− 4}。'), false);
});

test('占位符被改写时容错回填', () => {
  const source = 'Noise σ and ϵ are used here.';
  const { text, tokens } = protectMath(source, [], 3);
  const marker = tokens[0].marker;
  const mangled = text.replace(marker, marker.slice(0, -1));
  assert.equal(restoreMath(mangled, tokens), null);
  const tolerant = restoreMathTolerant(mangled, tokens);
  assert.ok(tolerant.includes('ϵ'));
  assert.ok(!tolerant.includes('⟦'));
  assert.ok(tolerant.includes('and'));
});

test('占位符被模型改写时不会整篇失败', async t => {
  const host = await harness(t);
  host.setReply(data => JSON.stringify(Object.fromEntries(
    data.paragraphs.map(p => [p.id, `${p.text.replace('⟧', '')} 的译文`]))));
  const paper = await host.upload('Mangled markers', 1, ['The noise σ is added at each diffusion step.']);
  const complete = await host.until(paper.id, 'complete');
  assert.ok(complete.translations[1].length > 0);
});

test('保留 PDF 提取标记的行内公式与原有引文', async t => {
  const host = await harness(t);
  const source = '  The custom operator customKernel yields the next value [1].  ';
  const start = source.indexOf('customKernel');
  host.setReply(data => JSON.stringify(Object.fromEntries(data.paragraphs.map(p => [p.id, `译文：${p.text}`]))));
  const paper = await host.upload('Inline layout', 1, [{ text: source, mathSpans: [{ start, end: start + 12 }] }]);
  const complete = await host.until(paper.id, 'complete');
  assert.deepEqual(complete.paragraphs[0].mathSpans, [{ start: start - 2, end: start + 10 }]);
  const sent = host.calls[0].paragraphs[0].text;
  assert.ok(!sent.includes('customKernel') && !sent.includes('[1]'));
  assert.equal(complete.translations[1], `译文：${source.trim()}`);
});

test('只保存回填后通过完整性检查的译文', async t => {
  const host = await harness(t);
  const source = 'This carefully constructed numerical model estimates the next unknown parameter σ and compares it with the previously computed estimate under several assumptions.';
  host.setReply((data, attempt) => JSON.stringify(Object.fromEntries(data.paragraphs.map(p => {
    const { marker } = protectMath(source, [], p.id).tokens[0];
    const value = attempt ? `译文：${p.text}` : '译'.repeat(Math.floor(source.length / 4) - 2) + marker;
    return [p.id, value];
  }))));
  const paper = await host.upload('Formula length', 1, [source]);
  const complete = await host.until(paper.id, 'complete');
  assert.equal(host.calls.length, 2);
  assert.equal(complete.translations[1], `译文：${source}`);
});

test('译文丢失占位符时整段重译并回填符号', async t => {
  const host = await harness(t);
  let first = true;
  host.setReply(data => {
    if (first) {
      first = false;
      return JSON.stringify(Object.fromEntries(data.paragraphs.map(p => [p.id, '缺少占位符的译文'])));
    }
    return JSON.stringify(Object.fromEntries(data.paragraphs.map(p => [p.id, `第 ${p.id} 段：${p.text}`])));
  });
  const paper = await host.upload('Symbols', 2, [
    'The noise σ is sampled at each step.',
    'The weight ϵ decays over time.',
  ]);
  const complete = await host.until(paper.id, 'complete');
  assert.ok(complete.translations[1].includes('σ'));
  assert.ok(complete.translations[2].includes('ϵ'));
  assert.equal(first, false);
});

test('译文丢句时重译', async t => {
  const host = await harness(t);
  let first = true;
  host.setReply(data => {
    if (first) {
      first = false;
      return JSON.stringify(Object.fromEntries(data.paragraphs.map(p => [p.id, '只译了第一句。'])));
    }
    return JSON.stringify(Object.fromEntries(data.paragraphs.map(p => [p.id, `第 ${p.id} 段：第一句。第二句。第三句。`])));
  });
  const paper = await host.upload('Sentences', 2, [
    'First sentence here. Second sentence follows. Third sentence ends.',
    'Alpha starts. Beta continues. Gamma finishes.',
  ]);
  const complete = await host.until(paper.id, 'complete');
  assert.match(complete.translations[1], /第三句/);
  assert.equal(first, false);
});

test('疑似截断的旧译文会被作废并重译', async t => {
  const host = await harness(t);
  const paper = await host.upload('Clipped answer', 2, [
    'A long English sentence that describes the proposed method in enough detail to be checked by the completeness rule.',
    'Another long English sentence about the experiments, the datasets and the measured results of this paper.',
  ]);
  await host.until(paper.id, 'complete');
  const path = join(await host.paperPath(paper.id), 'translations.json');
  const data = JSON.parse(await readFile(path, 'utf8'));
  data[1] = '= 1 e− 4}。';
  await writeFile(path, JSON.stringify(data));

  const broken = (await host.request('detail', paper.id)).value;
  assert.equal(broken.translated, 1);
  assert.equal((await host.request('translate', paper.id, {})).status, 202);
  const fixed = await host.until(paper.id, 'complete');
  assert.match(fixed.translations[1], /第 1 段/);
});

test('可以清除译文，也可以整篇删除', async t => {
  const host = await harness(t);
  const paper = await host.upload('Deletable', 3);
  await host.until(paper.id, 'complete');

  const reset = await host.request('reset', paper.id, {});
  assert.equal(reset.status, 200);
  assert.equal(reset.value.translated, 0);
  assert.equal(reset.value.status, 'pending');
  assert.equal((await host.request('detail', paper.id)).value.translations[1], undefined);

  const removed = await host.request('delete', paper.id, {});
  assert.equal(removed.status, 200);
  assert.equal(removed.value.deleted, paper.id);
  const missing = await host.request('detail', paper.id);
  assert.equal(missing.status, 404);
});

test('模型始终返回无法解析的内容时报告错误而不是死循环', async t => {
  const host = await harness(t);
  host.setReply(() => '抱歉，我无法完成这个请求。');
  const paper = await host.upload('Unusable output', 3);
  const failed = await host.until(paper.id, 'error');
  assert.match(failed.error, /未完成/);
  assert.equal(failed.translated, 0);
  assert.equal(failed.failedParagraphs.length, 3);
  assert.ok(failed.failedParagraphs.every(item => item.page === 1 && item.reason === 'missing'));
  assert.ok(host.calls.length < 20);
});

test('可以选择模型与推理强度并在翻译时使用', async t => {
  const host = await harness(t);
  const catalogue = (await host.request('settings')).value;
  assert.ok(catalogue.providers.some(provider => provider.id === 'deepseek-account'
    && provider.models.some(model => model.id === 'test-pro')));
  const info = (await host.request('modelInfo', { provider: 'deepseek-account', model: 'test-pro' })).value;
  assert.deepEqual(info.efforts.map(effort => effort.id), ['off', 'high']);

  const saved = (await host.request('settings', null, {
    provider: 'deepseek-account', model: 'test-pro', reasoningEffort: 'high', translationMode: 'custom',
  })).value;
  assert.equal(saved.current.model, 'test-pro');
  assert.equal(saved.current.reasoningEffort, 'high');

  const paper = await host.upload('Model choice', 2);
  await host.until(paper.id, 'complete');
  assert.equal(host.requests[0].model, 'test-pro');
  assert.equal(host.requests[0].reasoningEffort, 'high');
});

test('省费模式只关闭翻译思考，问答仍保留选定模型与推理强度', async t => {
  const host = await harness(t);
  await host.request('settings', null, {
    provider: 'deepseek-account', model: 'test-pro', reasoningEffort: 'high',
  });
  const paper = await host.upload('Economy translation', 2);
  const completed = await host.until(paper.id, 'complete');
  assert.equal(host.requests[0].model, 'test-pro');
  assert.equal(host.requests[0].reasoningEffort, 'off');
  assert.equal(completed.translationStats.requests, 1);
  assert.ok(completed.translationStats.inputChars > 0);
  assert.equal(completed.translationStats.repairs, 0);
  await host.request('ask', paper.id, { question: '论文有什么结论？' });
  assert.equal(host.requests.at(-1).reasoningEffort, 'high');
});

test('宿主拒绝跨站请求', async t => {
  const host = await harness(t);
  const result = await host.request('import', null, {}, { 'sec-fetch-site': 'cross-site' });
  assert.equal(result.status, 403);
  assert.equal(host.calls.length, 0);
});
