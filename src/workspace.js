import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { ReaderError } from './model.js';

export const PAPER_ID = /^[a-f0-9]{64}$/;

const samePath = (a, b) => typeof a === 'string' && relative(a, b) === '';
const identity = info => `${info.dev}:${info.ino}`;
const workspaceRequired = () => new ReaderError('请先选择一个阅藏工作区。', 409, 'WORKSPACE_REQUIRED');
const workspaceChanged = () => new ReaderError('阅藏工作区已变更，请重新打开文献。', 409, 'WORKSPACE_CHANGED');
const missingPaper = () => new ReaderError('在当前工作区找不到该文献。', 404);
const invalidStorage = () => new ReaderError('文献目录或文件已变更，请重新打开工作区。', 409, 'PAPER_STORAGE_CHANGED');

async function inspect(path) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function absoluteFolder(folder) {
  if (typeof folder !== 'string' || !folder || folder.includes('\0') || !isAbsolute(folder)) return false;
  if (process.platform !== 'win32') return true;
  return /^(?:[a-z]:[\\/]|[\\/]{2}[^?.\\/][^\\/]*[\\/][^\\/]+)/i.test(folder);
}

function validDocument(document) {
  if (!document || !PAPER_ID.test(document.id ?? '') || typeof document.title !== 'string' || !document.title.trim()
      || !Array.isArray(document.pages) || !document.pages.length || !Array.isArray(document.paragraphs)
      || !document.paragraphs.length) return false;
  const ids = new Set();
  return document.pages.every(page => page && Number.isFinite(page.width) && page.width > 0
    && Number.isFinite(page.height) && page.height > 0)
    && document.paragraphs.every(paragraph => {
      if (!paragraph || !Number.isInteger(paragraph.id) || paragraph.id < 1 || ids.has(paragraph.id)
          || !Number.isInteger(paragraph.page) || paragraph.page < 1 || paragraph.page > document.pages.length
          || typeof paragraph.text !== 'string' || !paragraph.text.trim() || !Array.isArray(paragraph.box)
          || paragraph.box.length !== 4 || !paragraph.box.every(value => Number.isFinite(value) && value >= 0 && value <= 1)
          || paragraph.box[0] >= paragraph.box[2] || paragraph.box[1] >= paragraph.box[3]) return false;
      ids.add(paragraph.id);
      return true;
    });
}

function folderTitle(title) {
  const clean = title.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return [...clean].slice(0, 48).join('').replace(/[. ]+$/u, '') || '论文';
}

