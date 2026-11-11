import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  accountRoute, complete, ReaderError, QUESTION_PROMPT, selectEvidence,
  TRANSLATION_PROMPT, translationBatch, parseTranslations,
} from './model.js';
import { classifyParagraphs, KIND_SKIP } from './classify.js';

export const name = 'dsh-quiet-reader';
export const inject = ['connection', 'llm', 'workspaceRegistry'];
const ROUTE = '/api/dsh-quiet-reader';
const PDF_LIMIT_MB = 40;
const PDF_LIMIT = PDF_LIMIT_MB * 1024 * 1024;
const ID = /^[a-f0-9]{64}$/;
const require = createRequire(import.meta.url);

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
        !Array.isArray(p.box) || p.box.length !== 4 ||
        !p.box.every(n => Number.isFinite(n) && n >= 0 && n <= 1) ||
        p.box[0] >= p.box[2] || p.box[1] >= p.box[3]) {
      throw new ReaderError('PDF 段落位置无效。');
    }
    chars += p.text.length;
    return { id: p.id, page: p.page, box: p.box, text: p.text.trim() };
  });
  if (chars > 600_000) throw new ReaderError('文献文字超过 60 万字符，请拆分 PDF。');
  const title = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim().slice(0, 180) : '';
  return { title: title || '未命名论文', pages, paragraphs };
}

/**
 * Older imports predate paragraph kinds; classify them once and persist the
 * result so both the host and the panel agree on what may be overlaid.
 */
