/**
 * 同频客户端插件（浏览器半边）。
 *
 * 只和 DSH 自己的地址通信：/dshtrade/api/*。不连云端，不读 Cookie。
 * 第一版：设置里的「同频」页显示 EA 连接、账户、持仓与本地库计数。
 */
window.__ModuleLoader__.load({
  id: '@local/dshtrade',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

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

    const cell = { padding: '6px 10px', borderBottom: '1px solid var(--dsw-alias-border-l1)', whiteSpace: 'nowrap' }

    function formatMoney(value, currency) {
      const number = Number(value)
      if (!Number.isFinite(number)) return '—'
      return number.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (currency ? ' ' + currency : '')
    }

    function PositionTable({ t, positions }) {
      const head = ['ticket', 'symbol', 'side', 'volume', 'profit'].map((key) =>
        h('th', { key, style: { textAlign: 'left', padding: '6px 10px', color: 'var(--dsw-alias-label-secondary)', fontWeight: 500, borderBottom: '1px solid var(--dsw-alias-border-l1)' } }, t(key)))
      const rows = positions.map((position) => {
        const profit = Number(position.profit || 0)
        return h('tr', { key: position.ticket },
          h('td', { style: cell }, position.ticket),
          h('td', { style: cell }, position.symbol),
          h('td', { style: { ...cell, color: position.side === 'buy' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' } }, position.side),
          h('td', { style: { ...cell, fontVariantNumeric: 'tabular-nums' } }, position.volume),
          h('td', { style: { ...cell, fontVariantNumeric: 'tabular-nums', color: profit >= 0 ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' } }, profit.toFixed(2)))
      })
      return h('div', { style: { overflowX: 'auto', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10 } },
        h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12 } },
          h('thead', null, h('tr', null, head)),
          h('tbody', null, rows)))
    }

    function Panel({ t }) {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [code, setCode] = useState('')
      const [busy, setBusy] = useState(false)

      const refresh = useCallback(async () => {
        try {
          const next = await call('/state')
          setState(next)
          setError('')
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        }
      }, [])

      useEffect(() => {
        refresh()
        const timer = setInterval(refresh, 2000)
        return () => clearInterval(timer)
      }, [refresh])

      const ea = (state && state.ea) || {}
      const phase = ea.phase || 'disconnected'
      const phaseInfo = PHASES[phase] || PHASES.disconnected
      const identity = ea.identity || null
      const account = ea.account || null
      const positions = ea.positions || []
      const counts = (state && state.counts) || {}

      const submit = async (event) => {
        event.preventDefault()
        setBusy(true)
        setError('')
        try {
          await call('/pair', { method: 'POST', body: JSON.stringify({ code: code.trim() }) })
          setCode('')
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
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
            placeholder: t('codePlaceholder'),
            style: {
              width: 140, padding: '6px 10px', borderRadius: 8, fontSize: 14, letterSpacing: 2,
              background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
              border: '1px solid var(--dsw-alias-border-l2)',
            },
          }),
          h('button', {
            type: 'submit', disabled: busy,
            style: {
              padding: '6px 14px', borderRadius: 8, fontSize: 13, cursor: busy ? 'default' : 'pointer',
              background: 'var(--dsw-alias-brand-primary)', color: '#fff', border: 'none', opacity: busy ? 0.6 : 1,
            },
          }, busy ? t('pairing') : t('pair'))))
      }
      if (phase === 'pairing') children.push(h('div', { key: 'pairHint', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('pairHint')))
      if (phase === 'confirming') children.push(h('div', { key: 'confirmHint', style: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' } }, t('confirmHint')))

      if (identity) {
        const rows = [
          h(Row, { key: 'account', label: t('account'), value: identity.account_id + (identity.server ? ' @ ' + identity.server : '') }),
          h(Row, { key: 'mode', label: t('mode'), value: identity.demo ? t('demo') : t('real') }),
          h(Row, { key: 'readOnly', label: t('readOnly'), value: identity.read_only ? t('readOnlyOn') : t('readOnlyOff') }),
          h(Row, { key: 'tradeEnabled', label: t('tradeEnabled'), value: identity.trade_enabled ? t('on') : t('off') }),
        ]
        if (Array.isArray(identity.capabilities) && identity.capabilities.length) {
          rows.push(h(Row, { key: 'capabilities', label: t('capabilities'), value: identity.capabilities.join(' · ') }))
        }
        children.push(h('div', { key: 'identity', style: { display: 'grid', gap: 4 } }, rows))
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

      children.push(h('div', { key: 'positionsTitle', style: { fontSize: 13, fontWeight: 600, marginTop: 4 } }, t('positions') + (positions.length ? ' · ' + positions.length : '')))
      children.push(positions.length
        ? h(PositionTable, { key: 'positions', t, positions })
        : h('div', { key: 'noPositions', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('noPositions')))

      children.push(h('div', { key: 'counts', style: { display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 4 } },
        h('span', null, t('storeTrades') + ' ' + (counts.trades || 0)),
        h('span', null, t('storeBars') + ' ' + (counts.bars || 0)),
        h('span', null, t('storeNotes') + ' ' + (counts.notes || 0))))

      children.push(h('div', { key: 'footer', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6, borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 10 } }, t('footer')))

      return h('div', { style: { display: 'grid', gap: 16, padding: '4px 2px 24px', color: 'var(--dsw-alias-label-primary)' } }, children)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.locale.register('dshtrade', {
          zh: {
            title: '同频 · 本机交易台',
            subtitle: '本机 EA 直连，数据留在本机',
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
            footer: '成交、K 线与笔记只写入本机数据库；本插件不上传任何数据，也不代下单。',
          },
          en: {
            title: 'Tongpin · local desk',
            subtitle: 'Direct EA connection, data stays on this machine',
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
            footer: 'Trades, bars and notes are stored in the local database only. This plugin uploads nothing and never places orders for you.',
          },
        })
        const t = ctx.locale.bind('dshtrade')
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dshtrade',
          label: () => t('title'),
          order: 60,
        }, () => h(Panel, { t })))
      },
    }
  },
})
