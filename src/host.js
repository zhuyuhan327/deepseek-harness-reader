import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, unlink, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  routeFor, complete, ReaderError, QUESTION_PROMPT, selectEvidence, validateTranslation,
} from './model.js';
import { classifyParagraphs, isTranslatable } from './classify.js';
import { createRequestQueue, translateDocument } from './translation.js';

export const name = 'dsh-quiet-reader';
export const inject = ['connection', 'llm', 'workspaceRegistry'];
const ROUTE = '/api/dsh-quiet-reader';
const PDF_LIMIT_MB = 40;
const PDF_LIMIT = PDF_LIMIT_MB * 1024 * 1024;
const ID = /^[a-f0-9]{64}$/;
const require = createRequire(import.meta.url);
const LAYOUT_VERSION = 7;

function validBox(box) {
  return Array.isArray(box) && box.length === 4
    && box.every(n => Number.isFinite(n) && n >= 0 && n <= 1)
    && box[0] < box[2] && box[1] < box[3];
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

async function saveJson(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx' });
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, path);
        break;
      } catch (error) {
        const temporaryLock = process.platform === 'win32' && ['EPERM', 'EBUSY', 'EACCES'].includes(error.code);
        if (!temporaryLock || attempt >= 5) throw error;
        await delay(12 * 2 ** attempt);
      }
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function validateMathSpans(spans, text) {
  if (spans === undefined) return [];
  const invalid = () => new ReaderError('PDF 行内公式位置无效。');
  if (!Array.isArray(spans) || spans.length > text.length) throw invalid();
  const first = text.length - text.trimStart().length;
  const last = text.trimEnd().length;
  const splitsCodePoint = offset => offset > 0 && /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(text.slice(offset - 1, offset + 1));
  const result = [];
  let previousEnd = 0;
  for (const span of spans) {
    const { start, end } = span ?? {};
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < previousEnd || end <= start ||
        end > text.length || splitsCodePoint(start) || splitsCodePoint(end)) throw invalid();
    previousEnd = end;
    const trimmedStart = Math.max(first, start);
    const trimmedEnd = Math.min(last, end);
    if (trimmedStart < trimmedEnd) {
      const { box, baseline, size } = span;
      const hasGeometry = validBox(box) && Number.isFinite(baseline) && baseline >= 0 && baseline <= 1
        && Number.isFinite(size) && size > 0 && size < 200;
      result.push({
        start: trimmedStart - first, end: trimmedEnd - first,
        ...(hasGeometry ? { box, baseline, size } : {}),
      });
    }
  }
  return result;
}

