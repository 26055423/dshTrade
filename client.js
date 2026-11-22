/**
 * 同频客户端插件（浏览器半边）。
 *
 * 只和 DSH 自己的地址通信：/dshtrade/api/*。不连云端，不读 Cookie。
 * 本版：设置页 + 输入框下方的入口 + 全屏交易台（K 线 / 持仓 / 下单）。
 */
window.__ModuleLoader__.load({
  id: '@local/dshtrade',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React

    // 交易台/聊天是全屏浮层。DSH 自己的设置面板也是浮层，层级未知，
    // 这里用足够高的值，保证从设置里点「打开交易台」时不会被盖住。
    const OVERLAY_Z = 2147483000

    // ---- 交易台开关（跨两个插槽共享）----
    let deskOpen = false
    const deskListeners = new Set()
    function setDeskOpen(next) {
      deskOpen = next
      if (next && chatOpen) {
        chatOpen = false
        for (const fn of chatListeners) fn()
      }
      for (const fn of deskListeners) fn()
    }
    function useDeskOpen() {
      return useSyncExternalStore(
        (fn) => { deskListeners.add(fn); return () => deskListeners.delete(fn) },
        () => deskOpen,
      )
    }

    let chatOpen = false
    const chatListeners = new Set()
    function setChatOpen(next) {
      chatOpen = next
      if (next) setDeskOpen(false)
      for (const fn of chatListeners) fn()
    }
    function useChatOpen() {
      return useSyncExternalStore(
        (fn) => { chatListeners.add(fn); return () => chatListeners.delete(fn) },
        () => chatOpen,
      )
    }

    const PHASES = {
      disconnected: ['未连接', 'idle'],
      connecting: ['正在连接本机 EA', 'warn'],
      pairing: ['等待配对码', 'warn'],
      confirming: ['等待 EA 本地确认', 'warn'],
      connected: ['已连接', 'success'],
      error: ['连接异常', 'error'],
    }

    async function call(path, init) {
      const response = await fetch('/dshtrade/api' + path, {
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        ...init,
      })
      let body = {}
      try { body = await response.json() } catch {}
      if (!response.ok || body.ok === false) throw new Error(body.error || '本机服务没有响应（' + response.status + '）')
      return body
    }

    function useLocalState(interval = 2000) {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const refresh = useCallback(async () => {
        try {
          setState(await call('/state'))
          setError('')
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        }
      }, [])
      useEffect(() => {
        refresh()
        const timer = setInterval(refresh, interval)
        return () => clearInterval(timer)
      }, [refresh, interval])
      return { state, error, refresh }
    }

    function toneColor(tone) {
      if (tone === 'success') return 'var(--dsw-alias-state-success-primary)'
      if (tone === 'warn') return 'var(--dsw-alias-state-warn-primary)'
      if (tone === 'error') return 'var(--dsw-alias-state-error-primary)'
      return 'var(--dsw-alias-state-idle-primary)'
    }

    function Badge({ tone, children }) {
      const color = toneColor(tone)
      return h('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px',
          borderRadius: 999, border: '1px solid var(--dsw-alias-border-l1)',
          color, fontSize: 12, lineHeight: '18px',
        },
      }, h('span', { style: { width: 6, height: 6, borderRadius: 999, background: color } }), children)
    }

    function Row({ label, value }) {
      return h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 16, padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
        h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13 } }, label),
        h('span', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: 13, fontVariantNumeric: 'tabular-nums' } }, value))
    }

    const cell = { padding: '5px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)', whiteSpace: 'nowrap' }
    const inputStyle = {
      padding: '5px 8px', borderRadius: 8, fontSize: 13, width: '100%', boxSizing: 'border-box',
      background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
      border: '1px solid var(--dsw-alias-border-l2)',
    }
    const buttonStyle = {
      padding: '6px 12px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
      border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
    }

    function formatMoney(value, currency) {
      const number = Number(value)
      if (!Number.isFinite(number)) return '—'
      return number.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (currency ? ' ' + currency : '')
    }

    // ---- K 线画布 ----
    const PAD = { left: 10, right: 58, top: 12, bottom: 22 }

    function drawChart(canvas, bars, hover) {
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      if (rect.width < 20 || rect.height < 20) return
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const W = rect.width
      const H = rect.height
      ctx.clearRect(0, 0, W, H)
      if (!Array.isArray(bars) || bars.length < 2) {
        ctx.fillStyle = 'rgba(150,150,150,0.8)'
        ctx.font = '12px system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('等待 K 线…', W / 2, H / 2)
        return
      }
      const plotW = W - PAD.left - PAD.right
      const plotH = H - PAD.top - PAD.bottom
      let max = -Infinity
      let min = Infinity
      for (const bar of bars) {
        if (bar[2] > max) max = bar[2]
        if (bar[3] < min) min = bar[3]
      }
      const span = Math.max(1e-9, max - min)
      const yOf = (price) => PAD.top + ((max - price) / span) * plotH
      const slot = plotW / bars.length
      const bodyW = Math.max(1, Math.min(12, slot * 0.62))

      ctx.font = '10px ui-monospace, SFMono-Regular, monospace'
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      for (let i = 0; i <= 4; i += 1) {
        const gy = PAD.top + (plotH * i) / 4
        ctx.strokeStyle = 'rgba(127,127,127,0.16)'
        ctx.beginPath()
        ctx.moveTo(PAD.left, gy)
        ctx.lineTo(PAD.left + plotW, gy)
        ctx.stroke()
        ctx.fillStyle = 'rgba(150,150,150,0.85)'
        ctx.fillText((max - (span * i) / 4).toFixed(2), PAD.left + plotW + 6, gy)
      }

      for (let i = 0; i < bars.length; i += 1) {
        const bar = bars[i]
        const cx = PAD.left + slot * (i + 0.5)
        const up = bar[4] >= bar[1]
        ctx.strokeStyle = up ? '#2f9e6e' : '#d4555b'
        ctx.fillStyle = ctx.strokeStyle
        ctx.beginPath()
        ctx.moveTo(cx, yOf(bar[2]))
        ctx.lineTo(cx, yOf(bar[3]))
        ctx.stroke()
        const yo = yOf(bar[1])
        const yc = yOf(bar[4])
        ctx.fillRect(cx - bodyW / 2, Math.min(yo, yc), bodyW, Math.max(1, Math.abs(yc - yo)))
      }

      ctx.textAlign = 'center'
      ctx.fillStyle = 'rgba(150,150,150,0.85)'
      const step = Math.max(1, Math.ceil(bars.length / 6))
      for (let i = 0; i < bars.length; i += step) {
        const date = new Date(bars[i][0] * 1000)
        const label = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
        ctx.fillText(label, PAD.left + slot * (i + 0.5), H - 8)
      }

      if (hover && Number.isInteger(hover.index) && bars[hover.index]) {
        const bar = bars[hover.index]
        const cx = PAD.left + slot * (hover.index + 0.5)
        ctx.strokeStyle = 'rgba(180,180,180,0.55)'
        ctx.setLineDash([3, 3])
        ctx.beginPath()
        ctx.moveTo(cx, PAD.top)
        ctx.lineTo(cx, PAD.top + plotH)
        ctx.moveTo(PAD.left, hover.y)
        ctx.lineTo(PAD.left + plotW, hover.y)
        ctx.stroke()
        ctx.setLineDash([])
        const text = 'O ' + bar[1] + '  H ' + bar[2] + '  L ' + bar[3] + '  C ' + bar[4]
        ctx.fillStyle = 'rgba(30,30,30,0.88)'
        const width = ctx.measureText(text).width + 12
        ctx.fillRect(PAD.left + 4, PAD.top + 2, width, 18)
        ctx.fillStyle = '#f2f2f2'
        ctx.textAlign = 'left'
        ctx.fillText(text, PAD.left + 10, PAD.top + 11)
      }
    }

    function Chart({ bars }) {
      const ref = useRef(null)
      const [hover, setHover] = useState(null)
      useEffect(() => {
        const canvas = ref.current
        if (!canvas) return undefined
        const redraw = () => drawChart(canvas, bars, hover)
        redraw()
        const observer = new ResizeObserver(redraw)
        if (canvas.parentElement) observer.observe(canvas.parentElement)
        window.addEventListener('resize', redraw)
        return () => {
          observer.disconnect()
          window.removeEventListener('resize', redraw)
        }
      }, [bars, hover])

      const move = (event) => {
        const canvas = ref.current
        if (!canvas || !bars.length) return
        const rect = canvas.getBoundingClientRect()
        const plotW = rect.width - PAD.left - PAD.right
        const slot = plotW / bars.length
        const index = Math.floor((event.clientX - rect.left - PAD.left) / slot)
        if (index < 0 || index >= bars.length) { setHover(null); return }
        setHover({ index, y: event.clientY - rect.top })
      }

      return h('div', { style: { position: 'relative', flex: 1, minHeight: 220, minWidth: 0 } },
        h('canvas', {
          ref,
          onMouseMove: move,
          onMouseLeave: () => setHover(null),
          style: { display: 'block', width: '100%', height: '100%', cursor: 'crosshair' },
        }))
    }

    // ---- 下单票 ----
    function Ticket({ t, identity, tick, onDone }) {
      const [side, setSide] = useState('buy')
      const [volume, setVolume] = useState('0.01')
      const [sl, setSl] = useState('')
      const [tp, setTp] = useState('')
      const [stage, setStage] = useState('idle')
      const [result, setResult] = useState(null)
      const [busy, setBusy] = useState(false)

      const capability = identity && Array.isArray(identity.capabilities) && identity.capabilities.includes('market')
      const enabled = Boolean(identity && identity.trade_enabled && capability)
      const price = tick ? Number(side === 'buy' ? tick.ask : tick.bid) : 0

      const submit = async () => {
        if (stage === 'idle') { setStage('confirm'); return }
        setBusy(true)
        setResult(null)
        try {
          const body = { action: 'market', side, volume: Number(volume), sl: Number(sl || 0), tp: Number(tp || 0), deviation: 20, symbol: identity.symbol || 'XAUUSD' }
          const reply = await call('/command', { method: 'POST', body: JSON.stringify(body) })
          setResult(reply.result)
          onDone && onDone()
        } catch (cause) {
          setResult({ state: 'rejected', ok: false, error: String(cause && cause.message ? cause.message : cause) })
        } finally {
          setBusy(false)
          setStage('idle')
        }
      }

      const stateTone = !result ? null : result.state === 'completed' ? 'success' : result.state === 'uncertain' ? 'warn' : 'error'

      return h('div', { style: { display: 'grid', gap: 8, padding: 12, borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)' } },
        h('div', { style: { display: 'flex', gap: 6 } },
          ['buy', 'sell'].map((value) => h('button', {
            key: value,
            onClick: () => { setSide(value); setStage('idle') },
            style: {
              ...buttonStyle,
              flex: 1,
              background: side === value ? (value === 'buy' ? 'rgba(47,158,110,0.18)' : 'rgba(212,85,91,0.18)') : 'var(--dsw-alias-bg-layer-2)',
              borderColor: side === value ? (value === 'buy' ? '#2f9e6e' : '#d4555b') : 'var(--dsw-alias-border-l2)',
            },
          }, t(value)))),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
          h('span', null, t('price')),
          h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, price ? price.toFixed(2) : '—')),
        h('label', { style: { display: 'grid', gap: 4, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
          t('volume'), h('input', { value: volume, onChange: (event) => setVolume(event.target.value), inputMode: 'decimal', style: inputStyle })),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
          h('label', { style: { display: 'grid', gap: 4, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
            t('stopLoss'), h('input', { value: sl, onChange: (event) => setSl(event.target.value), inputMode: 'decimal', style: inputStyle })),
          h('label', { style: { display: 'grid', gap: 4, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
            t('takeProfit'), h('input', { value: tp, onChange: (event) => setTp(event.target.value), inputMode: 'decimal', style: inputStyle }))),
        h('button', {
          type: 'button',
          disabled: !enabled || busy,
          onClick: submit,
          style: {
            ...buttonStyle,
            background: stage === 'confirm' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-brand-primary)',
            borderColor: 'transparent', color: '#fff', opacity: (!enabled || busy) ? 0.5 : 1,
          },
        }, busy ? t('submitting') : stage === 'confirm' ? t('confirmSubmit') : t('submit')),
        stage === 'confirm' ? h('button', { type: 'button', onClick: () => setStage('idle'), style: { ...buttonStyle, fontSize: 12 } }, t('cancel')) : null,
        !enabled ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, t('tradeDisabled')) : null,
        result ? h('div', { style: { fontSize: 11, color: toneColor(stateTone), lineHeight: 1.5 } },
          t('result') + ' ' + (result.state || '') + (result.error ? ' · ' + result.error : '') + (result.order ? ' · #' + result.order : '')) : null)
    }

    // ---- 全屏交易台 ----
    function Desk({ t }) {
      const open = useDeskOpen()
      const { state, error, refresh } = useLocalState(2000)
      const [tf, setTf] = useState('1m')
      const [bars, setBars] = useState([])
      const [closing, setClosing] = useState({ ticket: '', stage: 'idle' })
      const [notice, setNotice] = useState('')
      const [contacts, setContacts] = useState([])
      const [shareTo, setShareTo] = useState('')
      const [shareNote, setShareNote] = useState('')
      const [shareStatus, setShareStatus] = useState('')
      const [notes, setNotes] = useState([])
      const [noteBody, setNoteBody] = useState('')
      const [noteTicket, setNoteTicket] = useState('')
      const [noteStatus, setNoteStatus] = useState('')
      const [trades, setTrades] = useState([])
      const [historyStatus, setHistoryStatus] = useState('')

      const loadTrades = () => call('/trades?limit=20').then((reply) => setTrades(reply.trades || [])).catch(() => {})

      useEffect(() => {
        if (!open) return undefined
        let alive = true
        call('/im').then((reply) => { if (alive) setContacts(reply.contacts || []) }).catch(() => {})
        call('/notes?limit=20').then((reply) => { if (alive) setNotes(reply.notes || []) }).catch(() => {})
        loadTrades()
        return () => { alive = false }
      }, [open])

      useEffect(() => {
        if (!open) return undefined
        let alive = true
        const load = async () => {
          try {
            await call('/bars', { method: 'POST', body: JSON.stringify({ tf, limit: 500 }) })
            await new Promise((resolve) => setTimeout(resolve, 500))
            if (!alive) return
            const reply = await call('/bars?tf=' + encodeURIComponent(tf) + '&limit=500')
            if (alive) setBars(reply.bars || [])
          } catch {}
        }
        load()
        const timer = setInterval(load, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [open, tf])

      if (!open) return null
      const ea = (state && state.ea) || {}
      const identity = ea.identity || null
      const account = ea.account || null
      const positions = ea.positions || []
      const phase = ea.phase || 'disconnected'
      const phaseInfo = PHASES[phase] || PHASES.disconnected

      const closePosition = async (position) => {
        if (closing.ticket !== position.ticket) { setClosing({ ticket: position.ticket, stage: 'confirm' }); return }
        setClosing({ ticket: '', stage: 'idle' })
        setNotice('')
        try {
          const reply = await call('/command', { method: 'POST', body: JSON.stringify({ action: 'close', position_ticket: position.ticket, volume: 0 }) })
          const result = reply.result || {}
          setNotice(t('result') + ' ' + (result.state || '') + (result.error ? ' · ' + result.error : ''))
          refresh()
        } catch (cause) {
          setNotice(String(cause && cause.message ? cause.message : cause))
        }
      }

      const share = async () => {
        if (!shareTo) { setShareStatus(t('pickShare')); return }
        if (!bars.length) { setShareStatus(t('noBars')); return }
        const windowBars = bars.slice(-120)
        const card = {
          symbol: (identity && identity.symbol) || 'XAUUSD',
          tf,
          note: shareNote.trim(),
          window: { from: windowBars[0][0], to: windowBars[windowBars.length - 1][0] },
          bars: windowBars,
        }
        try {
          await call('/im/send', { method: 'POST', body: JSON.stringify({ to: shareTo, kind: 'card', text: shareNote.trim() || t('shareCard'), card }) })
          setShareStatus(t('shared'))
          setShareNote('')
        } catch (cause) {
          setShareStatus(String(cause && cause.message ? cause.message : cause))
        }
      }

      const saveNote = async () => {
        if (!noteBody.trim()) return
        try {
          await call('/notes', { method: 'POST', body: JSON.stringify({ ticket: noteTicket.trim(), body: noteBody.trim(), tags: [] }) })
          setNoteStatus(t('noteSaved'))
          setNoteBody('')
          const reply = await call('/notes?limit=20')
          setNotes(reply.notes || [])
        } catch (cause) {
          setNoteStatus(String(cause && cause.message ? cause.message : cause))
        }
      }

      /** 笔记列表前缀：能关联到本地成交就显示品种/方向/盈亏，否则退回单号。 */
      const noteLabel = (note) => {
        if (note.trade) {
          return note.trade.symbol + ' ' + (note.trade.side === 'buy' ? t('buy') : t('sell')) + ' ' + Number(note.trade.profit || 0).toFixed(2) + ' · '
        }
        return note.ticket ? '#' + note.ticket + ' · ' : ''
      }

      const syncHistory = async () => {
        setHistoryStatus(t('syncingHistory'))
        try {
          await call('/history', { method: 'POST', body: JSON.stringify({}) })
          const started = Date.now()
          while (Date.now() - started < 30000) {
            await new Promise((resolve) => setTimeout(resolve, 400))
            const reply = await call('/history')
            const job = reply.history || {}
            if (!job.active) {
              setHistoryStatus(job.error ? job.error : t('historyDone') + ' · ' + (job.trades || 0) + t('tradesUnit') + ' / ' + (job.deals || 0) + t('dealsUnit'))
              break
            }
          }
          await loadTrades()
          const reply = await call('/notes?limit=20')
          setNotes(reply.notes || [])
          refresh()
        } catch (cause) {
          setHistoryStatus(String(cause && cause.message ? cause.message : cause))
        }
      }

      const close = () => setDeskOpen(false)

      return h('div', {
        style: {
          position: 'fixed', inset: 0, zIndex: OVERLAY_Z, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.45)', padding: 20,
        },
        onMouseDown: (event) => { if (event.target === event.currentTarget) close() },
      },
        h('div', {
          style: {
            width: 'min(1180px, 96vw)', height: 'min(860px, 90vh)', display: 'flex', flexDirection: 'column',
            background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 14, overflow: 'hidden', boxShadow: '0 18px 60px rgba(0,0,0,0.35)',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
            h('div', { style: { fontSize: 14, fontWeight: 600 } }, t('deskTitle')),
            h(Badge, { tone: phaseInfo[1] }, phaseInfo[0]),
            identity ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
              identity.account_id + (identity.server ? ' @ ' + identity.server : '') + ' · ' + (identity.demo ? t('demo') : t('real'))) : null,
            h('div', { style: { flex: 1 } }),
            ['1m', '5m', '15m', '30m', '1h', '4h', '1d'].map((value) => h('button', {
              key: value, onClick: () => setTf(value),
              style: {
                ...buttonStyle, padding: '2px 8px', fontSize: 11,
                background: tf === value ? 'var(--dsw-alias-brand-primary)' : 'transparent',
                color: tf === value ? '#fff' : 'var(--dsw-alias-label-secondary)',
                borderColor: 'transparent',
              },
            }, value)),
            h('button', { onClick: close, style: { ...buttonStyle, padding: '2px 8px' } }, t('closeDesk'))),

          h('div', { style: { flex: 1, display: 'flex', minHeight: 0 } },
            h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, padding: 10, gap: 6 } },
              h(Chart, { bars }),
              h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', display: 'flex', gap: 12 } },
                h('span', null, t('bars') + ' ' + bars.length),
                h('span', null, t('tick') + ' ' + (ea.tick ? ea.tick.bid + ' / ' + ea.tick.ask : '—')))),
            h('div', { style: { width: 320, borderLeft: '1px solid var(--dsw-alias-border-l1)', padding: 12, display: 'grid', gap: 10, alignContent: 'start', overflowY: 'auto' } },
              error ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
              account ? h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
                [['balance', t('balance')], ['equity', t('equity')], ['free_margin', t('freeMargin')], ['profit', t('profit')]]
                  .map(([key, label]) => h('div', { key, style: { padding: '6px 8px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)' } },
                    h('div', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } }, label),
                    h('div', { style: { fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums' } }, formatMoney(account[key], account.currency))))) : null,

              h('div', { style: { fontSize: 12, fontWeight: 600 } }, t('positions') + (positions.length ? ' · ' + positions.length : '')),
              positions.length ? h('div', { style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, overflow: 'hidden' } },
                h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 11 } },
                  h('tbody', null, positions.map((position) => h('tr', { key: position.ticket },
                    h('td', { style: cell }, position.symbol + ' ' + position.side + ' ' + position.volume),
                    h('td', { style: { ...cell, color: Number(position.profit) >= 0 ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)', textAlign: 'right' } }, Number(position.profit || 0).toFixed(2)),
                    h('td', { style: { ...cell, textAlign: 'right' } },
                      h('button', {
                        onClick: () => closePosition(position),
                        style: { ...buttonStyle, padding: '1px 6px', fontSize: 10, background: closing.ticket === position.ticket ? 'var(--dsw-alias-state-warn-primary)' : 'transparent' },
                      }, closing.ticket === position.ticket ? t('confirmClose') : t('closePosition'))))))))
                : h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, t('noPositions')),

              notice ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)' } }, notice) : null,

              h(Ticket, { t, identity, tick: ea.tick, onDone: refresh }),

              h('div', { style: { display: 'grid', gap: 6, padding: 10, borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)' } },
                h('div', { style: { fontSize: 12, fontWeight: 600 } }, t('shareCard')),
                h('select', { value: shareTo, onChange: (event) => setShareTo(event.target.value), style: inputStyle },
                  h('option', { value: '' }, t('pickShare')),
                  contacts.map((contact) => h('option', { key: contact.code, value: contact.code }, contact.alias || contact.code))),
                h('input', { value: shareNote, onChange: (event) => setShareNote(event.target.value), placeholder: t('shareNote'), style: inputStyle }),
                h('button', { type: 'button', onClick: share, disabled: !contacts.length, style: { ...buttonStyle, opacity: contacts.length ? 1 : 0.5 } }, t('shareAction')),
                shareStatus ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, shareStatus) : null),

              h('div', { style: { display: 'grid', gap: 6, padding: 10, borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)' } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                  h('div', { style: { flex: 1, fontSize: 12, fontWeight: 600 } }, t('history')),
                  h('button', {
                    type: 'button', onClick: syncHistory, disabled: !identity,
                    style: { ...buttonStyle, padding: '1px 6px', fontSize: 10, opacity: identity ? 1 : 0.5 },
                  }, t('syncHistory'))),
                trades.length ? h('div', { style: { display: 'grid', gap: 3 } },
                  trades.slice(0, 6).map((trade) => h('button', {
                    key: trade.ticket, type: 'button',
                    onClick: () => { setNoteTicket(trade.ticket); setNoteStatus('') },
                    style: { ...buttonStyle, display: 'flex', justifyContent: 'space-between', gap: 6, padding: '2px 6px', fontSize: 10, textAlign: 'left' },
                  },
                    h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      '#' + trade.ticket + ' ' + trade.symbol + ' ' + (trade.side === 'buy' ? t('buy') : t('sell')) + ' ' + trade.volume),
                    h('span', { style: { color: Number(trade.profit) >= 0 ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)', fontVariantNumeric: 'tabular-nums' } },
                      Number(trade.profit || 0).toFixed(2)))))
                  : h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, t('noTrades')),
                historyStatus ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, historyStatus) : null),

              h('div', { style: { display: 'grid', gap: 6, padding: 10, borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)' } },
                h('div', { style: { fontSize: 12, fontWeight: 600 } }, t('notes')),
                h('div', { style: { display: 'grid', gap: 3 } },
                  notes.slice(0, 4).map((note) => h('button', {
                    key: note.id, type: 'button',
                    onClick: () => { setNoteBody(note.body); setNoteTicket(note.ticket || ''); setNoteStatus('') },
                    style: { ...buttonStyle, fontSize: 10, textAlign: 'left', padding: '2px 6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                  }, noteLabel(note) + String(note.body).slice(0, 40)))),
                h('input', { value: noteTicket, onChange: (event) => setNoteTicket(event.target.value), placeholder: t('noteTicket'), style: inputStyle }),
                h('textarea', {
                  value: noteBody, onChange: (event) => setNoteBody(event.target.value), placeholder: t('notePlaceholder'), rows: 3,
                  style: { ...inputStyle, resize: 'vertical', fontFamily: 'inherit' },
                }),
                h('button', { type: 'button', onClick: saveNote, style: buttonStyle }, t('saveNote')),
                noteStatus ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, noteStatus) : null))))
      )
    }

    function DockStrip({ t }) {
      const open = useDeskOpen()
      const { state } = useLocalState(4000)
      const ea = (state && state.ea) || {}
      const phase = ea.phase || 'disconnected'
      const phaseInfo = PHASES[phase] || PHASES.disconnected
      const index = ea.identity ? ea.identity.account_id + ' · ' + (ea.identity.demo ? t('demo') : t('real')) : t('localOnly')
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '3px 4px', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
        h('span', { style: { width: 6, height: 6, borderRadius: 999, background: toneColor(phaseInfo[1]) } }),
        h('span', null, t('deskTitle')),
        h('span', null, phaseInfo[0]),
        h('span', null, index),
        h('div', { style: { flex: 1 } }),
        h('button', { type: 'button', onClick: () => setChatOpen(true), style: { ...buttonStyle, padding: '2px 10px', fontSize: 11 } }, t('openChat')),
        h('button', { type: 'button', onClick: () => setDeskOpen(!open), style: { ...buttonStyle, padding: '2px 10px', fontSize: 11 } }, open ? t('closeDesk') : t('openDesk')))
    }

    function DeskGate({ t }) {
      return h(Desk, { t })
    }

    // ---- 设置页 ----
    function Panel({ t, close }) {
      const { state, error } = useLocalState(2000)
      const [code, setCode] = useState('')
      const [busy, setBusy] = useState(false)
      const [pairError, setPairError] = useState('')

      const ea = (state && state.ea) || {}
      const phase = ea.phase || 'disconnected'
      const phaseInfo = PHASES[phase] || PHASES.disconnected
      const identity = ea.identity || null
      const account = ea.account || null
      const positions = ea.positions || []
      const counts = (state && state.counts) || {}
      const friend = state && state.identity ? state.identity : null

      const submit = async (event) => {
        event.preventDefault()
        setBusy(true)
        setPairError('')
        try {
          await call('/pair', { method: 'POST', body: JSON.stringify({ code: code.trim() }) })
          setCode('')
        } catch (cause) {
          setPairError(String(cause && cause.message ? cause.message : cause))
        } finally {
          setBusy(false)
        }
      }

      const children = []
      children.push(h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
        h('div', null,
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, t('title')),
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 2 } }, t('subtitle'))),
        h(Badge, { tone: phaseInfo[1] }, phaseInfo[0])))
      if (error) children.push(h('div', { key: 'error', style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, error))
      if (!state && !error) children.push(h('div', { key: 'loading', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('loading')))

      if (phase === 'pairing' || phase === 'confirming') {
        children.push(h('form', { key: 'pair', onSubmit: submit, style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('input', {
            value: code, onChange: (event) => setCode(event.target.value), inputMode: 'numeric', maxLength: 8,
            placeholder: t('codePlaceholder'), style: { ...inputStyle, width: 150, letterSpacing: 2 },
          }),
          h('button', { type: 'submit', disabled: busy, style: { ...buttonStyle, background: 'var(--dsw-alias-brand-primary)', color: '#fff', borderColor: 'transparent', opacity: busy ? 0.6 : 1 } }, busy ? t('pairing') : t('pair'))))
      }
      if (pairError) children.push(h('div', { key: 'pairError', style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, pairError))
      if (phase === 'pairing') children.push(h('div', { key: 'pairHint', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('pairHint')))
      if (phase === 'confirming') children.push(h('div', { key: 'confirmHint', style: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' } }, t('confirmHint')))

      if (identity) {
        children.push(h('div', { key: 'identity', style: { display: 'grid', gap: 4 } },
          h(Row, { label: t('account'), value: identity.account_id + (identity.server ? ' @ ' + identity.server : '') }),
          h(Row, { label: t('mode'), value: identity.demo ? t('demo') : t('real') }),
          h(Row, { label: t('readOnly'), value: identity.read_only ? t('readOnlyOn') : t('readOnlyOff') }),
          h(Row, { label: t('tradeEnabled'), value: identity.trade_enabled ? t('on') : t('off') }),
          Array.isArray(identity.capabilities) && identity.capabilities.length
            ? h(Row, { label: t('capabilities'), value: identity.capabilities.join(' · ') }) : null))
      }

      if (account) {
        const stats = [['balance', t('balance')], ['equity', t('equity')], ['margin', t('margin')], ['free_margin', t('freeMargin')], ['profit', t('profit')]]
        children.push(h('div', { key: 'account', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 } },
          stats.map(([key, label]) => h('div', {
            key,
            style: { padding: '10px 12px', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)' },
          },
            h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, label),
            h('div', { style: { fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums', marginTop: 2 } }, formatMoney(account[key], account.currency))))))
      }

      if (friend) {
        children.push(h('div', { key: 'friend', style: { display: 'grid', gap: 4 } },
          h(Row, { label: t('friendCode'), value: friend.friend_code })))
      }

      children.push(h('div', { key: 'openDesk', style: { display: 'flex', gap: 8 } },
        h('button', { type: 'button', onClick: () => { if (typeof close === 'function') close(); setDeskOpen(true) }, style: { ...buttonStyle, background: 'var(--dsw-alias-brand-primary)', color: '#fff', borderColor: 'transparent' } }, t('openDesk')),
        h('button', { type: 'button', onClick: () => { if (typeof close === 'function') close(); setChatOpen(true) }, style: buttonStyle }, t('openChat'))))

      children.push(h('div', { key: 'counts', style: { display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 4 } },
        h('span', null, t('storeTrades') + ' ' + (counts.trades || 0)),
        h('span', null, t('storeBars') + ' ' + (counts.bars || 0)),
        h('span', null, t('storeNotes') + ' ' + (counts.notes || 0)),
        h('span', null, t('storeCommands') + ' ' + (counts.commands || 0))))

      children.push(h('div', { key: 'footer', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 10 } }, t('footer')))

      return h('div', { style: { display: 'grid', gap: 16, padding: '4px 2px 24px', color: 'var(--dsw-alias-label-primary)' } }, children)
    }

    function MiniChart({ bars }) {
      const ref = useRef(null)
      useEffect(() => {
        const canvas = ref.current
        if (!canvas || !Array.isArray(bars) || bars.length < 2) return
        const dpr = window.devicePixelRatio || 1
        const rect = canvas.getBoundingClientRect()
        canvas.width = Math.max(1, Math.round(rect.width * dpr))
        canvas.height = Math.max(1, Math.round(rect.height * dpr))
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, rect.width, rect.height)
        let min = Infinity
        let max = -Infinity
        for (const bar of bars) {
          if (bar[3] < min) min = bar[3]
          if (bar[2] > max) max = bar[2]
        }
        const span = Math.max(1e-9, max - min)
        const xOf = (index) => (index / (bars.length - 1)) * (rect.width - 2) + 1
        const yOf = (price) => rect.height - 2 - ((price - min) / span) * (rect.height - 4)
        ctx.strokeStyle = 'rgba(120,170,255,0.9)'
        ctx.lineWidth = 1.2
        ctx.beginPath()
        bars.forEach((bar, index) => {
          const x = xOf(index)
          const y = yOf(bar[4])
          if (index === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        })
        ctx.stroke()
      }, [bars])
      return h('canvas', { ref, style: { width: '100%', height: 56, display: 'block', marginTop: 6 } })
    }

    function CardView({ card }) {
      if (!card) return null
      return h('div', { style: { marginTop: 6, padding: 8, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)' } },
        h('div', { style: { fontSize: 12, fontWeight: 600 } }, String(card.symbol || '') + (card.tf ? ' · ' + card.tf : '')),
        Array.isArray(card.bars) && card.bars.length > 1 ? h(MiniChart, { bars: card.bars }) : null,
        card.note ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 2, whiteSpace: 'pre-wrap' } }, String(card.note)) : null)
    }

    function Chat({ t }) {
      const open = useChatOpen()
      const { state } = useLocalState(4000)
      const [im, setIm] = useState(null)
      const [contacts, setContacts] = useState([])
      const [peer, setPeer] = useState('')
      const [messages, setMessages] = useState([])
      const [text, setText] = useState('')
      const [code, setCode] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [copied, setCopied] = useState(false)

      const identity = state && state.identity ? state.identity : null

      const load = useCallback(async () => {
        try {
          const reply = await call('/im')
          setIm(reply.im || null)
          setContacts(reply.contacts || [])
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        }
      }, [])

      const loadThread = useCallback(async (who) => {
        if (!who) { setMessages([]); return }
        try {
          const reply = await call('/im/messages?peer=' + encodeURIComponent(who))
          setMessages(reply.messages || [])
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        }
      }, [])

      useEffect(() => {
        if (!open) return undefined
        load()
        loadThread(peer)
        const timer = setInterval(async () => {
          try { await call('/im/sync', { method: 'POST', body: '{}' }) } catch {}
          load()
          loadThread(peer)
        }, 4000)
        return () => clearInterval(timer)
      }, [open, peer, load, loadThread])

      if (!open) return null

      const addContact = async (event) => {
        event.preventDefault()
        if (!code.trim()) return
        setBusy(true)
        setError('')
        try {
          const reply = await call('/im/contact', { method: 'POST', body: JSON.stringify({ code: code.trim() }) })
          setCode('')
          await load()
          if (reply.contact) setPeer(reply.contact.code)
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        } finally {
          setBusy(false)
        }
      }

      const send = async (event) => {
        event.preventDefault()
        if (!peer || !text.trim()) return
        setBusy(true)
        setError('')
        try {
          await call('/im/send', { method: 'POST', body: JSON.stringify({ to: peer, kind: 'text', text: text.trim() }) })
          setText('')
          await loadThread(peer)
          await load()
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        } finally {
          setBusy(false)
        }
      }

      const copyCode = async () => {
        if (!identity) return
        try {
          await navigator.clipboard.writeText(identity.friend_code)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {}
      }

      const relayState = im ? (im.phase === 'ready' ? t('relayReady') : im.phase === 'disabled' ? t('relayDisabled') : (im.error || t('relayError'))) : t('loading')

      const contactRows = contacts.map((contact) => h('button', {
        key: contact.code,
        type: 'button',
        onClick: () => setPeer(contact.code),
        style: {
          display: 'block', width: '100%', textAlign: 'left', padding: '7px 9px', borderRadius: 8,
          border: '1px solid ' + (peer === contact.code ? 'var(--dsw-alias-brand-primary)' : 'transparent'),
          background: peer === contact.code ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontSize: 12,
        },
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
          h('span', null, contact.alias || contact.code),
          contact.unread ? h('span', { style: { color: 'var(--dsw-alias-brand-primary)' } }, String(contact.unread)) : null),
        h('div', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)', marginTop: 2 } }, contact.code)))

      const bubbles = messages.map((message) => {
        const outgoing = message.direction === 'out'
        return h('div', { key: message.id, style: { display: 'flex', justifyContent: outgoing ? 'flex-end' : 'flex-start' } },
          h('div', {
            style: {
              maxWidth: '76%', padding: '7px 10px', borderRadius: 10, fontSize: 12, lineHeight: 1.5,
              background: outgoing ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-1)',
              color: outgoing ? '#fff' : 'var(--dsw-alias-label-primary)',
              border: outgoing ? '1px solid transparent' : '1px solid var(--dsw-alias-border-l1)',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            },
          },
            message.body,
            message.kind === 'card' ? h(CardView, { card: message.data }) : null,
            h('div', { style: { fontSize: 9, opacity: 0.7, marginTop: 4, textAlign: 'right' } }, new Date(message.created).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))))
      })

      const body = h('div', { style: { flex: 1, display: 'flex', minHeight: 0 } },
        h('div', { style: { width: 250, borderRight: '1px solid var(--dsw-alias-border-l1)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 } },
          h('form', { onSubmit: addContact, style: { display: 'grid', gap: 6 } },
            h('input', { value: code, onChange: (event) => setCode(event.target.value), placeholder: t('addContact'), style: inputStyle }),
            h('button', { type: 'submit', disabled: busy, style: { ...buttonStyle, fontSize: 12 } }, t('addContactAction'))),
          h('div', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } }, t('friendCodeHint')),
          h('div', { style: { flex: 1, overflowY: 'auto', display: 'grid', gap: 2, alignContent: 'start' } },
            contactRows.length ? contactRows : h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, t('noContacts')))),
        h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 } },
          h('div', { style: { flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 } },
            bubbles.length ? bubbles : h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, peer ? t('noMessages') : t('pickContact'))),
          h('form', { onSubmit: send, style: { display: 'flex', gap: 8, padding: 10, borderTop: '1px solid var(--dsw-alias-border-l1)' } },
            h('input', { value: text, onChange: (event) => setText(event.target.value), placeholder: t('inputPlaceholder'), disabled: !peer, style: { ...inputStyle, flex: 1 } }),
            h('button', { type: 'submit', disabled: busy || !peer || !text.trim(), style: { ...buttonStyle, opacity: busy || !peer || !text.trim() ? 0.5 : 1 } }, t('send')))))

      return h('div', {
        style: { position: 'fixed', inset: 0, zIndex: OVERLAY_Z, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)', padding: 20 },
        onMouseDown: (event) => { if (event.target === event.currentTarget) setChatOpen(false) },
      },
        h('div', { style: { width: 'min(960px, 96vw)', height: 'min(680px, 88vh)', display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 14, overflow: 'hidden', boxShadow: '0 18px 60px rgba(0,0,0,0.35)' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flexWrap: 'wrap' } },
            h('div', { style: { fontSize: 14, fontWeight: 600 } }, t('chatTitle')),
            h(Badge, { tone: im && im.phase === 'ready' ? 'success' : im && im.phase === 'error' ? 'error' : 'idle' }, relayState),
            h('div', { style: { flex: 1 } }),
            identity ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, t('myCode') + ' ' + identity.friend_code) : null,
            identity ? h('button', { type: 'button', onClick: copyCode, style: { ...buttonStyle, padding: '2px 8px', fontSize: 11 } }, copied ? t('copied') : t('copy')) : null,
            h('button', { type: 'button', onClick: () => setChatOpen(false), style: { ...buttonStyle, padding: '2px 8px', fontSize: 11 } }, t('closeChat'))),
          error ? h('div', { style: { padding: '6px 14px', fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
          body))
    }

    const ZH = {
      title: '同频 · 本机交易台',
      subtitle: '本机 EA 直连，数据留在本机',
      deskTitle: '同频交易台',
      loading: '正在读取本机状态…',
      codePlaceholder: '8 位配对码',
      pair: '配对',
      pairing: '提交中…',
      pairHint: '在 MT5 的 EA 图表上读取 8 位配对码，120 秒内有效。',
      confirmHint: '请在 MT5 图表上核对来源与账户，点击「允许本次连接」。',
      account: '账户',
      mode: '账户类型',
      demo: '模拟',
      real: '实盘',
      readOnly: '只读',
      readOnlyOn: '是',
      readOnlyOff: '否',
      tradeEnabled: '允许交易',
      capabilities: '可用动作',
      on: '开',
      off: '关',
      balance: '余额',
      equity: '净值',
      margin: '保证金',
      freeMargin: '可用保证金',
      profit: '浮动盈亏',
      positions: '持仓',
      ticket: '单号',
      symbol: '品种',
      side: '方向',
      volume: '手数',
      noPositions: '当前没有持仓。',
      storeTrades: '本地成交',
      storeBars: '本地K线',
      storeNotes: '笔记',
      storeCommands: '指令',
      footer: '成交、K 线与笔记只写入本机数据库；本插件不上传任何数据。下单命令只在你在交易台确认后发送一次，超时视为未确认且不会自动重发。',
      openDesk: '打开交易台',
      closeDesk: '关闭',
      localOnly: '本机',
      price: '价格',
      buy: '买入',
      sell: '卖出',
      stopLoss: '止损',
      takeProfit: '止盈',
      submit: '下单',
      confirmSubmit: '确认下单',
      submitting: '发送中…',
      cancel: '取消',
      result: '结果',
      tradeDisabled: 'EA 未开启交易或未授权市价单，下单已禁用。',
      closePosition: '平仓',
      confirmClose: '确认平仓',
      bars: 'K线',
      tick: '买价/卖价',
      friendCode: '好友码',
      chatTitle: '同频消息',
      openChat: '消息',
      closeChat: '关闭',
      myCode: '我的好友码',
      copy: '复制',
      copied: '已复制',
      addContact: '对方好友码',
      addContactAction: '添加好友',
      friendCodeHint: '交换好友码即可聊天，无需注册；消息端到端加密。',
      noContacts: '还没有联系人。',
      pickContact: '在左侧选择联系人，或添加好友码。',
      noMessages: '还没有消息。',
      inputPlaceholder: '输入消息…',
      send: '发送',
      relayReady: '中继已连接',
      relayDisabled: '未配置中继',
      relayError: '中继异常',
      shareCard: '分享复盘卡片',
      shareNote: '附言（可选）',
      pickShare: '选择好友…',
      shareAction: '发送卡片',
      shared: '卡片已发送',
      noBars: '还没有 K 线，先等行情。',
      notes: '复盘笔记',
      noteTicket: '关联单号（可选）',
      notePlaceholder: '这单当时的判断、情绪、执行…',
      saveNote: '保存笔记',
      noteSaved: '已保存到本机',
      history: '成交历史',
      syncHistory: '同步历史',
      syncingHistory: '同步中…',
      historyDone: '已同步',
      tradesUnit: ' 笔',
      dealsUnit: ' 条成交',
      noTrades: '还没有本地成交；连上 EA 后点「同步历史」。',
    }

    const EN = {
      title: 'Tongpin · local desk',
      subtitle: 'Direct EA connection, data stays on this machine',
      deskTitle: 'Tongpin desk',
      loading: 'Reading local state…',
      codePlaceholder: '8-digit code',
      pair: 'Pair',
      pairing: 'Submitting…',
      pairHint: 'Read the 8-digit code on the MT5 EA chart; it expires in 120 seconds.',
      confirmHint: 'Confirm the origin and account on the MT5 chart, then click Allow.',
      account: 'Account',
      mode: 'Mode',
      demo: 'Demo',
      real: 'Live',
      readOnly: 'Read-only',
      readOnlyOn: 'Yes',
      readOnlyOff: 'No',
      tradeEnabled: 'Trading',
      capabilities: 'Actions',
      on: 'On',
      off: 'Off',
      balance: 'Balance',
      equity: 'Equity',
      margin: 'Margin',
      freeMargin: 'Free margin',
      profit: 'Floating P/L',
      positions: 'Positions',
      ticket: 'Ticket',
      symbol: 'Symbol',
      side: 'Side',
      volume: 'Volume',
      noPositions: 'No open positions.',
      storeTrades: 'Local trades',
      storeBars: 'Local bars',
      storeNotes: 'Notes',
      storeCommands: 'Orders',
      footer: 'Trades, bars and notes are stored only in the local database. An order is sent once after you confirm it in the desk; a timeout is reported as unconfirmed and is never retried automatically.',
      openDesk: 'Open desk',
      closeDesk: 'Close',
      localOnly: 'Local',
      price: 'Price',
      buy: 'Buy',
      sell: 'Sell',
      stopLoss: 'Stop loss',
      takeProfit: 'Take profit',
      submit: 'Place order',
      confirmSubmit: 'Confirm order',
      submitting: 'Sending…',
      cancel: 'Cancel',
      result: 'Result',
      tradeDisabled: 'Trading is off or market orders are not authorized; ordering is disabled.',
      closePosition: 'Close',
      confirmClose: 'Confirm',
      bars: 'Bars',
      tick: 'Bid / Ask',
      friendCode: 'Friend code',
      chatTitle: 'Tongpin messages',
      openChat: 'Messages',
      closeChat: 'Close',
      myCode: 'My code',
      copy: 'Copy',
      copied: 'Copied',
      addContact: 'Friend code',
      addContactAction: 'Add friend',
      friendCodeHint: 'Exchange friend codes to chat; no sign-up, end-to-end encrypted.',
      noContacts: 'No contacts yet.',
      pickContact: 'Pick a contact on the left, or add a friend code.',
      noMessages: 'No messages yet.',
      inputPlaceholder: 'Write a message…',
      send: 'Send',
      relayReady: 'Relay connected',
      relayDisabled: 'Relay not configured',
      relayError: 'Relay error',
      shareCard: 'Share review card',
      shareNote: 'Note (optional)',
      pickShare: 'Pick a friend…',
      shareAction: 'Send card',
      shared: 'Card sent',
      noBars: 'No bars yet; wait for quotes.',
      notes: 'Review notes',
      noteTicket: 'Ticket (optional)',
      notePlaceholder: 'Your read, emotion and execution at that moment…',
      saveNote: 'Save note',
      noteSaved: 'Saved locally',
      history: 'Trade history',
      syncHistory: 'Sync history',
      syncingHistory: 'Syncing…',
      historyDone: 'Synced',
      tradesUnit: ' trades',
      dealsUnit: ' deals',
      noTrades: 'No local trades yet; connect the EA and press Sync history.',
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.locale.register('dshtrade', { zh: ZH, en: EN })
        const t = ctx.locale.bind('dshtrade')

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dshtrade',
          label: () => t('title'),
          order: 60,
        }, (owner) => h(Panel, { t, close: owner && owner.close })))

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'dshtrade-entry',
          order: 5,
        }, () => h(DockStrip, { t })))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dshtrade-desk',
          order: 100,
        }, () => h(DeskGate, { t })))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dshtrade-chat',
          order: 101,
        }, () => h(Chat, { t })))
      },
    }
  },
})
