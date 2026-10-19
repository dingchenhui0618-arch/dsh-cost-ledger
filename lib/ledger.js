// Durable call ledger, aggregation, bill reconciliation, and file I/O.
//
// A record is frozen at call time: token counts, the matched price tier and the
// computed nano-CNY cost are written together. Changing prices later never
// rewrites history. A user-entered bill is a separate object; the export joins
// the two but never overwrites either side.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { dayKey, hourKey, NANO_PER_CNY } from './prices.js'

export const LEDGER_VERSION = 1
export const SCOPES = Object.freeze(['hour', 'day', 'session'])
export const USAGE_SOURCES = Object.freeze(['adapter', 'estimated', 'missing'])
export const CALL_STATUSES = Object.freeze(['ok', 'error', 'aborted', 'interrupted', 'ended'])

export function formatNanoCny(nano, digits) {
  const places = digits === undefined ? 4 : digits
  if (!Number.isSafeInteger(nano)) return '0.' + '0'.repeat(places)
  return (nano / NANO_PER_CNY).toFixed(places)
}

/** Parse a user-entered positive decimal CNY amount into integer nano-CNY. */
export function parseCnyToNano(value) {
  const text = typeof value === 'number' ? String(value) : String(value === undefined || value === null ? '' : value).trim()
  if (!/^\d+(\.\d{1,9})?$/.test(text)) throw new Error('金额必须是非负十进制数，最多 9 位小数：' + text)
  const pieces = text.split('.')
  const whole = Number(pieces[0])
  const fraction = (pieces[1] === undefined ? '' : pieces[1]) + '000000000'
  const nano = whole * NANO_PER_CNY + Number(fraction.slice(0, 9))
  if (!Number.isSafeInteger(nano) || nano < 0) throw new Error('金额超出可精确表示的范围：' + text)
  return nano
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function countOrZero(value) {
  return isCount(value) ? value : 0
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/**
 * Validate one persisted call record and fill compatibility defaults.
 * Returns undefined for a malformed line; the caller drops that line.
 */
export function normalizeRecord(raw, options) {
  const opts = options || {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const at = raw.at
  if (!isCount(at)) return undefined
  const session = cleanText(raw.session, 200)
  const provider = cleanText(raw.provider, 120)
  const model = cleanText(raw.model, 200)
  if (session.length === 0 || provider.length === 0 || model.length === 0) return undefined
  const inputTokens = countOrZero(raw.inputTokens)
  const outputTokens = countOrZero(raw.outputTokens)
  const cacheHitTokens = countOrZero(raw.cacheHitTokens)
  const cacheWriteTokens = countOrZero(raw.cacheWriteTokens)
  const reasoningTokens = countOrZero(raw.reasoningTokens)
  const costInputNano = countOrZero(raw.costInputNano)
  const costCacheHitNano = countOrZero(raw.costCacheHitNano)
  const costCacheWriteNano = countOrZero(raw.costCacheWriteNano)
  const costOutputNano = countOrZero(raw.costOutputNano)
  const computedNano = costInputNano + costCacheHitNano + costCacheWriteNano + costOutputNano
  const costNano = raw.costNano === undefined ? computedNano : raw.costNano
  if (!isCount(costNano) || costNano !== computedNano) return undefined
  const priced = raw.priced === undefined ? computedNano > 0 : raw.priced
  if (typeof priced !== 'boolean') return undefined
  const usageSource = USAGE_SOURCES.includes(raw.usageSource) ? raw.usageSource : 'adapter'
  const status = CALL_STATUSES.includes(raw.status) ? raw.status : 'ok'
  const timeZone = opts.timeZone || 'Asia/Shanghai'
  const time = Number(at)
  return {
    v: LEDGER_VERSION,
    id: cleanText(raw.id, 80) || String(time) + '-' + String(inputTokens) + '-' + String(outputTokens),
    at: time,
    hour: hourKey(time, timeZone),
    day: dayKey(time, timeZone),
    session,
    provider,
    model,
    purpose: cleanText(raw.purpose, 40),
    inputTokens,
    outputTokens,
    cacheHitTokens,
    cacheWriteTokens,
    reasoningTokens,
    usageSource,
    priced,
    priceTier: raw.priceTier === 'peak' || raw.priceTier === 'offPeak' || raw.priceTier === 'flat' ? raw.priceTier : null,
    priceModel: cleanText(raw.priceModel, 200),
    costInputNano,
    costCacheHitNano,
    costCacheWriteNano,
    costOutputNano,
    costNano,
    status,
    finish: cleanText(raw.finish, 40) || 'unknown',
    ms: countOrZero(raw.ms),
    error: cleanText(raw.error, 300),
  }
}

function emptyBucket(scope, key) {
  return {
    scope,
    key,
    calls: 0,
    pricedCalls: 0,
    unpricedCalls: 0,
    adapterCalls: 0,
    estimatedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheHitTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedNano: 0,
    firstAt: 0,
    lastAt: 0,
  }
}

function addToBucket(bucket, record) {
  bucket.calls += 1
  if (record.priced) bucket.pricedCalls += 1
  else bucket.unpricedCalls += 1
  if (record.usageSource === 'adapter') bucket.adapterCalls += 1
  else if (record.usageSource === 'estimated') bucket.estimatedCalls += 1
  bucket.inputTokens += record.inputTokens
  bucket.outputTokens += record.outputTokens
  bucket.cacheHitTokens += record.cacheHitTokens
  bucket.cacheWriteTokens += record.cacheWriteTokens
  bucket.reasoningTokens += record.reasoningTokens
  bucket.estimatedNano += record.costNano
  if (bucket.firstAt === 0 || record.at < bucket.firstAt) bucket.firstAt = record.at
  if (record.at > bucket.lastAt) bucket.lastAt = record.at
}

/** Aggregate records by one of the three scopes, newest key first. */
export function aggregateRecords(records, scope, timeZone) {
  if (!SCOPES.includes(scope)) throw new Error('未知聚合范围：' + scope)
  const zone = timeZone || 'Asia/Shanghai'
  const map = new Map()
  for (const record of records) {
    if (typeof record !== 'object' || record === null) continue
    let key
    if (scope === 'session') key = record.session
    else if (scope === 'hour') key = record.hour || hourKey(record.at, zone)
    else key = record.day || dayKey(record.at, zone)
    if (typeof key !== 'string' || key.length === 0) continue
    let bucket = map.get(key)
    if (bucket === undefined) {
      bucket = emptyBucket(scope, key)
      map.set(key, bucket)
    }
    addToBucket(bucket, record)
  }
  const rows = Array.from(map.values())
  if (scope === 'session') rows.sort(function (a, b) { return b.lastAt - a.lastAt })
  else rows.sort(function (a, b) { return b.key < a.key ? -1 : b.key > a.key ? 1 : 0 })
  return rows
}

function billId(scope, key) {
  return scope + '|' + key
}

function diffPercent(diffNano, estimatedNano) {
  if (!Number.isFinite(estimatedNano) || estimatedNano <= 0) return null
  return (diffNano / estimatedNano) * 100
}

/** Join manually entered bills onto aggregate rows. Missing bills stay null. */
export function joinBills(rows, bills) {
  const index = new Map()
  for (const bill of bills) index.set(billId(bill.scope, bill.key), bill)
  return rows.map(function (row) {
    const bill = index.get(billId(row.scope, row.key))
    const actualNano = bill === undefined ? null : bill.actualNano
    const diffNano = actualNano === null ? null : actualNano - row.estimatedNano
    return Object.assign({}, row, {
      estimatedCny: formatNanoCny(row.estimatedNano, 6),
      actualNano,
      actualCny: actualNano === null ? null : formatNanoCny(actualNano, 6),
      diffNano,
      diffCny: diffNano === null ? null : formatNanoCny(diffNano, 6),
      diffPct: diffNano === null ? null : diffPercent(diffNano, row.estimatedNano),
      billNote: bill === undefined ? '' : bill.note,
      billUpdatedAt: bill === undefined ? null : bill.updatedAt,
    })
  })
}

/** Totals over all calls, plus the day-level bill total (not a sum of hour bills). */
export function totalsOf(records, bills) {
  const total = {
    calls: 0,
    pricedCalls: 0,
    unpricedCalls: 0,
    adapterCalls: 0,
    estimatedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheHitTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedNano: 0,
    actualNano: null,
    diffNano: null,
    dayBillCount: 0,
  }
  for (const record of records) {
    total.calls += 1
    if (record.priced) total.pricedCalls += 1
    else total.unpricedCalls += 1
    if (record.usageSource === 'adapter') total.adapterCalls += 1
    else if (record.usageSource === 'estimated') total.estimatedCalls += 1
    total.inputTokens += record.inputTokens
    total.outputTokens += record.outputTokens
    total.cacheHitTokens += record.cacheHitTokens
    total.cacheWriteTokens += record.cacheWriteTokens
    total.reasoningTokens += record.reasoningTokens
    total.estimatedNano += record.costNano
  }
  let actual = 0
  let dayBills = 0
  for (const bill of bills) {
    if (bill.scope !== 'day') continue
    actual += bill.actualNano
    dayBills += 1
  }
  total.dayBillCount = dayBills
  if (dayBills > 0) {
    total.actualNano = actual
    total.diffNano = actual - total.estimatedNano
  }
  return {
    calls: total.calls,
    pricedCalls: total.pricedCalls,
    unpricedCalls: total.unpricedCalls,
    adapterCalls: total.adapterCalls,
    estimatedCalls: total.estimatedCalls,
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    cacheHitTokens: total.cacheHitTokens,
    cacheWriteTokens: total.cacheWriteTokens,
    reasoningTokens: total.reasoningTokens,
    estimatedNano: total.estimatedNano,
    estimatedCny: formatNanoCny(total.estimatedNano, 6),
    actualNano: total.actualNano,
    actualCny: total.actualNano === null ? null : formatNanoCny(total.actualNano, 6),
    diffNano: total.diffNano,
    diffCny: total.diffNano === null ? null : formatNanoCny(total.diffNano, 6),
    dayBillCount: total.dayBillCount,
  }
}

/** Validate one user-entered bill. */
export function normalizeBill(raw, now) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('账单必须是对象')
  const scope = raw.scope
  if (!SCOPES.includes(scope)) throw new Error('scope 必须是 hour|day|session')
  const key = cleanText(raw.key, 200)
  if (key.length === 0) throw new Error('key 不能为空')
  if (scope === 'hour' && !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3])$/.test(key)) {
    throw new Error('hour 账单的 key 必须是 YYYY-MM-DDTHH（北京时间）')
  }
  if (scope === 'day' && !/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    throw new Error('day 账单的 key 必须是 YYYY-MM-DD（北京时间）')
  }
  const actualNano = parseCnyToNano(raw.amountCny)
  const amountCny = typeof raw.amountCny === 'number' ? String(raw.amountCny) : String(raw.amountCny).trim()
  return {
    scope,
    key,
    amountCny,
    actualNano,
    note: cleanText(raw.note, 200),
    updatedAt: isCount(now) ? now : Date.now(),
  }
}