function withKinds(document) {
  if (!document.paragraphs.some(paragraph => paragraph.kind === undefined)) return document;
  const kinds = classifyParagraphs(document.paragraphs);
  return {
    ...document,
    paragraphs: document.paragraphs.map((paragraph, index) => ({ ...paragraph, kind: kinds[index] })),
  };
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
  const imports = new Map();
  const questions = new Set();
  const lifetime = new AbortController();
  let modelTail = Promise.resolve();

  function modelTask(task) {
    const next = modelTail.then(() => {
      lifetime.signal.throwIfAborted();
      return task();
    });
    modelTail = next.catch(() => {});
    return next;
  }

  function directory(id) {
    if (!ID.test(id ?? '')) throw new ReaderError('文献编号无效。');
    return join(root, id);
  }

  async function paper(id) {
    const stored = await readJson(join(directory(id), 'paper.json'), null);
    if (!stored) throw new ReaderError('找不到该文献。', 404);
    const document = withKinds(stored);
    if (document !== stored) await saveJson(join(directory(id), 'paper.json'), document);
    return document;
  }

  async function detail(id) {
    const document = await paper(id);
    const translations = await readJson(join(directory(id), 'translations.json'), {});
    // Stored answers that carry replacement characters are not shown; dropping
    // them here makes the paper look unfinished so they get translated again.
    pruneTranslations(translations);
    const history = await readJson(join(directory(id), 'history.json'), []);
    const translatable = document.paragraphs.filter(paragraph => paragraph.kind !== KIND_SKIP);
    const translatedCount = translatable.filter(paragraph => Object.hasOwn(translations, paragraph.id)).length;
    const job = jobs.get(id);
    return {
      ...document, translations, history, translated: translatedCount, expected: translatable.length,
      status: translatable.length === translatedCount ? 'complete' : job?.status ?? 'pending',
      error: job?.error ?? '',
    };
  }

  function startTranslation(document) {
    const id = document.id;
    if (jobs.get(id)?.status === 'running') return;
    const job = { status: 'running', error: '' };
    jobs.set(id, job);
    void (async () => {
      try {
        const path = join(directory(id), 'translations.json');
        const translations = await readJson(path, {});
        if (pruneTranslations(translations)) await saveJson(path, translations);
        if (!translationBatch(document.paragraphs, translations).length) return;
        const route = await accountRoute(ctx.llm, lifetime.signal);
        let stalls = 0;
        const limit = document.paragraphs.length * 2 + 50;
        for (let round = 0; round < limit; round++) {
          let batch = translationBatch(document.paragraphs, translations);
          if (!batch.length) return;
          let saved = 0;
          // Models occasionally wrap, truncate or number their JSON. Retry with
          // a smaller batch instead of failing the whole paper; every accepted
          // paragraph is already on disk, so the next round only asks for what
          // is still missing.
          for (let attempt = 0; attempt < 3 && !saved; attempt++) {
            const input = { title: document.title, paragraphs: batch };
            const { text } = await modelTask(() =>
              complete(ctx.llm, route, TRANSLATION_PROMPT, input, 6500, lifetime.signal));
            const result = parseTranslations(text, batch);
            for (const [paragraphId, value] of result.values) translations[paragraphId] = value;
            saved = result.values.size;
            if (saved) await saveJson(path, translations);
            else batch = batch.slice(0, Math.max(1, Math.ceil(batch.length / 2)));
          }
          if (saved) stalls = 0;
          else if (++stalls >= 2) {
            throw new ReaderError('模型连续返回无法解析的译文。已保存的进度可以继续。', 502);
          }
        }
        // Every round saved at least one paragraph but the paper never finished.
        throw new ReaderError('全文翻译未能在预期轮次内完成。已保存的进度可以继续。', 502);
      } catch (error) {
        if (!(error instanceof ReaderError) && !lifetime.signal.aborted) {
          ctx.logger?.warn?.(`dsh-quiet-reader: translation interrupted (${error.code ?? error.name ?? 'unknown'})`);
        }
        job.status = 'error';
        job.error = error instanceof ReaderError ? error.message : '全文翻译暂停。请检查账号或本地文件后继续。';
      } finally {
        if (job.status === 'running') jobs.delete(id);
      }
    })();
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
    if (!imports.has(id)) {
      const task = (async () => {
        const path = directory(id);
        await mkdir(path, { recursive: true });
        const manifest = join(path, 'paper.json');
        const stored = await readJson(manifest, null);
        if (!stored) await writeFile(join(path, 'original.pdf'), pdf);
        const workspace = await ctx.workspaceRegistry.create(path, stored?.title ?? parsed.title);
        const document = { ...withKinds(stored ?? parsed), id, workspaceId: String(workspace.id) };
        await saveJson(manifest, document);
        // Reopening an imported paper shows its existing progress. Resume is explicit.
        if (!stored) startTranslation(document);
        return detail(id);
      })();
      imports.set(id, task);
    }
    const task = imports.get(id);
    try { return await task; } finally { if (imports.get(id) === task) imports.delete(id); }
  }

  async function ask(id, input) {
    const question = typeof input.question === 'string' ? input.question.trim() : '';
    if (!question || question.length > 1000) throw new ReaderError('请输入 1 至 1000 字的问题。');
    if (questions.has(id)) throw new ReaderError('本篇文献还有一个问题正在回答。', 409);
    questions.add(id);
    try {
      const document = await detail(id);
      const selected = document.paragraphs.find(p => p.id === input.selectedId);
      const page = selected?.page ?? (Number.isInteger(input.page) ? input.page : 1);
      const excerpts = selectEvidence(document, document.translations, question, page, selected?.id);
      const history = document.history.slice(-2).map(turn => ({
        question: turn.question.slice(0, 400), answer: turn.answer.slice(0, 750),
      }));
      const route = await accountRoute(ctx.llm, lifetime.signal);
      const reply = await modelTask(() => complete(ctx.llm, route, QUESTION_PROMPT, {
        title: document.title, question, history, excerpts,
      }, 1400, lifetime.signal));
      if (!reply.finished) throw new ReaderError('回答未完整生成。请重试当前问题。', 502);
      const answer = reply.text;
      const turn = { question, answer, references: excerpts.map(({ id, page }) => ({ id, page })) };
      const updated = [...document.history, turn].slice(-40);
      await saveJson(join(directory(id), 'history.json'), updated);
      return updated;
    } finally {
      questions.delete(id);
    }
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
      if (value) result.push({ id: value.id, title: value.title, workspaceId: value.workspaceId });
    }
    return result.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  }

  async function asset(name) {
    if (name === 'reader.css') {
      return new Response(await readFile(new URL('./reader.css', import.meta.url)), {
        headers: { 'content-type': 'text/css; charset=utf-8', 'x-content-type-options': 'nosniff' },
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
        if (action === 'pdf') {
          await paper(id);
          return new Response(await readFile(join(directory(id), 'original.pdf')), {
            headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
          });
        }
      }
      if (request.method === 'POST') {
        if (action === 'import') return json(await importPaper(request), 201);
        if (action === 'translate') {
          startTranslation(await paper(id));
          return json(await detail(id), 202);
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
