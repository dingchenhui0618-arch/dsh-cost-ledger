// Command-line interface for dsh-cost-ledger.
//
// `export` writes JSON or CSV to stdout by default, or to --out. `--dry-run`
// prints a preview and guarantees that no target file is opened for writing.
// The CLI reads the same JSONL/bill files as the Host half; it never needs the
// harness to be running.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { BUILTIN_PRICE_TABLE, normalizePriceTable, parsePriceTableJson } from './prices.js'
import { formatNanoCny, normalizeBill, readBills, readJsonl, SCOPES, writeBills } from './ledger.js'
import { buildReport, previewText, toCsv, toJson } from './report.js'

const DEFAULT_LEDGER = 'cost-ledger.jsonl'
const DEFAULT_BILLS = 'cost-ledger-bills.json'
const DEFAULT_PRICES = 'cost-ledger-prices.json'

const HELP = [
  'dsh-cost-ledger — 可核对 token 成本账',
  '',
  '用法：',
  '  dsh-cost-ledger export [--json|--csv] [--scope hour|day|session] [--detail]',
  '                           [--since DATE] [--until DATE] [--out FILE] [--dry-run]',
  '  dsh-cost-ledger dry-run [同样的筛选参数]',
  '  dsh-cost-ledger bill set --scope day --key 2026-10-19 --amount 12.34 [--note 文本]',
  '  dsh-cost-ledger bill list [--json]',
  '  dsh-cost-ledger bill delete --scope day --key 2026-10-19',
  '  dsh-cost-ledger prices',
  '',
  '全局参数：',
  '  --home DIR       DSH_HOME（默认 $DSH_HOME 或 ~/.dsh）',
  '  --ledger FILE    账本 JSONL 路径',
  '  --bills FILE     手填账单 JSON 路径',
  '  --prices FILE    价目表 JSON 路径',
  '',
  '口径：估算费用 = 本地价目表 × adapter 上报的 token；实际费用 = 你手填的平台账单。',
  '未定价 provider/model 不会套用相似模型的费率，而是计入 unpriced。',
].join('\n') + '\n'

const VALUE_FLAGS = new Set(['scope', 'format', 'out', 'since', 'until', 'home', 'ledger', 'bills', 'prices', 'key', 'amount', 'note'])
const BOOLEAN_FLAGS = new Set(['json', 'csv', 'detail', 'dry-run', 'help'])

function parseFlags(args) {
  const flags = {}
  const positional = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') {
      positional.push(...args.slice(index + 1))
      break
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2)
      if (eq >= 0) {
        if (!VALUE_FLAGS.has(name)) throw new Error('未知参数：--' + name)
        flags[name] = arg.slice(eq + 1)
        continue
      }
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true
        continue
      }
      if (!VALUE_FLAGS.has(name)) throw new Error('未知参数：--' + name)
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error('--' + name + ' 需要一个值')
      flags[name] = value
      index += 1
      continue
    }
    positional.push(arg)
  }
  return { flags, positional }
}

function parseTime(value, endOfDay) {
  if (value === undefined) return undefined
  const text = String(value).trim()
  if (/^\d+$/.test(text)) return Number(text)
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const start = Date.parse(text + 'T00:00:00+08:00')
    if (!Number.isFinite(start)) throw new Error('无法解析日期：' + text)
    return endOfDay ? start + 86_400_000 - 1 : start
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(text)) {
    const start = Date.parse(text + ':00:00+08:00')
    if (!Number.isFinite(start)) throw new Error('无法解析小时：' + text)
    return endOfDay ? start + 3_600_000 - 1 : start
  }
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed)) throw new Error('无法解析时间：' + text)
  return parsed
}

function readPriceConfig(path, warn) {
  if (existsSync(path)) {
    try {
      return { table: parsePriceTableJson(readFileSync(path, 'utf8'), path), source: 'file', path, error: '' }
    } catch (error) {
      warn('价目表读取失败，回退内置表：' + String(error.message || error) + '\n')
    }
  }
  return { table: normalizePriceTable(BUILTIN_PRICE_TABLE), source: 'builtin', path, error: '' }
}

function resolvePaths(flags, base) {
  const home = flags.home || base.home || process.env.DSH_HOME || join(homedir(), '.dsh')
  return {
    home,
    ledgerPath: flags.ledger || join(home, DEFAULT_LEDGER),
    billsPath: flags.bills || join(home, DEFAULT_BILLS),
    pricesPath: flags.prices || join(home, DEFAULT_PRICES),
  }
}

function exportCommand(argv, context) {
  const { flags, positional } = parseFlags(argv)
  if (positional.length > 0) throw new Error('export 不接受位置参数：' + positional.join(' '))
  const format = flags.json ? 'json' : flags.csv ? 'csv' : (flags.format === 'csv' ? 'csv' : 'json')
  if (flags.format !== undefined && flags.format !== 'json' && flags.format !== 'csv') {
    throw new Error('--format 只能是 json 或 csv')
  }
  const scope = flags.scope || 'day'
  if (!SCOPES.includes(scope)) throw new Error('--scope 只能是 hour|day|session')
  const detail = flags.detail === true
  const dryRun = flags['dry-run'] === true
  const paths = resolvePaths(flags, context)
  const priceConfig = readPriceConfig(paths.pricesPath, context.warn)
  const read = readJsonl(paths.ledgerPath, { timeZone: priceConfig.table.timeZone })
  const billRead = readBills(paths.billsPath)
  if (read.skipped > 0) context.warn('已跳过 ' + read.skipped + ' 条损坏的账本记录\n')
  if (billRead.error) context.warn('账单文件读取失败：' + billRead.error + '\n')
  if (billRead.skipped > 0) context.warn('已跳过 ' + billRead.skipped + ' 条损坏的账单记录\n')
  const report = buildReport({
    records: read.records,
    bills: billRead.bills,
    scope,
    detail,
    since: parseTime(flags.since, false),
    until: parseTime(flags.until, true),
    source: {
      ledgerPath: paths.ledgerPath,
      billsPath: paths.billsPath,
      pricesPath: priceConfig.path,
      priceSource: priceConfig.source,
      priceVersion: priceConfig.table.version,
      skippedRecords: read.skipped,
      skippedBills: billRead.skipped,
    },
  })
  if (dryRun) {
    context.out(previewText(report, 12))
    if (flags.out) context.out('dry-run: 未写入 ' + flags.out + '\n')
    return 0
  }
  const content = format === 'csv' ? toCsv(report) : toJson(report)
  if (flags.out) {
    mkdirSync(dirname(flags.out), { recursive: true })
    writeFileSync(flags.out, content, 'utf8')
    context.out('wrote ' + flags.out + ' (' + report.rows.length + ' rows, ' + report.recordCount + ' calls)\n')
  } else {
    context.out(content)
  }
  return 0
}

