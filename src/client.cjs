// Client half of dsh-cost-ledger: the 成本账 Tab in the conversation view.
//
// Must stay CommonJS — the build wraps this in window.__ModuleLoader__.load()
// and React is supplied by the harness. Data is read-only from the host route;
// the only write is a user-entered platform bill amount.

const React = require('react')
const h = React.createElement
const CSS = require('./client-css.cjs')

const API = '/dsh-cost-ledger'
const POLL_MS = 1500
const SCOPES = [
  ['hour', '按小时'],
  ['day', '按日'],
  ['session', '按会话'],
]

let snap = { data: null, error: '', at: 0 }
const listeners = new Set()
let timer = null

function emit() {
  Array.from(listeners).forEach(function (fn) {
    try {
      fn(snap)
    } catch (error) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-cost-ledger] listener failed', error)
    }
  })
}

function load() {
  fetch(API + '/state', { headers: { accept: 'application/json' } })
    .then(function (res) { return res.json() })
    .then(function (data) {
      snap = { data: data, error: '', at: Date.now() }
      emit()
    })
    .catch(function (error) {
      snap = { data: snap.data, error: String((error && error.message) || error), at: Date.now() }
      emit()
    })
}

function subscribe(fn) {
  listeners.add(fn)
  if (timer === null) {
    load()
    timer = setInterval(load, POLL_MS)
  }
  fn(snap)
  return function () {
    listeners.delete(fn)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

function post(path, body) {
  return fetch(API + '/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(function (res) { return res.json() }).then(function (data) {
    load()
    return data
  })
}

function fmtInt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0'
  return value.toLocaleString('zh-CN')
}

function fmtCny(value) {
  if (value === null || value === undefined || value === '') return '—'
  const text = String(value)
  return text.charAt(0) === '-' ? '-¥' + text.slice(1) : '¥' + text
}

function fmtPct(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return (value > 0 ? '+' : '') + value.toFixed(2) + '%'
}

function shortKey(key, session) {
  if (typeof key !== 'string') return '—'
  if (session) {
    const parts = key.split('-')
    return parts.length > 2 ? parts[0] + '…' + parts.slice(-1)[0] : key
  }
  return key.replace('T', ' ')
}

function clock(ms) {
  if (typeof ms !== 'number') return '—'
  const d = new Date(ms)
  const pad = function (n) { return n < 10 ? '0' + n : String(n) }
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}

function Stat(props) {
  return h('div', { className: 'cd-stat' + (props.tone ? ' ' + props.tone : '') },
    h('b', null, props.value),
    h('span', null, props.label),
  )
}

function ScopeTabs(props) {
  return h('div', { className: 'cd-tabs' }, SCOPES.map(function (pair) {
    return h('button', {
      key: pair[0],
      type: 'button',
      className: 'cd-tab' + (props.scope === pair[0] ? ' cd-on' : ''),
      onClick: function () { props.onChange(pair[0]) },
    }, pair[1])
  }))
}

function AggTable(props) {
  const rows = props.rows || []
  const scope = props.scope
  if (rows.length === 0) {
    return h('div', { className: 'cd-empty' }, '还没有记录。模型调用完成后，这里会按' + (scope === 'hour' ? '小时' : scope === 'day' ? '日' : '会话') + '汇总。')
  }
  return h('div', { className: 'cd-scroll' },
    h('table', { className: 'cd-table' },
      h('thead', null, h('tr', null,
        h('th', null, scope === 'session' ? '会话' : '时段'),
        h('th', { className: 'cd-num' }, '调用'),
        h('th', { className: 'cd-num' }, '输入'),
        h('th', { className: 'cd-num' }, '输出'),
        h('th', { className: 'cd-num' }, '缓存命中'),
        h('th', { className: 'cd-num' }, '估算'),
        h('th', { className: 'cd-num' }, '实际账单'),
        h('th', { className: 'cd-num' }, '差异'),
        h('th', null, ''),
      )),
      h('tbody', null, rows.map(function (row) {
        const diffTone = row.diffNano === null ? '' : row.diffNano > 0 ? 'cd-up' : row.diffNano < 0 ? 'cd-down' : ''
        return h('tr', { key: row.scope + '-' + row.key },
          h('td', { className: 'cd-mono' }, shortKey(row.key, scope === 'session')),
          h('td', { className: 'cd-num' }, fmtInt(row.calls)),
          h('td', { className: 'cd-num' }, fmtInt(row.inputTokens)),
          h('td', { className: 'cd-num' }, fmtInt(row.outputTokens)),
          h('td', { className: 'cd-num' }, fmtInt(row.cacheHitTokens)),
          h('td', { className: 'cd-num' }, fmtCny(row.estimatedCny)),
          h('td', { className: 'cd-num' }, fmtCny(row.actualCny)),
          h('td', { className: 'cd-num ' + diffTone }, row.diffCny === null ? '—' : fmtCny(row.diffCny) + ' (' + fmtPct(row.diffPct) + ')'),
          h('td', null, h('button', {
            type: 'button',
            className: 'cd-btn cd-mini',
            onClick: function () { props.onPick(row) },
          }, row.actualCny === null ? '填账单' : '改账单')),
        )
      })),
    ),
  )
}