function validateDocument(input) {
  if (!input || !Array.isArray(input.pages) || input.pages.length < 1 || input.pages.length > 150 ||
      !Array.isArray(input.paragraphs) || !input.paragraphs.length || input.paragraphs.length > 2500) {
    throw new ReaderError('请上传 150 页以内、可提取文本的 PDF。');
  }
  const pages = input.pages.map(page => {
    if (!page || ![page.width, page.height].every(n => Number.isFinite(n) && n > 0 && n < 6000)) {
      throw new ReaderError('PDF 页面尺寸不受支持。');
    }
    return { width: page.width, height: page.height };
  });
  let chars = 0;
  const paragraphs = input.paragraphs.map((p, index) => {
    if (!p || p.id !== index + 1 || !Number.isInteger(p.page) || p.page < 1 || p.page > pages.length ||
        typeof p.text !== 'string' || !p.text.trim() || p.text.length > 2400 ||
        !validBox(p.box)) {
      throw new ReaderError('PDF 段落位置无效。');
    }
    chars += p.text.length;
    const mathSpans = validateMathSpans(p.mathSpans, p.text);
    const style = p.style && typeof p.style === 'object'
      ? {
        size: Number.isFinite(p.style.size) && p.style.size > 0 && p.style.size < 200 ? p.style.size : 0,
        bold: Boolean(p.style.bold),
        italic: Boolean(p.style.italic),
        align: ['center', 'right'].includes(p.style.align) ? p.style.align : 'left',
        fontFamily: ['sans-serif', 'monospace'].includes(p.style.fontFamily) ? p.style.fontFamily : 'serif',
        lineHeight: Number.isFinite(p.style.lineHeight) && p.style.lineHeight > 0 && p.style.lineHeight < 200
          ? p.style.lineHeight : 0,
      }
      : undefined;
    const lines = Array.isArray(p.lines) ? p.lines.slice(0, 160).filter(validBox) : [];
    return {
      id: p.id, page: p.page, box: p.box, text: p.text.trim(),
      ...(style ? { style } : {}),
      ...(lines.length ? { lines } : {}),
      ...(mathSpans.length ? { mathSpans } : {}),
    };
  });
  if (chars > 600_000) throw new ReaderError('文献文字超过 60 万字符，请拆分 PDF。');
  const title = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim().slice(0, 180) : '';
  const total = pages.length;
  let range;
  if (input.range && typeof input.range === 'object') {
    const first = Number(input.range.first);
    const last = Number(input.range.last);
    if (Number.isInteger(first) && Number.isInteger(last) && first >= 1 && last <= total && first <= last) {
      range = { first, last };
    }
  }
  const layoutVersion = input.layoutVersion === LAYOUT_VERSION ? LAYOUT_VERSION : 0;
  const regions = Array.isArray(input.regions) ? input.regions.slice(0, 10_000).filter(region =>
    region && Number.isInteger(region.page) && region.page >= 1 && region.page <= total
    && ['figure', 'table'].includes(region.kind) && validBox(region.box))
    .map(({ page, kind, box }) => ({ page, kind, box })) : [];
  return { title: title || '未命名论文', pages, paragraphs, regions, layoutVersion, ...(range ? { range } : {}) };
}

// Older manifests are classified when read and saved in the current schema
// on reimport. Reads never replace the manifest of a concurrent import.
const SCHEMA = 5;

function withKinds(document) {
  const needs = document.schema !== SCHEMA || document.paragraphs.some(paragraph => paragraph.kind === undefined);
  if (!needs) return document;
  const kinds = classifyParagraphs(document.paragraphs, document.regions);
  return {
    ...document,
    schema: SCHEMA,
    paragraphs: document.paragraphs.map((paragraph, index) => ({ ...paragraph, kind: kinds[index] })),
  };
}

function pageRange(document) {
  return document.range ?? { first: 1, last: document.pages.length };
}

function inRange(page, range) {
  return page >= range.first && page <= range.last;
}

function activeDocument(document) {
  const range = pageRange(document);
  return {
    ...document,
    paragraphs: document.paragraphs.filter(p => inRange(p.page, range)),
    regions: (document.regions ?? []).filter(region => inRange(region.page, range)),
  };
}

function mergeImport(stored, parsed) {
  const range = pageRange(parsed);
  const loaded = new Set(stored?.importedPages ?? stored?.paragraphs.map(p => p.page));
  const layoutPages = new Set(stored?.layoutVersion === LAYOUT_VERSION ? stored.layoutPages : []);
  const replace = new Set();
  for (let page = range.first; page <= range.last; page++) {
    if (!loaded.has(page) || (parsed.layoutVersion && !layoutPages.has(page))) replace.add(page);
    loaded.add(page);
    if (parsed.layoutVersion) layoutPages.add(page);
  }
  if (!replace.size && stored) return { ...stored, range };

  const previous = stored?.paragraphs ?? [];
  const candidates = new Map();
  for (const paragraph of previous) {
    if (!replace.has(paragraph.page)) continue;
    const key = JSON.stringify([paragraph.page, paragraph.text]);
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(paragraph.id);
  }
  let nextId = previous.reduce((max, paragraph) => Math.max(max, paragraph.id), stored?.lastParagraphId ?? 0);
  const paragraphs = previous.filter(p => !replace.has(p.page));
  for (const paragraph of parsed.paragraphs) {
    if (!replace.has(paragraph.page)) continue;
    const key = JSON.stringify([paragraph.page, paragraph.text]);
    paragraphs.push({ ...paragraph, id: candidates.get(key)?.shift() ?? ++nextId });
  }
  paragraphs.sort((a, b) => a.page - b.page);
  const regions = [
    ...(stored?.regions ?? []).filter(region => !replace.has(region.page)),
    ...parsed.regions.filter(region => replace.has(region.page)),
  ];
  return withKinds({
    ...parsed, range, paragraphs, regions, importedPages: [...loaded], layoutPages: [...layoutPages],
    layoutVersion: parsed.layoutVersion || (stored?.layoutVersion === LAYOUT_VERSION ? LAYOUT_VERSION : 0),
    lastParagraphId: nextId,
  });
}

