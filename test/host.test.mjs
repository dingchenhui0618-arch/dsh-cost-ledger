import { strict as assert } from 'node:assert'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/host.js'
import { makeHome, makeRecord } from './fixtures.mjs'

const TEST_PRICES = {
  version: 'test-1',
  timeZone: 'Asia/Shanghai',
  peakHours: [],
  models: {
    'test-provider': {
      'test-model': {
        offPeak: { input: 1, output: 2, cacheHit: 0.1 },
      },
    },
  },
}

function setup(options) {
  const settings = options || {}
  const home = settings.home || makeHome()
  const listeners = new Map()
  const routes = []
  const disposers = []
  const webServer = {
    register(route) {
      if (settings.registerThrows === true) throw new Error('webServer.register is unavailable')
      routes.push(route)
      return function () {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
  const ctx = {
    webServer,
    get() { return undefined },
    on(event, listener) {
      listeners.set(event, listener)
      const dispose = function () {
        if (listeners.get(event) === listener) listeners.delete(event)
      }
      disposers.push(dispose)
      return dispose
    },
    effect(fn) {
      const dispose = fn()
      const wrapped = typeof dispose === 'function' ? dispose : function () {}
      disposers.push(wrapped)
      return wrapped
    },
  }
  apply(ctx, Object.assign({ dshHome: home }, settings.config))
  return {
    home,
    listeners,
    routes,
    dispose() {
      const pending = disposers.splice(0)
      for (const dispose of pending) dispose()
    },
    async consume(options, chunks, breakAfter) {
      const listener = listeners.get('llm/stream')
      assert.ok(listener, 'llm/stream listener was registered')
      const stream = listener(options, function () {
        return (async function* () {
          for (const chunk of chunks) yield chunk
        })()
      })
      const out = []
      for await (const chunk of stream) {
        out.push(chunk)
        if (breakAfter !== undefined && out.length >= breakAfter) break
      }
      return out
    },
    async request(method, path, body) {
      assert.ok(routes.length > 0, 'web route was registered')
      const route = routes[0]
      const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
      const req = Readable.from(payload)
      req.method = method
      req.url = path
      const res = {
        statusCode: 0,
        headers: {},
        body: '',
        setHeader(key, value) { this.headers[key.toLowerCase()] = value },
        end(chunk) { this.body = chunk === undefined ? '' : String(chunk) },
      }
      await route.handler(req, res)
      let json
      try { json = JSON.parse(res.body) } catch (error) { json = undefined }
      return { status: res.statusCode, headers: res.headers, body: res.body, json }
    },
  }
}

function streamOptions(overrides) {
  return Object.assign({
    provider: 'test-provider',
    model: 'test-model',
    sessionId: 'session-a',
    system: 'hello',
    messages: [{ role: 'user', content: 'hi' }],
  }, overrides)
}

function usageChunks(usage) {
  return [
    { type: 'text-delta', index: 0, text: 'ok' },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

test('one streamed call becomes one priced ledger row with adapter usage', async () => {
  const h = setup({ config: { prices: TEST_PRICES } })
  const chunks = usageChunks({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 100, cacheWriteTokens: 0 })
  const streamed = await h.consume(streamOptions(), chunks)
  assert.equal(streamed.length, 3)
  const state = await h.request('GET', '/dsh-cost-ledger/state')
  assert.equal(state.status, 200)
  assert.equal(state.json.totals.calls, 1)
  assert.equal(state.json.totals.estimatedNano, 1_410_000)
  assert.equal(state.json.recent.length, 1)
  assert.equal(state.json.recent[0].usageSource, 'adapter')
  assert.equal(state.json.recent[0].inputTokens, 1000)
  assert.equal(state.json.recent[0].cacheHitTokens, 100)
  assert.equal(state.json.recent[0].priceTier, 'offPeak')
  assert.equal(state.json.prices.version, 'test-1')
  assert.ok(existsSync(join(h.home, 'cost-ledger.jsonl')))
  assert.equal(readFileSync(join(h.home, 'cost-ledger.jsonl'), 'utf8').trim().split('\n').length, 1)
})

test('a stream without a usage chunk is recorded as an estimate, never as adapter truth', async () => {
  const h = setup({ config: { prices: TEST_PRICES } })
  await h.consume(streamOptions({ system: 'abcd' }), [
    { type: 'text-delta', index: 0, text: '中文' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const state = await h.request('GET', '/dsh-cost-ledger/state')
  const record = state.json.recent[0]
  assert.equal(record.usageSource, 'estimated')
  assert.ok(record.inputTokens > 0)
  assert.ok(record.outputTokens > 0)
  assert.equal(record.priced, true)
})

test('an unknown provider/model stays unpriced and visible in totals', async () => {
  const h = setup({ config: { prices: TEST_PRICES } })
  await h.consume(streamOptions({ provider: 'chenyuzhiyun', model: 'deepseek-flash' }), usageChunks({ inputTokens: 10, outputTokens: 10 }))
  const state = await h.request('GET', '/dsh-cost-ledger/state')
  assert.equal(state.json.recent[0].priced, false)
  assert.equal(state.json.recent[0].costNano, 0)
  assert.equal(state.json.totals.unpricedCalls, 1)
})

test('a stream error is recorded and rethrown unchanged', async () => {
  const h = setup({ config: { prices: TEST_PRICES } })
  await assert.rejects(function () {
    return h.consume(streamOptions(), (function* () {
      yield { type: 'text-delta', index: 0, text: 'partial' }
      throw new Error('upstream exploded')
    })())
  }, /upstream exploded/)
  const state = await h.request('GET', '/dsh-cost-ledger/state')
  assert.equal(state.json.recent[0].status, 'error')
  assert.match(state.json.recent[0].error, /upstream exploded/)
})

test('a consumer that stops early is recorded as interrupted, not ok', async () => {
  const h = setup({ config: { prices: TEST_PRICES } })
  await h.consume(streamOptions(), usageChunks({ inputTokens: 10, outputTokens: 10 }), 1)
  const state = await h.request('GET', '/dsh-cost-ledger/state')
  assert.equal(state.json.recent[0].status, 'interrupted')
})

test('a failed route registration leaves capture working', async () => {
  const h = setup({ registerThrows: true, config: { prices: TEST_PRICES } })
  await h.consume(streamOptions(), usageChunks({ inputTokens: 10, outputTokens: 10 }))
  const lines = readFileSync(join(h.home, 'cost-ledger.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  assert.equal(h.routes.length, 0)
})

test('unload removes the stream listener and the route', async () => {
  const h = setup({ config: { prices: TEST_PRICES } })
  assert.equal(h.listeners.size, 1)
  assert.equal(h.routes.length, 1)
  h.dispose()
  assert.equal(h.listeners.size, 0)
  assert.equal(h.routes.length, 0)
})

test('a posted bill appears as a separate actual column and a diff', async () => {
  const h = setup({ config: { prices: TEST_PRICES } })
  await h.consume(streamOptions(), usageChunks({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 100 }))
  const save = await h.request('POST', '/dsh-cost-ledger/bill', {
    scope: 'day', key: '2026-10-19', amountCny: '0.01', note: '平台账单',
  })
  assert.equal(save.status, 200)
  assert.equal(save.json.ok, true)
  const state = await h.request('GET', '/dsh-cost-ledger/state')
  const row = state.json.scopes.day.rows.find(function (item) { return item.key === '2026-10-19' })
  assert.equal(row.estimatedNano, 1_410_000)
  assert.equal(row.actualNano, 10_000_000)
  assert.equal(row.diffNano, 8_590_000)
  assert.equal(row.billNote, '平台账单')
})

test('deleting a bill removes the actual column but keeps the estimate', async () => {
  const h = setup({ config: { prices: TEST_PRICES } })
  await h.consume(streamOptions(), usageChunks({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 100 }))
  await h.request('POST', '/dsh-cost-ledger/bill', { scope: 'day', key: '2026-10-19', amountCny: '0.01' })
  const removed = await h.request('POST', '/dsh-cost-ledger/bill', { scope: 'day', key: '2026-10-19', amountCny: null })
  assert.equal(removed.json.ok, true)
  const state = await h.request('GET', '/dsh-cost-ledger/state')
  const row = state.json.scopes.day.rows.find(function (item) { return item.key === '2026-10-19' })
  assert.equal(row.actualNano, null)
  assert.equal(row.estimatedNano, 1_410_000)
})

test('CSV export and dry-run preview are both available over HTTP', async () => {
  const h = setup({ config: { prices: TEST_PRICES } })
  await h.consume(streamOptions(), usageChunks({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 100 }))
  const csv = await h.request('GET', '/dsh-cost-ledger/export?format=csv&scope=day')
  assert.equal(csv.status, 200)
  assert.match(csv.headers['content-type'], /text\/csv/)
  assert.match(csv.headers['content-disposition'], /attachment/)
  assert.match(csv.body, /estimated_cny/)
  const dry = await h.request('GET', '/dsh-cost-ledger/export?format=csv&scope=day&dryRun=1')
  assert.equal(dry.status, 200)
  assert.equal(dry.json.dryRun, true)
  assert.match(dry.json.preview, /dry-run/)
  assert.doesNotMatch(dry.json.preview, /^scope,period/m)
})

test('reload picks up an edited price file for future calls only', async () => {
  const home = makeHome()
  const pricesPath = join(home, 'prices.json')
  writeFileSync(pricesPath, JSON.stringify(TEST_PRICES), 'utf8')
  const h = setup({ home, config: { pricesPath } })
  await h.consume(streamOptions(), usageChunks({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 100 }))
  const changed = Object.assign({}, TEST_PRICES, {
    version: 'test-2',
    models: {
      'test-provider': {
        'test-model': { offPeak: { input: 2, output: 2, cacheHit: 0.1 } },
      },
    },
  })
  writeFileSync(pricesPath, JSON.stringify(changed), 'utf8')
  const reload = await h.request('POST', '/dsh-cost-ledger/reload', {})
  assert.equal(reload.status, 200)
  assert.equal(reload.json.prices.version, 'test-2')
  await h.consume(streamOptions(), usageChunks({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 100 }))
  const state = await h.request('GET', '/dsh-cost-ledger/state')
  assert.equal(state.json.recent[0].costNano, 2_410_000)
  assert.equal(state.json.recent[1].costNano, 1_410_000)
})

test('invalid inline prices fall back to the builtin table and report the error', async () => {
  const h = setup({ config: { prices: { models: { bad: { m: { offPeak: { input: -1, output: 0 } } } } } } })
  const state = await h.request('GET', '/dsh-cost-ledger/state')
  assert.equal(state.json.prices.source, 'builtin')
  assert.match(state.json.prices.error, /回退内置表/)
})

test('missing webServer still leaves capture alive', async () => {
  const home = makeHome()
  const listeners = new Map()
  const ctx = {
    get() { return undefined },
    on(event, listener) { listeners.set(event, listener); return function () {} },
    effect(fn) { return fn() },
  }
  apply(ctx, { dshHome: home, prices: TEST_PRICES })
  assert.equal(listeners.size, 1)
  const listener = listeners.get('llm/stream')
  const stream = listener(streamOptions(), function () {
    return (async function* () {
      for (const chunk of usageChunks({ inputTokens: 1000, outputTokens: 200 })) yield chunk
    })()
  })
  for await (const chunk of stream) void chunk
  const lines = readFileSync(join(home, 'cost-ledger.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
})
