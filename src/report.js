// Report building, CSV serialisation, and dry-run preview.
//
// The export deliberately contains both raw integer nano-CNY fields and
// formatted decimal strings. The integers are the machine-readable truth; the
// strings are for reading and for spreadsheet users.

import { aggregateRecords, formatNanoCny, joinBills, totalsOf } from './ledger.js'

export const REPORT_SCHEMA = 'dsh-cost-ledger/v1'

function isoAt(at) {
  return Number.isFinite(at) ? new Date(at).toISOString() : ''
}

function filterRecords(records, since, until) {
  return records.filter(function (record) {
    if (typeof since === 'number' && record.at < since) return false
    if (typeof until === 'number' && record.at > until) return false
    return true
  })
}

function billAt(bill) {
  if (bill.scope === 'hour') return Date.parse(bill.key + ':00:00+08:00')
  return Date.parse(bill.key + 'T00:00:00+08:00')
}

function filterBillsForTotals(bills, since, until) {
  return bills.filter(function (bill) {
    if (bill.scope !== 'day') return false
    const at = billAt(bill)
    if (!Number.isFinite(at)) return false
    if (typeof since === 'number' && at < since) return false
    if (typeof until === 'number' && at > until) return false
    return true
  })
}

function detailRow(record) {
  return {
    id: record.id,
    at: record.at,
    atIso: isoAt(record.at),
    hour: record.hour,
    day: record.day,
    session: record.session,
    provider: record.provider,
    model: record.model,
    purpose: record.purpose,
    usageSource: record.usageSource,
    status: record.status,
    finish: record.finish,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheHitTokens: record.cacheHitTokens,
    cacheWriteTokens: record.cacheWriteTokens,
    reasoningTokens: record.reasoningTokens,
    priceTier: record.priceTier,
    priceModel: record.priceModel,
    priced: record.priced,
    costInputNano: record.costInputNano,
    costCacheHitNano: record.costCacheHitNano,
    costCacheWriteNano: record.costCacheWriteNano,
    costOutputNano: record.costOutputNano,
    costNano: record.costNano,
    costCny: formatNanoCny(record.costNano, 6),
    costInputCny: formatNanoCny(record.costInputNano, 6),
    costCacheHitCny: formatNanoCny(record.costCacheHitNano, 6),
    costCacheWriteCny: formatNanoCny(record.costCacheWriteNano, 6),
    costOutputCny: formatNanoCny(record.costOutputNano, 6),
    ms: record.ms,
    error: record.error,
  }
}

function aggregateRow(row) {
  return {
    scope: row.scope,
    period: row.key,
    calls: row.calls,
    pricedCalls: row.pricedCalls,
    unpricedCalls: row.unpricedCalls,
    adapterCalls: row.adapterCalls,
    estimatedCalls: row.estimatedCalls,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheHitTokens: row.cacheHitTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    reasoningTokens: row.reasoningTokens,
    estimatedNano: row.estimatedNano,
    estimatedCny: formatNanoCny(row.estimatedNano, 6),
    actualNano: row.actualNano,
    actualCny: row.actualCny,
    diffNano: row.diffNano,
    diffCny: row.diffCny,
    diffPct: row.diffPct === null || row.diffPct === undefined ? null : Number(row.diffPct.toFixed(4)),
    billNote: row.billNote,
    billUpdatedAt: row.billUpdatedAt,
    firstAt: row.firstAt,
    lastAt: row.lastAt,
  }
}

/**
 * Build one export/report object. `detail` switches from period aggregates to
 * one row per model call. Bills are joined only in aggregate mode; a single
 * call cannot be matched to a platform bill meaningfully.
 */
export function buildReport(options) {
  const opts = options || {}
  const records = filterRecords(Array.isArray(opts.records) ? opts.records : [], opts.since, opts.until)
  const bills = Array.isArray(opts.bills) ? opts.bills : []
  const scope = opts.scope || 'day'
  const detail = opts.detail === true
  const totalsBills = filterBillsForTotals(bills, opts.since, opts.until)
  if (detail) {
    const rows = records.slice().sort(function (a, b) { return b.at - a.at }).map(detailRow)
    return {
      schema: REPORT_SCHEMA,
      generatedAt: typeof opts.now === 'number' ? opts.now : Date.now(),
      currency: 'CNY',
      unit: 'nano_cny',
      scope,
      detail: true,
      recordCount: records.length,
      filtered: { since: opts.since ?? null, until: opts.until ?? null },
      totals: totalsOf(records, totalsBills),
      rows,
      source: opts.source || null,
    }
  }
  const rows = joinBills(aggregateRecords(records, scope, opts.timeZone), bills).map(aggregateRow)
  return {
    schema: REPORT_SCHEMA,
    generatedAt: typeof opts.now === 'number' ? opts.now : Date.now(),
    currency: 'CNY',
    unit: 'nano_cny',
    scope,
    detail: false,
    recordCount: records.length,
    filtered: { since: opts.since ?? null, until: opts.until ?? null },
    totals: totalsOf(records, totalsBills),
    rows,
    source: opts.source || null,
  }
}

