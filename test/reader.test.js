import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createReader } from '../src/host.js';
import { parseTranslations } from '../src/model.js';

const origin = 'http://127.0.0.1:8767';

function defaultReply(data) {
  if (!data.paragraphs) return '结果见论文第 1 页。';
  return JSON.stringify(Object.fromEntries(data.paragraphs.map(p => [p.id, `第 ${p.id} 段的译文`])));
}

function model() {
  const calls = [];
  let failAt = -1;
  let reply = null;
  const llm = {
    listProviders: () => [{ id: 'deepseek-account' }, { id: 'api-key' }],
    listModels: async provider => {
      assert.equal(provider, 'deepseek-account');
      return [{ id: 'test-flash', inputModalities: ['text'] }];
    },
    async *stream(options) {
      assert.equal(options.provider, 'deepseek-account');
      assert.deepEqual(options.tools, []);
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
    llm, calls,
    failOn(call) { failAt = call; },
    setReply(fn) { reply = fn; },
  };
}

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-quiet-reader-test-'));
  const workspaceIds = new Map();
  const fake = model();
  const ctx = {
    llm: fake.llm,
    workspaceRegistry: {
      async create(path) {
        if (!workspaceIds.has(path)) workspaceIds.set(path, `workspace-${workspaceIds.size + 1}`);
        return { id: workspaceIds.get(path) };
      },
    },
  };
  let reader = createReader(ctx, root);
  t.after(async () => {
    reader.dispose();
    await rm(root, { recursive: true, force: true });
  });

  async function request(action, id, body, extra = {}) {
    const url = new URL('/api/dsh-quiet-reader', origin);
    url.searchParams.set('action', action);
    if (id) url.searchParams.set('id', id);
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
        text: texts?.[index] ?? `${title}: section ${index + 1} describes the experimental method.`,
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

  return {
    ...fake, request, upload, until, workspaceIds,
    restart() {
      reader.dispose();
      reader = createReader(ctx, root);
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
  assert.equal(host.workspaceIds.size, 2);

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

test('模型始终返回无法解析的内容时报告错误而不是死循环', async t => {
  const host = await harness(t);
  host.setReply(() => '抱歉，我无法完成这个请求。');
  const paper = await host.upload('Unusable output', 3);
  const failed = await host.until(paper.id, 'error');
  assert.match(failed.error, /无法解析/);
  assert.equal(failed.translated, 0);
  assert.ok(host.calls.length < 20);
});

test('宿主拒绝跨站请求', async t => {
  const host = await harness(t);
  const result = await host.request('import', null, {}, { 'sec-fetch-site': 'cross-site' });
  assert.equal(result.status, 403);
  assert.equal(host.calls.length, 0);
});
