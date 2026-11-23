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
  layout: { selectPanel() {} },
  locale: {
    register(ns, dicts) {
      if (locales.some((entry) => entry.ns === ns)) throw new Error(`locale namespace "${ns}" already has locale "zh"`)
      locales.push({ ns, dicts })
    },
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
assert.deepEqual(factoryResult.inject, ['slots', 'locale', 'layout'])
factoryResult.apply(ctx)

assert.deepEqual(injected.sort(), ['conversation.composer.dock', 'main', 'plugins.detail.actions', 'settings.section', 'shell.overlay', 'shell.overlay'])
assert.deepEqual(registered.map((spec) => spec.name).sort(), ['conversation.composer.dock', 'main', 'plugins.detail.actions', 'settings.section', 'shell.overlay', 'shell.overlay'])
assert.ok(registered.some((spec) => spec.id === 'dshtrade-chat'), '注册了消息浮层')
assert.ok(registered.some((spec) => spec.name === 'main' && spec.key === 'dshtrade-desk'), '交易台注册进主区域')
assert.equal(registered.find((spec) => spec.name === 'settings.section').id, 'dshtrade')
assert.equal(locales.length, 1)
assert.ok(locales[0].dicts.zh.title)
assert.ok(locales[0].dicts.en.title)

// 同一页面里插件可能被重复 apply（开关插件 / HMR）：语言包撞名不能把整次装配打断。
registered.length = 0
injected.length = 0
assert.doesNotThrow(() => factoryResult.apply(ctx), '重复 apply 不应抛错')
assert.equal(registered.length, 6, '重复 apply 仍然注册六个插槽')
assert.equal(locales.length, 1, '语言包仍然只有一份')
console.log('client ok: bundle 解析 + 六个插槽注册（含主区域面板与详情页入口）+ 中英文本地化 + 重复 apply 幂等')