/** Read JSONL ledger lines, dropping malformed entries instead of failing open. */
export function readJsonl(filePath, options) {
  if (typeof filePath !== 'string' || !existsSync(filePath)) return { records: [], skipped: 0 }
  const text = readFileSync(filePath, 'utf8')
  const records = []
  let skipped = 0
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      skipped += 1
      continue
    }
    const record = normalizeRecord(parsed, options)
    if (record === undefined) skipped += 1
    else records.push(record)
  }
  return { records, skipped }
}

/** Read the bill file; a corrupt file is reported rather than silently replaced. */
export function readBills(filePath) {
  if (typeof filePath !== 'string' || !existsSync(filePath)) return { bills: [], skipped: 0, error: '' }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    return { bills: [], skipped: 0, error: String(error.message || error) }
  }
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.bills) ? parsed.bills : [])
  const bills = []
  let skipped = 0
  for (const item of list) {
    try {
      const bill = normalizeBill(item, item && item.updatedAt)
      const duplicate = bills.findIndex(function (other) { return other.scope === bill.scope && other.key === bill.key })
      if (duplicate >= 0) bills.splice(duplicate, 1)
      bills.push(bill)
    } catch (error) {
      skipped += 1
    }
  }
  return { bills, skipped, error: '' }
}

export function writeBills(filePath, bills) {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const payload = { version: LEDGER_VERSION, currency: 'CNY', bills: bills }
  writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8')
}