async function boundedBody(request, limit) {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > limit) throw new ReaderError('上传内容超过大小限制。', 413);
  if (!request.body) throw new ReaderError('请求缺少内容。');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ReaderError('上传内容超过大小限制。', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

/**
 * Remove answers that cannot be shown: empty strings and text containing the
 * Unicode replacement character (a corrupted model answer or transport chunk).
 * @returns how many entries were dropped.
 */
function pruneTranslations(translations) {
  let removed = 0;
  for (const [id, value] of Object.entries(translations)) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\uFFFD')) {
      delete translations[id];
      removed += 1;
    }
  }
  return removed;
}

/**
 * Drop stored answers with missing mathematical spans or incomplete prose so
 * the next translation pass rewrites them.
 * @returns how many entries were dropped or normalized.
 */
function pruneSuspicious(document, translations) {
  const byId = new Map(document.paragraphs.map(paragraph => [String(paragraph.id), paragraph]));
  let changed = 0;
  for (const [id, value] of Object.entries(translations)) {
    const paragraph = byId.get(id);
    if (!paragraph) continue;
    const checked = validateTranslation(paragraph, value);
    if (checked.text === undefined) {
      delete translations[id];
      changed += 1;
    } else if (checked.text !== value) {
      translations[id] = checked.text;
      changed += 1;
    }
  }
  return changed;
}

function assertOrigin(request) {
  const site = request.headers.get('sec-fetch-site');
  const origin = request.headers.get('origin');
  if (site && site !== 'same-origin' && site !== 'none') {
    throw new ReaderError('请求来源不符合阅读面板的访问要求。', 403);
  }
  if (origin) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      throw new ReaderError('请求来源不符合阅读面板的访问要求。', 403);
    }
    if (origin !== new URL(request.url).origin && host !== request.headers.get('host')) {
      throw new ReaderError('请求来源不符合阅读面板的访问要求。', 403);
    }
  }
  if (request.method === 'POST' && request.headers.get('x-quiet-reader') !== '1') {
    throw new ReaderError('请从 Harness 阅读面板发起操作。', 403);
  }
}