function findOption(flags, name, fallback) {
  return flags[name] === undefined ? fallback : flags[name]
}

function billCommand(argv, context) {
  const sub = argv[0]
  const rest = argv.slice(1)
  const { flags } = parseFlags(rest)
  const paths = resolvePaths(flags, context)
  const read = readBills(paths.billsPath)
  if (read.error) throw new Error('账单文件读取失败：' + read.error)
  if (sub === 'list') {
    if (flags.json) {
      context.out(JSON.stringify({ bills: read.bills }, null, 2) + '\n')
      return 0
    }
    if (read.bills.length === 0) {
      context.out('（没有手填账单）\n')
      return 0
    }
    context.out('scope\tkey\tamount_cny\tupdated_at\tnote\n')
    for (const bill of read.bills) {
      context.out([bill.scope, bill.key, bill.amountCny, new Date(bill.updatedAt).toISOString(), bill.note].join('\t') + '\n')
    }
    return 0
  }
  if (sub === 'set') {
    const scope = findOption(flags, 'scope', 'day')
    const key = flags.key
    const amount = flags.amount
    if (!key || amount === undefined) throw new Error('bill set 需要 --key 与 --amount')
    const bill = normalizeBill({ scope, key, amountCny: amount, note: flags.note }, Date.now())
    const index = read.bills.findIndex(function (other) { return other.scope === bill.scope && other.key === bill.key })
    if (index >= 0) read.bills.splice(index, 1)
    read.bills.push(bill)
    writeBills(paths.billsPath, read.bills)
    context.out('saved ' + bill.scope + ' ' + bill.key + ' = ¥' + formatNanoCny(bill.actualNano, 6) + '\n')
    return 0
  }
  if (sub === 'delete') {
    const scope = findOption(flags, 'scope', 'day')
    const key = flags.key
    if (!key) throw new Error('bill delete 需要 --key')
    const index = read.bills.findIndex(function (bill) { return bill.scope === scope && bill.key === key })
    if (index < 0) {
      context.out('not found\n')
      return 1
    }
    read.bills.splice(index, 1)
    writeBills(paths.billsPath, read.bills)
    context.out('deleted ' + scope + ' ' + key + '\n')
    return 0
  }
  throw new Error('bill 子命令只能是 set|list|delete')
}

function pricesCommand(argv, context) {
  const { flags } = parseFlags(argv)
  const paths = resolvePaths(flags, context)
  const priceConfig = readPriceConfig(paths.pricesPath, context.warn)
  const table = priceConfig.table
  if (flags.json) {
    context.out(JSON.stringify(table, null, 2) + '\n')
    return 0
  }
  context.out('source: ' + priceConfig.source + (priceConfig.path ? ' (' + priceConfig.path + ')' : '') + '\n')
  context.out('version: ' + table.version + '\n')
  context.out('timeZone: ' + table.timeZone + '\n')
  for (const [provider, group] of Object.entries(table.models)) {
    for (const [model, entry] of Object.entries(group)) {
      context.out(provider + '\t' + model + '\toffPeak=' + JSON.stringify(entry.offPeak) + (entry.peak ? '\tpeak=' + JSON.stringify(entry.peak) : '') + '\n')
    }
  }
  return 0
}

/**
 * Run one CLI invocation. Pure enough to unit-test: pass `io` to capture output,
 * or let it return { code, stdout, stderr }.
 */
export function runCli(argv, options) {
  const opts = options || {}
  const chunks = []
  const errors = []
  const context = {
    home: opts.home,
    out: function (text) { chunks.push(text) },
    warn: function (text) { errors.push(text) },
  }
  const args = Array.isArray(argv) ? argv.slice() : []
  let code = 0
  try {
    if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h' || args[0] === '--version') {
      context.out(HELP)
    } else if (args[0] === 'export') {
      code = exportCommand(args.slice(1), context)
    } else if (args[0] === 'dry-run') {
      code = exportCommand(args.slice(1).concat(['--dry-run']), context)
    } else if (args[0] === 'bill') {
      code = billCommand(args.slice(1), context)
    } else if (args[0] === 'prices') {
      code = pricesCommand(args.slice(1), context)
    } else {
      throw new Error('未知命令：' + args[0])
    }
  } catch (error) {
    code = 2
    errors.push(String((error && error.message) || error) + '\n')
    errors.push('运行 dsh-cost-ledger help 查看用法。\n')
  }
  const stdout = chunks.join('')
  const stderr = errors.join('')
  if (opts.io && typeof opts.io.out === 'function') opts.io.out(stdout)
  if (opts.io && typeof opts.io.err === 'function') opts.io.err(stderr)
  return { code, stdout, stderr }
}
