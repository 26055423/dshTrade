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

    // ---- 交易台开关（跨两个插槽共享）----
    let deskOpen = false
    const deskListeners = new Set()
    function setDeskOpen(next) {
      deskOpen = next
      for (const fn of deskListeners) fn()
    }
    function useDeskOpen() {
      return useSyncExternalStore(
        (fn) => { deskListeners.add(fn); return () => deskListeners.delete(fn) },
        () => deskOpen,
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

      const close = () => setDeskOpen(false)

      return h('div', {
        style: {
          position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center',
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

              h(Ticket, { t, identity, tick: ea.tick, onDone: refresh }))))
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
        h('button', { type: 'button', onClick: () => setDeskOpen(!open), style: { ...buttonStyle, padding: '2px 10px', fontSize: 11 } }, open ? t('closeDesk') : t('openDesk')))
    }

    function DeskGate({ t }) {
      return h(Desk, { t })
    }

    // ---- 设置页 ----
    function Panel({ t }) {
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
        h('button', { type: 'button', onClick: () => setDeskOpen(true), style: { ...buttonStyle, background: 'var(--dsw-alias-brand-primary)', color: '#fff', borderColor: 'transparent' } }, t('openDesk'))))

      children.push(h('div', { key: 'counts', style: { display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 4 } },
        h('span', null, t('storeTrades') + ' ' + (counts.trades || 0)),
        h('span', null, t('storeBars') + ' ' + (counts.bars || 0)),
        h('span', null, t('storeNotes') + ' ' + (counts.notes || 0)),
        h('span', null, t('storeCommands') + ' ' + (counts.commands || 0))))

      children.push(h('div', { key: 'footer', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 10 } }, t('footer')))

      return h('div', { style: { display: 'grid', gap: 16, padding: '4px 2px 24px', color: 'var(--dsw-alias-label-primary)' } }, children)
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
        }, () => h(Panel, { t })))

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
      },
    }
  },
})
