import { strict as assert } from 'node:assert'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  aggregateRecords,
  formatNanoCny,
  joinBills,
  LedgerStore,
  normalizeBill,
  normalizeRecord,
  parseCnyToNano,
  readBills,
  readJsonl,
  totalsFromBuckets,
  totalsOf,
  writeBills,
} from '../src/ledger.js'
import { buildReport, csvCell, toCsv } from '../src/report.js'
import { makeHome, makeRecord } from './fixtures.mjs'

const DAY = Date.parse('2026-10-19T02:00:00Z')

test('CNY amounts are parsed into exact integer nano-CNY', () => {
  assert.equal(parseCnyToNano('0'), 0)
  assert.equal(parseCnyToNano('1'), 1_000_000_000)
  assert.equal(parseCnyToNano('12.34'), 12_340_000_000)
  assert.equal(parseCnyToNano('0.000000001'), 1)
  assert.equal(formatNanoCny(12_340_000_000, 4), '12.3400')
  assert.throws(function () { parseCnyToNano('1.2345678901') }, /金额/)
  assert.throws(function () { parseCnyToNano('-1') }, /金额/)
  assert.throws(function () { parseCnyToNano('abc') }, /金额/)
})

test('a record whose components do not add up is rejected', () => {
  const bad = makeRecord({ costNano: 9999 })
  assert.equal(normalizeRecord(bad), undefined)
  const good = normalizeRecord(makeRecord())
  assert.ok(good)
  assert.equal(good.hour, '2026-10-19T10')
  assert.equal(good.day, '2026-10-19')
})

test('calendar keys are derived from the timestamp, not trusted from disk', () => {
  const record = normalizeRecord(Object.assign(makeRecord(), { hour: '1999-01-01T00', day: '1999-01-01' }))
  assert.equal(record.hour, '2026-10-19T10')
  assert.equal(record.day, '2026-10-19')
})

test('aggregation groups by hour, day, and session', () => {
  const records = [
    normalizeRecord(makeRecord({ at: DAY, session: 's1', costNano: 100, costInputNano: 100, costCacheHitNano: 0, costOutputNano: 0 })),
    normalizeRecord(makeRecord({ at: DAY + 60_000, session: 's1', costNano: 200, costInputNano: 200, costCacheHitNano: 0, costOutputNano: 0 })),
    normalizeRecord(makeRecord({ at: DAY + 3_600_000, session: 's2', costNano: 300, costInputNano: 300, costCacheHitNano: 0, costOutputNano: 0 })),
  ]
  const hours = aggregateRecords(records, 'hour')
  assert.equal(hours.length, 2)
  assert.equal(hours[0].key, '2026-10-19T11')
  assert.equal(hours[1].key, '2026-10-19T10')
  assert.equal(hours[1].calls, 2)
  assert.equal(hours[1].estimatedNano, 300)
  const days = aggregateRecords(records, 'day')
  assert.equal(days.length, 1)
  assert.equal(days[0].calls, 3)
  assert.equal(days[0].estimatedNano, 600)
  const sessions = aggregateRecords(records, 'session')
  assert.equal(sessions.length, 2)
  assert.equal(sessions[0].key, 's2')
  assert.equal(sessions[1].calls, 2)
})

test('bills are joined as a separate actual column with an explicit diff', () => {
  const rows = aggregateRecords([normalizeRecord(makeRecord({ costNano: 1_000_000_000, costInputNano: 1_000_000_000, costCacheHitNano: 0, costOutputNano: 0 }))], 'day')
  const bills = [normalizeBill({ scope: 'day', key: '2026-10-19', amountCny: '2.50', note: '平台截图' }, 1)]
  const joined = joinBills(rows, bills)
  assert.equal(joined[0].estimatedCny, '1.000000')
  assert.equal(joined[0].actualCny, '2.500000')
  assert.equal(joined[0].diffCny, '1.500000')
  assert.equal(joined[0].diffPct, 150)
  assert.equal(joined[0].billNote, '平台截图')
})

test('a missing bill leaves actual and diff null rather than guessing', () => {
  const rows = aggregateRecords([normalizeRecord(makeRecord())], 'day')
  const joined = joinBills(rows, [])
  assert.equal(joined[0].actualCny, null)
  assert.equal(joined[0].diffCny, null)
  assert.equal(joined[0].diffPct, null)
})

test('totals count every call and only day bills feed the actual total', () => {
  const records = [
    normalizeRecord(makeRecord({ at: DAY, costNano: 100, costInputNano: 100, costCacheHitNano: 0, costOutputNano: 0 })),
    normalizeRecord(makeRecord({ at: DAY + 1, costNano: 200, costInputNano: 200, costCacheHitNano: 0, costOutputNano: 0, priced: false })),
  ]
  const bills = [
    normalizeBill({ scope: 'day', key: '2026-10-19', amountCny: '0.000001' }, 1),
    normalizeBill({ scope: 'hour', key: '2026-10-19T10', amountCny: '99' }, 1),
    normalizeBill({ scope: 'session', key: 'session-a', amountCny: '99' }, 1),
  ]
  const totals = totalsOf(records, bills)
  assert.equal(totals.calls, 2)
  assert.equal(totals.pricedCalls, 1)
  assert.equal(totals.unpricedCalls, 1)
  assert.equal(totals.actualNano, 1000)
  assert.equal(totals.diffNano, 1000 - 300)
  const buckets = aggregateRecords(records, 'day')
  assert.deepEqual(totalsFromBuckets(buckets, bills), totals)
})