export function createReader(ctx, root) {
  const jobs = new Map();
  const starting = new Map();
  const imports = new Map();
  const questions = new Map();
  const mutations = new Set();
  const lifetime = new AbortController();
  const enqueueModel = createRequestQueue(2);

  const settingsPath = join(dirname(root), 'settings.json');
  let catalogue = { at: 0, value: null };

  async function readSettings() {
    const stored = await readJson(settingsPath, {});
    return stored && typeof stored === 'object' ? stored : {};
  }

  // The catalogue is read from Harness on demand, so models added by a future
  // DSH update appear in the picker without changing the plugin.
  async function modelCatalogue() {
    if (catalogue.value && Date.now() - catalogue.at < 60_000) return catalogue.value;
    const providers = [];
    for (const provider of ctx.llm.listProviders()) {
      let models;
      try {
        models = await ctx.llm.listModels(provider.id);
      } catch {
        models = [];
      }
      const text = (models ?? []).filter(model => !model.inputModalities || model.inputModalities.includes('text'));
      if (!text.length) continue;
      providers.push({
        id: provider.id,
        name: provider.name ?? provider.id,
        models: text.map(model => ({ id: model.id, name: model.name ?? model.id })),
      });
    }
    catalogue = { at: Date.now(), value: providers };
    return providers;
  }

  function waitForTask(promise, signal) {
    return new Promise((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      if (signal.aborted) aborted();
      else signal.addEventListener('abort', aborted, { once: true });
      void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    });
  }

  function modelTask(task, signal) {
    return enqueueModel(() => waitForTask(Promise.resolve().then(() => {
      signal.throwIfAborted();
      return task();
    }), signal), signal);
  }

  function assertIdle(id) {
    if (mutations.has(id)) throw new ReaderError('正在清除或删除这篇文献，请稍后重试。', 409);
  }

  async function mutatePaper(id, action) {
    assertIdle(id);
    if (imports.has(id)) throw new ReaderError('正在导入这篇文献，请稍后重试。', 409);
    mutations.add(id);
    try {
      await Promise.allSettled([starting.get(id)]);
      const document = await paper(id);
      const job = jobs.get(id);
      const question = questions.get(id);
      const reason = new ReaderError('文献已清除或删除，本次请求已停止。', 409);
      job?.controller.abort(reason);
      question?.controller.abort(reason);
      // Any disk write that started before cancellation must finish before this
      // mutation removes its result.
      await Promise.allSettled([job?.task, question?.task]);
      jobs.delete(id);
      return await action(document);
    } finally {
      mutations.delete(id);
    }
  }

  function directory(id) {
    if (!ID.test(id ?? '')) throw new ReaderError('文献编号无效。');
    return join(root, id);
  }

  async function paper(id) {
    const stored = await readJson(join(directory(id), 'paper.json'), null);
    if (!stored) throw new ReaderError('找不到该文献。', 404);
    return withKinds(stored);
  }

  async function detail(id) {
    const document = activeDocument(await paper(id));
    const translations = await readJson(join(directory(id), 'translations.json'), {});
    // Stored answers that carry replacement characters or look truncated are not
    // shown; dropping them here makes the paper look unfinished so they get
    // translated again.
    pruneTranslations(translations);
    pruneSuspicious(document, translations);
    const history = await readJson(join(directory(id), 'history.json'), []);
    const translatable = document.paragraphs.filter(paragraph => isTranslatable(paragraph.kind));
    const translatedCount = translatable.filter(paragraph => Object.hasOwn(translations, paragraph.id)).length;
    const activeTranslations = Object.fromEntries(translatable
      .filter(paragraph => Object.hasOwn(translations, paragraph.id))
      .map(paragraph => [paragraph.id, translations[paragraph.id]]));
    const job = jobs.get(id);
    return {
      ...document, translations: activeTranslations, history, translated: translatedCount, expected: translatable.length,
      status: translatable.length === translatedCount ? 'complete' : job?.status === 'complete' ? 'pending' : job?.status ?? 'pending',
      error: job?.error ?? '', failedParagraphs: job?.failures ?? [],
      translationStats: job?.stats,
    };
  }

  function startTranslation(document) {
    document = activeDocument(document);
    const id = document.id;
    assertIdle(id);
    if (jobs.get(id)?.status === 'running') return;
    const controller = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, controller.signal]);
    const job = { status: 'running', error: '', controller, stats: { requests: 0, repairs: 0, inputChars: 0, outputChars: 0 } };
    jobs.set(id, job);
    job.task = (async () => {
      try {
        const path = join(directory(id), 'translations.json');
        const translations = await readJson(path, {});
        signal.throwIfAborted();
        const droppedEmpty = pruneTranslations(translations);
        const droppedSuspicious = pruneSuspicious(document, translations);
        if (droppedEmpty || droppedSuspicious) await saveJson(path, translations);
        if (!document.paragraphs.some(p => isTranslatable(p.kind) && !Object.hasOwn(translations, p.id))) return;
        let routeTask;
        const request = async (system, data, maxTokens, { phase = 'initial' } = {}) => {
          const run = () => modelTask(async () => {
            routeTask ??= readSettings().then(settings => routeFor(ctx.llm, settings, signal, { translation: true }));
            const route = await waitForTask(routeTask, signal);
            signal.throwIfAborted();
            job.stats.requests++;
            if (phase !== 'initial') job.stats.repairs++;
            job.stats.inputChars += system.length + JSON.stringify(data).length;
            const reply = await complete(ctx.llm, route, system, data, maxTokens, signal);
            job.stats.outputChars += reply.text.length;
            return reply;
          }, signal);
          try { return await run(); }
          catch (error) {
            if (error?.code !== 'RATE_LIMIT') throw error;
            await delay(750, undefined, { signal });
            return run();
          }
        };
        job.failures = await translateDocument({
          document, translations, request, signal,
          save: () => saveJson(path, translations),
        });
        if (job.failures.length) {
          job.status = 'error';
          job.error = `${job.failures.length} 段未完成，其他译文已保存。可查看下方原因并继续翻译。`;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (!(error instanceof ReaderError)) {
          ctx.logger?.warn?.(`dsh-quiet-reader: translation interrupted (${error.code ?? error.name ?? 'unknown'})`);
        }
        job.status = 'error';
        job.error = error instanceof ReaderError ? error.message : '全文翻译暂停。请检查账号或本地文件后继续。';
      } finally {
        if (jobs.get(id) === job) {
          if (signal.aborted) {
            if (lifetime.signal.aborted) jobs.delete(id);
            else { job.status = 'pending'; job.error = ''; }
          }
          else if (job.status === 'running') job.status = 'complete';
        }
      }
    })();
  }

  function prepareTranslation(id) {
    assertIdle(id);
    if (!starting.has(id)) {
      const task = paper(id).then(startTranslation).finally(() => starting.delete(id));
      starting.set(id, task);
    }
    return starting.get(id);
  }

  async function pauseTranslation(id) {
    assertIdle(id);
    await paper(id);
    await starting.get(id);
    const job = jobs.get(id);
    if (job?.status === 'running') {
      job.controller.abort(new ReaderError('翻译已暂停，已完成的译文已保留。', 409));
      await job.task;
    }
    return detail(id);
  }

  async function importPaper(request) {
    const bytes = await boundedBody(request, PDF_LIMIT + 5 * 1024 * 1024);
    let form;
    try {
      form = await new Response(bytes, { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData();
    } catch {
      throw new ReaderError('上传请求格式无效。');
    }
    const file = form.get('pdf');
    const documentJson = form.get('document');
    if (!(file instanceof File) || !file.size || file.size > PDF_LIMIT || typeof documentJson !== 'string') {
      throw new ReaderError(`请选择 ${PDF_LIMIT_MB} MB 以内的 PDF。`);
    }
    const pdf = Buffer.from(await file.arrayBuffer());
    if (!pdf.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
      throw new ReaderError('文件缺少有效的 PDF 标记。');
    }
    let input;
    try { input = JSON.parse(documentJson); } catch { throw new ReaderError('解析后的文献数据无效。'); }
    const parsed = validateDocument(input);
    const id = createHash('sha256').update(pdf).digest('hex');
    assertIdle(id);
    const previous = imports.get(id);
    const task = (previous?.catch(() => {}) ?? Promise.resolve()).then(async () => {
      const path = directory(id);
      await mkdir(path, { recursive: true });
      const manifest = join(path, 'paper.json');
      const stored = await readJson(manifest, null);
      if (!stored) await writeFile(join(path, 'original.pdf'), pdf);
      const workspace = await ctx.workspaceRegistry.create(path, stored?.title ?? parsed.title);
      const document = { ...withKinds(mergeImport(stored, parsed)), id, workspaceId: String(workspace.id) };
      await saveJson(manifest, document);
      // Reopening an imported paper shows its existing progress. Resume is explicit.
      if (!stored) startTranslation(document);
      return detail(id);
    });
    imports.set(id, task);
    try { return await task; } finally { if (imports.get(id) === task) imports.delete(id); }
  }

  function ask(id, input) {
    const question = typeof input.question === 'string' ? input.question.trim() : '';
    if (!question || question.length > 1000) throw new ReaderError('请输入 1 至 1000 字的问题。');
    assertIdle(id);
    if (questions.has(id)) throw new ReaderError('本篇文献还有一个问题正在回答。', 409);
    const controller = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, controller.signal]);
    const job = { controller };
    questions.set(id, job);
    job.task = (async () => {
      try {
        const document = await detail(id);
        signal.throwIfAborted();
        const selected = document.paragraphs.find(p => p.id === input.selectedId);
        const page = selected?.page ?? (Number.isInteger(input.page) ? input.page : 1);
        const excerpts = selectEvidence(document, document.translations, question, page, selected?.id);
        const history = document.history.slice(-2).map(turn => ({
          question: turn.question.slice(0, 400), answer: turn.answer.slice(0, 750),
        }));
        const route = await waitForTask(routeFor(ctx.llm, await readSettings(), signal), signal);
        const reply = await modelTask(() => complete(ctx.llm, route, QUESTION_PROMPT, {
          title: document.title, question, history, excerpts,
        }, 1400, signal), signal);
        signal.throwIfAborted();
        if (!reply.finished) throw new ReaderError('回答未完整生成。请重试当前问题。', 502);
        const answer = reply.text;
        const turn = { question, answer, references: excerpts.map(({ id, page }) => ({ id, page })) };
        const updated = [...document.history, turn].slice(-40);
        await saveJson(join(directory(id), 'history.json'), updated);
        return updated;
      } finally {
        if (questions.get(id) === job) questions.delete(id);
      }
    })();
    return job.task;
  }

  async function list() {
    const entries = await readdir(root, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const result = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID.test(entry.name)) continue;
      const value = await readJson(join(root, entry.name, 'paper.json'), null);
      if (!value) continue;
      result.push({ id: value.id, title: value.title, workspaceId: value.workspaceId });
    }
    return result.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  }

  async function asset(name) {
    if (name === 'reader.css') {
      return new Response(await readFile(new URL('./reader.css', import.meta.url)), {
        headers: { 'content-type': 'text/css; charset=utf-8', 'x-content-type-options': 'nosniff' },
      });
    }
    if (name === 'layout.js' || name === 'presentation.js' || name === 'pdf-export.js') {
      return new Response(await readFile(new URL('./' + name, import.meta.url)), {
        headers: { 'content-type': 'text/javascript; charset=utf-8', 'x-content-type-options': 'nosniff' },
      });
    }
    let library;
    try {
      library = dirname(require.resolve('pdfjs-dist/package.json'));
    } catch {
      throw new ReaderError('阅读器缺少 PDF 解析依赖，请重新安装插件。', 500);
    }
    if (name === 'pdf.mjs' || name === 'pdf.worker.mjs') {
      return new Response(await readFile(join(library, 'build', name)), {
        headers: { 'content-type': 'text/javascript; charset=utf-8', 'x-content-type-options': 'nosniff' },
      });
    }
    if (/^standard_fonts\/[A-Za-z0-9_.-]+\.(?:pfb|ttf)$/.test(name)) {
      return new Response(await readFile(join(library, name)), {
        headers: { 'content-type': 'application/octet-stream' },
      });
    }
    throw new ReaderError('找不到该阅读资源。', 404);
  }

  async function fetch(request) {
    try {
      assertOrigin(request);
      const { searchParams } = new URL(request.url);
      const action = searchParams.get('action');
      const id = searchParams.get('id');
      if (request.method === 'GET') {
        if (action === 'list') return json(await list());
        if (action === 'detail') return json(await detail(id));
        if (action === 'asset') return await asset(searchParams.get('name') ?? '');
        if (action === 'settings') {
          return json({ current: await readSettings(), providers: await modelCatalogue() });
        }
        if (action === 'modelInfo') {
          const provider = searchParams.get('provider') ?? '';
          const model = searchParams.get('model') ?? '';
          try {
            const info = await ctx.llm.resolveModelInfo?.(provider, model);
            const efforts = (info?.reasoning?.efforts ?? []).map(effort => ({ id: effort.id, name: effort.name ?? effort.id }));
            return json({ efforts });
          } catch {
            return json({ efforts: [] });
          }
        }
        if (action === 'pdf') {
          await paper(id);
          return new Response(await readFile(join(directory(id), 'original.pdf')), {
            headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
          });
        }
      }
      if (request.method === 'POST') {
        if (action === 'import') return json(await importPaper(request), 201);
        if (action === 'settings') {
          let input;
          try { input = JSON.parse(await boundedBody(request, 4096)); } catch { throw new ReaderError('模型设置格式无效。'); }
          const providers = await modelCatalogue();
          const provider = providers.find(item => item.id === input?.provider) ?? providers[0];
          if (!provider) throw new ReaderError('当前没有可用的文本模型。', 503);
          const model = provider.models.find(item => item.id === input?.model) ?? provider.models[0];
          const settings = { provider: provider.id, model: model.id,
            translationMode: input?.translationMode === 'custom' ? 'custom' : 'economy' };
          let efforts = [];
          try {
            const info = await ctx.llm.resolveModelInfo?.(provider.id, model.id);
            efforts = info?.reasoning?.efforts ?? [];
          } catch {}
          const wanted = typeof input?.reasoningEffort === 'string' ? input.reasoningEffort : '';
          if (wanted && efforts.some(effort => effort.id === wanted)) settings.reasoningEffort = wanted;
          else if (efforts.some(effort => effort.id === 'off')) settings.reasoningEffort = 'off';
          await saveJson(settingsPath, settings);
          return json({ current: settings, providers });
        }
        if (action === 'translate') {
          await prepareTranslation(id);
          return json(await detail(id), 202);
        }
        if (action === 'pause') return json(await pauseTranslation(id));
        if (action === 'reset') {
          return json(await mutatePaper(id, async document => {
            await rm(join(directory(id), 'translations.json'), { force: true });
            await rm(join(directory(id), 'history.json'), { force: true });
            return detail(document.id);
          }));
        }
        if (action === 'delete') {
          return json(await mutatePaper(id, async document => {
            try {
              if (document.workspaceId) await ctx.workspaceRegistry.delete?.(document.workspaceId);
            } catch {
              throw new ReaderError('工作区删除失败，文献文件已保留。请重试。', 502);
            }
            await rm(directory(id), { recursive: true, force: true });
            return { deleted: document.id };
          }));
        }
        if (action === 'ask') {
          let input;
          try { input = JSON.parse(await boundedBody(request, 8192)); } catch { throw new ReaderError('问题请求格式无效。'); }
          return json(await ask(id, input ?? {}));
        }
      }
      throw new ReaderError('阅读操作不存在。', 404);
    } catch (error) {
      const status = error instanceof ReaderError ? error.status : 500;
      return json({ error: status === 500 ? '阅读服务暂时不可用。请检查本地存储或 Harness 账号。' : error.message }, status);
    }
  }
  return { fetch, dispose: () => lifetime.abort() };
}

export function apply(ctx) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const reader = createReader(ctx, resolve(home, 'plugins', name, 'papers'));
  ctx.effect(() => {
    const disposers = [
      ctx.connection.fetch.register({
        path: ROUTE, methods: ['GET'], requestBody: 'buffered', fetch: reader.fetch,
      }),
      ctx.connection.fetch.register({
        path: ROUTE + '/write', methods: ['POST'], requestBody: 'streaming', fetch: reader.fetch,
      }),
    ];
    return () => {
      for (const dispose of disposers) dispose?.();
      reader.dispose();
    };
  });
}
