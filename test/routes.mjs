/**
 * 路由冒烟：用假 EA + 真实 Store/Identity，验证同源接口、身份与下单路径。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startFakeEa } from './fake-ea.js'
import { EaClient } from '../host/ea.js'
import { Store } from '../host/store.js'
import { Identity } from '../host/identity.js'
import { registerRoutes } from '../host/routes.js'

const origin = 'http://127.0.0.1:56162'
const eaPort = 18811
const apiPort = 18812
const dir = mkdtempSync(path.join(tmpdir(), 'dshtrade-routes-'))
const fake = startFakeEa({ port: eaPort, origin })
await new Promise((resolve) => setTimeout(resolve, 120))

const store = new Store(path.join(dir, 'routes.db'))
const identity = new Identity(store)
const ea = new EaClient({ url: `ws://127.0.0.1:${eaPort}/ws`, origin, symbol: 'XAUUSD', tf: '1m', store })
ea.start()
await waitFor(() => ea.snapshot().phase === 'pairing')
ea.pair('12345678')
await waitFor(() => ea.snapshot().phase === 'connected')
await waitFor(() => ea.snapshot().account)

let handler = null
const ctx = {
  webServer: {
    getOrigin: () => origin,
    register(route) { handler = route.handler; return () => {} },
  },
  effect(fn) { const dispose = fn(); return dispose },
}
registerRoutes(ctx, { store, ea, identity, log: () => {} })
assert.ok(handler, '注册了同源路由')

const server = createServer((req, res) => handler(req, res))
await new Promise((resolve) => server.listen(apiPort, '127.0.0.1', resolve))

const state = await request('GET', '/dshtrade/api/state')
assert.equal(state.ok, true)
assert.ok(state.identity.friend_code.startsWith('TP-'), '返回好友码')
assert.equal(state.counts.commands, 0)

const order = await request('POST', '/dshtrade/api/command', { action: 'market', side: 'buy', volume: 0.01, sl: 0, tp: 0 })
assert.equal(order.ok, true)
assert.equal(order.result.state, 'completed')
assert.equal(order.result.order, '456')

const after = await request('GET', '/dshtrade/api/state')
assert.equal(after.counts.commands, 1)

const saved = await request('POST', '/dshtrade/api/notes', { ticket: '700001', body: '等回调确认再入场', tags: ['入场时机'] })
assert.equal(saved.ok, true)
const notes = await request('GET', '/dshtrade/api/notes')
assert.ok(notes.notes.some((note) => note.body === '等回调确认再入场'))
assert.equal(notes.notes[0].ticket, '700001')

const started = await request('POST', '/dshtrade/api/history', {})
assert.equal(started.ok, true)
assert.equal(started.range.to > started.range.from, true)
await waitFor(() => ea.snapshot().history.active === false && ea.snapshot().history.pages === 2)
const status = await request('GET', '/dshtrade/api/history')
assert.equal(status.history.error, '')
assert.equal(status.history.trades, 2)

const linked = await request('GET', '/dshtrade/api/notes')
const linkedNote = linked.notes.find((note) => note.body === '等回调确认再入场')
assert.equal(linkedNote.trade.ticket, '700001')
assert.equal(linkedNote.trade.symbol, 'XAUUSD')
assert.equal(linkedNote.trade.profit, 12.3)

const trades = await request('GET', '/dshtrade/api/trades')
assert.equal(trades.trades.length, 2)

const badOrigin = await request('POST', '/dshtrade/api/command', { action: 'market', side: 'buy', volume: 0.01 }, 'http://evil.invalid')
assert.equal(badOrigin.status, 403)

const badVolume = await request('POST', '/dshtrade/api/command', { action: 'market', side: 'buy', volume: -1 })
assert.equal(badVolume.status, 400)

server.close()
ea.stop()
store.close()
await fake.close()
rmSync(dir, { recursive: true, force: true })
console.log('routes ok: state/身份/下单/笔记/历史同步/笔记关联成交/来源校验/参数校验')

async function request(method, pathname, body, requestOrigin = origin) {
  const headers = { 'Content-Type': 'application/json' }
  if (requestOrigin) headers.Origin = requestOrigin
  const response = await fetch(`http://127.0.0.1:${apiPort}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const value = await response.json().catch(() => ({}))
  return { status: response.status, ...value }
}

async function waitFor(check, timeout = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error('超时：' + ea.snapshot().phase + ' ' + ea.snapshot().error)
}
