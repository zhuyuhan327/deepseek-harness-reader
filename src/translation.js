import {
  BATCH_CHARS, BATCH_PARAGRAPHS, TRANSLATION_PROMPT,
  parseTranslations, protectMath, validateTranslation,
  translationFragments, assembleFragments,
} from './model.js';
import { isTranslatable } from './classify.js';
import { restoreMathTolerant, stripMathMarkers } from './math.js';

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

function splitBatches(items, maxParts = BATCH_PARAGRAPHS, maxChars = BATCH_CHARS) {
  const batches = [];
  let batch = [];
  let chars = 0;
  for (const item of items) {
    if (batch.length && (chars + item.text.length > maxChars || batch.length >= maxParts)) {
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

function alreadySimplified(text) {
  const prose = text.replace(/⟦M+:\d+:\d+⟧/g, '');
  return /^[\p{Script=Han}\p{N}\p{P}\p{S}\s]+$/u.test(prose) &&
    /[这为图对经发还应结从项进测训练变归观读译]/u.test(prose) &&
    !/[這為圖對經發還應結從項進測訓練變歸觀讀譯論學術數據實驗顯說設計處機網絡決採範圍參與視頻較統資歷臺灣]/u.test(prose);
}

function groupFragments({ paragraphs, sequence }) {
  const byContext = new Map();
  const aliases = new Map();
  const adjacent = (index, step) => {
    for (let i = index + step; typeof sequence[i] === 'string'; i += step) {
      if (sequence[i].trim()) return sequence[i].trim();
    }
    return '';
  };
  sequence.forEach((id, index) => {
    if (typeof id !== 'number') return;
    const part = paragraphs[id - 1];
    const key = JSON.stringify([adjacent(index, -1), part.text, adjacent(index, 1)]);
    if (byContext.has(key)) aliases.set(id, byContext.get(key).id);
    else byContext.set(key, part);
  });
  return { parts: [...byContext.values()], aliases };
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
    const [item] = group;
    const local = !cached && alreadySimplified(item.text) ? validateTranslation(item.paragraph, item.paragraph.text, item.tokens).text : undefined;
    const reused = cached ? translations[cached.paragraph.id] : local;
    if (reused !== undefined) {
      for (const { paragraph } of group) {
        if (Object.hasOwn(translations, paragraph.id)) continue;
        translations[paragraph.id] = reused;
        copied = true;
      }
    } else {
      tasks.push({ ...item, group });
    }
  }
  if (copied) await save();
  const initialBatches = splitBatches(tasks);
  let fatal;
  let writeTail = Promise.resolve();
  const persist = accepted => {
    signal.throwIfAborted();
    for (const [item, text] of accepted) {
      for (const { paragraph } of item.group) translations[paragraph.id] = text;
    }
    writeTail = writeTail.then(() => { signal.throwIfAborted(); return save(); });
    return writeTail;
  };
  async function respond(system, data, phase) {
    if (fatal) throw fatal;
    signal.throwIfAborted();
    try { return await request(system, data, 6500, { phase }); }
    catch (error) {
      // An unusable answer is a paragraph failure, unlike an unavailable
      // account, connection or storage. Later paragraphs can still succeed.
      if (!['NO_CONTENT', 'OUTPUT_LIMIT', 'UNEXPECTED_TOOL'].includes(error?.code)) throw error;
      return { text: '', finished: false };
    }
  }
  async function invoke(items, phase) {
    const paragraphs = items.map(item => ({ id: item.paragraph.id, text: item.text }));
    const instruction = phase === 'repair' ? '这些是需要补译的段落。请按原编号逐项完整翻译并核对占位符。' : '';
    const reply = await respond(TRANSLATION_PROMPT + instruction, { title: document.title, paragraphs }, phase);
    signal.throwIfAborted();
    return parseTranslations(reply.text, paragraphs, {
      allowPlainText: items.length === 1 && reply.finished === true,
      finished: reply.finished === true,
    });
  }
  async function runPass(batches, phase) {
    let cursor = 0;
    const pending = [];
    async function worker() {
      while (!fatal && cursor < batches.length) {
        const items = batches[cursor++];
        try {
          const result = await invoke(items, phase);
          const accepted = [];
          const missing = [];
          for (const item of items) {
            const checked = validateTranslation(item.paragraph, result.values.get(item.paragraph.id), item.tokens);
            if (checked.text !== undefined) accepted.push([item, checked.text]);
            else missing.push({ ...item, reason: checked.reason, value: result.values.get(item.paragraph.id) });
          }
          if (accepted.length) await persist(accepted);
          for (const item of missing) pending.push({ ...item, partial: accepted.length > 0 });
        } catch (error) { fatal ??= error; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
    signal.throwIfAborted();
    if (fatal) throw fatal;
    return pending.sort((a, b) => a.paragraph.page - b.paragraph.page || a.paragraph.id - b.paragraph.id);
  }

  const pending = await runPass(initialBatches, 'initial');
  const repairBatches = splitBatches(pending, Math.floor(BATCH_PARAGRAPHS / 2), Math.floor(BATCH_CHARS / 2));
  const remaining = await runPass(repairBatches, 'repair');
  // Cap supplementary calls relative to the initial work. An unsuccessful
  // model cannot turn every missing paragraph into a cascade of requests.
  let fallbackCalls = Math.max(3, initialBatches.length);
  const failures = [];
  for (const item of remaining) {
    let checked = { reason: item.reason };
    if (fallbackCalls && item.partial && checked.reason === 'missing') {
      fallbackCalls--;
      const retry = await invoke([item], 'repair');
      checked = validateTranslation(item.paragraph, retry.values.get(item.paragraph.id), item.tokens);
    }
    if (fallbackCalls && checked.text === undefined && (item.tokens.length || checked.reason === 'incomplete')) {
      const fragments = translationFragments(item.paragraph);
      const { parts, aliases } = groupFragments(fragments);
      // Short clauses need far fewer output tokens than full paragraphs. Pack
      // them more densely so a normal formula-heavy paragraph can still fit
      // within the bounded supplementary budget.
      const partsPerBatch = Math.max(BATCH_PARAGRAPHS * 3, Math.ceil(parts.length / fallbackCalls));
      const batches = splitBatches(parts, partsPerBatch, Math.floor(BATCH_CHARS / 2));
      if (batches.length && batches.length <= fallbackCalls) {
        const values = new Map();
        for (const paragraphs of batches) {
          fallbackCalls--;
          const reply = await respond(fragments.prompt, { title: document.title, ...fragments.data, paragraphs }, 'fragments');
          signal.throwIfAborted();
          const parsed = parseTranslations(reply.text, paragraphs, {
            allowPlainText: paragraphs.length === 1 && reply.finished === true,
            finished: reply.finished === true,
          });
          for (const [id, value] of parsed.values) values.set(id, value);
          if (parsed.missing.length) break;
        }
        for (const [id, representative] of aliases) values.set(id, values.get(representative));
        checked = assembleFragments(item.paragraph, fragments, values);
      }
    }
    let accepted = checked.text;
    if (accepted === undefined && checked.reason === 'math' && typeof item.value === 'string') {
      accepted = restoreMathTolerant(item.value, item.tokens ?? []) ?? stripMathMarkers(item.value);
    }
    if (accepted !== undefined) await persist([[item, accepted]]);
    else for (const { paragraph } of item.group) failures.push({ id: paragraph.id, page: paragraph.page, reason: checked.reason });
  }
  signal.throwIfAborted();
  return failures.sort((a, b) => a.page - b.page || a.id - b.id);
}
