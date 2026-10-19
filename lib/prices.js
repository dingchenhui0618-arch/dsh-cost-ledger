// Price table and CNY cost arithmetic for dsh-cost-ledger.
//
// Design rules, because this file decides what "estimated cost" means:
//   1. Only an explicit provider + model match is priced. An unknown route is
//      NEVER silently priced with a lookalike model's rate.
//   2. Rates are CNY per 1,000,000 tokens, the unit used by DeepSeek's official
//      pricing page and by most resellers.
//   3. Cost is stored as integer nano-CNY (1 CNY = 1e9 nano-CNY). Integer sums
//      avoid floating-point drift in hour/day/session aggregates.
//   4. The built-in table is only a starting point for official DeepSeek
//      routes. A reseller provider (TokenRouter, OpenCodex, ...) is unpriced
//      until the user writes an explicit entry in prices.json.

export const CURRENCY = 'CNY'
export const UNIT = 'per_1m_tokens'
export const NANO_PER_CNY = 1_000_000_000
export const BUILTIN_PRICE_VERSION = '2026-10-19'
export const BUILTIN_PRICE_SOURCE_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'

// Chinese statutory holidays for 2026, as published by the State Council on
// 2025-11-04 (国办发明电〔2025〕7号). DeepSeek bills weekends and these dates
// at the off-peak rate all day. Make-up workdays that fall on a weekend stay
// off-peak, because the official rule is weekday-based.
export const CHINA_2026_HOLIDAYS = Object.freeze([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
])

const FLASH_OFF_PEAK = Object.freeze({ input: 1, cacheHit: 0.02, output: 4 })
const FLASH_PEAK = Object.freeze({ input: 2, cacheHit: 0.04, output: 8 })
const PRO_OFF_PEAK = Object.freeze({ input: 4.5, cacheHit: 0.15, output: 13.5 })
const PRO_PEAK = Object.freeze({ input: 9, cacheHit: 0.3, output: 27 })

function officialModels() {
  return {
    'deepseek-flash': { offPeak: FLASH_OFF_PEAK, peak: FLASH_PEAK },
    // Legacy names are still accepted by the API and billed as Flash.
    'deepseek-v4-flash': { offPeak: FLASH_OFF_PEAK, peak: FLASH_PEAK },
    'deepseek-v4-flash-vision-exp': { offPeak: FLASH_OFF_PEAK, peak: FLASH_PEAK },
    'deepseek-v4-pro': { offPeak: PRO_OFF_PEAK, peak: PRO_PEAK },
  }
}

export const BUILTIN_PRICE_TABLE = Object.freeze({
  currency: CURRENCY,
  unit: UNIT,
  version: BUILTIN_PRICE_VERSION,
  source: 'builtin: DeepSeek 官方模型与价格页（2026-10-19 抓取）',
  sourceUrl: BUILTIN_PRICE_SOURCE_URL,
  timeZone: 'Asia/Shanghai',
  peakHours: Object.freeze([Object.freeze([9, 12]), Object.freeze([14, 18])]),
  holidays: CHINA_2026_HOLIDAYS,
  models: Object.freeze({
    'deepseek-official': Object.freeze(officialModels()),
    'deepseek-account': Object.freeze(officialModels()),
  }),
})

function assertObject(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(label + ' 必须是对象')
  }
  return value
}

function numberField(value, label) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number < 0) throw new Error(label + ' 必须是非负数字')
  return number
}

function normalizeRate(value, label) {
  const raw = assertObject(value, label)
  const input = numberField(raw.input, label + '.input')
  const output = numberField(raw.output, label + '.output')
  const cacheHit = raw.cacheHit === undefined ? 0 : numberField(raw.cacheHit, label + '.cacheHit')
  // DeepSeek does not charge cache writes separately; a custom table may say
  // otherwise. Falling back to the miss rate is the conservative choice.
  const cacheWrite = raw.cacheWrite === undefined ? input : numberField(raw.cacheWrite, label + '.cacheWrite')
  return { input, output, cacheHit, cacheWrite }
}