/** Totals from disjoint day buckets, without keeping every record in memory. */
export function totalsFromBuckets(buckets, bills) {
  const total = {
    calls: 0,
    pricedCalls: 0,
    unpricedCalls: 0,
    adapterCalls: 0,
    estimatedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheHitTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedNano: 0,
    actualNano: null,
    diffNano: null,
    dayBillCount: 0,
  }
  for (const bucket of buckets) {
    total.calls += bucket.calls
    total.pricedCalls += bucket.pricedCalls
    total.unpricedCalls += bucket.unpricedCalls
    total.adapterCalls += bucket.adapterCalls
    total.estimatedCalls += bucket.estimatedCalls
    total.inputTokens += bucket.inputTokens
    total.outputTokens += bucket.outputTokens
    total.cacheHitTokens += bucket.cacheHitTokens
    total.cacheWriteTokens += bucket.cacheWriteTokens
    total.reasoningTokens += bucket.reasoningTokens
    total.estimatedNano += bucket.estimatedNano
  }
  let actual = 0
  let dayBills = 0
  for (const bill of bills) {
    if (bill.scope !== 'day') continue
    actual += bill.actualNano
    dayBills += 1
  }
  total.dayBillCount = dayBills
  if (dayBills > 0) {
    total.actualNano = actual
    total.diffNano = actual - total.estimatedNano
  }
  return {
    calls: total.calls,
    pricedCalls: total.pricedCalls,
    unpricedCalls: total.unpricedCalls,
    adapterCalls: total.adapterCalls,
    estimatedCalls: total.estimatedCalls,
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    cacheHitTokens: total.cacheHitTokens,
    cacheWriteTokens: total.cacheWriteTokens,
    reasoningTokens: total.reasoningTokens,
    estimatedNano: total.estimatedNano,
    estimatedCny: formatNanoCny(total.estimatedNano, 6),
    actualNano: total.actualNano,
    actualCny: total.actualNano === null ? null : formatNanoCny(total.actualNano, 6),
    diffNano: total.diffNano,
    diffCny: total.diffNano === null ? null : formatNanoCny(total.diffNano, 6),
    dayBillCount: total.dayBillCount,
  }
}

