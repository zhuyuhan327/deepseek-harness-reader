import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { translateDocument, createRequestQueue } from '../src/translation.js';
import { ReaderError, BATCH_PARAGRAPHS, validateTranslation } from '../src/model.js';

const paragraph = id => ({ id, page: Math.ceil(id / 14), kind: 'text', text: `Section ${id} describes the reconstruction method.` });

test('两批并发翻译使用独立段落，写入串行且可从进度恢复', async () => {
  const translations = {};
  let requests = 0;
  let active = 0;
  let maximum = 0;
  let writing = false;
  let snapshot;
  const options = {
    document: { title: 'Fixture', paragraphs: Array.from({ length: 28 }, (_, i) => paragraph(i + 1)) },
    translations,
    signal: new AbortController().signal,
    async request(_system, data) {
      requests++;
      maximum = Math.max(maximum, ++active);
      await delay(20);
      active--;
      return { text: JSON.stringify(Object.fromEntries(data.paragraphs.map(p => [p.id, '本节描述了图像重建方法。']))) };
    },
    async save() {
      assert.equal(writing, false);
      writing = true;
      await delay(2);
      snapshot = { ...translations };
      writing = false;
    },
  };
  assert.deepEqual(await translateDocument(options), []);
  assert.equal(maximum, 2);
  assert.equal(requests, 2);
  assert.equal(Object.keys(snapshot).length, 28);
  await translateDocument(options);
  assert.equal(requests, 2);
});

test('单段无法翻译时保留失败位置并完成后续段落', async () => {
  const translations = {};
  const document = { title: 'Fixture', paragraphs: Array.from({ length: 30 }, (_, i) => paragraph(i + 1)) };
  document.paragraphs[0].text = 'Unrecoverable sentence about reconstruction.';
  const failures = await translateDocument({
    document, translations, signal: new AbortController().signal, save: async () => {},
    async request(_system, data) {
      return { text: JSON.stringify(Object.fromEntries((data.paragraphs ?? [])
        .filter(p => !p.text.includes('Unrecoverable'))
        .map(p => [p.id, '本节描述了图像重建方法。']))) };
    },
  });
  assert.deepEqual(failures.map(({ id, page }) => ({ id, page })), [{ id: 1, page: 1 }]);
  assert.equal(Object.keys(translations).length, 29);
  assert.ok(translations[30]);
});

test('重复正文复用已验证结果', async () => {
  const translations = { 1: '本节描述了图像重建方法。' };
  let calls = 0;
  await translateDocument({
    document: { paragraphs: [paragraph(1), { ...paragraph(1), id: 2, page: 2 }] },
    translations, signal: new AbortController().signal, save: async () => {},
    request: async () => { calls++; throw Error('unexpected request'); },
  });
  assert.equal(calls, 0);
  assert.equal(translations[2], translations[1]);
});

test('连续空回复和超长回复只标记失败段落，后续批次仍能完成', async () => {
  for (const code of ['NO_CONTENT', 'OUTPUT_LIMIT']) {
    const translations = {};
    let calls = 0;
    const failures = await translateDocument({
      document: { paragraphs: Array.from({ length: 30 }, (_, i) => paragraph(i + 1)) },
      translations, signal: new AbortController().signal, save: async () => {},
      async request(_system, data) {
        calls++;
        if (data.paragraphs.some(p => p.id <= 14)) throw new ReaderError('bad output', 502, code);
        return { text: JSON.stringify(Object.fromEntries(data.paragraphs.map(p => [p.id, '本节描述了图像重建方法。']))), finished: true };
      },
    });
    assert.deepEqual(failures.map(item => item.id), Array.from({ length: 14 }, (_, i) => i + 1));
    assert.equal(Object.keys(translations).length, 16);
    assert.ok(translations[30]);
    assert.equal(calls, 17);
  }
});

test('公式密集段落分批翻译文字片段，拼回后全部变量可重新校验', async () => {
  const item = { id: 2, page: 1, kind: 'text', text: 'Estimate σ and ϵ from observation α. '.repeat(60).trim() };
  const translations = {};
  let fragmentCalls = 0;
  const failures = await translateDocument({
    document: { paragraphs: [item] }, translations, signal: new AbortController().signal, save: async () => {},
    async request(_system, data) {
      if (!data.context) return { text: '{}', finished: true };
      fragmentCalls++;
      assert.ok(data.paragraphs.length <= BATCH_PARAGRAPHS);
      const parts = { Estimate: '估计', and: '和', '. Estimate': '。估计', 'from observation': '根据观测值' };
      return { text: JSON.stringify(Object.fromEntries(data.paragraphs.map(p => [p.id, parts[p.text]]))), finished: true };
    },
  });
  assert.deepEqual(failures, []);
  assert.ok(fragmentCalls > 1);
  assert.equal((translations[2].match(/σ/g) ?? []).length, 60);
  assert.equal((translations[2].match(/ϵ/g) ?? []).length, 60);
  assert.equal((translations[2].match(/α/g) ?? []).length, 60);
  assert.equal(validateTranslation(item, translations[2]).text, translations[2]);
});

test('未完成的编号回复不保存半句，单段重试后保存完整译文', async () => {
  const translations = {};
  let calls = 0;
  await translateDocument({
    document: { paragraphs: [paragraph(12)] }, translations,
    signal: new AbortController().signal, save: async () => {},
    async request() {
      calls++;
      return calls === 1 ? { text: '12. 这项方法解决', finished: false }
        : { text: '本节描述了图像重建方法。', finished: true };
    },
  });
  assert.equal(calls, 2);
  assert.equal(translations[12], '本节描述了图像重建方法。');
});

test('限流后队列降低并发，取消排队请求不会阻塞后续任务', async () => {
  const queue = createRequestQueue(2);
  const signal = new AbortController().signal;
  const finish = Promise.withResolvers();
  const first = queue(() => finish.promise, signal);
  const limited = queue(() => { throw Object.assign(Error('limited'), { code: 'RATE_LIMIT' }); }, signal);
  await assert.rejects(limited, /limited/);
  const controller = new AbortController();
  const cancelled = queue(() => assert.fail('cancelled task started'), controller.signal);
  controller.abort();
  await assert.rejects(cancelled);
  let began = false;
  const next = queue(() => { began = true; }, signal);
  await delay(5);
  assert.equal(began, false);
  finish.resolve();
  await Promise.all([first, next]);
  assert.equal(began, true);
});
