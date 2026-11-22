/**
 * 本机 SQLite：成交、K 线、笔记、联系人、消息。
 *
 * 这里的数据全部属于本机用户；不从任何云端读取，也不上传。
 * 表结构故意做得保守：先满足「看盘 + 复盘 + 聊天」三件事，后续加列用 ALTER。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trades(
  ticket TEXT PRIMARY KEY,
  account_key TEXT NOT NULL DEFAULT '',
  symbol TEXT NOT NULL DEFAULT '',
  side TEXT NOT NULL DEFAULT '',
  volume REAL NOT NULL DEFAULT 0,
  open_price REAL NOT NULL DEFAULT 0,
  close_price REAL NOT NULL DEFAULT 0,
  opened_utc INTEGER NOT NULL DEFAULT 0,
  closed_utc INTEGER NOT NULL DEFAULT 0,
  profit REAL NOT NULL DEFAULT 0,
  raw TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_trades_closed ON trades(closed_utc DESC);
CREATE TABLE IF NOT EXISTS deals(
  deal_ticket TEXT PRIMARY KEY,
  position_id TEXT NOT NULL DEFAULT '',
  symbol TEXT NOT NULL DEFAULT '',
  type INTEGER NOT NULL DEFAULT 0,
  entry INTEGER NOT NULL DEFAULT 0,
  volume REAL NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  profit REAL NOT NULL DEFAULT 0,
  commission REAL NOT NULL DEFAULT 0,
  swap REAL NOT NULL DEFAULT 0,
  fee REAL NOT NULL DEFAULT 0,
  time_server INTEGER NOT NULL DEFAULT 0,
  time_msc_server INTEGER NOT NULL DEFAULT 0,
  order_ticket TEXT NOT NULL DEFAULT '',
  raw TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_deals_position ON deals(position_id);
CREATE TABLE IF NOT EXISTS bars(
  symbol TEXT NOT NULL,
  tf TEXT NOT NULL,
  time_utc INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL DEFAULT 0,
  PRIMARY KEY(symbol, tf, time_utc)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS notes(
  id TEXT PRIMARY KEY,
  ticket TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_ticket ON notes(ticket);
CREATE TABLE IF NOT EXISTS contacts(
  key TEXT PRIMARY KEY,
  alias TEXT NOT NULL DEFAULT '',
  added INTEGER NOT NULL,
  ed25519 TEXT NOT NULL DEFAULT '',
  x25519 TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY,
  peer TEXT NOT NULL,
  direction TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  body TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS commands(
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_peer ON messages(peer, created DESC);
`

export class Store {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true })
    this.file = file
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 3000')
    this.db.exec(SCHEMA)
    this.ensureColumns()
  }

  ensureColumns() {
    const add = (table, column, ddl) => {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)
      if (!columns.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
    }
    add('contacts', 'ed25519', "TEXT NOT NULL DEFAULT ''")
    add('contacts', 'x25519', "TEXT NOT NULL DEFAULT ''")
    add('messages', 'data', "TEXT NOT NULL DEFAULT ''")
    add('trades', 'time_basis', "TEXT NOT NULL DEFAULT 'broker_server'")
  }

  meta(key, fallback = '') {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
    return row ? row.value : fallback
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value))
  }

  /** rows: [[utcSec, open, high, low, close, volume], ...] */
  putBars(symbol, tf, rows) {
    if (!Array.isArray(rows) || !rows.length) return 0
    const stmt = this.db.prepare(
      'INSERT INTO bars(symbol, tf, time_utc, open, high, low, close, volume) VALUES(?,?,?,?,?,?,?,?) ' +
      'ON CONFLICT(symbol, tf, time_utc) DO UPDATE SET open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume',
    )
    let n = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of rows) {
        if (!Array.isArray(r) || r.length < 5) continue
        const [t, o, h, l, c, v = 0] = r
        if (!Number.isFinite(t) || !Number.isFinite(o)) continue
        stmt.run(symbol, tf, Math.trunc(t), o, h, l, c, v)
        n += 1
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return n
  }

  bars(symbol, tf, from = 0, to = 0, limit = 3000) {
    const rows = this.db.prepare(
      'SELECT time_utc, open, high, low, close, volume FROM bars WHERE symbol = ? AND tf = ? AND time_utc >= ? AND (? = 0 OR time_utc <= ?) ORDER BY time_utc DESC LIMIT ?',
    ).all(symbol, tf, from, to, to, Math.max(1, Math.min(5000, limit)))
    return rows.reverse().map((r) => [r.time_utc, r.open, r.high, r.low, r.close, r.volume])
  }

  /** deal 是 EA history 页里的原始成交；原始行全部保留，交易由 rebuildTrades 重建。 */
  putDeals(rows = []) {
    if (!Array.isArray(rows) || !rows.length) return 0
    const stmt = this.db.prepare(
      'INSERT INTO deals(deal_ticket, position_id, symbol, type, entry, volume, price, profit, commission, swap, fee, ' +
      'time_server, time_msc_server, order_ticket, raw) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ' +
      'ON CONFLICT(deal_ticket) DO UPDATE SET position_id=excluded.position_id, symbol=excluded.symbol, type=excluded.type, ' +
      'entry=excluded.entry, volume=excluded.volume, price=excluded.price, profit=excluded.profit, ' +
      'commission=excluded.commission, swap=excluded.swap, fee=excluded.fee, time_server=excluded.time_server, ' +
      'time_msc_server=excluded.time_msc_server, order_ticket=excluded.order_ticket, raw=excluded.raw',
    )
    let n = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        const ticket = String(row && row.deal_ticket || '')
        if (!ticket) continue
        stmt.run(
          ticket,
          String(row.position_id || ''),
          String(row.symbol || ''),
          Number(row.type || 0),
          Number(row.entry || 0),
          Number(row.volume || 0),
          Number(row.price || 0),
          Number(row.profit || 0),
          Number(row.commission || 0),
          Number(row.swap || 0),
          Number(row.fee || 0),
          Math.trunc(Number(row.time_server || 0)),
          Math.trunc(Number(row.time_msc_server || 0)),
          String(row.order_ticket || ''),
          JSON.stringify(row),
        )
        n += 1
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return n
  }

  /**
   * 用本地 deal 重建「已平仓交易」读模型。
   *
   * entry 0 视为开仓，其余（1=平仓、2=反手、3=对平）都按平仓腿计入；价格按手数加权，
   * 时间取券商服务器秒（EA 的 time_basis 就是 broker_server），不做时区猜测。
   * 只有既开又平的头寸才会成为一笔历史，未平仓的留给了持仓面板。
   */
  rebuildTrades(accountKey = '') {
    const rows = this.db.prepare(
      'SELECT position_id, symbol, type, entry, volume, price, profit, commission, swap, fee, time_server FROM deals ORDER BY time_msc_server ASC',
    ).all()
    const groups = new Map()
    for (const row of rows) {
      const key = String(row.position_id || '')
      if (!key) continue
      let group = groups.get(key)
      if (!group) {
        group = { key, symbol: row.symbol, side: row.type === 0 ? 'buy' : 'sell', opens: [], closes: [], opened: 0, closed: 0, profit: 0 }
        groups.set(key, group)
      }
      if (!group.symbol) group.symbol = row.symbol
      group.profit += Number(row.profit || 0) + Number(row.commission || 0) + Number(row.swap || 0) + Number(row.fee || 0)
      if (Number(row.entry) === 0) {
        group.opens.push(row)
        group.opened = group.opened ? Math.min(group.opened, row.time_server) : row.time_server
      } else {
        group.closes.push(row)
        group.closed = Math.max(group.closed, row.time_server)
      }
    }

    const stmt = this.db.prepare(
      'INSERT INTO trades(ticket, account_key, symbol, side, volume, open_price, close_price, opened_utc, closed_utc, profit, raw, time_basis) ' +
      'VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(ticket) DO UPDATE SET account_key=excluded.account_key, symbol=excluded.symbol, ' +
      'side=excluded.side, volume=excluded.volume, open_price=excluded.open_price, close_price=excluded.close_price, ' +
      'opened_utc=excluded.opened_utc, closed_utc=excluded.closed_utc, profit=excluded.profit, raw=excluded.raw, time_basis=excluded.time_basis',
    )
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec('DELETE FROM trades')
      let n = 0
      for (const group of groups.values()) {
        if (!group.opens.length || !group.closes.length) continue
        const openVolume = group.opens.reduce((sum, row) => sum + Number(row.volume || 0), 0)
        const closeVolume = group.closes.reduce((sum, row) => sum + Number(row.volume || 0), 0)
        const volume = openVolume || closeVolume
        const openPrice = weighted(group.opens)
        const closePrice = weighted(group.closes)
        stmt.run(
          group.key, String(accountKey), String(group.symbol), group.side,
          Number(volume.toFixed(4)), openPrice, closePrice,
          Math.trunc(group.opened), Math.trunc(group.closed), Number(group.profit.toFixed(2)),
          JSON.stringify({ deals: group.opens.length + group.closes.length }),
          'broker_server',
        )
        n += 1
      }
      this.db.exec('COMMIT')
      return n
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  trade(ticket) {
    const row = this.db.prepare(
      'SELECT ticket, symbol, side, volume, open_price, close_price, opened_utc, closed_utc, profit, time_basis FROM trades WHERE ticket = ?',
    ).get(String(ticket))
    return row || null
  }

  upsertTrade(t) {
    const row = {
      ticket: String(t.ticket || ''), account_key: String(t.account_key || ''), symbol: String(t.symbol || ''),
      side: String(t.side || ''), volume: Number(t.volume || 0), open_price: Number(t.open_price || 0),
      close_price: Number(t.close_price || 0), opened_utc: Number(t.opened_utc || 0), closed_utc: Number(t.closed_utc || 0),
      profit: Number(t.profit || 0), raw: JSON.stringify(t.raw || t),
    }
    if (!row.ticket) return
    this.db.prepare(
      'INSERT INTO trades(ticket, account_key, symbol, side, volume, open_price, close_price, opened_utc, closed_utc, profit, raw) ' +
      'VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(ticket) DO UPDATE SET account_key=excluded.account_key, symbol=excluded.symbol, ' +
      'side=excluded.side, volume=excluded.volume, open_price=excluded.open_price, close_price=excluded.close_price, ' +
      'opened_utc=excluded.opened_utc, closed_utc=excluded.closed_utc, profit=excluded.profit, raw=excluded.raw',
    ).run(row.ticket, row.account_key, row.symbol, row.side, row.volume, row.open_price, row.close_price, row.opened_utc, row.closed_utc, row.profit, row.raw)
  }

  trades({ from = 0, to = 0, symbol = '', limit = 200 } = {}) {
    const rows = this.db.prepare(
      'SELECT ticket, symbol, side, volume, open_price, close_price, opened_utc, closed_utc, profit FROM trades ' +
      'WHERE closed_utc >= ? AND (? = 0 OR closed_utc <= ?) AND (? = \'\' OR symbol = ?) ORDER BY closed_utc DESC LIMIT ?',
    ).all(from, to, to, symbol, symbol, Math.max(1, Math.min(1000, limit)))
    return rows.map((r) => ({
      ticket: r.ticket, symbol: r.symbol, side: r.side, volume: r.volume,
      open_price: r.open_price, close_price: r.close_price,
      opened_utc: r.opened_utc, closed_utc: r.closed_utc, profit: r.profit,
    }))
  }

  saveNote({ id, ticket = '', body = '', tags = [] }) {
    const now = Date.now()
    const key = String(id || '').trim() || 'n_' + now.toString(36) + Math.random().toString(36).slice(2, 8)
    this.db.prepare(
      'INSERT INTO notes(id, ticket, body, tags, created, updated) VALUES(?,?,?,?,?,?) ' +
      'ON CONFLICT(id) DO UPDATE SET ticket=excluded.ticket, body=excluded.body, tags=excluded.tags, updated=excluded.updated',
    ).run(key, String(ticket), String(body), JSON.stringify(Array.isArray(tags) ? tags : []), now, now)
    return { id: key, updated: now }
  }

  notes(limit = 100) {
    return this.db.prepare('SELECT id, ticket, body, tags, created, updated FROM notes ORDER BY updated DESC LIMIT ?')
      .all(Math.max(1, Math.min(500, limit)))
      .map((r) => ({ ...r, tags: safeJson(r.tags, []) }))
  }

  logCommand({ id, action, payload = {}, state = '' }) {
    if (!id) return
    this.db.prepare(
      'INSERT INTO commands(id, action, payload, state, created) VALUES(?,?,?,?,?) ' +
      'ON CONFLICT(id) DO UPDATE SET state=excluded.state',
    ).run(String(id), String(action), JSON.stringify(payload || {}), String(state), Date.now())
  }

  commands(limit = 50) {
    return this.db.prepare('SELECT id, action, payload, state, created FROM commands ORDER BY created DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, limit)))
      .map((r) => ({ ...r, payload: safeJson(r.payload, {}) }))
  }

  upsertContact({ code, alias = '', ed25519 = '', x25519 = '' }) {
    if (!code) return
    this.db.prepare(
      'INSERT INTO contacts(key, alias, added, ed25519, x25519) VALUES(?,?,?,?,?) ' +
      'ON CONFLICT(key) DO UPDATE SET alias=excluded.alias, ed25519=excluded.ed25519, x25519=excluded.x25519',
    ).run(String(code), String(alias), Date.now(), String(ed25519), String(x25519))
  }

  contact(code) {
    const row = this.db.prepare('SELECT key, alias, added, ed25519, x25519 FROM contacts WHERE key = ?').get(String(code))
    if (!row) return null
    return { code: row.key, alias: row.alias, added: row.added, ed25519: row.ed25519, x25519: row.x25519 }
  }

  contacts() {
    return this.db.prepare('SELECT key, alias, added, ed25519, x25519 FROM contacts ORDER BY added DESC')
      .all()
      .map((row) => ({ code: row.key, alias: row.alias, added: row.added, ed25519: row.ed25519, x25519: row.x25519 }))
  }

  addMessage({ id, peer, direction, kind = 'text', body = '', data = null, created = Date.now(), read = 0 }) {
    if (!id || !peer) return
    this.db.prepare(
      'INSERT OR REPLACE INTO messages(id, peer, direction, kind, body, data, created, read) VALUES(?,?,?,?,?,?,?,?)',
    ).run(String(id), String(peer), String(direction), String(kind), String(body), data ? JSON.stringify(data) : '', Number(created), Number(read))
  }

  messages(peer, limit = 100) {
    return this.db.prepare('SELECT id, peer, direction, kind, body, data, created, read FROM messages WHERE peer = ? ORDER BY created ASC LIMIT ?')
      .all(String(peer), Math.max(1, Math.min(500, limit)))
      .map((row) => ({ ...row, data: row.data ? safeJson(row.data, null) : null }))
  }

  unread(peer) {
    return this.db.prepare("SELECT count(*) AS n FROM messages WHERE peer = ? AND direction = 'in' AND read = 0").get(String(peer)).n
  }

  counts() {
    const one = (sql) => this.db.prepare(sql).get().n
    return {
      trades: one('SELECT count(*) AS n FROM trades'),
      deals: one('SELECT count(*) AS n FROM deals'),
      bars: one('SELECT count(*) AS n FROM bars'),
      notes: one('SELECT count(*) AS n FROM notes'),
      messages: one('SELECT count(*) AS n FROM messages'),
      commands: one('SELECT count(*) AS n FROM commands'),
    }
  }

  close() {
    try { this.db.close() } catch {}
  }
}

function safeJson(text, fallback) {
  try { return JSON.parse(text) } catch { return fallback }
}

function weighted(rows) {
  let volume = 0
  let cost = 0
  for (const row of rows) {
    const size = Number(row.volume || 0)
    if (!Number.isFinite(size) || size <= 0) continue
    volume += size
    cost += size * Number(row.price || 0)
  }
  return volume > 0 ? Number((cost / volume).toFixed(6)) : 0
}
