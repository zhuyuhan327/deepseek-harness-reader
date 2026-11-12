import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createReader } from '../src/host.js';

const pages = [{ width: 612, height: 792 }];
const paragraphs = [{ id: 1, page: 1, box: [.1, .2, .9, .3], text: '这篇论文介绍了一种图像重建方法。' }];
const pdf = content => `%PDF-1.7\n${content}\n%%EOF`;
const digest = content => createHash('sha256').update(content).digest('hex');

async function harness(t, llm) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-reader-workspace-'));
  const roots = [join(base, '阅藏一'), join(base, '阅藏二')];
  const config = join(base, 'profile');
  await Promise.all(roots.map(root => mkdir(root)));
  const workspaces = new Map();
  let next = 0;
  const ctx = {
    workspaceRegistry: {
      get: id => workspaces.get(id),
      async create(path, title) {
        const existing = [...workspaces.values()].find(value => value.path === path);
        if (existing) return existing;
        const workspace = { id: `workspace-${++next}`, path, title };
        workspaces.set(workspace.id, workspace);
        return workspace;
      },
      delete() { assert.fail('Deleting a paper must not call the workspace registry'); },
    },
    get llm() { return llm ?? assert.fail('Chinese fixtures must not call a model'); },
  };
  let reader = createReader(ctx, join(config, 'papers'));
  t.after(async () => {
    reader.dispose();
    await rm(base, { recursive: true, force: true });
  });

  async function request(action, { workspaceId, id, body } = {}) {
    const url = new URL('http://127.0.0.1:8767/api/dsh-quiet-reader');
    url.searchParams.set('action', action);
    if (workspaceId) url.searchParams.set('workspaceId', workspaceId);
    if (id) url.searchParams.set('id', id);
    const response = await reader.fetch(new Request(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-quiet-reader': '1' },
      body: body instanceof FormData || body === undefined ? body : JSON.stringify(body),
    }));
    return { status: response.status, value: await response.json() };
  }

  async function select(folder) {
    const result = await request('workspace', { body: { folder } });
    assert.equal(result.status, 200, JSON.stringify(result.value));
    return result.value.workspace;
  }

  async function upload(workspaceId, bytes, title = 'CON:同名研究', source = paragraphs) {
    const body = new FormData();
    body.set('pdf', new File([bytes], 'fixture.pdf'));
    body.set('document', JSON.stringify({ title, pages, paragraphs: source }));
    const result = await request('import', { workspaceId, body });
    assert.equal(result.status, 201, JSON.stringify(result.value));
    return result.value;
  }

  async function paperPath(root, id) {
    const child = (await readdir(root)).find(name => name.endsWith(`-${id}`));
    assert.ok(child);
    return join(root, child);
  }

  return {
    base, roots, config, workspaces, request, select, upload, paperPath,
    restart() {
      reader.dispose();
      reader = createReader(ctx, join(config, 'papers'));
    },
  };
}

test('必须选择工作区，同名文献隔离，删除只移除所选文献子目录', async t => {
  const host = await harness(t);
  const { request } = host;
  assert.deepEqual((await request('workspace')).value, { workspace: null });
  assert.deepEqual((await request('list')).value, []);
  const required = await request('import', { body: {} });
  assert.equal(required.status, 409);
  assert.equal(required.value.code, 'WORKSPACE_REQUIRED');
  assert.equal((await request('workspace', { body: { folder: 'relative-path' } })).status, 400);

  const root = host.roots[0];
  const workspace = await host.select(root);
  assert.equal(workspace.path, await realpath(root));
  const first = await host.upload(workspace.id, pdf('first'));
  const second = await host.upload(workspace.id, pdf('second'));
  assert.notEqual(first.id, second.id);
  assert.equal(first.workspaceId, second.workspaceId);
  assert.equal(host.workspaces.size, 1);
  const firstPath = await host.paperPath(root, first.id);
  const secondPath = await host.paperPath(root, second.id);
  const unrelated = join(root, '我的笔记.txt');
  await writeFile(unrelated, 'keep');
  await writeFile(join(firstPath, 'derived.pdf'), 'delete this paper export too');
  assert.equal((await request('delete', { workspaceId: workspace.id, id: first.id, body: {} })).status, 200);
  await assert.rejects(access(firstPath), { code: 'ENOENT' });
  await access(join(secondPath, 'original.pdf'));
  assert.equal(await readFile(unrelated, 'utf8'), 'keep');
  assert.deepEqual((await request('list', { workspaceId: workspace.id })).value.map(item => item.id), [second.id]);
});