function normalizeHolidays(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('holidays 必须是 YYYY-MM-DD 字符串数组')
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item)) {
      throw new Error('holidays 含非法日期：' + String(item))
    }
    out.push(item)
  }
  return out
}

function normalizePeakHours(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('peakHours 必须是 [start, end] 数组')
  return value.map(function (pair) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error('peakHours 每项必须是 [start, end]')
    const start = Number(pair[0])
    const end = Number(pair[1])
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24 || start >= end) {
      throw new Error('peakHours 的 start/end 必须是 0..24 的整数且 start < end')
    }
    return [start, end]
  })
}

/**
 * Validate and copy a price table. Unknown fields are dropped; every rate is
 * copied into a plain object so a caller cannot mutate the built-in table.
 * @param {unknown} value
 * @returns {object}
 */
export function normalizePriceTable(value) {
  const raw = assertObject(value, 'priceTable')
  const timeZone = typeof raw.timeZone === 'string' && raw.timeZone.length > 0 ? raw.timeZone : 'Asia/Shanghai'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0)
  } catch (error) {
    throw new Error('timeZone 不是有效的 IANA 时区：' + timeZone)
  }
  const modelsRaw = assertObject(raw.models, 'models')
  const models = {}
  for (const [provider, groupRaw] of Object.entries(modelsRaw)) {
    if (provider.length === 0) throw new Error('models 的 provider 不能为空')
    const group = assertObject(groupRaw, 'models.' + provider)
    const copy = {}
    for (const [model, entryRaw] of Object.entries(group)) {
      if (model.length === 0) throw new Error('models.' + provider + ' 的 model 不能为空')
      const entry = assertObject(entryRaw, 'models.' + provider + '.' + model)
      const offPeak = normalizeRate(entry.offPeak ?? entry.rate, 'models.' + provider + '.' + model + '.offPeak')
      const copyEntry = { offPeak }
      if (entry.peak !== undefined) copyEntry.peak = normalizeRate(entry.peak, 'models.' + provider + '.' + model + '.peak')
      copy[model] = copyEntry
    }
    if (Object.keys(copy).length === 0) throw new Error('models.' + provider + ' 不能为空')
    models[provider] = copy
  }
  if (Object.keys(models).length === 0) throw new Error('models 不能为空')
  return {
    currency: typeof raw.currency === 'string' ? raw.currency : CURRENCY,
    unit: typeof raw.unit === 'string' ? raw.unit : UNIT,
    version: typeof raw.version === 'string' ? raw.version : 'custom',
    source: typeof raw.source === 'string' ? raw.source : 'custom',
    sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl : '',
    timeZone,
    peakHours: normalizePeakHours(raw.peakHours),
    holidays: normalizeHolidays(raw.holidays),
    models,
  }
}

/** Read and validate a JSON price table file. */
export function parsePriceTableJson(text, label) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error((label || '价目表') + ' 不是合法 JSON：' + String(error.message || error))
  }
  return normalizePriceTable(parsed)
}

/** Calendar fields in one IANA timezone (default Asia/Shanghai). */
export function zonedParts(at, timeZone) {
  const zone = timeZone || 'Asia/Shanghai'
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at))
  const pick = function (type) {
    const found = parts.find(function (part) { return part.type === type })
    return found === undefined ? '' : found.value
  }
  const year = Number(pick('year'))
  const month = Number(pick('month'))
  const day = Number(pick('day'))
  const hour = Number(pick('hour'))
  if (![year, month, day, hour].every(Number.isInteger)) throw new Error('无法解析时间戳：' + at)
  // Weekday from the civil date, so no locale-dependent weekday string is used.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return { year, month, day, hour, weekday }
}

function pad2(value) {
  return value < 10 ? '0' + value : String(value)
}

function padYear(value) {
  return String(value).padStart(4, '0')
}

export function dayKey(at, timeZone) {
  const p = zonedParts(at, timeZone)
  return padYear(p.year) + '-' + pad2(p.month) + '-' + pad2(p.day)
}

export function hourKey(at, timeZone) {
  const p = zonedParts(at, timeZone)
  return dayKey(at, timeZone) + 'T' + pad2(p.hour)
}

