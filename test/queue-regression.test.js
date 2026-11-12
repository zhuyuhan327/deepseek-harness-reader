import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequestQueue } from '../src/translation.js';

test('开始执行前取消的模型请求不会调用模型或占住队列', async () => {
  const queue = createRequestQueue(1);
  const controller = new AbortController();
  const reason = new Error('paper reset');
  let calls = 0;
  const cancelled = queue(() => { calls++; }, controller.signal);
  controller.abort(reason);

  await assert.rejects(cancelled, error => error === reason);
  assert.equal(calls, 0);
  const next = await queue(() => 'next', new AbortController().signal);
  assert.equal(next, 'next');
});
