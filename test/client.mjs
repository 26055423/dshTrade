/**
 * 不启动 DSH 的客户端模块冒烟：验证 bundle 能解析、apply 能注册三个插槽。
 * 只伪造最小 React 与 ctx；不渲染组件。
 */
import assert from 'node:assert/strict'

const registered = []
const injected = []
const locales = []

let factoryResult = null
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      assert.equal(id, '@local/dshtrade')
      factoryResult = factory(fakeRequire)
    },
  },
}

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
  useSyncExternalStore: (_subscribe, get) => get(),
}

function fakeRequire(name) {
  if (name === 'react') return React
  throw new Error('unexpected module: ' + name)
}

const ctx = {
  locale: {
    register(ns, dicts) { locales.push({ ns, dicts }) },
    bind: () => (key) => key,
  },
  slots: {
    inject(key, callback) { injected.push(key); callback() },
    register(spec) { registered.push(spec); return () => {} },
  },
}

const { readFile } = await import('node:fs/promises')
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
new Function('window', source)(globalThis.window)

assert.ok(factoryResult, 'factory 已执行')
assert.deepEqual(factoryResult.inject, ['slots', 'locale'])
factoryResult.apply(ctx)

assert.deepEqual(injected.sort(), ['conversation.composer.dock', 'settings.section', 'shell.overlay'])
assert.deepEqual(registered.map((spec) => spec.name).sort(), ['conversation.composer.dock', 'settings.section', 'shell.overlay'])
assert.equal(registered.find((spec) => spec.name === 'settings.section').id, 'dshtrade')
assert.equal(locales.length, 1)
assert.ok(locales[0].dicts.zh.title)
assert.ok(locales[0].dicts.en.title)
console.log('client ok: bundle 解析 + 三个插槽注册 + 中英文本地化')