function RecentTable(props) {
  const rows = props.rows || []
  if (rows.length === 0) return null
  return h('div', null,
    h('h4', { className: 'cd-h4' }, '最近调用（只存元数据，不存 prompt 正文）'),
    h('div', { className: 'cd-scroll' },
      h('table', { className: 'cd-table' },
        h('thead', null, h('tr', null,
          h('th', null, '时间'),
          h('th', null, '模型'),
          h('th', null, '会话'),
          h('th', { className: 'cd-num' }, '输入'),
          h('th', { className: 'cd-num' }, '输出'),
          h('th', { className: 'cd-num' }, '缓存命中'),
          h('th', { className: 'cd-num' }, '估算'),
          h('th', null, '用量来源'),
          h('th', null, '状态'),
        )),
        h('tbody', null, rows.map(function (row, index) {
          return h('tr', { key: row.id + '-' + index },
            h('td', { className: 'cd-mono' }, clock(row.at)),
            h('td', { className: 'cd-mono' }, row.model || '—'),
            h('td', { className: 'cd-mono' }, shortKey(row.session, true)),
            h('td', { className: 'cd-num' }, fmtInt(row.inputTokens)),
            h('td', { className: 'cd-num' }, fmtInt(row.outputTokens)),
            h('td', { className: 'cd-num' }, fmtInt(row.cacheHitTokens)),
            h('td', { className: 'cd-num' }, fmtCny(row.costCny)),
            h('td', null, row.usageSource === 'adapter' ? h('span', { className: 'cd-badge cd-ok' }, 'adapter') : h('span', { className: 'cd-badge cd-warn' }, row.usageSource)),
            h('td', null, row.status === 'ok' ? h('span', { className: 'cd-badge cd-ok' }, 'ok') : h('span', { className: 'cd-badge cd-warn' }, row.status)),
          )
        })),
      ),
    ),
  )
}

function BillForm(props) {
  const form = props.form
  const set = props.set
  return h('div', { className: 'cd-card' },
    h('h4', null, '手填官方账单（只作为对照列，不覆盖本地估算）'),
    h('div', { className: 'cd-form' },
      h('label', null, '范围',
        h('select', {
          value: form.scope,
          onChange: function (event) { set({ scope: event.target.value, key: '', amountCny: '', note: '' }) },
        }, SCOPES.map(function (pair) { return h('option', { key: pair[0], value: pair[0] }, pair[1]) })),
      ),
      h('label', null, '时段 / 会话',
        h('input', {
          value: form.key,
          placeholder: form.scope === 'hour' ? '2026-10-19T14' : form.scope === 'day' ? '2026-10-19' : 'session-…',
          onChange: function (event) { set({ key: event.target.value }) },
        }),
      ),
      h('label', null, '官方金额 CNY',
        h('input', {
          value: form.amountCny,
          placeholder: '例如 12.34',
          inputMode: 'decimal',
          onChange: function (event) { set({ amountCny: event.target.value }) },
        }),
      ),
      h('label', { className: 'cd-wide' }, '备注（可选）',
        h('input', {
          value: form.note,
          placeholder: '账单截图 / 平台页面 / 日期',
          onChange: function (event) { set({ note: event.target.value }) },
        }),
      ),
      h('div', { className: 'cd-actions' },
        h('button', {
          type: 'button',
          className: 'cd-btn cd-primary',
          disabled: props.busy,
          onClick: props.onSave,
        }, props.busy ? '保存中…' : '保存账单'),
        h('button', {
          type: 'button',
          className: 'cd-btn',
          disabled: props.busy,
          onClick: props.onDelete,
        }, '删除该账单'),
        props.message ? h('span', { className: 'cd-msg' }, props.message) : null,
      ),
    ),
  )
}

