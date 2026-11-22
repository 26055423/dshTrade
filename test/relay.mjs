/**
 * 中继端到端：两个本机身份注册、加密发送、投递、解密落库，中继库中看不到明文。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startRelay } from '../relay/server.js'
import { Store } from '../host/store.js'
import { Identity } from '../host/identity.js'
import { Im } from '../host/im.js'

const dir = mkdtempSync(path.join(tmpdir(), 'dshtrade-relay-'))
const port = 18831
const relay = startRelay({ port, dbPath: path.join(dir, 'relay.db'), log: () => {} })
await relay.listen()
const url = `http://127.0.0.1:${port}`

const aliceStore = new Store(path.join(dir, 'alice.db'))
const bobStore = new Store(path.join(dir, 'bob.db'))
const alice = new Im({ identity: new Identity(aliceStore), store: aliceStore, relayUrl: url, log: () => {} })
const bob = new Im({ identity: new Identity(bobStore), store: bobStore, relayUrl: url, log: () => {} })

await alice.register()
await bob.register()
assert.equal(alice.status().registered, true)

await alice.addContact(bob.identity.friendCode, '鲍勃')
assert.equal(aliceStore.contacts().length, 1)

await alice.send(bob.identity.friendCode, { kind: 'text', text: '这单怎么看？' })
await bob.sync()

const inbox = bobStore.messages(alice.identity.friendCode)
assert.equal(inbox.length, 1)
assert.equal(inbox[0].body, '这单怎么看？')
assert.equal(inbox[0].direction, 'in')
assert.equal(inbox[0].kind, 'text')

await bob.addContact(alice.identity.friendCode, '爱丽丝')
await bob.send(alice.identity.friendCode, { kind: 'card', text: '复盘 700001', card: { symbol: 'XAUUSD', tf: '15m', note: '等回调' } })
await alice.sync()
const received = aliceStore.messages(bob.identity.friendCode)
assert.equal(received.length, 2, '自己发的一条 + 收到的一条')
const card = received.find((message) => message.kind === 'card')
assert.ok(card)
assert.equal(card.direction, 'in')
assert.ok(card.body.includes('复盘'))
assert.equal(card.data.symbol, 'XAUUSD')
assert.equal(card.data.note, '等回调')
assert.ok(card.data.bars === undefined)

const relayDb = new DatabaseSync(path.join(dir, 'relay.db'))
const rows = relayDb.prepare('SELECT payload FROM envelopes').all()
assert.equal(rows.length, 0, '投递并确认后中继不留信封')
relayDb.close()

// 再发一条不确认，检查中继里只有密文。
await alice.send(bob.identity.friendCode, { kind: 'text', text: '明文不应出现' })
const raw = new DatabaseSync(path.join(dir, 'relay.db'))
const stored = raw.prepare('SELECT payload FROM envelopes').all().map((row) => row.payload).join('\n')
raw.close()
assert.ok(stored.length > 0)
assert.ok(!stored.includes('明文不应出现'), '中继库不包含正文')
assert.ok(stored.includes('"box"'))

// 部署形态：nginx 把 /relay/ 反代到回环 8791。用同样的前缀重写验证 relayUrl 带路径也能用。
const { createServer, request: httpRequest } = await import('node:http')
const prefixPort = 18832
const proxy = createServer((req, res) => {
  const target = (req.url || '/').replace(/^\/relay/, '') || '/'
  const upstream = httpRequest({ host: '127.0.0.1', port, path: target, method: req.method, headers: req.headers }, (reply) => {
    res.writeHead(reply.statusCode || 502, reply.headers)
    reply.pipe(res)
  })
  upstream.on('error', () => { res.writeHead(502); res.end() })
  req.pipe(upstream)
})
await new Promise((resolve) => proxy.listen(prefixPort, '127.0.0.1', resolve))

const carolStore = new Store(path.join(dir, 'carol.db'))
const daveStore = new Store(path.join(dir, 'dave.db'))
const prefixUrl = `http://127.0.0.1:${prefixPort}/relay/`
const carol = new Im({ identity: new Identity(carolStore), store: carolStore, relayUrl: prefixUrl, log: () => {} })
const dave = new Im({ identity: new Identity(daveStore), store: daveStore, relayUrl: prefixUrl, log: () => {} })
await carol.register()
await dave.register()
assert.equal(carol.status().registered, true)
assert.equal(carol.status().relay, prefixUrl.replace(/\/+$/, ''), 'relayUrl 去掉尾部斜杠后仍带路径前缀')
await carol.addContact(dave.identity.friendCode, '戴夫')
await carol.send(dave.identity.friendCode, { kind: 'text', text: '经 /relay 前缀投递' })
await dave.sync()
assert.equal(daveStore.messages(carol.identity.friendCode)[0].body, '经 /relay 前缀投递')
await new Promise((resolve) => proxy.close(resolve))
carolStore.close()
daveStore.close()

await relay.close()
aliceStore.close()
bobStore.close()
rmSync(dir, { recursive: true, force: true })
console.log('relay ok: 注册/好友码/加密投递/解密落库/中继无明文 + /relay 前缀可用')
