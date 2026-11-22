#!/usr/bin/env node
/**
 * dshTrade 薄中继。
 *
 * 只做三件事：登记公钥、暂存密文信封、按收件人投递后删除。
 * 不解析正文、不保存聊天内容、没有账号密码；信封带签名，中继验证后入库。
 *
 * 运行：node relay/server.js
 * 环境：RELAY_PORT(8791) RELAY_HOST(127.0.0.1) RELAY_DB(relay.db) RELAY_TTL(604800)
 */
import { createHash, randomBytes, verify as verifySignature, createPublicKey } from 'node:crypto'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const MAX_BODY = 256 * 1024
const MAX_ENVELOPES = 2000

export function startRelay(options = {}) {
  const port = Number(options.port ?? process.env.RELAY_PORT ?? 8791)
  const host = options.host || process.env.RELAY_HOST || '127.0.0.1'
  const dbPath = resolve(options.dbPath || process.env.RELAY_DB || 'relay.db')
  const maxTtl = Number(options.ttl || process.env.RELAY_TTL || 604800)
  const log = options.log || ((...args) => console.log('[relay]', ...args))

  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
CREATE TABLE IF NOT EXISTS accounts(
  code TEXT PRIMARY KEY,
  ed25519 TEXT NOT NULL,
  x25519 TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS envelopes(
  id TEXT PRIMARY KEY,
  to_code TEXT NOT NULL,
  from_code TEXT NOT NULL,
  sent INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_envelopes_to ON envelopes(to_code, sent);
`)

  const limits = new Map()
  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      log('request failed', error)
      send(res, 500, { ok: false, error: 'internal error' })
    })
  })

  const cleanup = setInterval(() => {
    db.prepare('DELETE FROM envelopes WHERE expires < ?').run(Date.now())
  }, 60_000)
  cleanup.unref()

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://relay')
    const route = url.pathname
    if (req.method === 'GET' && route === '/v1/health') return send(res, 200, { ok: true, service: 'dshtrade-relay', envelopes: count() })
    if (req.method === 'POST') {
      if (!rate(req)) return send(res, 429, { ok: false, error: 'too many requests' })
      const body = await readJson(req)
      if (route === '/v1/register') return register(res, body)
      if (route === '/v1/send') return sendEnvelope(req, res, body)
      if (route === '/v1/inbox') return inbox(req, res)
      if (route === '/v1/ack') return ack(req, res, body)
    }
    if (req.method === 'GET' && route === '/v1/keys') {
      const row = db.prepare('SELECT code, ed25519, x25519 FROM accounts WHERE code = ?').get(String(url.searchParams.get('code') || ''))
      if (!row) return send(res, 404, { ok: false, error: 'not found' })
      return send(res, 200, { ok: true, ...row })
    }
    return send(res, 404, { ok: false, error: 'not found' })
  }

  function register(res, body) {
    const code = String(body.code || '')
    const ed25519 = String(body.ed25519 || '')
    const x25519 = String(body.x25519 || '')
    const sig = String(body.sig || '')
    if (!/^TP-[A-Z0-9-]{4,40}$/.test(code)) return send(res, 400, { ok: false, error: 'invalid code' })
    if (!isDer(ed25519) || !isDer(x25519) || !sig) return send(res, 400, { ok: false, error: 'invalid keys' })
    if (!verifyDer(ed25519, registerText(code, ed25519, x25519), sig)) return send(res, 403, { ok: false, error: 'bad signature' })
    const token = randomBytes(32).toString('base64url')
    db.prepare(
      'INSERT INTO accounts(code, ed25519, x25519, token_hash, created) VALUES(?,?,?,?,?) ' +
      'ON CONFLICT(code) DO UPDATE SET ed25519=excluded.ed25519, x25519=excluded.x25519, token_hash=excluded.token_hash',
    ).run(code, ed25519, x25519, sha(token), Date.now())
    return send(res, 200, { ok: true, token })
  }

  function sendEnvelope(req, res, body) {
    const account = auth(req)
    if (!account) return send(res, 401, { ok: false, error: 'unauthorized' })
    const envelope = body.envelope || {}
    if (!envelope || envelope.v !== 1) return send(res, 400, { ok: false, error: 'invalid envelope' })
    if (envelope.from !== account.code) return send(res, 403, { ok: false, error: 'sender mismatch' })
    if (!/^TP-[A-Z0-9-]{4,40}$/.test(String(envelope.to || ''))) return send(res, 400, { ok: false, error: 'invalid recipient' })
    if (!String(envelope.nonce || '') || !String(envelope.box || '')) return send(res, 400, { ok: false, error: 'empty envelope' })
    const ttl = Math.max(60, Math.min(maxTtl, Number(envelope.ttl) || maxTtl))
    if (!verifyDer(account.ed25519, canonical(envelope), String(envelope.sig || ''))) return send(res, 403, { ok: false, error: 'bad signature' })
    const recipient = db.prepare('SELECT 1 FROM accounts WHERE code = ?').get(String(envelope.to))
    if (!recipient) return send(res, 404, { ok: false, error: 'recipient not registered' })
    if (countFor(String(envelope.to)) >= MAX_ENVELOPES) return send(res, 507, { ok: false, error: 'mailbox full' })
    db.prepare('INSERT OR REPLACE INTO envelopes(id, to_code, from_code, sent, expires, payload) VALUES(?,?,?,?,?,?)')
      .run(String(envelope.id), String(envelope.to), String(envelope.from), Number(envelope.sent) || Date.now(), Date.now() + ttl * 1000, JSON.stringify(envelope))
    return send(res, 200, { ok: true })
  }

  function inbox(req, res) {
    const account = auth(req)
    if (!account) return send(res, 401, { ok: false, error: 'unauthorized' })
    const rows = db.prepare('SELECT payload FROM envelopes WHERE to_code = ? AND expires >= ? ORDER BY sent ASC LIMIT 200').all(account.code, Date.now())
    return send(res, 200, { ok: true, envelopes: rows.map((row) => JSON.parse(row.payload)) })
  }

  function ack(req, res, body) {
    const account = auth(req)
    if (!account) return send(res, 401, { ok: false, error: 'unauthorized' })
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, 500).map(String) : []
    const statement = db.prepare('DELETE FROM envelopes WHERE id = ? AND to_code = ?')
    for (const id of ids) statement.run(id, account.code)
    return send(res, 200, { ok: true, removed: ids.length })
  }

  function auth(req) {
    const header = String(req.headers.authorization || '')
    if (!header.startsWith('Bearer ')) return null
    return db.prepare('SELECT code, ed25519 FROM accounts WHERE token_hash = ?').get(sha(header.slice(7))) || null
  }

  function rate(req) {
    const ip = req.socket.remoteAddress || 'unknown'
    const now = Date.now()
    const entry = limits.get(ip) || { started: now, count: 0 }
    if (now - entry.started > 60_000) { entry.started = now; entry.count = 0 }
    entry.count += 1
    limits.set(ip, entry)
    return entry.count <= 240
  }

  function count() {
    return db.prepare('SELECT count(*) AS n FROM envelopes').get().n
  }

  function countFor(code) {
    return db.prepare('SELECT count(*) AS n FROM envelopes WHERE to_code = ?').get(code).n
  }

  return {
    server,
    db,
    listen: () => new Promise((done) => server.listen(port, host, done)),
    close: () => new Promise((done) => {
      clearInterval(cleanup)
      server.close(() => { try { db.close() } catch {} ; done() })
    }),
    address: () => `http://${host}:${port}`,
  }
}

function canonical(envelope) {
  return [envelope.v, envelope.id, envelope.from, envelope.to, envelope.sent, envelope.ttl, envelope.nonce, envelope.box].join('\n')
}

function registerText(code, ed25519, x25519) {
  return 'dshtrade-register-v1\n' + code + '\n' + ed25519 + '\n' + x25519
}

function isDer(value) {
  if (typeof value !== 'string' || value.length < 40 || value.length > 400) return false
  return /^[A-Za-z0-9+/=]+$/.test(value)
}

function verifyDer(der, text, signature) {
  try {
    const key = createPublicKey({ key: Buffer.from(der, 'base64'), format: 'der', type: 'spki' })
    return verifySignature(null, Buffer.from(text), key, Buffer.from(signature, 'base64url'))
  } catch {
    return false
  }
}

function sha(text) {
  return createHash('sha256').update(String(text)).digest('hex')
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('invalid json')) }
    })
    req.on('error', reject)
  })
}

function send(res, status, value) {
  if (res.writableEnded) return
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const relay = startRelay()
  relay.listen().then(() => console.log(`[relay] listening on ${relay.address()} db=${resolve(process.env.RELAY_DB || 'relay.db')}`))
}