test('同一 PDF 在不同工作区隔离，旧工作区请求不能修改当前文献', async t => {
  const host = await harness(t);
  const [firstRoot, secondRoot] = host.roots;
  const first = await host.select(firstRoot);
  const content = pdf('same binary across workspaces');
  const firstPaper = await host.upload(first.id, content);
  const second = await host.select(secondRoot);
  const secondPaper = await host.upload(second.id, content);
  assert.equal(firstPaper.id, secondPaper.id);
  assert.notEqual(firstPaper.workspaceId, secondPaper.workspaceId);
  const stale = await host.request('delete', { workspaceId: first.id, id: firstPaper.id, body: {} });
  assert.equal(stale.status, 409);
  assert.equal(stale.value.code, 'WORKSPACE_CHANGED');
  await access(join(await host.paperPath(firstRoot, firstPaper.id), 'original.pdf'));
  await access(join(await host.paperPath(secondRoot, secondPaper.id), 'original.pdf'));
  assert.deepEqual((await host.select(firstRoot)), first);
  assert.deepEqual((await host.request('list', { workspaceId: first.id })).value.map(p => p.id), [firstPaper.id]);
});

test('切换工作区会取消在途翻译，旧结果不能写到新工作区的同一文献', { timeout: 4_000 }, async t => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  t.after(() => finish.resolve());
  let requests = 0;
  const host = await harness(t, {
    listProviders: () => [{ id: 'deepseek-account' }],
    listModels: async () => [{ id: 'fixture-flash' }],
    async *stream({ signal }) {
      const first = ++requests === 1;
      if (first) {
        started.resolve(signal);
        await finish.promise;
      }
      const text = first ? '{"1":"旧工作区的译文。"}' : '{"1":"新工作区的译文。"}';
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });
  const [firstRoot, secondRoot] = host.roots;
  const source = paragraphs.map(p => ({ ...p, text: 'This paper describes an image reconstruction approach.' }));
  const first = await host.select(firstRoot);
  const content = pdf('same paper with active translation');
  const paper = await host.upload(first.id, content, 'Same paper', source);
  const oldSignal = await started.promise;
  const second = await host.select(secondRoot);
  assert.equal(oldSignal.aborted, true);
  await host.upload(second.id, content, 'Same paper', source);
  finish.resolve();
  let completed;
  for (let attempt = 0; attempt < 100; attempt++) {
    completed = (await host.request('detail', { workspaceId: second.id, id: paper.id })).value;
    if (completed.status === 'complete') break;
    await delay(10);
  }
  assert.equal(completed.status, 'complete');
  assert.equal(completed.translations[1], '新工作区的译文。');
  const firstPath = await host.paperPath(firstRoot, paper.id);
  await access(join(firstPath, 'original.pdf'));
  await assert.rejects(access(join(firstPath, 'translations.json')), { code: 'ENOENT' });
});

test('侧栏移除持久撤销选择，重选已有目录发现原文献', async t => {
  const host = await harness(t);
  const root = host.roots[0];
  const workspace = await host.select(root);
  const paper = await host.upload(workspace.id, pdf('recover from sidebar removal'));
  const path = await host.paperPath(root, paper.id);
  host.workspaces.delete(workspace.id);
  assert.deepEqual((await host.request('workspace')).value, { workspace: null });
  assert.equal(JSON.parse(await readFile(join(host.config, 'workspace.json'), 'utf8')), null);
  const stale = await host.request('detail', { workspaceId: workspace.id, id: paper.id });
  assert.equal(stale.value.code, 'WORKSPACE_REQUIRED');
  await access(join(path, 'original.pdf'));

  host.workspaces.set(workspace.id, workspace);
  host.restart();
  assert.deepEqual((await host.request('workspace')).value, { workspace: null });
  assert.deepEqual(await host.select(root), workspace);
  const list = await host.request('list', { workspaceId: workspace.id });
  assert.deepEqual(list.value.map(item => item.id), [paper.id]);
  assert.equal((await host.request('detail', { workspaceId: workspace.id, id: paper.id })).status, 200);
});

test('发现文献不跟随子目录链接，损坏清单与内容不匹配的目录不会被删除', async t => {
  const host = await harness(t);
  const root = host.roots[0];
  const workspace = await host.select(root);
  const outside = join(host.base, 'outside');
  const corrupt = join(root, 'corrupt');
  const foreign = join(root, 'foreign');
  await Promise.all([outside, corrupt, foreign].map(path => mkdir(path)));
  const source = pdf('outside source');
  const id = digest(source);
  const manifest = { id, title: 'Existing paper', pages, paragraphs };
  await Promise.all([
    writeFile(join(outside, 'original.pdf'), source),
    writeFile(join(outside, 'paper.json'), JSON.stringify(manifest)),
    writeFile(join(corrupt, 'original.pdf'), source),
    writeFile(join(corrupt, 'paper.json'), JSON.stringify({ ...manifest, paragraphs: [null] })),
    writeFile(join(foreign, 'original.pdf'), pdf('different source')),
    writeFile(join(foreign, 'paper.json'), JSON.stringify(manifest)),
  ]);
  await symlink(outside, join(root, 'linked-paper'), 'junction');
  const visible = await host.request('list', { workspaceId: workspace.id });
  assert.deepEqual(visible.value.map(item => item.id), [id]);
  const denied = await host.request('delete', { workspaceId: workspace.id, id, body: {} });
  assert.equal(denied.status, 409);
  await access(join(foreign, 'original.pdf'));
  await access(join(outside, 'original.pdf'));
  await rm(foreign, { recursive: true });
  assert.deepEqual((await host.request('list', { workspaceId: workspace.id })).value, []);
});
