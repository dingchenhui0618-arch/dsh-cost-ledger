// Host half of dsh-cost-ledger.
//
// Capture point: the `llm/stream` waterfall. The listener wraps the downstream
// AsyncIterable, reads the `usage` chunk when the adapter emits one, and writes
// exactly one ledger row when the stream settles. It never changes the request
// or the chunks, and every error path is contained: a broken ledger must not
// break a model call.
//
// The panel route is disposable and independent of capture. If `webServer`
// cannot register the route, model-call accounting continues.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_PRICE_TABLE, estimatePromptTokens, normalizePriceTable, parsePriceTableJson, priceUsage, resolvePrice } from './prices.js'
import { LedgerStore, readJsonl, SCOPES } from './ledger.js'
import { buildReport, previewText, reportFilename, toCsv, toJson } from './report.js'

export const name = 'dsh-cost-ledger'
export const inject = ['webServer']

const MAX_BODY = 1_048_576
const ROUTE = '/dsh-cost-ledger'
const DEFAULT_LEDGER = 'cost-ledger.jsonl'
const DEFAULT_BILLS = 'cost-ledger-bills.json'
const DEFAULT_PRICES = 'cost-ledger-prices.json'

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function sendText(res, status, body, headers) {
  res.statusCode = status
  for (const [key, value] of Object.entries(headers || {})) res.setHeader(key, value)
  res.end(body)
}

function readBody(req) {
  return new Promise(function (resolve) {
    let raw = ''
    req.on('data', function (chunk) {
      raw += chunk
      if (raw.length > MAX_BODY) {
        req.destroy()
        resolve(undefined)
      }
    })
    req.on('end', function () {
      if (raw.length === 0) return resolve({})
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined)
      } catch (error) {
        resolve(undefined)
      }
    })
    req.on('error', function () { resolve(undefined) })
  })
}

function methodFromUrl(url) {
  const path = String(url || '').split('?')[0]
  return path.replace(/^\/dsh-cost-ledger\/?/, '') || 'state'
}

function queryOf(url) {
  try {
    return new URL(String(url || ''), 'http://ledger.local').searchParams
  } catch (error) {
    return new URLSearchParams()
  }
}

function loadPrices(config) {
  const inline = config && config.prices
  if (inline !== undefined) {
    try {
      const table = normalizePriceTable(inline)
      return { table, source: 'inline', path: '', error: '', version: table.version }
    } catch (error) {
      return { table: normalizePriceTable(BUILTIN_PRICE_TABLE), source: 'builtin', path: '', error: 'inline prices 配置无效，已回退内置表：' + String(error.message || error), version: BUILTIN_PRICE_TABLE.version }
    }
  }
  const path = config && typeof config.pricesPath === 'string' ? config.pricesPath : ''
  if (path.length > 0 && existsSync(path)) {
    try {
      const table = parsePriceTableJson(readFileSync(path, 'utf8'), path)
      return { table, source: 'file', path, error: '', version: table.version }
    } catch (error) {
      return { table: normalizePriceTable(BUILTIN_PRICE_TABLE), source: 'builtin', path, error: '价目表读取失败，已回退内置表：' + String(error.message || error), version: BUILTIN_PRICE_TABLE.version }
    }
  }
  return { table: normalizePriceTable(BUILTIN_PRICE_TABLE), source: 'builtin', path, error: '', version: BUILTIN_PRICE_TABLE.version }
}

