import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

test('客户端模块导出插槽注册，面板与侧栏入口成对出现', async () => {
  let registered;
  globalThis.window = { __ModuleLoader__: { load: entry => { registered = entry; } } };
  const React = {
    createElement: () => null,
    Fragment: Symbol('Fragment'),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: () => ({ current: null }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useSyncExternalStore: () => '',
  };
  await import('../src/client.js');
  assert.ok(registered, '客户端模块必须调用 __ModuleLoader__.load');
  assert.equal(registered.id, 'dsh-quiet-reader');
  const plugin = registered.factory(specifier => {
    assert.equal(specifier, 'react');
    return React;
  });
  assert.deepEqual(plugin.inject, ['slots']);
  const calls = [];
  plugin.apply({
    slots: {
      inject(name, register) { calls.push(name); register(); },
      register(options) { calls.push(options.name); },
    },
  });
  assert.deepEqual(calls, ['main', 'main', 'sidebar.footer.action', 'sidebar.footer.action', 'sidebar.panellist', 'sidebar.panellist']);
  delete globalThis.window;
});

function hookHarness() {
  let cursor = 0;
  const hooks = [];
  const effects = [];
  const useEffect = (effect, dependencies) => {
    const index = cursor++;
    const previous = hooks[index];
    if (previous && dependencies && previous.dependencies?.length === dependencies.length &&
        dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
    hooks[index] = { dependencies };
    effects.push(() => {
      previous?.cleanup?.();
      hooks[index].cleanup = effect();
    });
  };
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useEffect,
    useLayoutEffect: useEffect,
    useRef(value) { return hooks[cursor++] ??= { current: value }; },
    useState(value) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof value === 'function' ? value() : value;
      return [hooks[index], next => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; }];
    },
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
  return {
    React,
    async settle(render) {
      let tree;
      for (let pass = 0; pass < 4; pass++) {
        cursor = 0;
        tree = render({});
        for (const run of effects.splice(0)) run();
        await setImmediate();
      }
      return tree;
    },
    unmount() { for (const hook of hooks) hook?.cleanup?.(); },
  };
}

function* elements(node) {
  if (Array.isArray(node)) {
    for (const item of node) yield* elements(item);
  } else if (node?.type) {
    yield node;
    yield* elements(node.children);
  }
}

test('先选工作区再导入及打开文献，文献请求携带工作区编号', async t => {
  const globals = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  const hooks = hookHarness();
  t.after(() => { hooks.unmount(); Object.assign(globalThis, globals); });
  let registered;
  globalThis.window = Object.assign(new EventTarget(), { __ModuleLoader__: { load: entry => { registered = entry; } } });
  globalThis.document = Object.assign(new EventTarget(), { baseURI: 'http://127.0.0.1:8767/' });
  const workspace = { id: 'workspace-1', path: 'D:/Papers', title: 'Papers' };
  const id = 'a'.repeat(64);
  const assets = new Map([
    ['pdf.mjs', `export const GlobalWorkerOptions = {}; export function getDocument() {
      return { async destroy() {}, promise: Promise.resolve({ numPages: 1, async getMetadata() { return {}; }, async getPage() {
        return { getViewport() { return { width: 612, height: 792 }; }, cleanup() {} };
      } }) };
    }`],
    ['layout.js', `export function extractPageLayout(_pdf, _page, _viewport, page) {
      return { regions: [], paragraphs: [{ page, text: 'Fixture source paragraph.', box: [.1, .2, .9, .3] }] };
    }`],
  ]);
  const modules = registerHooks({ resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith('http://127.0.0.1:8767/api/dsh-quiet-reader?')) return nextResolve(specifier, context);
    const params = new URL(specifier).searchParams;
    const source = assets.get(params.get('name'));
    assert.equal(params.get('action'), 'asset');
    assert.ok(source, `unexpected asset: ${specifier}`);
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  } });
  t.after(() => modules.deregister());
  let active = null;
  let picks = 0;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const params = new URL(url).searchParams;
    const action = params.get('action');
    requests.push({ action, method: options.method ?? 'GET', workspaceId: params.get('workspaceId') });
    if (action === 'workspace') {
      if (options.method === 'POST') {
        assert.deepEqual(JSON.parse(options.body), { folder: workspace.path });
        active = workspace;
      }
      return Response.json({ workspace: active });
    }
    if (action === 'settings') return Response.json({ current: {}, providers: [] });
    assert.equal(params.get('workspaceId'), workspace.id);
    if (action === 'list') return Response.json([{ id, workspaceId: workspace.id, title: 'Fixture paper' }]);
    if (action === 'import') {
      assert.equal(options.body.get('pdf').name, 'fixture.pdf');
      const parsed = JSON.parse(options.body.get('document'));
      assert.equal(parsed.layoutVersion, 13);
      assert.deepEqual(parsed.range, { first: 1, last: 1 });
    } else {
      assert.equal(action, 'detail');
      assert.equal(params.get('id'), id);
    }
    return Response.json({ id, workspaceId: workspace.id, title: 'Fixture paper', layoutVersion: 13, layoutPages: [1],
      pages: [{ width: 612, height: 792 }], paragraphs: [], history: [], translations: {}, status: 'complete', translated: 0, expected: 0 });
  };
  await import('../src/client.js?workspace-contract');
  assert.ok(registered);
  const plugin = registered.factory(() => hooks.React);
  let panel;
  plugin.apply({
    inject(_services, setup) {
      setup({ uiWorkspace: { async pickDirectory() { picks++; return workspace.path; } } });
    },
    slots: {
      inject(_name, register) { register(); },
      register(options, component) { if (options.name === 'main') panel = component; },
    },
  });
  assert.ok(panel);
  const before = [...elements(await hooks.settle(panel))];
  const upload = before.find(node => node.type === 'button' && node.children.includes('上传 PDF'));
  assert.ok(!upload || upload.props.disabled);
  assert.equal(requests.some(request => request.action === 'list'), false);
  const chooser = before.find(node => node.type === 'button' && node.children.some(text => typeof text === 'string' && /选择.*工作区/.test(text)));
  assert.ok(chooser, '应先显示选择工作区按钮');
  await chooser.props.onClick();
  const opened = [...elements(await hooks.settle(panel))];
  assert.equal(picks, 1);
  assert.ok(requests.some(request => request.action === 'workspace' && request.method === 'POST'));
  assert.ok(requests.some(request => request.action === 'list' && request.workspaceId === workspace.id));
  const papers = opened.find(node => node.type === 'select' && [...elements(node.children)].some(option => option.props.value === id));
  assert.ok(papers);
  const file = opened.find(node => node.type === 'input' && node.props.type === 'file');
  assert.ok(file);
  await file.props.onChange({ currentTarget: { files: [new File(['%PDF-1.7'], 'fixture.pdf')], value: 'fixture.pdf' } });
  const dialog = [...elements(await hooks.settle(panel))];
  const submit = dialog.find(node => node.type === 'button' && node.children.includes('开始解析并翻译'));
  assert.ok(submit, '上传后应显示页码确认');
  await submit.props.onClick();
  await hooks.settle(panel);
  assert.ok(requests.some(request => request.action === 'import' && request.workspaceId === workspace.id));
  assert.ok(requests.some(request => request.action === 'detail' && request.workspaceId === workspace.id));
});
