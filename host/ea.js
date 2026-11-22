/**
 * 本机 EA 客户端。
 *
 * 直连 SyncTrade EA 的回环 WebSocket（ws://127.0.0.1:18765/ws，子协议 tongpin-local.v1），
 * 自己实现 RFC6455 握手与帧，因为浏览器之外的原生 WebSocket 不能设置 Origin，
 * 而 EA 要求 Origin 精确匹配。所有数据只在本机进程里流转。
 */
import { createHash, randomBytes } from 'node:crypto'
import { connect as netConnect } from 'node:net'

const PROTOCOL = 'tongpin-local.v1'
const TRADE_TFS = new Set(['1m', '5m', '15m', '30m', '1h', '4h', '1d'])

export class EaClient {
  constructor({ url, origin, symbol = 'XAUUSD', tf = '1m', store = null, log = () => {} }) {
    this.url = new URL(url)
    this.origin = origin
    this.symbol = symbol
    this.tf = TRADE_TFS.has(tf) ? tf : '1m'
    this.store = store
    this.log = log
    this.state = {
      phase: 'disconnected',
      error: '',
      identity: null,
      account: null,
      positions: [],
      orders: [],
      tick: null,
      forming: {},
      bars: {},
      serverTimeMs: 0,
      updated: 0,
      revision: 0,
    }
    this.listeners = new Set()
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.fragments = []
    this.socketOpen = false
    this.stopping = false
    this.token = ''
    this.lastMessage = 0
    this.timer = null
    this.retry = null
  }

  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  snapshot() {
    return this.state
  }

  patch(patch) {
    this.state = { ...this.state, ...patch, updated: Date.now(), revision: this.state.revision + 1 }
    for (const fn of this.listeners) {
      try { fn(this.state) } catch (error) { this.log('listener failed', error) }
    }
  }

  start() {
    this.stopping = false
    this.connect()
  }

  stop() {
    this.stopping = true
    clearTimeout(this.retry)
    this.retry = null
    this.destroy()
    this.patch({ phase: 'disconnected' })
  }