function PriceCard(props) {
  const prices = props.prices || {}
  return h('div', { className: 'cd-card' },
    h('h4', null, '价目表来源'),
    h('div', { className: 'cd-kv' },
      h('span', null, '来源'), h('b', null, prices.source || '—'),
      h('span', null, '版本'), h('b', null, prices.version || '—'),
      h('span', null, '文件'), h('code', null, prices.path || '（内置表）'),
      h('span', null, 'provider'), h('b', null, (prices.providers || []).join(', ') || '—'),
      h('span', null, '模型条目'), h('b', null, String(prices.modelCount || 0)),
    ),
    prices.error ? h('div', { className: 'cd-warn-box' }, prices.error) : null,
    prices.source === 'builtin'
      ? h('div', { className: 'cd-hint' }, '内置表只对 DeepSeek 官方 provider 生效。TokenRouter / OpenCodex 等中转 provider 默认未定价，请在 ' + (prices.path || 'cost-ledger-prices.json') + ' 里显式写 provider → model 价格。')
      : null,
  )
}

function LedgerView() {
  const [state, setState] = React.useState(snap)
  React.useEffect(function () { return subscribe(setState) }, [])
  const [scope, setScope] = React.useState('day')
  const [detail, setDetail] = React.useState(false)
  const [preview, setPreview] = React.useState('')
  const [previewBusy, setPreviewBusy] = React.useState(false)
  const [form, setFormState] = React.useState({ scope: 'day', key: '', amountCny: '', note: '' })
  const [billBusy, setBillBusy] = React.useState(false)
  const [message, setMessage] = React.useState('')

  const data = state.data
  const totals = (data && data.totals) || {}
  const scopes = (data && data.scopes) || {}
  const scopeData = scopes[scope] || { rows: [], total: 0 }
  const rows = scopeData.rows || []
  const recent = (data && data.recent) || []
  const prices = (data && data.prices) || null
  const health = (data && data.health) || {}

  function setForm(patch) {
    setFormState(function (current) { return Object.assign({}, current, patch) })
  }

  React.useEffect(function () {
    if (form.key !== '' || rows.length === 0) return
    setForm({ key: rows[0].key, amountCny: rows[0].actualCny || '', note: rows[0].billNote || '' })
    // Deliberately only fills the form when it is still empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, scope])

  function pickBill(row) {
    setForm({ scope: row.scope, key: row.key, amountCny: row.actualCny || '', note: row.billNote || '' })
    setMessage('')
  }

  function saveBill() {
    setBillBusy(true)
    setMessage('')
    const body = { scope: form.scope, key: form.key.trim(), amountCny: form.amountCny.trim(), note: form.note.trim() }
    post('bill', body).then(function (res) {
      setBillBusy(false)
      if (res && res.ok) {
        setMessage('已保存')
        setForm({ amountCny: '', note: '', key: '' })
      } else {
        setMessage((res && res.error) || '保存失败')
      }
    }).catch(function (error) {
      setBillBusy(false)
      setMessage(String((error && error.message) || error))
    })
  }

  function deleteBill() {
    setBillBusy(true)
    setMessage('')
    post('bill', { scope: form.scope, key: form.key.trim(), amountCny: null }).then(function (res) {
      setBillBusy(false)
      setMessage(res && res.ok ? '已删除' : ((res && res.error) || '没有找到该账单'))
    }).catch(function (error) {
      setBillBusy(false)
      setMessage(String((error && error.message) || error))
    })
  }

  function runPreview() {
    setPreviewBusy(true)
    const url = API + '/export?dryRun=1&format=csv&scope=' + encodeURIComponent(scope) + (detail ? '&detail=1' : '')
    fetch(url, { headers: { accept: 'application/json' } })
      .then(function (res) { return res.json() })
      .then(function (res) { setPreview(res && res.preview ? res.preview : JSON.stringify(res, null, 2)); setPreviewBusy(false) })
      .catch(function (error) { setPreview(String((error && error.message) || error)); setPreviewBusy(false) })
  }

  const exportBase = API + '/export?scope=' + encodeURIComponent(scope) + (detail ? '&detail=1' : '')
  const live = typeof health.loadedRecords === 'number' && health.loadedRecords > 0

  return h('div', { className: 'cd-root' },
    h('div', { className: 'cd-head' },
      h('div', null,
        h('div', { className: 'cd-title' }, '成本账'),
        h('div', { className: 'cd-sub' }, '每一次模型调用的 token 与 CNY 记录；本地估算和手填平台账单分列，不混为一谈。'),
      ),
      h('div', { className: 'cd-live' + (live ? ' cd-live-on' : '') },
        h('span', { className: 'cd-dot' }),
        h('span', null, live ? '记录中' : '等待调用'),
      ),
      h('div', { className: 'cd-spacer' }),
      h('button', { type: 'button', className: 'cd-btn', onClick: function () { post('reload', {}) } }, '重载价目表'),
    ),
    state.error ? h('div', { className: 'cd-error' }, '与 host 通信失败：' + state.error) : null,
    health.billError ? h('div', { className: 'cd-warn-box' }, '账单文件读取失败：' + health.billError) : null,
    health.skippedRecords ? h('div', { className: 'cd-warn-box' }, '已跳过 ' + health.skippedRecords + ' 条损坏的账本记录。') : null,

    h('div', { className: 'cd-stats' },
      h(Stat, { label: '本地估算合计', value: fmtCny(totals.estimatedCny), tone: 'cd-good' }),
      h(Stat, { label: '日账单合计', value: fmtCny(totals.actualCny), tone: 'cd-accent' }),
      h(Stat, {
        label: '差异（实际-估算）',
        value: totals.diffCny === null || totals.diffCny === undefined ? '—' : fmtCny(totals.diffCny),
        tone: totals.diffNano > 0 ? 'cd-bad' : totals.diffNano < 0 ? 'cd-good' : '',
      }),
      h(Stat, { label: '调用数', value: fmtInt(totals.calls) }),
      h(Stat, { label: '缓存命中 tokens', value: fmtInt(totals.cacheHitTokens) }),
      h(Stat, { label: '未定价调用', value: fmtInt(totals.unpricedCalls), tone: totals.unpricedCalls > 0 ? 'cd-warn' : '' }),
    ),

    h('div', { className: 'cd-toolbar' },
      h(ScopeTabs, { scope: scope, onChange: function (next) {
        setScope(next)
        setPreview('')
        setForm({ scope: next, key: '', amountCny: '', note: '' })
      } }),
      h('div', { className: 'cd-spacer' }),
      h('a', { className: 'cd-btn', href: exportBase + '&format=json', download: '' }, '导出 JSON'),
      h('a', { className: 'cd-btn', href: exportBase + '&format=csv', download: '' }, '导出 CSV'),
      h('button', { type: 'button', className: 'cd-btn', disabled: previewBusy, onClick: runPreview }, previewBusy ? '预览中…' : 'dry-run 预览'),
      h('label', { className: 'cd-check' },
        h('input', { type: 'checkbox', checked: detail, onChange: function (event) { setDetail(event.target.checked) } }),
        '导出明细',
      ),
    ),

    h(AggTable, { rows: rows, scope: scope, onPick: pickBill }),
    h('div', { className: 'cd-note' }, '差异 = 手填官方账单 − 本地估算；正数表示平台收得更多。没有手填账单的时段留空，不做猜测。'),

    preview ? h('pre', { className: 'cd-preview' }, preview) : null,

    h(BillForm, {
      form: form,
      set: setForm,
      busy: billBusy,
      message: message,
      onSave: saveBill,
      onDelete: deleteBill,
    }),

    h(RecentTable, { rows: recent.slice(0, 20) }),

    h(PriceCard, { prices: prices }),

    h('div', { className: 'cd-card cd-meta' },
      h('h4', null, '文件与口径'),
      h('div', null, '账本：', h('code', null, (data && data.files && data.files.ledgerPath) || '—')),
      h('div', null, '账单：', h('code', null, (data && data.files && data.files.billsPath) || '—')),
      h('div', null, '时区：', h('b', null, (data && data.timeZone) || 'Asia/Shanghai'), '；费用在调用时冻结，改价不回写历史。'),
      h('div', null, '调用数：', h('b', null, String((data && data.capture && data.capture.calls) || 0)), '；其中 usage 缺失时按官方字符比例估算，并标为 estimated。'),
    ),
  )
}

function apply(ctx) {
  ctx.effect(function () {
    return function () {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      listeners.clear()
      snap = { data: null, error: '', at: 0 }
    }
  })

  ctx.effect(function () {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-cost-ledger'
    style.textContent = CSS
    document.head.appendChild(style)
    return function () { style.remove() }
  })

  ctx.slots.inject('conversation.view', function () {
    let disposeView
    try {
      disposeView = ctx.slots.register(
        { name: 'conversation.view', id: 'cost-ledger', order: 35, label: '成本账' },
        LedgerView,
      )
    } catch (error) {
      disposeView = undefined
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[dsh-cost-ledger] could not register the 成本账 view; host capture still runs', error)
      }
    }
    return typeof disposeView === 'function' ? disposeView : function () {}
  })
}

module.exports = {
  name: 'dsh-cost-ledger',
  inject: ['slots'],
  apply: apply,
}
