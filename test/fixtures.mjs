// Shared test fixtures. Kept dependency-free and explicit so every record's
// nano-CNY components add up to its total.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function makeHome(prefix) {
  return mkdtempSync(join(tmpdir(), (prefix || 'cost-ledger-test-') + '-'))
}

let nextId = 1

export function makeRecord(overrides) {
  const raw = overrides || {}
  const at = raw.at === undefined ? Date.parse('2026-10-19T02:00:00Z') : raw.at
  const inputTokens = raw.inputTokens === undefined ? 1000 : raw.inputTokens
  const outputTokens = raw.outputTokens === undefined ? 200 : raw.outputTokens
  const cacheHitTokens = raw.cacheHitTokens === undefined ? 100 : raw.cacheHitTokens
  const cacheWriteTokens = raw.cacheWriteTokens === undefined ? 0 : raw.cacheWriteTokens
  const reasoningTokens = raw.reasoningTokens === undefined ? 0 : raw.reasoningTokens
  const costInputNano = raw.costInputNano === undefined ? 1000 : raw.costInputNano
  const costCacheHitNano = raw.costCacheHitNano === undefined ? 20 : raw.costCacheHitNano
  const costCacheWriteNano = raw.costCacheWriteNano === undefined ? 0 : raw.costCacheWriteNano
  const costOutputNano = raw.costOutputNano === undefined ? 800 : raw.costOutputNano
  const costNano = raw.costNano === undefined
    ? costInputNano + costCacheHitNano + costCacheWriteNano + costOutputNano
    : raw.costNano
  return {
    v: 1,
    id: raw.id || 'call-' + (nextId++),
    at,
    hour: raw.hour === undefined ? '' : raw.hour,
    day: raw.day === undefined ? '' : raw.day,
    session: raw.session === undefined ? 'session-a' : raw.session,
    provider: raw.provider === undefined ? 'test-provider' : raw.provider,
    model: raw.model === undefined ? 'test-model' : raw.model,
    purpose: raw.purpose || '',
    inputTokens,
    outputTokens,
    cacheHitTokens,
    cacheWriteTokens,
    reasoningTokens,
    usageSource: raw.usageSource || 'adapter',
    priced: raw.priced === undefined ? true : raw.priced,
    priceTier: raw.priceTier === undefined ? 'offPeak' : raw.priceTier,
    priceModel: raw.priceModel === undefined ? 'test-model' : raw.priceModel,
    costInputNano,
    costCacheHitNano,
    costCacheWriteNano,
    costOutputNano,
    costNano,
    status: raw.status || 'ok',
    finish: raw.finish || 'stop',
    ms: raw.ms === undefined ? 5 : raw.ms,
    error: raw.error || '',
  }
}

export function actionChunks(text, usage) {
  const chunks = [{ type: 'text-delta', index: 0, text: text }]
  if (usage !== undefined) chunks.push({ type: 'usage', usage })
  chunks.push({ type: 'finish', reason: { kind: 'stop' } })
  return chunks
}
