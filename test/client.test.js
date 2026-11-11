import assert from 'node:assert/strict';
import { test } from 'node:test';

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
  assert.deepEqual(calls, ['main', 'main', 'sidebar.panellist', 'sidebar.panellist']);
  delete globalThis.window;
});
