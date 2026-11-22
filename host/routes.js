/**
 * 同源 HTTP 路由：浏览器只和 DSH 自己的地址说话，不跨域、不带 Cookie。
 * 数据全部来自本机 EA 客户端与本地 SQLite。
 */
const PREFIX = '/dshtrade/api'
const MAX_BODY = 64 * 1024

export function registerRoutes(ctx, { store, ea, identity, log = () => {} }) {
  const origin = safeOrigin(ctx)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => handle(req, res, { store, ea, identity, origin, log }).catch((error) => {
      log('route failed', error)
      write(res, 500, { ok: false, error: '本机服务出错' })
    }),
  }))
}

function safeOrigin(ctx) {
  try { return ctx.webServer.getOrigin() } catch { return '' }
}

async function handle(req, res, deps) {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const path = url.pathname
  if (!path.startsWith(PREFIX)) return write(res, 404, { ok: false, error: '接口不存在' })
  const route = path.slice(PREFIX.length) || '/'
  const method = req.method || 'GET'

  if (method === 'POST' && !trusted(req, deps.origin)) return write(res, 403, { ok: false, error: '请求来源不正确' })
  if (req.headers['sec-fetch-site'] === 'cross-site') return write(res, 403, { ok: false, error: '请求来源不正确' })

  try {
    if (method === 'GET' && route === '/state') {
      const state = deps.ea.snapshot()
      const { bars, ...rest } = state
      return write(res, 200, {
        ok: true,
        ea: { ...rest, bars: Object.fromEntries(Object.entries(bars || {}).map(([tf, rows]) => [tf, rows.length])) },
        identity: deps.identity ? deps.identity.view() : null,
        counts: deps.store.counts(),
      })
    }
    if (method === 'GET' && route === '/health') {
      return write(res, 200, { ok: true, phase: deps.ea.snapshot().phase, counts: deps.store.counts() })
    }
    if (method === 'GET' && route === '/trades') {
      const q = url.searchParams
      const rows = deps.store.trades({
        from: Number(q.get('from') || 0),
        to: Number(q.get('to') || 0),
        symbol: String(q.get('symbol') || ''),
        limit: Number(q.get('limit') || 200),
      })
      return write(res, 200, { ok: true, trades: rows })
    }
    if (method === 'GET' && route === '/bars') {
      const q = url.searchParams
      const tf = String(q.get('tf') || '1m')
      const rows = deps.store.bars(String(q.get('symbol') || 'XAUUSD'), tf, Number(q.get('from') || 0), Number(q.get('to') || 0), Number(q.get('limit') || 3000))
      return write(res, 200, { ok: true, tf, bars: rows })
    }
    if (method === 'GET' && route === '/commands') {
      return write(res, 200, { ok: true, commands: deps.store.commands(Number(url.searchParams.get('limit') || 50)) })
    }
    if (method === 'GET' && route === '/notes') {
      return write(res, 200, { ok: true, notes: deps.store.notes(Number(url.searchParams.get('limit') || 100)) })
    }
    if (method === 'POST' && route === '/command') {
      const body = await readJson(req)
      const action = String(body.action || '')
      if (!TRADE_ACTIONS.has(action)) throw httpError('不支持的动作', 400)
      const state = deps.ea.snapshot()
      if (state.phase !== 'connected' || !state.identity) throw httpError('本机 EA 未连接', 409)
      if (!state.identity.trade_enabled) throw httpError('EA 未开启交易', 403)
      if (Array.isArray(state.identity.capabilities) && !state.identity.capabilities.includes(action)) throw httpError('EA 未开放该动作', 403)
      const payload = validateCommand(body, action, state.identity)
      const result = await deps.ea.command(payload)
      return write(res, 200, { ok: result.ok === true, result })
    }
    if (method === 'POST' && route === '/pair') {
      const body = await readJson(req)
      deps.ea.pair(body.code)
      return write(res, 200, { ok: true })
    }
    if (method === 'POST' && route === '/bars') {
      const body = await readJson(req)
      deps.ea.requestBars(String(body.tf || '1m'), Number(body.limit || 500))
      return write(res, 200, { ok: true })
    }
    if (method === 'POST' && route === '/notes') {
      const body = await readJson(req)
      const saved = deps.store.saveNote({ id: body.id, ticket: body.ticket, body: body.body, tags: body.tags })
      return write(res, 200, { ok: true, note: saved })
    }
    return write(res, 404, { ok: false, error: '接口不存在' })
  } catch (error) {
    const status = error && error.status ? error.status : 400
    return write(res, status, { ok: false, error: String(error?.message || error) })
  }
}

function trusted(req, origin) {  const given = req.headers.origin
  if (!given) return true
  try {
    const a = new URL(given)
    const b = new URL(origin || 'http://127.0.0.1')
    return a.protocol === b.protocol && a.host === b.host
  } catch { return false }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('请求体不是 JSON')) }
    })
    req.on('error', reject)
  })
}

function write(res, status, value) {
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

const TRADE_ACTIONS = new Set(['market', 'close', 'cancel', 'modify'])

function httpError(message, status) {
  return Object.assign(new Error(message), { status })
}

function finite(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw httpError(label + '不正确', 400)
  return number
}

function ticket(value, label) {
  const text = String(value ?? '').trim()
  if (!/^[0-9]{1,32}$/.test(text)) throw httpError(label + '不正确', 400)
  return text
}

/** 只放行协议允许的字段；EA 侧仍会做它自己的最终校验。 */
function validateCommand(body, action, identity) {
  const payload = { action }
  if (body.command_id !== undefined) {
    const id = String(body.command_id)
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw httpError('指令编号不正确', 400)
    payload.command_id = id
  }
  if (action === 'market') {
    const side = String(body.side || '')
    if (side !== 'buy' && side !== 'sell') throw httpError('方向不正确', 400)
    const volume = finite(body.volume, '手数')
    if (volume <= 0) throw httpError('手数需大于零', 400)
    payload.symbol = String(body.symbol || identity.symbol || 'XAUUSD').toUpperCase()
    payload.side = side
    payload.volume = volume
    payload.sl = Math.max(0, finite(body.sl ?? 0, '止损'))
    payload.tp = Math.max(0, finite(body.tp ?? 0, '止盈'))
    payload.deviation = Math.max(0, Math.min(200, finite(body.deviation ?? 20, '滑点')))
    return payload
  }
  if (action === 'close') {
    payload.position_ticket = ticket(body.position_ticket, '持仓单号')
    payload.volume = Math.max(0, finite(body.volume ?? 0, '手数'))
    return payload
  }
  if (action === 'cancel') {
    payload.order_ticket = ticket(body.order_ticket, '挂单号')
    return payload
  }
  payload.ticket = ticket(body.ticket, '持仓单号')
  payload.sl = finite(body.sl, '止损')
  payload.tp = finite(body.tp, '止盈')
  return payload
}