test('CSV neutralises spreadsheet formula injection and quotes commas', () => {
  assert.equal(csvCell('=cmd'), "'=cmd")
  assert.equal(csvCell('+SUM(A1)'), "'+SUM(A1)")
  assert.equal(csvCell('a,b'), '"a,b"')
  assert.equal(csvCell('a"b'), '"a""b"')
  assert.equal(csvCell(-12.5), '-12.5')
  const report = buildReport({
    records: [normalizeRecord(makeRecord({ model: '=EVIL' }))],
    bills: [],
    scope: 'day',
    detail: true,
    now: 1,
  })
  const csv = toCsv(report)
  assert.match(csv, /cost_cny/)
  assert.match(csv, /'=EVIL/)
})

test('aggregate and detail reports expose raw nano-CNY plus formatted CNY', () => {
  const record = normalizeRecord(makeRecord())
  const aggregate = buildReport({ records: [record], bills: [], scope: 'day', now: 1 })
  assert.equal(aggregate.schema, 'dsh-cost-ledger/v1')
  assert.equal(aggregate.detail, false)
  assert.equal(aggregate.rows[0].estimatedNano, 1820)
  assert.equal(aggregate.rows[0].estimatedCny, '0.000002')
  const detail = buildReport({ records: [record], bills: [], scope: 'day', detail: true, now: 1 })
  assert.equal(detail.rows[0].costNano, 1820)
  assert.equal(detail.rows[0].costCny, '0.000002')
  assert.equal(detail.rows[0].model, 'test-model')
})

test('JSONL reading skips corrupt lines instead of failing the whole ledger', () => {
  const home = makeHome()
  const path = join(home, 'ledger.jsonl')
  writeFileSync(path, JSON.stringify(makeRecord()) + '\nnot json\n{"at":1}\n', 'utf8')
  const read = readJsonl(path, { timeZone: 'Asia/Shanghai' })
  assert.equal(read.records.length, 1)
  assert.equal(read.skipped, 2)
})

test('the store persists records, keeps totals beyond the recent ring, and reloads', () => {
  const home = makeHome()
  const ledgerPath = join(home, 'ledger.jsonl')
  const billsPath = join(home, 'bills.json')
  const store = new LedgerStore({ ledgerPath, billsPath, maxRecent: 2, clock: function () { return 1 } })
  store.load()
  for (let index = 0; index < 5; index += 1) {
    store.add(makeRecord({ at: DAY + index * 1000, costNano: 100 + index, costInputNano: 100 + index, costCacheHitNano: 0, costOutputNano: 0 }))
  }
  assert.equal(store.recordCount(), 5)
  assert.equal(store.recent.length, 2)
  const snapshot = store.snapshot()
  assert.equal(snapshot.totals.calls, 5)
  assert.equal(snapshot.totals.estimatedNano, 510)
  assert.equal(snapshot.recent.length, 2)
  assert.equal(snapshot.recent[0].costNano, 104)

  const reloaded = new LedgerStore({ ledgerPath, billsPath, maxRecent: 2 })
  reloaded.load()
  assert.equal(reloaded.snapshot().totals.calls, 5)
})

test('bills can be set, replaced, listed, and deleted on disk', () => {
  const home = makeHome()
  const ledgerPath = join(home, 'ledger.jsonl')
  const billsPath = join(home, 'bills.json')
  const store = new LedgerStore({ ledgerPath, billsPath, clock: function () { return 100 } })
  store.load()
  store.setBill({ scope: 'day', key: '2026-10-19', amountCny: '1.25', note: 'first' })
  store.setBill({ scope: 'day', key: '2026-10-19', amountCny: '3.50', note: 'second' })
  assert.equal(store.bills.length, 1)
  assert.equal(store.billFor('day', '2026-10-19').actualNano, 3_500_000_000)
  const onDisk = readBills(billsPath)
  assert.equal(onDisk.bills.length, 1)
  assert.equal(onDisk.bills[0].amountCny, '3.50')
  assert.equal(store.deleteBill('day', '2026-10-19'), true)
  assert.equal(store.deleteBill('day', '2026-10-19'), false)
  assert.equal(readBills(billsPath).bills.length, 0)
})

test('bill validation rejects malformed period keys', () => {
  assert.throws(function () { normalizeBill({ scope: 'hour', key: '2026-10-19', amountCny: '1' }) }, /hour/)
  assert.throws(function () { normalizeBill({ scope: 'day', key: '2026/10/19', amountCny: '1' }) }, /day/)
  assert.throws(function () { normalizeBill({ scope: 'week', key: 'x', amountCny: '1' }) }, /scope/)
  const bill = normalizeBill({ scope: 'session', key: 'session-a', amountCny: 0 }, 5)
  assert.equal(bill.actualNano, 0)
  assert.equal(bill.updatedAt, 5)
})

test('writeBills is readable by readBills and preserves notes', () => {
  const home = makeHome()
  const path = join(home, 'bills.json')
  writeBills(path, [normalizeBill({ scope: 'day', key: '2026-10-19', amountCny: '9.99', note: 'note' }, 7)])
  const read = readBills(path)
  assert.equal(read.error, '')
  assert.equal(read.bills[0].note, 'note')
  assert.match(readFileSync(path, 'utf8'), /"currency": "CNY"/)
})
