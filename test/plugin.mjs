/**
 * 插件装配冒烟：真正调用 index.js 的 apply，验证导入、路由注册与卸载。
 * 不启动 DSH：webServer 与 effect 用最小替身。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const dir = mkdtempSync(path.join(tmpdir(), 'dshtrade-plugin-'))
const routes = []
let disposer = null

const ctx = {
  webServer: {
    getOrigin: () => 'http://127.0.0.1:56162',
    register(route) { routes.push(route); return () => {} },
  },
  effect(fn) {
    disposer = fn()
    return disposer
  },
}

apply(ctx, { dataDir: dir, eaUrl: 'ws://127.0.0.1:1/ws', relayUrl: '' })
await new Promise((resolve) => setTimeout(resolve, 300))

assert.ok(routes.some((route) => route.path === '/dshtrade/api'), '注册了同源路由')
assert.equal(typeof disposer, 'function', '注册了可卸载的 effect')
disposer()
await new Promise((resolve) => setTimeout(resolve, 150))
try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch {}
console.log('resources', process.getActiveResourcesInfo())
console.log('plugin ok: apply 装配、路由注册与卸载')
process.exit(0)
