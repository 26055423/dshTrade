import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startFakeEa } from './fake-ea.js'
import { EaClient } from '../host/ea.js'
import { Store } from '../host/store.js'

const origin = 'http://127.0.0.1:56162'
const port = 18799
const dir = mkdtempSync(path.join(tmpdir(), 'dshtrade-'))
const fake = startFakeEa({ port, origin })
await new Promise((resolve) => setTimeout(resolve, 120))

const store = new Store(path.join(dir, 'test.db'))
const ea = new EaClient({ url: `ws://127.0.0.1:${port}/ws`, origin, symbol: 'XAUUSD', tf: '1m', store })
ea.start()

await waitFor(() => ea.snapshot().phase === 'pairing', 'EA 进入配对阶段')
ea.pair('12345678')
await waitFor(() => ea.snapshot().phase === 'connected', 'EA 完成配对')
assert.equal(ea.snapshot().identity.account_id, '5001')
assert.equal(ea.snapshot().identity.demo, true)

await waitFor(() => ea.snapshot().account && ea.snapshot().account.balance === 10000, '收到账户快照')
await waitFor(() => ea.snapshot().positions.length === 1, '收到持仓')
await waitFor(() => (ea.snapshot().bars['1m'] || []).length === 3, '收到 K 线')

const order = await ea.command({ action: 'market', side: 'buy', volume: 0.01, sl: 0, tp: 0, deviation: 20 })
assert.equal(order.state, 'completed')
assert.equal(order.order, '456')
assert.equal(order.ok, true)
assert.equal(store.commands().length, 1)
assert.equal(store.commands()[0].state, 'completed')

const stored = store.bars('XAUUSD', '1m')
assert.equal(stored.length, 3, 'K 线落本地库')
assert.equal(stored[0][1], 2400)

store.upsertTrade({ ticket: '700001', account_key: 'k', symbol: 'XAUUSD', side: 'buy', volume: 0.01, open_price: 2400, close_price: 2412.5, opened_utc: 1700000000, closed_utc: 1700003600, profit: 12.5 })
assert.equal(store.trades().length, 1)
assert.equal(store.trades()[0].profit, 12.5)

const note = store.saveNote({ ticket: '700001', body: '等回调确认再入场', tags: ['入场时机'] })
assert.equal(store.notes().length, 1)
assert.equal(store.notes()[0].body, '等回调确认再入场')
assert.equal(store.notes()[0].id, note.id)

const counts = store.counts()
assert.equal(counts.trades, 1)
assert.equal(counts.bars, 3)
assert.equal(counts.notes, 1)

ea.stop()
store.close()
await fake.close()
rmSync(dir, { recursive: true, force: true })
console.log('smoke ok: EA 握手/配对/快照/K 线 + 本地 SQLite 写入读取')

async function waitFor(check, label, timeout = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error('超时：' + label + '（' + ea.snapshot().phase + ' ' + ea.snapshot().error + '）')
}