export function createWorkspaceLibrary(registry, settingsPath, { readJson, saveJson, onChange, maxPdfBytes }) {
  let selected;
  let pending = Promise.resolve();

  function serialize(action) {
    const task = pending.then(action);
    pending = task.catch(() => {});
    return task;
  }

  async function registered(id) {
    try {
      if (typeof registry.get === 'function') return await registry.get(id);
      const items = await registry.list();
      if (Array.isArray(items)) return items.find(item => String(item.id) === id);
    } catch {
      throw new ReaderError('暂时无法读取 Harness 工作区。请稍后重试。', 503);
    }
    throw new ReaderError('Harness 工作区服务不可用。', 503);
  }

  function setSelected(next) {
    const previous = selected;
    selected = next;
    if (previous && previous !== next) onChange(previous);
  }

  async function rootExists(scope) {
    const info = await inspect(scope.path);
    return info?.isDirectory() && !info.isSymbolicLink() && identity(info) === scope.identity
      && samePath(await realpath(scope.path), scope.path);
  }

  async function restoreSelection() {
    if (selected === undefined) {
      let value;
      try { value = await readJson(settingsPath, null); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      selected = typeof value?.id === 'string' && absoluteFolder(value.path) && typeof value.identity === 'string'
        ? { ...value, papers: new Map() } : null;
    }
    if (!selected) return null;
    const workspace = await registered(selected.id);
    if (!workspace || !samePath(workspace.path, selected.path) || !(await rootExists(selected))) {
      // An absent registration never causes any filesystem cleanup.
      setSelected(null);
      await saveJson(settingsPath, null);
      return null;
    }
    selected.title = workspace.title || basename(selected.path) || '阅藏';
    return selected;
  }

  const status = () => serialize(restoreSelection);
  const describe = scope => scope ? { id: scope.id, path: scope.path, title: scope.title } : null;

  function select(folder) {
    return serialize(async () => {
      if (!absoluteFolder(folder)) throw new ReaderError('请选择有效的本地工作区文件夹。');
      let path;
      try { path = await realpath(folder); }
      catch { throw new ReaderError('无法打开所选文件夹。'); }
      const info = await inspect(path);
      if (!info?.isDirectory()) throw new ReaderError('请选择一个已经存在的工作区文件夹。');
      const title = basename(path) || '阅藏';
      let workspace;
      try { workspace = await registry.create(path, title); }
      catch { throw new ReaderError('无法登记所选 Harness 工作区。请重试。', 503); }
      const id = workspace?.id == null ? '' : String(workspace.id);
      const live = id ? await registered(id) : null;
      if (!live || !samePath(live.path, path)) throw new ReaderError('所选工作区已不可用。请重新选择。', 409);
      if (selected?.id === id && samePath(selected.path, path) && selected.identity === identity(info)) return selected;
      const next = { id, path, identity: identity(info), title: live.title || title, papers: new Map() };
      if (!(await rootExists(next))) throw new ReaderError('所选文件夹已变更。请重新选择。', 409);
      await mkdir(dirname(settingsPath), { recursive: true });
      await saveJson(settingsPath, { id, path, identity: next.identity });
      setSelected(next);
      return next;
    });
  }

  async function required(id) {
    const scope = await status();
    if (!scope) throw workspaceRequired();
    if (id !== scope.id) throw workspaceChanged();
    return scope;
  }

  async function assertActive(scope) {
    const current = await status();
    if (!current) throw workspaceRequired();
    if (current !== scope) throw workspaceChanged();
  }

  async function child(scope, name) {
    if (basename(name) !== name || name === '.' || name === '..') return null;
    const path = join(scope.path, name);
    const info = await inspect(path);
    if (!info?.isDirectory() || info.isSymbolicLink() || !samePath(dirname(await realpath(path)), scope.path)) return null;
    return { scope, name, path, identity: identity(info) };
  }

  async function assertDirectory(paper) {
    if (!(await rootExists(paper.scope))) throw workspaceRequired();
    const actual = await child(paper.scope, paper.name);
    if (!actual || actual.identity !== paper.identity || !samePath(actual.path, paper.path)) throw invalidStorage();
  }

  async function regular(path) {
    const info = await inspect(path);
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink()) throw invalidStorage();
    return info;
  }

  async function readRegular(path, maxBytes) {
    const info = await regular(path);
    if (!info) return null;
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const current = await file.stat({ bigint: true });
      if (!current.isFile() || identity(current) !== identity(info)) throw invalidStorage();
      if (maxBytes !== undefined && current.size > BigInt(maxBytes)) throw invalidStorage();
      return await file.readFile();
    } finally {
      await file.close();
    }
  }

  async function loadChild(scope, name) {
    const paper = await child(scope, name);
    if (!paper) return null;
    const manifest = await readRegular(join(paper.path, 'paper.json'));
    if (!manifest || !(await regular(join(paper.path, 'original.pdf')))) return null;
    const document = JSON.parse(manifest.toString('utf8'));
    return validDocument(document) ? { ...paper, document } : null;
  }

  async function scan(scope) {
    await assertActive(scope);
    const names = (await readdir(scope.path, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name).sort();
    const papers = new Map();
    for (const name of names) {
      const paper = await loadChild(scope, name).catch(() => null);
      if (paper && !papers.has(paper.document.id)) papers.set(paper.document.id, paper);
    }
    await assertActive(scope);
    scope.papers = papers;
    return papers;
  }

  async function list(scope) {
    const papers = await scan(scope);
    return [...papers.values()].map(({ document }) => ({ id: document.id, title: document.title, workspaceId: scope.id }))
      .sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  }

  async function find(scope, id, optional = false) {
    if (!PAPER_ID.test(id ?? '')) throw new ReaderError('文献编号无效。');
    await assertActive(scope);
    const cached = scope.papers.get(id);
    const fresh = cached && await loadChild(scope, cached.name).catch(() => null);
    if (fresh?.document.id === id) return fresh;
    const paper = (await scan(scope)).get(id);
    if (!paper && !optional) throw missingPaper();
    return paper;
  }

  async function reserve(scope, title, id) {
    await assertActive(scope);
    const base = `paper-${folderTitle(title)}-${id}`;
    let name = base;
    for (;;) {
      try {
        await mkdir(join(scope.path, name));
        const paper = await child(scope, name);
        if (!paper) throw invalidStorage();
        return paper;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        name = `${base}-${randomUUID().slice(0, 8)}`;
      }
    }
  }

  async function pathFor(paper, filename) {
    await assertActive(paper.scope);
    await assertDirectory(paper);
    return join(paper.path, filename);
  }

  async function read(paper, filename, fallback) {
    const path = await pathFor(paper, filename);
    const bytes = await readRegular(path);
    return bytes ? JSON.parse(bytes.toString('utf8')) : fallback;
  }

  async function save(paper, filename, value) {
    const path = await pathFor(paper, filename);
    await regular(path);
    await saveJson(path, value);
    if (filename === 'paper.json') paper.scope.papers.set(value.id, { ...paper, document: value });
  }

  async function writePdf(paper, pdf) {
    const path = await pathFor(paper, 'original.pdf');
    await writeFile(path, pdf, { flag: 'wx' });
  }

  async function readPdf(paper) {
    const path = await pathFor(paper, 'original.pdf');
    const bytes = await readRegular(path, maxPdfBytes);
    if (!bytes) throw missingPaper();
    return bytes;
  }

  async function clearTranslations(paper) {
    const path = await pathFor(paper, 'translations.json');
    if (await regular(path)) await rm(path, { force: true });
  }

  async function remove(paper) {
    const pdf = await readPdf(paper);
    if (createHash('sha256').update(pdf).digest('hex') !== paper.document.id) throw invalidStorage();
    await assertActive(paper.scope);
    await assertDirectory(paper);
    await rm(paper.path, { recursive: true });
    paper.scope.papers.delete(paper.document.id);
  }

  async function discard(paper) {
    await assertDirectory(paper);
    await rm(paper.path, { recursive: true });
  }

  return { status, select, describe, required, assertActive, list, find, reserve, read, save, writePdf, readPdf, clearTranslations, remove, discard };
}