  connect() {
    if (this.stopping) return
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.destroy()
    this.patch({ phase: 'connecting', error: '' })
    const key = randomBytes(16).toString('base64')
    this.handshakeKey = key
    const socket = netConnect({ host: this.url.hostname, port: Number(this.url.port || 80) })
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    this.socketOpen = false
    socket.setNoDelay(true)
    socket.on('connect', () => {
      const lines = [
        `GET ${this.url.pathname || '/ws'} HTTP/1.1`,
        `Host: ${this.url.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Protocol: ${PROTOCOL}`,
        `Origin: ${this.origin}`,
        '',
        '',
      ]
      socket.write(lines.join('\r\n'))
    })
    socket.on('data', (chunk) => this.receive(chunk))
    socket.on('error', (error) => {
      if (this.socket !== socket) return
      this.fail('未能连接本机 EA：' + (error.code || error.message))
    })
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.destroy()
      if (this.stopping) return
      const wasConnected = this.state.phase === 'connected'
      this.patch({
        phase: 'disconnected',
        error: wasConnected ? '本机 EA 连接已断开，交易已停用；重新连接后请核对未完成指令。' : this.state.error,
        identity: null, account: null, positions: [], orders: [],
      })
      this.token = ''
      this.retry = setTimeout(() => this.connect(), 8000)
    })
  }

  fail(message) {
    this.destroy()
    this.patch({ phase: 'error', error: message })
    if (!this.stopping) this.retry = setTimeout(() => this.connect(), 8000)
  }

  destroy() {
    clearInterval(this.timer)
    this.timer = null
    const socket = this.socket
    this.socket = null
    this.socketOpen = false
    if (socket) {
      try { socket.destroy() } catch {}
    }
  }

  receive(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    if (!this.socketOpen) {
      const end = this.buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const head = this.buffer.subarray(0, end).toString('utf8')
      this.buffer = this.buffer.subarray(end + 4)
      const status = head.split('\r\n', 1)[0] || ''
      if (!/^HTTP\/1\.1 101/.test(status)) {
        this.fail('EA 拒绝了本机连接：' + status)
        return
      }
      this.socketOpen = true
      this.lastMessage = Date.now()
      this.timer = setInterval(() => this.heartbeat(), 3000)
    }
    this.parseFrames()
  }

  heartbeat() {
    if (!this.socketOpen) return
    if (Date.now() - this.lastMessage > 15000) {
      this.fail('EA 长时间无响应，已停止连接；请重新连接并核对指令结果。')
      return
    }
    if (this.state.phase === 'pairing' || this.state.phase === 'confirming') return
    this.send({ type: 'ping' }, false)
  }

  parseFrames() {
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0]
      const b1 = this.buffer[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let length = b1 & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        const big = this.buffer.readBigUInt64BE(2)
        if (big > 32n * 1024n * 1024n) { this.fail('EA 返回的数据过大'); return }
        length = Number(big)
        offset = 10
      }
      let maskKey = null
      if (masked) {
        if (this.buffer.length < offset + 4) return
        maskKey = this.buffer.subarray(offset, offset + 4)
        offset += 4
      }
      if (this.buffer.length < offset + length) return
      let payload = this.buffer.subarray(offset, offset + length)
      this.buffer = this.buffer.subarray(offset + length)
      if (maskKey) {
        const copy = Buffer.from(payload)
        for (let i = 0; i < copy.length; i += 1) copy[i] ^= maskKey[i % 4]
        payload = copy
      }
      this.onFrame(fin, opcode, payload)
    }
  }

  onFrame(fin, opcode, payload) {
    if (opcode === 0x8) {
      this.destroy()
      return
    }
    if (opcode === 0x9) {
      this.frame(0xa, payload)
      return
    }
    if (opcode === 0xa) return
    if (opcode === 0x1) {
      this.fragments = [payload]
      this.fragOpcode = 1
    } else if (opcode === 0x0) {
      this.fragments.push(payload)
    } else {
      return
    }
    if (!fin) return
    const text = Buffer.concat(this.fragments).toString('utf8')
    this.fragments = []
    if (text.length > 1024 * 1024) return
    this.lastMessage = Date.now()
    let message
    try { message = JSON.parse(text) } catch { this.patch({ error: 'EA 返回了无法识别的数据，请核对 EA 版本。' }); return }
    this.onMessage(message)
  }

  onMessage(message) {
    const type = message && message.type
    if (type === 'hello') {
      this.patch({ phase: 'pairing', error: '' })
      return
    }
    if (type === 'pair_pending') {
      this.patch({ phase: 'confirming', error: '' })
      return
    }
    if (type === 'paired') {
      this.token = String(message.token || '')
      const identity = identityOf(message)
      this.patch({ phase: 'connected', error: '', identity })
      this.send({ type: 'snapshot' })
      this.requestBars(this.tf)
      return
    }
    if (type === 'snapshot' || type === 'trade') {
      const identity = identityOf(message)
      const patch = { serverTimeMs: Number(message.server_time_ms || 0) }
      if (identity) patch.identity = identity
      if (message.account) patch.account = message.account
      if (Array.isArray(message.positions)) patch.positions = message.positions
      if (Array.isArray(message.orders)) patch.orders = message.orders
      if (message.tick) patch.tick = message.tick
      this.patch(patch)
      return
    }
    if (type === 'tick' && message.tick) {
      this.patch({ tick: message.tick })
      return
    }
    if (type === 'bar' && message.tf) {
      const forming = { ...this.state.forming, [message.tf]: message }
      this.patch({ forming })
      return
    }
    if (type === 'bars' && Array.isArray(message.bars)) {
      const tf = String(message.tf || '')
      if (!TRADE_TFS.has(tf)) return
      const rows = message.bars
      const bars = { ...this.state.bars, [tf]: rows }
      this.patch({ bars })
      try { this.store?.putBars(String(message.symbol || this.symbol), tf, rows) } catch (error) { this.log('store bars failed', error) }
      return
    }
    if (type === 'command_result') {
      this.log('command result', message)
      return
    }
    if (type === 'error') {
      this.patch({ error: String(message.error || message.code || 'EA 返回错误') })
    }
  }

  pair(code) {
    if (this.state.phase !== 'pairing' && this.state.phase !== 'confirming') throw new Error('EA 还未就绪，请等待连接成功')
    if (!/^\d{8}$/.test(String(code || ''))) throw new Error('请输入 EA 图表显示的 8 位配对码')
    this.send({ type: 'pair', code: String(code) }, false)
    this.patch({ phase: 'confirming', error: '' })
  }

  requestBars(tf, limit = 500) {
    if (!TRADE_TFS.has(tf)) return
    this.send({ type: 'bars', symbol: this.symbol, tf, limit, request_id: randomBytes(8).toString('hex') })
  }

  auth() {
    const id = this.state.identity
    if (!id || !this.token) throw new Error('请先完成本机配对')
    return { token: this.token, account_id: id.account_id, server: id.server, epoch: id.epoch }
  }

  send(message, authenticate = true) {
    if (!this.socketOpen || !this.socket) throw new Error('本机 EA 未连接')
    const body = authenticate ? { ...message, ...this.auth() } : message
    this.frame(0x1, Buffer.from(JSON.stringify(body)))
  }

  frame(opcode, payload) {
    if (!this.socket) return
    const length = payload.length
    let header
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | length])
    } else if (length < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }
    const mask = randomBytes(4)
    const masked = Buffer.alloc(length)
    for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ mask[i % 4]
    this.socket.write(Buffer.concat([header, mask, masked]))
  }
}

function identityOf(message) {
  const accountId = message.account_id ?? message.account?.login
  if (accountId === undefined || accountId === null) return null
  return {
    instance_id: String(message.instance_id || ''),
    account_id: String(accountId),
    server: String(message.server || message.account?.server || ''),
    epoch: String(message.epoch || ''),
    symbol: String(message.symbol || ''),
    demo: message.demo === true,
    read_only: message.read_only !== false,
    trade_enabled: message.trade_enabled === true,
    capabilities: Array.isArray(message.capabilities) ? message.capabilities : [],
  }
}

export function keyFingerprint(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}