/** Whether `at` falls in a configured peak window on a weekday. */
export function isPeakAt(at, table) {
  if (!table || !Array.isArray(table.peakHours) || table.peakHours.length === 0) return false
  const parts = zonedParts(at, table.timeZone)
  if (parts.weekday === 0 || parts.weekday === 6) return false
  const date = padYear(parts.year) + '-' + pad2(parts.month) + '-' + pad2(parts.day)
  if (Array.isArray(table.holidays) && table.holidays.includes(date)) return false
  return table.peakHours.some(function (window) {
    return parts.hour >= window[0] && parts.hour < window[1]
  })
}

/**
 * Resolve one explicit provider + model price entry.
 * Exact model match wins; then the longest `name-` prefix (dated model
 * suffixes). A provider-level `*` group is used only when the exact provider
 * has no entry. No cross-model fallback exists.
 */
export function resolvePrice(table, provider, model) {
  if (!table || typeof provider !== 'string' || typeof model !== 'string') return undefined
  const providerOrder = table.models[provider] !== undefined ? [provider, '*'] : ['*']
  for (const providerKey of providerOrder) {
    const group = table.models[providerKey]
    if (group === undefined) continue
    if (group[model] !== undefined) {
      return { table, providerKey, model: model, entry: group[model] }
    }
    let best
    for (const name of Object.keys(group)) {
      if (model.startsWith(name + '-') && (best === undefined || name.length > best.length)) best = name
    }
    if (best !== undefined) return { table, providerKey, model: best, entry: group[best] }
  }
  return undefined
}

/**
 * Price one usage object in nano-CNY. Token counts follow Harness semantics:
 * `inputTokens` is cache-miss input; cache-read and cache-write are separate.
 */
export function priceUsage(usage, resolved, at) {
  if (resolved === undefined) return undefined
  const tokens = {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheHit: usage.cacheHitTokens === undefined ? 0 : usage.cacheHitTokens,
    cacheWrite: usage.cacheWriteTokens === undefined ? 0 : usage.cacheWriteTokens,
  }
  for (const [name, value] of Object.entries(tokens)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('token 数必须是非负安全整数：' + name)
  }
  const peak = isPeakAt(at, resolved.table)
  const rate = peak && resolved.entry.peak !== undefined ? resolved.entry.peak : resolved.entry.offPeak
  const inputNano = Math.round(tokens.input * rate.input * 1000)
  const cacheHitNano = Math.round(tokens.cacheHit * rate.cacheHit * 1000)
  const cacheWriteNano = Math.round(tokens.cacheWrite * rate.cacheWrite * 1000)
  const outputNano = Math.round(tokens.output * rate.output * 1000)
  return {
    tier: peak && resolved.entry.peak !== undefined ? 'peak' : 'offPeak',
    rate: { input: rate.input, output: rate.output, cacheHit: rate.cacheHit, cacheWrite: rate.cacheWrite },
    inputNano,
    cacheHitNano,
    cacheWriteNano,
    outputNano,
    totalNano: inputNano + cacheHitNano + cacheWriteNano + outputNano,
  }
}

/**
 * Character-based token estimate, used only when the adapter emitted no usage
 * chunk. DeepSeek documents roughly 0.3 token per English character and 0.6
 * token per Chinese character; this is an estimate and is labelled as such.
 */
export function estimateTextTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let score = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    score += code >= 0x2e80 ? 0.6 : 0.3
  }
  return Math.ceil(score)
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    if (typeof block.text === 'string') text += block.text
    if (typeof block.arguments === 'string') text += block.arguments
  }
  return text
}

/** Estimate the prompt side from a GenerateOptions-shaped object. */
export function estimatePromptTokens(options) {
  if (typeof options !== 'object' || options === null) return 0
  let text = ''
  if (typeof options.system === 'string') text += options.system
  if (Array.isArray(options.messages)) {
    for (const message of options.messages) {
      if (typeof message !== 'object' || message === null) continue
      text += contentText(message.content)
    }
  }
  if (Array.isArray(options.tools)) {
    try {
      text += JSON.stringify(options.tools)
    } catch (error) {
      // A non-serialisable tools list contributes nothing to the estimate.
    }
  }
  return estimateTextTokens(text)
}