const AGGREGATE_COLUMNS = [
  ['scope', 'scope'],
  ['period', 'period'],
  ['calls', 'calls'],
  ['priced_calls', 'pricedCalls'],
  ['unpriced_calls', 'unpricedCalls'],
  ['adapter_calls', 'adapterCalls'],
  ['estimated_calls', 'estimatedCalls'],
  ['input_tokens', 'inputTokens'],
  ['output_tokens', 'outputTokens'],
  ['cache_hit_tokens', 'cacheHitTokens'],
  ['cache_write_tokens', 'cacheWriteTokens'],
  ['reasoning_tokens', 'reasoningTokens'],
  ['estimated_nano_cny', 'estimatedNano'],
  ['estimated_cny', 'estimatedCny'],
  ['actual_nano_cny', 'actualNano'],
  ['actual_cny', 'actualCny'],
  ['diff_nano_cny', 'diffNano'],
  ['diff_cny', 'diffCny'],
  ['diff_pct', 'diffPct'],
  ['bill_note', 'billNote'],
  ['first_at', 'firstAt'],
  ['last_at', 'lastAt'],
]

const DETAIL_COLUMNS = [
  ['id', 'id'],
  ['at', 'at'],
  ['at_iso', 'atIso'],
  ['hour', 'hour'],
  ['day', 'day'],
  ['session', 'session'],
  ['provider', 'provider'],
  ['model', 'model'],
  ['purpose', 'purpose'],
  ['usage_source', 'usageSource'],
  ['status', 'status'],
  ['finish', 'finish'],
  ['input_tokens', 'inputTokens'],
  ['output_tokens', 'outputTokens'],
  ['cache_hit_tokens', 'cacheHitTokens'],
  ['cache_write_tokens', 'cacheWriteTokens'],
  ['reasoning_tokens', 'reasoningTokens'],
  ['price_tier', 'priceTier'],
  ['price_model', 'priceModel'],
  ['priced', 'priced'],
  ['cost_input_nano_cny', 'costInputNano'],
  ['cost_cache_hit_nano_cny', 'costCacheHitNano'],
  ['cost_cache_write_nano_cny', 'costCacheWriteNano'],
  ['cost_output_nano_cny', 'costOutputNano'],
  ['cost_nano_cny', 'costNano'],
  ['cost_cny', 'costCny'],
  ['ms', 'ms'],
  ['error', 'error'],
]

/** One CSV cell. Strings that could be spreadsheet formulas are neutralised. */
export function csvCell(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  let text = String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text
  if (/[",\r\n]/.test(text)) text = '"' + text.replace(/"/g, '""') + '"'
  return text
}

export function toCsv(report) {
  const columns = report.detail ? DETAIL_COLUMNS : AGGREGATE_COLUMNS
  const lines = [columns.map(function (pair) { return pair[0] }).join(',')]
  for (const row of report.rows) {
    lines.push(columns.map(function (pair) { return csvCell(row[pair[1]]) }).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

export function toJson(report) {
  return JSON.stringify(report, null, 2) + '\n'
}

function briefCny(value) {
  if (value === null || value === undefined) return '—'
  const text = String(value)
  return text.charAt(0) === '-' ? '-¥' + text.slice(1) : '¥' + text
}

/** Human-readable dry-run output. No file is opened or written. */
export function previewText(report, limit) {
  const max = limit === undefined ? 10 : limit
  const totals = report.totals || {}
  const lines = []
  lines.push('dsh-cost-ledger dry-run')
  lines.push('  scope: ' + report.scope + (report.detail ? ' (detail)' : ''))
  lines.push('  records: ' + report.recordCount + ', groups: ' + report.rows.length)
  lines.push('  estimated: ' + briefCny(totals.estimatedCny) + '  actual(day bills): ' + briefCny(totals.actualCny) + '  diff: ' + briefCny(totals.diffCny))
  lines.push('  unpriced calls: ' + (totals.unpricedCalls ?? 0) + ', adapter usage: ' + (totals.adapterCalls ?? 0) + ', estimated usage: ' + (totals.estimatedCalls ?? 0))
  lines.push('')
  lines.push('  ' + (report.detail
    ? 'at                     model                         tokens(in/out/cache)  cost_cny'
    : 'period                 calls  cache_hit  estimated_cny  actual_cny  diff_cny'))
  const rows = report.rows.slice(0, max)
  for (const row of rows) {
    if (report.detail) {
      lines.push('  ' + String(row.atIso).padEnd(22).slice(0, 22) + ' ' + String(row.model).padEnd(29).slice(0, 29) + ' ' +
        String(row.inputTokens + '/' + row.outputTokens + '/' + row.cacheHitTokens).padEnd(21) + ' ' + row.costCny)
    } else {
      lines.push('  ' + String(row.period).padEnd(22).slice(0, 22) + ' ' + String(row.calls).padStart(5) + '  ' +
        String(row.cacheHitTokens).padStart(9) + '  ' + String(briefCny(row.estimatedCny)).padStart(13) + '  ' +
        String(briefCny(row.actualCny)).padStart(10) + '  ' + String(briefCny(row.diffCny)).padStart(8))
    }
  }
  if (report.rows.length > max) lines.push('  … ' + (report.rows.length - max) + ' more rows')
  lines.push('')
  lines.push('  (dry-run: nothing was written)')
  return lines.join('\n') + '\n'
}

export function reportFilename(report, format) {
  const stamp = new Date(report.generatedAt).toISOString().replace(/[:.]/g, '-')
  return 'cost-ledger-' + report.scope + (report.detail ? '-detail' : '') + '-' + stamp + '.' + format
}
