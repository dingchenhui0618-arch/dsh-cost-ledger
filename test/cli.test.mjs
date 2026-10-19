import { strict as assert } from 'node:assert'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { runCli } from '../src/cli.js'
import { normalizeBill, writeBills } from '../src/ledger.js'
import { makeHome, makeRecord } from './fixtures.mjs'

const DAY = Date.parse('2026-10-19T02:00:00Z')
const PREVIOUS_DAY = Date.parse('2026-10-18T02:00:00Z')

function setupHome() {
  const home = makeHome('cost-ledger-cli-')
  const records = [
    makeRecord({ at: DAY, session: 'session-a', costNano: 1_000_000, costInputNano: 1_000_000, costCacheHitNano: 0, costOutputNano: 0 }),
    makeRecord({ at: DAY + 1000, session: 'session-b', costNano: 2_000_000, costInputNano: 2_000_000, costCacheHitNano: 0, costOutputNano: 0 }),
    makeRecord({ at: PREVIOUS_DAY, session: 'session-a', costNano: 3_000_000, costInputNano: 3_000_000, costCacheHitNano: 0, costOutputNano: 0 }),
  ]
  writeFileSync(join(home, 'cost-ledger.jsonl'), records.map(function (record) { return JSON.stringify(record) }).join('\n') + '\n', 'utf8')
  writeBills(join(home, 'cost-ledger-bills.json'), [
    normalizeBill({ scope: 'day', key: '2026-10-19', amountCny: '0.01', note: '平台' }, 1),
  ])
  return home
}

test('CLI export emits machine-readable JSON with estimate and actual columns', function () {
  const home = setupHome()
  const result = runCli(['export', '--home', home, '--json', '--scope', 'day'])
  assert.equal(result.code, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.schema, 'dsh-cost-ledger/v1')
  assert.equal(report.rows.length, 2)
  assert.equal(report.totals.calls, 3)
  assert.equal(report.totals.estimatedNano, 6_000_000)
  assert.equal(report.totals.actualNano, 10_000_000)
  const today = report.rows.find(function (row) { return row.period === '2026-10-19' })
  assert.equal(today.actualCny, '0.010000')
  assert.equal(today.diffNano, 7_000_000)
})

test('CLI export emits CSV and can write to a file', function () {
  const home = setupHome()
  const target = join(home, 'out', 'ledger.csv')
  const result = runCli(['export', '--home', home, '--csv', '--scope', 'day', '--out', target])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /wrote/)
  const csv = readFileSync(target, 'utf8')
  assert.match(csv, /scope,period,calls/)
  assert.match(csv, /2026-10-19/)
})

test('dry-run writes nothing even when --out is supplied', function () {
  const home = setupHome()
  const target = join(home, 'should-not-exist.csv')
  const result = runCli(['export', '--home', home, '--csv', '--dry-run', '--out', target])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /dry-run/)
  assert.equal(existsSync(target), false)
})

test('CLI detail export contains one row per call', function () {
  const home = setupHome()
  const result = runCli(['export', '--home', home, '--json', '--detail'])
  assert.equal(result.code, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.detail, true)
  assert.equal(report.rows.length, 3)
  assert.ok(report.rows.every(function (row) { return row.model === 'test-model' }))
})

test('date filters use inclusive Beijing-day boundaries', function () {
  const home = setupHome()
  const result = runCli(['export', '--home', home, '--json', '--scope', 'day', '--since', '2026-10-19', '--until', '2026-10-19'])
  assert.equal(result.code, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.recordCount, 2)
  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0].period, '2026-10-19')
})

test('bill set and bill list update the reconciliation file', function () {
  const home = setupHome()
  const set = runCli(['bill', 'set', '--home', home, '--scope', 'day', '--key', '2026-10-19', '--amount', '12.34', '--note', '账单页'])
  assert.equal(set.code, 0)
  assert.match(set.stdout, /12\.340000/)
  const list = runCli(['bill', 'list', '--home', home, '--json'])
  assert.equal(list.code, 0)
  const bills = JSON.parse(list.stdout).bills
  assert.equal(bills.length, 1)
  assert.equal(bills[0].amountCny, '12.34')
  const deleted = runCli(['bill', 'delete', '--home', home, '--scope', 'day', '--key', '2026-10-19'])
  assert.equal(deleted.code, 0)
  assert.equal(JSON.parse(runCli(['bill', 'list', '--home', home, '--json']).stdout).bills.length, 0)
})

test('a bad command exits 2 with usage text, and help exits 0', function () {
  const bad = runCli(['nonsense'])
  assert.equal(bad.code, 2)
  assert.match(bad.stderr, /未知命令/)
  const help = runCli(['help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /dsh-cost-ledger/)
})

test('prices command reports the effective table', function () {
  const home = setupHome()
  writeFileSync(join(home, 'cost-ledger-prices.json'), JSON.stringify({
    version: 'cli-test',
    timeZone: 'Asia/Shanghai',
    peakHours: [],
    models: { 'test-provider': { 'test-model': { offPeak: { input: 3, output: 4, cacheHit: 0.5 } } } },
  }), 'utf8')
  const result = runCli(['prices', '--home', home])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /cli-test/)
  assert.match(result.stdout, /test-provider/)
  assert.match(result.stdout, /test-model/)
})

test('export accepts --format=value syntax', function () {
  const home = setupHome()
  const result = runCli(['export', '--home', home, '--format=csv', '--scope=session'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /scope,period,calls/)
  assert.match(result.stdout, /session-a/)
})
