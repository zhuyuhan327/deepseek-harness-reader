import {
  BATCH_CHARS, BATCH_PARAGRAPHS, TRANSLATION_PROMPT,
  parseTranslations, protectMath, validateTranslation,
  translationFragments, assembleFragments,
} from './model.js';
import { isTranslatable } from './classify.js';

// One shared queue bounds translation and question traffic for this reader.
export function createRequestQueue(concurrency = 2) {
  const pending = [];
  let active = 0;
  let limit = concurrency;
  let throttledUntil = 0;
  function drain() {
    if (Date.now() >= throttledUntil) limit = concurrency;
    while (active < limit && pending.length) {
      const item = pending.shift();
      item.signal.removeEventListener('abort', item.abort);
      if (item.signal.aborted) {
        item.reject(item.signal.reason);
        continue;
      }
      active++;
      void Promise.resolve().then(() => {
        item.signal.throwIfAborted();
        return item.task();
      }).then(item.resolve, error => {
        if (error?.code === 'RATE_LIMIT') {
          limit = 1;
          throttledUntil = Date.now() + 30_000;
        }
        item.reject(error);
      }).finally(() => { active--; drain(); });
    }
  }
  return (task, signal) => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const item = { task, signal, resolve, reject };
    item.abort = () => {
      const index = pending.indexOf(item);
      if (index >= 0) pending.splice(index, 1);
      reject(signal.reason);
    };
    pending.push(item);
    signal.addEventListener('abort', item.abort, { once: true });
    drain();
  });
}

function splitBatches(items) {
  const batches = [];
  let batch = [];
  let chars = 0;
  for (const item of items) {
    if (batch.length && (chars + item.text.length > BATCH_CHARS || batch.length >= BATCH_PARAGRAPHS)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(item);
    chars += item.text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

// The host validates saved translations before calling this worker. Requests
// are independent; writes are serialized and use the same validation as reads.
export async function translateDocument({ document, translations, request, save, signal, concurrency = 2 }) {
  signal.throwIfAborted();
  const groups = new Map();
  for (const paragraph of document.paragraphs) {
    if (!isTranslatable(paragraph.kind)) continue;
    const protectedText = protectMath(paragraph.text, paragraph.mathSpans, paragraph.id);
    const key = JSON.stringify([paragraph.text, protectedText.tokens.map(token => token.value)]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ paragraph, ...protectedText });
  }
  const tasks = [];
  let copied = false;
  for (const group of groups.values()) {
    const cached = group.find(({ paragraph }) => Object.hasOwn(translations, paragraph.id));
    if (cached) {
      for (const { paragraph } of group) {
        if (Object.hasOwn(translations, paragraph.id)) continue;
        translations[paragraph.id] = translations[cached.paragraph.id];
        copied = true;
      }
    } else {
      tasks.push({ ...group[0], group });
    }
  }
  if (copied) await save();
  const batches = splitBatches(tasks);
  let cursor = 0;
  let fatal;
  let writeTail = Promise.resolve();
  const failures = [];
  const persist = accepted => {
    signal.throwIfAborted();
    for (const [item, text] of accepted) {
      for (const { paragraph } of item.group) translations[paragraph.id] = text;
    }
    writeTail = writeTail.then(() => { signal.throwIfAborted(); return save(); });
    return writeTail;
  };
  async function respond(system, data) {
    if (fatal) throw fatal;
    signal.throwIfAborted();
    try { return await request(system, data, 6500); }
    catch (error) {
      // An unusable answer is a paragraph failure, unlike an unavailable
      // account, connection or storage. Later paragraphs can still succeed.
      if (!['NO_CONTENT', 'OUTPUT_LIMIT'].includes(error?.code)) throw error;
      return { text: '', finished: false };
    }
  }
  async function invoke(items, instruction = '') {
    const paragraphs = items.map(item => ({ id: item.paragraph.id, text: item.text }));
    const reply = await respond(TRANSLATION_PROMPT + instruction, { title: document.title, paragraphs });
    signal.throwIfAborted();
    return parseTranslations(reply.text, paragraphs, {
      allowPlainText: Boolean(instruction) && items.length === 1 && reply.finished === true,
      finished: reply.finished === true,
    });
  }
  async function translateBatch(items) {
    const result = await invoke(items);
    const accepted = [];
    const missing = [];
    for (const item of items) {
      const checked = validateTranslation(item.paragraph, result.values.get(item.paragraph.id), item.tokens);
      if (checked.text !== undefined) accepted.push([item, checked.text]);
      else missing.push(item);
    }
    if (accepted.length) await persist(accepted);
    for (const item of missing) {
      if (fatal) return;
      const retry = await invoke([item], '本次只翻译一个段落，请完整保留所有占位符。');
      let checked = validateTranslation(item.paragraph, retry.values.get(item.paragraph.id), item.tokens);
      if (checked.text === undefined) {
        const fragments = translationFragments(item.paragraph);
        const values = new Map();
        for (const paragraphs of splitBatches(fragments.paragraphs)) {
          const reply = await respond(fragments.prompt, { title: document.title, ...fragments.data, paragraphs });
          signal.throwIfAborted();
          const parts = parseTranslations(reply.text, paragraphs, {
            allowPlainText: paragraphs.length === 1 && reply.finished === true,
            finished: reply.finished === true,
          });
          for (const [id, value] of parts.values) values.set(id, value);
          if (parts.missing.length) break;
        }
        if (fragments.sequence.length) checked = assembleFragments(item.paragraph, fragments, values);
      }
      if (checked.text !== undefined) await persist([[item, checked.text]]);
      else {
        for (const { paragraph } of item.group) {
          failures.push({ id: paragraph.id, page: paragraph.page, reason: checked.reason });
        }
      }
    }
  }
  async function worker() {
    while (!fatal && cursor < batches.length) {
      const items = batches[cursor++];
      try { await translateBatch(items); }
      catch (error) { fatal ??= error; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  await writeTail;
  signal.throwIfAborted();
  if (fatal) throw fatal;
  return failures.sort((a, b) => a.page - b.page || a.id - b.id);
}