/**
 * In-memory ledger index. It keeps aggregates and a bounded recent list rather
 * than every record, so a long-running profile does not grow without bound.
 */
export class LedgerStore {
  constructor(options) {
    const opts = options || {}
    if (typeof opts.ledgerPath !== 'string' || opts.ledgerPath.length === 0) throw new Error('ledgerPath 不能为空')
    if (typeof opts.billsPath !== 'string' || opts.billsPath.length === 0) throw new Error('billsPath 不能为空')
    this.ledgerPath = opts.ledgerPath
    this.billsPath = opts.billsPath
    this.timeZone = opts.timeZone || 'Asia/Shanghai'
    this.maxRecent = isCount(opts.maxRecent) ? opts.maxRecent : 120
    this.clock = typeof opts.clock === 'function' ? opts.clock : Date.now
    this.hour = new Map()
    this.day = new Map()
    this.session = new Map()
    this.recent = []
    this.bills = []
    this.billError = ''
    this.billSkipped = 0
    this.loadedSkipped = 0
  }

  load() {
    this.hour.clear()
    this.day.clear()
    this.session.clear()
    this.recent.length = 0
    const read = readJsonl(this.ledgerPath, { timeZone: this.timeZone })
    this.loadedSkipped = read.skipped
    for (const record of read.records) this.add(record, false)
    const bills = readBills(this.billsPath)
    this.bills = bills.bills
    this.billError = bills.error
    this.billSkipped = bills.skipped
    return this
  }

