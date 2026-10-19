import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  BUILTIN_PRICE_TABLE,
  CHINA_2026_HOLIDAYS,
  dayKey,
  estimatePromptTokens,
  estimateTextTokens,
  hourKey,
  isPeakAt,
  normalizePriceTable,
  priceUsage,
  resolvePrice,
} from '../src/prices.js'

const table = normalizePriceTable(BUILTIN_PRICE_TABLE)
const PEAK_MONDAY = Date.parse('2026-10-19T02:00:00Z') // 10:00 Beijing, weekday
const OFF_PEAK_SATURDAY = Date.parse('2026-10-17T02:00:00Z')
const HOLIDAY_MONDAY = Date.parse('2026-10-05T02:00:00Z')

test('built-in table prices the official Flash rate as off-peak on a weekend', () => {
  const resolved = resolvePrice(table, 'deepseek-official', 'deepseek-flash')
  assert.ok(resolved)
  assert.equal(resolved.model, 'deepseek-flash')
  const cost = priceUsage({
    inputTokens: 1_000_000,
    outputTokens: 250_000,
    cacheHitTokens: 500_000,
    cacheWriteTokens: 0,
  }, resolved, OFF_PEAK_SATURDAY)
  assert.equal(cost.tier, 'offPeak')
  assert.equal(cost.totalNano, 2_010_000_000)
  assert.equal(cost.totalNano / 1e9, 2.01)
})

test('peak windows, weekends, and statutory holidays are distinguished', () => {
  assert.equal(isPeakAt(PEAK_MONDAY, table), true)
  assert.equal(isPeakAt(OFF_PEAK_SATURDAY, table), false)
  assert.equal(isPeakAt(HOLIDAY_MONDAY, table), false)
  assert.ok(CHINA_2026_HOLIDAYS.includes('2026-10-05'))
})

test('peak Flash doubles every component', () => {
  const resolved = resolvePrice(table, 'deepseek-account', 'deepseek-flash')
  const off = priceUsage({ inputTokens: 1000, outputTokens: 1000, cacheHitTokens: 1000, cacheWriteTokens: 0 }, resolved, OFF_PEAK_SATURDAY)
  const peak = priceUsage({ inputTokens: 1000, outputTokens: 1000, cacheHitTokens: 1000, cacheWriteTokens: 0 }, resolved, PEAK_MONDAY)
  assert.equal(peak.totalNano, off.totalNano * 2)
})

test('cache writes default to the cache-miss input rate', () => {
  const resolved = resolvePrice(table, 'deepseek-official', 'deepseek-flash')
  const cost = priceUsage({ inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheWriteTokens: 1_000_000 }, resolved, OFF_PEAK_SATURDAY)
  assert.equal(cost.cacheWriteNano, 1_000_000_000)
})

test('legacy Flash model names resolve to the Flash rate', () => {
  const resolved = resolvePrice(table, 'deepseek-official', 'deepseek-v4-flash-vision-exp')
  assert.equal(resolved.model, 'deepseek-v4-flash-vision-exp')
  const dated = resolvePrice(table, 'deepseek-official', 'deepseek-flash-20261017')
  assert.equal(dated.model, 'deepseek-flash')
})

test('a reseller provider is never silently priced with official rates', () => {
  assert.equal(resolvePrice(table, 'chenyuzhiyun', 'deepseek-flash'), undefined)
  assert.equal(resolvePrice(table, 'opencodex', 'gpt-5.5'), undefined)
})

test('a custom table can add a provider or a wildcard provider explicitly', () => {
  const custom = normalizePriceTable({
    version: 'test',
    timeZone: 'Asia/Shanghai',
    peakHours: [],
    models: {
      chenyuzhiyun: {
        'deepseek-flash': { offPeak: { input: 1.5, cacheHit: 0.03, output: 6 } },
      },
      '*': {
        'gpt-5.5': { offPeak: { input: 10, cacheHit: 0, output: 30 } },
      },
    },
  })
  const reseller = resolvePrice(custom, 'chenyuzhiyun', 'deepseek-flash')
  assert.equal(reseller.entry.offPeak.input, 1.5)
  assert.equal(reseller.table, custom)
  const wildcard = resolvePrice(custom, 'opencodex', 'gpt-5.5')
  assert.equal(wildcard.entry.offPeak.output, 30)
})

test('an invalid price table is rejected with a useful message', () => {
  assert.throws(function () {
    normalizePriceTable({ models: { p: { m: { offPeak: { input: -1, output: 1 } } } } })
  }, /input/)
  assert.throws(function () {
    normalizePriceTable({ timeZone: 'Mars/Olympus', models: { p: { m: { offPeak: { input: 1, output: 1 } } } } })
  }, /timeZone/)
  assert.throws(function () {
    normalizePriceTable({ models: {} })
  }, /models/)
})

test('zone keys use the configured timezone', () => {
  assert.equal(dayKey(PEAK_MONDAY, 'Asia/Shanghai'), '2026-10-19')
  assert.equal(hourKey(PEAK_MONDAY, 'Asia/Shanghai'), '2026-10-19T10')
  assert.equal(dayKey(PEAK_MONDAY, 'UTC'), '2026-10-19')
  assert.equal(hourKey(PEAK_MONDAY, 'UTC'), '2026-10-19T02')
})

test('token estimates follow the documented character ratios', () => {
  assert.equal(estimateTextTokens(''), 0)
  assert.equal(estimateTextTokens('abcd'), 2)
  assert.equal(estimateTextTokens('中文'), 2)
  assert.equal(estimatePromptTokens({
    system: 'abcd',
    messages: [{ role: 'user', content: '中文' }],
  }), 3)
})
