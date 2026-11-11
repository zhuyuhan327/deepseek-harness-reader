import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createReader } from '../src/host.js';

async function harness(t, respond, workspaceRegistry = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-quiet-reader-lifecycle-'));
  const reader = createReader({
    workspaceRegistry: { async create() { return { id: 'test-workspace' }; }, ...workspaceRegistry },
    llm: {
      listProviders: () => [{ id: 'deepseek-account' }],
      listModels: async () => [{ id: 'test-flash', inputModalities: ['text'] }],
      async *stream({ messages, signal }) {
        const data = JSON.parse(messages[0].content[0].text);
        const text = await respond(data, signal);
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  }, root);
  t.after(async () => {
    reader.dispose();
    await rm(root, { recursive: true, force: true });
  });

  async function request(action, id, input) {
    const url = new URL('http://127.0.0.1:8767/api/dsh-quiet-reader');
    url.searchParams.set('action', action);
    if (id) url.searchParams.set('id', id);
    const response = await reader.fetch(new Request(url, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { 'x-quiet-reader': '1' },
      body: input instanceof FormData || input === undefined ? input : JSON.stringify(input),
    }));
    return { status: response.status, value: await response.json() };
  }

  async function importPaper() {
    const form = new FormData();
    form.set('pdf', new File(['%PDF-1.7\nFixture\n%%EOF'], 'paper.pdf'));
    form.set('document', JSON.stringify({
      title: 'Fixture paper',
      pages: [{ width: 612, height: 792 }],
      paragraphs: [{ id: 1, page: 1, text: 'The approach improves image reconstruction.', box: [0.12, 0.2, 0.83, 0.25] }],
    }));
    const result = await request('import', undefined, form);
    assert.equal(result.status, 201, JSON.stringify(result.value));
    return result.value;
  }

  async function translated(id) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { value } = await request('detail', id);
      if (value.status === 'complete') return value;
      assert.notEqual(value.status, 'error', value.error);
      await delay(10);
    }
    assert.fail('翻译未在预期时间内完成');
  }

  return { root, request, importPaper, translated };
}

test('清除译文取消在途模型请求，旧结果不能覆盖随后启动的翻译', { timeout: 4_000 }, async t => {
  const started = Promise.withResolvers();
  const finishOld = Promise.withResolvers();
  t.after(() => finishOld.resolve());
  let callCount = 0;
  const host = await harness(t, async (_data, signal) => {
    if (++callCount === 1) {
      started.resolve(signal);
      await finishOld.promise;
      return '{"1":"旧的翻译结果。"}';
    }
    return '{"1":"新的翻译结果。"}';
  });
  const { id } = await host.importPaper();
  const oldSignal = await started.promise;

  const reset = await host.request('reset', id, {});
  assert.equal(reset.status, 200);
  assert.equal(reset.value.translated, 0);
  assert.equal(oldSignal.aborted, true);

  assert.equal((await host.request('translate', id, {})).status, 202);
  finishOld.resolve();
  const detail = await host.translated(id);
  assert.equal(detail.translations[1], '新的翻译结果。');
  assert.equal(callCount, 2);
});

test('列表保留工作区缺失的文献，显式删除取消进行中的问答', { timeout: 4_000 }, async t => {
  const questionStarted = Promise.withResolvers();
  const finishQuestion = Promise.withResolvers();
  t.after(() => finishQuestion.resolve());
  const removedWorkspaces = [];
  const host = await harness(t, async (data, signal) => {
    if (data.question) {
      questionStarted.resolve(signal);
      await finishQuestion.promise;
      return '旧文献的问答结果。';
    }
    return '{"1":"该方法改善了图像重建。"}';
  }, {
    list: () => [],
    async delete(id) { removedWorkspaces.push(id); },
  });
  const { id } = await host.importPaper();
  await host.translated(id);
  const list = await host.request('list');
  assert.deepEqual(list.value.map(paper => paper.id), [id]);
  await access(join(host.root, id, 'original.pdf'));

  const question = host.request('ask', id, { question: '论文的主要结论是什么？' });
  const questionSignal = await questionStarted.promise;
  const removed = await host.request('delete', id, {});
  assert.equal(removed.status, 200);
  assert.deepEqual(removedWorkspaces, ['test-workspace']);
  assert.equal(questionSignal.aborted, true);
  assert.equal((await question).status, 409);
  await assert.rejects(access(join(host.root, id, 'original.pdf')), { code: 'ENOENT' });

  finishQuestion.resolve();
  const reopened = await host.importPaper();
  assert.equal(reopened.id, id);
  assert.deepEqual((await host.translated(id)).history, []);
});

test('工作区删除失败时保留原文和已有译文', async t => {
  const host = await harness(t, async () => '{"1":"该方法改善了图像重建。"}', {
    async delete() { throw new Error('workspace table write failed'); },
  });
  const { id } = await host.importPaper();
  await host.translated(id);
  assert.equal((await host.request('delete', id, {})).status, 502);
  await access(join(host.root, id, 'original.pdf'));
  assert.equal((await host.request('detail', id)).value.translated, 1);
});
