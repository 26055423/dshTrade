/**
 * 假 EA：只实现本机协议里只读需要的部分，用来在没有 MT5 的机器上跑冒烟测试。
 * 不是产品代码，不参与打包。
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function startFakeEa({ port = 18799, origin = 'http://127.0.0.1:56162', code = '12345678' } = {}) {
  const server = createServer((req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain' })
    res.end('upgrade required')
  })
  const sockets = new Set()
  server.on('upgrade', (req, socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    if (req.headers.origin !== origin) {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const key = req.headers['sec-websocket-key'] || ''
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      'Sec-WebSocket-Protocol: tongpin-local.v1',
      '', '',
    ].join('\r\n'))

    const identity = { instance_id: 'fake-instance', account_id: '5001', server: 'Broker-Demo', epoch: 'epoch-1', symbol: 'XAUUSD', demo: true, read_only: false, trade_enabled: true, capabilities: ['market', 'close', 'cancel', 'modify'] }
    send(socket, { type: 'hello', protocol: 'tongpin-local', version: 1, ea_version: 'fake', instance_id: identity.instance_id, pairing_required: true })

    readFrames(socket, (text) => {
      let message
      try { message = JSON.parse(text) } catch { return }
      if (message.type === 'pair') {
        if (String(message.code) !== code) {
          send(socket, { type: 'error', code: 'PAIR_CODE', error: '配对码不正确' })
          return
        }
        send(socket, { type: 'pair_pending', message: '等待本地确认' })
        setTimeout(() => send(socket, { type: 'paired', token: 'f'.repeat(64), ...identity }), 20)
        return
      }
      if (message.type === 'snapshot' || message.type === 'subscribe') {
        send(socket, {
          type: 'snapshot', ...identity,
          account: { login: '5001', server: 'Broker-Demo', balance: 10000, equity: 10012.5, margin: 0, free_margin: 10012.5, profit: 12.5, currency: 'USD' },
          positions: [{ ticket: '700001', symbol: 'XAUUSD', side: 'buy', volume: 0.01, price_open: 2400, sl: 0, tp: 0, profit: 12.5, magic: 26055423 }],
          orders: [],
          tick: { symbol: 'XAUUSD', bid: 2412.4, ask: 2412.7, time: 1700000000, time_msc: 1700000000000 },
          bars: {},
          server_time_ms: 1700000000000,
        })
        return
      }
      if (message.type === 'bars') {
        const base = 1700000000
        const rows = []
        for (let i = 0; i < 3; i += 1) {
          const t = base + i * 60
          rows.push([t, 2400 + i, 2405 + i, 2398 + i, 2403 + i, 10 + i])
        }
        send(socket, { type: 'bars', request_id: message.request_id, symbol: message.symbol, tf: message.tf, bars: rows, ...identity })
        return
      }
      if (message.type === 'history') {
        // 两页：第一页一个完整头寸，第二页再一个；够验证分页游标与重建逻辑。
        const base = 1700000000
        const pages = {
          '': {
            deals: [
              deal('900001', '700001', 0, 0, 2400, 0, base + 10),
              deal('900002', '700001', 1, 1, 2412.5, 12.5, base + 3610),
            ],
            next_cursor: 'cursor-1',
            has_more: true,
            through_server: base + 86399,
          },
          'cursor-1': {
            deals: [
              deal('900003', '700002', 1, 0, 2420, 0, base + 86400),
              deal('900004', '700002', 1, 1, 2415.5, -4.5, base + 90000),
            ],
            next_cursor: '',
            has_more: false,
            through_server: base + 172799,
          },
        }
        const page = pages[String(message.cursor || '')] || pages['']
        send(socket, { type: 'history', request_id: message.request_id, range: { from_server: message.from, to_server: message.to }, ...page, errors: [], time_basis: 'broker_server', server_time_ms: Date.now(), ...identity })
        return
      }
      if (message.type === 'ping') send(socket, { type: 'pong', server_time_ms: Date.now() })
      if (message.type === 'command') {
        send(socket, {
          type: 'command_result', command_id: message.command_id, state: 'completed', ok: true, retcode: 10009,
          order: '456', deal: '789', price: 2412.7, volume: message.volume || 0, partial: false, error: '',
          server_time_ms: Date.now(), ...identity,
        })
      }
    })
  })
  server.listen(port, '127.0.0.1')
  return {
    port,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) {
        try { socket.destroy() } catch {}
      }
      sockets.clear()
      server.close(resolve)
    }),
  }
}

function deal(dealTicket, positionId, type, entry, price, profit, timeServer) {
  return {
    deal_ticket: dealTicket, position_id: positionId, symbol: 'XAUUSD', type, entry,
    volume: 0.01, price, profit, commission: -0.1, swap: 0, fee: 0,
    time_server: timeServer, time_msc_server: timeServer * 1000,
    order_ticket: dealTicket, magic: '26055423', reason: 0, comment: '', external_id: '',
  }
}

function send(socket, value) {
  const payload = Buffer.from(JSON.stringify(value))
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  try { socket.write(Buffer.concat([header, payload])) } catch {}
}

function readFrames(socket, onText) {
  let buffer = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    while (buffer.length >= 2) {
      const b0 = buffer[0]
      const b1 = buffer[1]
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let length = b1 & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        length = Number(buffer.readBigUInt64BE(2))
        offset = 10
      }
      let mask = null
      if (masked) {
        if (buffer.length < offset + 4) return
        mask = buffer.subarray(offset, offset + 4)
        offset += 4
      }
      if (buffer.length < offset + length) return
      let payload = buffer.subarray(offset, offset + length)
      buffer = buffer.subarray(offset + length)
      if (mask) {
        const copy = Buffer.from(payload)
        for (let i = 0; i < copy.length; i += 1) copy[i] ^= mask[i % 4]
        payload = copy
      }
      if (opcode === 0x8) { socket.end(); return }
      if (opcode === 0x9) { continue }
      if (opcode === 0x1) onText(payload.toString('utf8'))
    }
  })
  socket.on('error', () => {})
}