  add(record, persist) {
    const normalized = normalizeRecord(record, { timeZone: this.timeZone })
    if (normalized === undefined) return undefined
    this._bucket(this.hour, normalized.hour, 'hour', normalized)
    this._bucket(this.day, normalized.day, 'day', normalized)
    this._bucket(this.session, normalized.session, 'session', normalized)
    this.recent.push(normalized)
    if (this.recent.length > this.maxRecent) this.recent.splice(0, this.recent.length - this.maxRecent)
    if (persist !== false) {
      mkdirSync(dirname(this.ledgerPath), { recursive: true })
      appendFileSync(this.ledgerPath, JSON.stringify(normalized) + '\n', 'utf8')
    }
    return normalized
  }

  _bucket(map, key, scope, record) {
    let bucket = map.get(key)
    if (bucket === undefined) {
      bucket = emptyBucket(scope, key)
      map.set(key, bucket)
    }
    addToBucket(bucket, record)
  }

  reloadBills() {
    const bills = readBills(this.billsPath)
    this.bills = bills.bills
    this.billError = bills.error
    this.billSkipped = bills.skipped
  }

  setBill(raw) {
    const bill = normalizeBill(raw, this.clock())
    const index = this.bills.findIndex(function (other) { return other.scope === bill.scope && other.key === bill.key })
    if (index >= 0) this.bills.splice(index, 1)
    this.bills.push(bill)
    writeBills(this.billsPath, this.bills)
    return bill
  }

  deleteBill(scope, key) {
    const index = this.bills.findIndex(function (bill) { return bill.scope === scope && bill.key === key })
    if (index < 0) return false
    this.bills.splice(index, 1)
    writeBills(this.billsPath, this.bills)
    return true
  }

  billFor(scope, key) {
    return this.bills.find(function (bill) { return bill.scope === scope && bill.key === key })
  }

  rows(scope) {
    const map = scope === 'hour' ? this.hour : scope === 'session' ? this.session : this.day
    return joinBills(Array.from(map.values()), this.bills)
  }

  recordCount() {
    let count = 0
    for (const bucket of this.day.values()) count += bucket.calls
    return count
  }

  snapshot(options) {
    const opts = options || {}
    const limits = { hour: opts.hourLimit ?? 48, day: opts.dayLimit ?? 31, session: opts.sessionLimit ?? 50 }
    const scopes = {}
    for (const scope of SCOPES) {
      const rows = this.rows(scope)
      scopes[scope] = {
        total: rows.length,
        rows: rows.slice(0, limits[scope]),
      }
    }
    const bills = this.bills.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt }).slice(0, 200)
    const recent = this.recent.slice().reverse()
    return {
      version: LEDGER_VERSION,
      currency: 'CNY',
      timeZone: this.timeZone,
      now: this.clock(),
      scopes,
      recent,
      bills,
      totals: totalsFromBuckets(this.day.values(), this.bills),
      files: {
        ledgerPath: this.ledgerPath,
        billsPath: this.billsPath,
      },
      health: {
        loadedRecords: this.recordCount(),
        skippedRecords: this.loadedSkipped,
        billError: this.billError,
        skippedBills: this.billSkipped,
      },
    }
  }
}