function priceInfo(prices, config) {
  const table = prices.table
  const providers = Object.keys(table.models)
  let modelCount = 0
  for (const provider of providers) modelCount += Object.keys(table.models[provider]).length
  return {
    source: prices.source,
    path: prices.path,
    version: prices.version,
    sourceUrl: table.sourceUrl || '',
    currency: table.currency,
    unit: table.unit,
    timeZone: table.timeZone,
    peakHours: table.peakHours,
    holidays: table.holidays.length,
    providers,
    modelCount,
    error: prices.error,
    builtinOnlyOfficial: prices.source === 'builtin',
  }
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function usageFromChunk(usage) {
  if (typeof usage !== 'object' || usage === null) return undefined
  return {
    inputTokens: tokenCount(usage.inputTokens),
    outputTokens: tokenCount(usage.outputTokens),
    cacheHitTokens: tokenCount(usage.cacheReadTokens),
    cacheWriteTokens: tokenCount(usage.cacheWriteTokens),
    reasoningTokens: tokenCount(usage.reasoningTokens),
  }
}

function addChars(acc, text) {
  if (typeof text !== 'string' || text.length === 0) return
  for (const char of text) {
    if (char.codePointAt(0) >= 0x2e80) acc.wideChars += 1
    else acc.asciiChars += 1
  }
}

function estimateChars(acc) {
  return Math.ceil(acc.wideChars * 0.6 + acc.asciiChars * 0.3)
}

function sessionOf(options) {
  if (options && typeof options.sessionId === 'string' && options.sessionId.length > 0) return options.sessionId
  if (options && typeof options.purpose === 'string' && options.purpose.length > 0) return 'purpose:' + options.purpose
  return 'unattributed'
}

function statusOf(acc) {
  if (acc.error !== '') return 'error'
  if (acc.finish === 'error') return 'error'
  if (acc.finish === 'aborted') return 'aborted'
  if (!acc.completed) return 'interrupted'
  if (acc.finish === 'unknown') return 'ended'
  return 'ok'
}

function makeRecord(options, acc, prices, started, finished, index) {
  const at = started
  const usage = acc.usage
  const promptEstimate = usage === undefined ? estimatePromptTokens(options) : 0
  const completionEstimate = usage === undefined ? estimateChars(acc) : 0
  const usageSource = usage !== undefined ? 'adapter' : (promptEstimate + completionEstimate > 0 ? 'estimated' : 'missing')
  const tokens = usage === undefined
    ? {
        inputTokens: promptEstimate,
        outputTokens: completionEstimate,
        cacheHitTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      }
    : usage
  const resolved = resolvePrice(prices.table, String(options.provider || ''), String(options.model || ''))
  let cost
  if (resolved !== undefined) {
    try {
      cost = priceUsage(tokens, resolved, at)
    } catch (error) {
      cost = undefined
    }
  }
  const priced = cost !== undefined
  const costs = cost === undefined
    ? { inputNano: 0, cacheHitNano: 0, cacheWriteNano: 0, outputNano: 0, totalNano: 0 }
    : cost
  return {
    v: 1,
    id: String(at) + '-' + String(index),
    at,
    hour: '',
    day: '',
    session: sessionOf(options),
    provider: String(options.provider || 'unknown'),
    model: String(options.model || 'unknown'),
    purpose: typeof options.purpose === 'string' ? options.purpose : '',
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheHitTokens: tokens.cacheHitTokens,
    cacheWriteTokens: tokens.cacheWriteTokens,
    reasoningTokens: tokens.reasoningTokens,
    usageSource,
    priced,
    priceTier: cost === undefined ? null : cost.tier,
    priceModel: resolved === undefined ? '' : resolved.model,
    costInputNano: costs.inputNano,
    costCacheHitNano: costs.cacheHitNano,
    costCacheWriteNano: costs.cacheWriteNano,
    costOutputNano: costs.outputNano,
    costNano: costs.totalNano,
    status: statusOf(acc),
    finish: acc.finish || 'unknown',
    ms: Math.max(0, finished - started),
    error: acc.error,
  }
}

export function apply(ctx, config) {
  const settings = config && typeof config === 'object' ? config : {}
  const home = typeof settings.dshHome === 'string' ? settings.dshHome : dshHome()
  const timeZone = typeof settings.timeZone === 'string' ? settings.timeZone : 'Asia/Shanghai'
  const ledgerPath = typeof settings.ledgerPath === 'string' ? settings.ledgerPath : join(home, DEFAULT_LEDGER)
  const billsPath = typeof settings.billsPath === 'string' ? settings.billsPath : join(home, DEFAULT_BILLS)
  const pricesPath = typeof settings.pricesPath === 'string' ? settings.pricesPath : join(home, DEFAULT_PRICES)
  const priceConfig = Object.assign({}, settings, { pricesPath })
  let prices = loadPrices(priceConfig)
  const store = new LedgerStore({
    ledgerPath,
    billsPath,
    timeZone,
    maxRecent: settings.maxRecent,
  })
  store.load()
  const stats = { calls: 0, priced: 0, unpriced: 0, estimated: 0, errors: 0 }
  let callIndex = 0

  function capture(options, next) {
    const started = Date.now()
    const acc = {
      usage: undefined,
      wideChars: 0,
      asciiChars: 0,
      finish: 'unknown',
      error: '',
      completed: false,
    }
    let stream
    try {
      stream = next()
    } catch (error) {
      acc.error = String((error && error.message) || error)
      try {
        store.add(makeRecord(options, acc, prices, started, Date.now(), ++callIndex), true)
      } catch (inner) {
        // capture must never replace the original exception
      }
      stats.errors += 1
      throw error
    }
    return (async function* () {
      try {
        for await (const chunk of stream) {
          if (chunk && typeof chunk === 'object') {
            if (chunk.type === 'usage') {
              const parsed = usageFromChunk(chunk.usage)
              if (parsed !== undefined) acc.usage = parsed
            } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
              addChars(acc, chunk.text)
            } else if (chunk.type === 'tool-call-delta') {
              addChars(acc, chunk.argumentsDelta)
            } else if (chunk.type === 'finish') {
              acc.finish = chunk.reason && chunk.reason.kind ? String(chunk.reason.kind) : 'unknown'
            }
          }
          yield chunk
        }
        acc.completed = true
      } catch (error) {
        acc.error = String((error && error.message) || error)
        throw error
      } finally {
        try {
          const record = makeRecord(options, acc, prices, started, Date.now(), ++callIndex)
          // Fill the Beijing calendar keys using the same helper the store uses.
          const normalized = store.add(record, true)
          if (normalized !== undefined) {
            stats.calls += 1
            if (record.priced) stats.priced += 1
            else stats.unpriced += 1
            if (record.usageSource === 'estimated') stats.estimated += 1
            if (record.status === 'error' || record.status === 'aborted') stats.errors += 1
          }
        } catch (error) {
          // A ledger write failure must not affect the model stream.
        }
      }
    })()
  }

  ctx.on('llm/stream', function (options, next) {
    return capture(options, next)
  })

  ctx.effect(function () {
    let disposeRoute
    try {
      disposeRoute = ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async function (req, res) {
          try {
            const method = methodFromUrl(req.url)
            const query = queryOf(req.url)
            if (req.method === 'GET' && method === 'state') {
              const snapshot = store.snapshot()
              snapshot.prices = priceInfo(prices, settings)
              snapshot.capture = stats
              snapshot.exportable = { json: true, csv: true, dryRun: true, scopes: SCOPES }
              sendJson(res, 200, snapshot)
              return
            }
            if (req.method === 'GET' && method === 'export') {
              const format = query.get('format') === 'csv' ? 'csv' : 'json'
              const scope = SCOPES.includes(query.get('scope')) ? query.get('scope') : 'day'
              const detail = query.get('detail') === '1' || query.get('detail') === 'true'
              const dryRun = query.get('dryRun') === '1' || query.get('dryRun') === 'true'
              const read = readJsonl(ledgerPath, { timeZone })
              const report = buildReport({
                records: read.records,
                bills: store.bills,
                scope,
                detail,
                now: Date.now(),
                source: { ledgerPath, skippedRecords: read.skipped },
              })
              if (dryRun) {
                sendJson(res, 200, {
                  ok: true,
                  dryRun: true,
                  format,
                  scope,
                  detail,
                  recordCount: report.recordCount,
                  rows: report.rows.slice(0, 20),
                  preview: previewText(report, 8),
                })
                return
              }
              const content = format === 'csv' ? toCsv(report) : toJson(report)
              sendText(res, 200, content, {
                'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
                'content-disposition': 'attachment; filename="' + reportFilename(report, format) + '"',
                'cache-control': 'no-store',
              })
              return
            }
            if (req.method === 'POST' && method === 'bill') {
              const body = await readBody(req)
              if (body === undefined) {
                sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' })
                return
              }
              const scope = body.scope
              const key = typeof body.key === 'string' ? body.key : ''
              if (body.amountCny === null || body.amountCny === '') {
                if (!SCOPES.includes(scope) || key.length === 0) {
                  sendJson(res, 400, { ok: false, error: '删除账单需要 scope 与 key' })
                  return
                }
                const removed = store.deleteBill(scope, key)
                sendJson(res, removed ? 200 : 404, { ok: removed, removed })
                return
              }
              try {
                const bill = store.setBill({ scope, key, amountCny: body.amountCny, note: body.note })
                sendJson(res, 200, { ok: true, bill })
              } catch (error) {
                sendJson(res, 400, { ok: false, error: String(error.message || error) })
              }
              return
            }
            if (req.method === 'POST' && method === 'reload') {
              prices = loadPrices(priceConfig)
              store.reloadBills()
              const snapshot = store.snapshot()
              snapshot.prices = priceInfo(prices, settings)
              snapshot.capture = stats
              sendJson(res, 200, snapshot)
              return
            }
            if (method === 'state' || method === 'export' || method === 'bill' || method === 'reload') {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            sendJson(res, 404, { error: 'unknown method' })
          } catch (error) {
            sendJson(res, 500, { error: String((error && error.message) || error) })
          }
        },
      })
    } catch (error) {
      disposeRoute = undefined
    }
    return function () {
      if (typeof disposeRoute === 'function') disposeRoute()
    }
  })
}
