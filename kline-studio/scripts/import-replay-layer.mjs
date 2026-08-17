import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'

const DEFAULT_PROJECT = 'D:/项目/tradingview/kline-studio'
const DEFAULT_ARCHIVE_ROOT = 'C:/Users/diffzhou/Documents/tradingview-replay-archives'
const SUPPORTED_REASONS = new Set(['INITIAL_STOP_LOSS', 'INITIAL_STOP_LOSS_GAP', 'TRAILING_STOP', 'TRAILING_STOP_GAP', 'OPPOSITE_SIGNAL_CLOSE', 'END_OF_DATA_MARK_TO_MARKET', 'COURSE_TARGET', 'COURSE_TARGET_GAP'])
const INTERVAL_IDS = new Map([[1, '1m'], [5, '5m'], [15, '15m'], [30, '30m'], [60, '1h'], [120, '2h'], [240, '4h'], [1440, '1d'], [10080, '1w']])

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`)
    const key = token.slice(2)
    if (key === 'dry-run') {
      values.dryRun = true
      continue
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`)
    values[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value
    index += 1
  }
  return values
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function filesUnder(root) {
  const output = []
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else output.push(path)
    }
  }
  await visit(root)
  return output
}

async function findLatestBacktest(archiveRoot) {
  if (!await exists(archiveRoot)) throw new Error(`Replay archive root does not exist: ${archiveRoot}`)
  const candidates = (await filesUnder(archiveRoot)).filter((path) => extname(path).toLowerCase() === '.json' && /[\\/]results[\\/]backtests[\\/]/i.test(path))
  if (candidates.length === 0) throw new Error(`No results/backtests/*.json found under ${archiveRoot}`)
  const ranked = await Promise.all(candidates.map(async (path) => ({ path, modifiedAt: (await stat(path)).mtimeMs })))
  ranked.sort((left, right) => right.modifiedAt - left.modifiedAt || right.path.localeCompare(left.path))
  return ranked[0].path
}

function archiveDirectoryFor(backtestPath) {
  let current = dirname(backtestPath)
  while (dirname(current) !== current) {
    if (basename(current).toLowerCase() === 'results') return dirname(current)
    current = dirname(current)
  }
  return null
}

async function parseJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot parse JSON ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function resolveSignals(backtest, backtestPath, explicitPath, trades) {
  const directCandidates = [explicitPath, backtest.source_signal_file].filter(Boolean).map((path) => resolve(path))
  for (const path of directCandidates) {
    if (!await exists(path)) continue
    const value = await parseJson(path)
    if (Array.isArray(value?.drawings)) return { path, value }
  }
  const archiveDirectory = archiveDirectoryFor(backtestPath)
  const extrasDirectory = archiveDirectory ? join(archiveDirectory, 'results', 'extras') : null
  if (!extrasDirectory || !await exists(extrasDirectory)) return null
  const requiredIndices = new Set(trades.map((trade) => trade.entry_signal_idx).filter(Number.isInteger))
  const candidates = []
  for (const path of (await filesUnder(extrasDirectory)).filter((item) => extname(item).toLowerCase() === '.json')) {
    try {
      const value = await parseJson(path)
      if (!Array.isArray(value?.drawings)) continue
      const indices = new Set(value.drawings.map((drawing) => drawing.idx).filter(Number.isInteger))
      const score = [...requiredIndices].filter((index) => indices.has(index)).length
      candidates.push({ path, value, score })
    } catch {
      // Ignore unrelated JSON files in the archive extras directory.
    }
  }
  candidates.sort((left, right) => right.score - left.score || right.value.drawings.length - left.value.drawings.length)
  return candidates[0] ?? null
}

function normalizedSymbol(value) {
  const symbol = String(value ?? '').toUpperCase()
  if (symbol.endsWith('XAUUSD')) return 'XAUUSD'
  if (symbol.endsWith('XAGUSD')) return 'XAGUSD'
  if (symbol.includes('BTCUSDT.P')) return 'BTCUSDT.P'
  if (symbol.endsWith('US500')) return 'US500'
  if (symbol.endsWith('ETHUSD')) return 'ETHUSD'
  throw new Error(`Unsupported website symbol: ${value}`)
}

function asFinite(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`Missing or invalid ${label}`)
  return number
}

function nonEmpty(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function beijingTime(unixSeconds) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(unixSeconds * 1000))
  const part = (type) => parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
}

function safeId(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42)
}

const args = parseArgs(process.argv.slice(2))
const projectDirectory = resolve(args.project ?? DEFAULT_PROJECT)
const archiveRoot = resolve(args.archiveRoot ?? DEFAULT_ARCHIVE_ROOT)
const inputPath = resolve(args.input ?? await findLatestBacktest(archiveRoot))
if (!await exists(inputPath)) throw new Error(`Backtest file does not exist: ${inputPath}`)
const inputBytes = await readFile(inputPath)
const inputSha256 = createHash('sha256').update(inputBytes).digest('hex')
const backtest = JSON.parse(inputBytes.toString('utf8'))
const scenario = args.scenario ?? 'conservative_stop_first'
const rawTrades = backtest?.scenarios?.[scenario]?.trades
if (!Array.isArray(rawTrades) || rawTrades.length === 0) throw new Error(`Missing or empty scenarios.${scenario}.trades in ${inputPath}`)

const symbol = normalizedSymbol(backtest.symbol)
const timeframeMinutes = Number(backtest.timeframe_minutes)
const interval = INTERVAL_IDS.get(timeframeMinutes)
if (!interval) throw new Error(`Unsupported website timeframe: ${backtest.timeframe_minutes} minutes`)
const timeframeSeconds = timeframeMinutes * 60
const signals = await resolveSignals(backtest, inputPath, args.signals, rawTrades)
const signalBytes = signals ? await readFile(signals.path) : null
const signalSha256 = signalBytes ? createHash('sha256').update(signalBytes).digest('hex') : ''
const drawings = signals?.value?.drawings ?? []
const drawingsByIdx = new Map(drawings.filter((drawing) => Number.isInteger(drawing.idx)).map((drawing) => [drawing.idx, drawing]))
const signalMetadata = signals?.value ?? {}
const sourceDataSha256 = nonEmpty(backtest.source_data_sha256, nonEmpty(signalMetadata.source_data_sha256, ''))
const ruleSetKey = nonEmpty(signalMetadata.rule_set_key, nonEmpty(backtest.rule_set_key, ''))
const ruleSetId = nonEmpty(signalMetadata.rule_set_id, nonEmpty(backtest.rule_set_id, ''))
const ruleSetSha256 = nonEmpty(signalMetadata.rule_set_sha256, nonEmpty(backtest.rule_set_sha256, ''))
const replayStartedAtEpoch = Number(args.replayStartedAtEpoch)
const replayFinishedAtEpoch = Number(args.replayFinishedAtEpoch)

const trades = rawTrades.map((trade, index) => {
  const tradeNumber = Number(trade.trade_number)
  if (!Number.isInteger(tradeNumber) || tradeNumber !== index + 1) throw new Error(`Trade numbering is not contiguous at index ${index}`)
  if (trade.side !== 'long' && trade.side !== 'short') throw new Error(`Invalid side for trade ${tradeNumber}`)
  const hasDynamicCourseTarget = trade.course_take_profit &&
    (trade.course_take_profit.mode === 'actual_risk_adaptive' || trade.course_take_profit.mode === 'dynamic_after_entry')
  if (trade.no_fixed_take_profit_at_entry !== true || trade.fixed_take_profit !== null || (trade.take_profit !== null && !hasDynamicCourseTarget)) {
    throw new Error(`Trade ${tradeNumber} uses an unsupported fixed take-profit; only no-fixed-target or post-entry dynamic course targets are accepted`)
  }
  const reasonCode = String(trade.exit_reason)
  if (!SUPPORTED_REASONS.has(reasonCode)) throw new Error(`Unsupported exit reason ${reasonCode} for trade ${tradeNumber}`)
  const entryTime = asFinite(trade.entry_bar_open_time, `entry time for trade ${tradeNumber}`)
  const exitTime = asFinite(trade.exit_bar_open_time, `exit time for trade ${tradeNumber}`)
  if (!Number.isInteger(entryTime) || entryTime % timeframeSeconds !== 0 || !Number.isInteger(exitTime) || exitTime % timeframeSeconds !== 0 || exitTime < entryTime) throw new Error(`Trade ${tradeNumber} has invalid interval-aligned times`)
  const signal = drawingsByIdx.get(trade.entry_signal_idx)
  const plan = signal?.trade_plan
  const entryPrice = asFinite(trade.entry_price, `entry price for trade ${tradeNumber}`)
  const stopLoss = asFinite(trade.initial_stop_loss ?? trade.stop_loss, `initial stop for trade ${tradeNumber}`)
  const trailingActivationUsd = trade.trailing_activation_usd === null || trade.trailing_activation_usd === undefined
    ? null
    : asFinite(trade.trailing_activation_usd, `trailing activation USD for trade ${tradeNumber}`)
  const trailingDistanceUsd = trade.trailing_distance_usd === null || trade.trailing_distance_usd === undefined
    ? null
    : asFinite(trade.trailing_distance_usd, `trailing distance USD for trade ${tradeNumber}`)
  const entry = {
    signalIdx: Number.isInteger(trade.entry_signal_idx) ? trade.entry_signal_idx : trade.entry_idx,
    signalTime: asFinite(trade.entry_signal_bar_open_time ?? entryTime - timeframeSeconds, `signal time for trade ${tradeNumber}`),
    time: entryTime,
    beijingTime: nonEmpty(trade.entry_bar_beijing_open_time, beijingTime(entryTime)),
    price: entryPrice,
    setup: nonEmpty(signal?.setup, `回放信号 #${trade.entry_signal_idx}`),
    reason: nonEmpty(signal?.reason, '由已完成的严格因果回放结果导入。'),
    ruleVersion: nonEmpty(plan?.rule_version, nonEmpty(backtest.version, 'imported-replay-v1')),
    triggerReference: nonEmpty(plan?.entry?.trigger_reference, 'signal_bar'),
    triggerCondition: nonEmpty(plan?.entry?.trigger_condition, trade.side === 'long' ? 'next_bar_high > signal_bar_high' : 'next_bar_low < signal_bar_low'),
    stopLoss,
    takeProfit: null,
    noFixedTakeProfitAtEntry: true,
    stopMethod: nonEmpty(trade.stop_method, 'imported_initial_stop'),
    trailingRule: nonEmpty(backtest.exit_rule_config?.trailing_rule, 'legacy_usd_trailing'),
    trailingActivationUsd,
    trailingDistanceUsd,
  }
  const exit = {
    idx: Number.isInteger(trade.exit_idx) ? trade.exit_idx : trade.entry_idx,
    time: exitTime,
    beijingTime: nonEmpty(trade.exit_bar_beijing_close_time, beijingTime(exitTime + timeframeSeconds)),
    price: asFinite(trade.exit_price, `exit price for trade ${tradeNumber}`),
    reasonCode,
    ambiguous: Boolean(trade.ambiguous_ohlc_order),
    finalActiveStop: asFinite(trade.final_active_stop, `final active stop for trade ${tradeNumber}`),
    trailingActivated: Boolean(trade.trailing_activated),
    trailingActivationIdx: trade.trailing_activation_idx === null || trade.trailing_activation_idx === undefined ? null : asFinite(trade.trailing_activation_idx, `trailing activation index for trade ${tradeNumber}`),
    trailingStructureIdx: trade.trailing_structure_idx === null || trade.trailing_structure_idx === undefined ? null : asFinite(trade.trailing_structure_idx, `trailing structure index for trade ${tradeNumber}`),
    trailingStructureConfirmationIdx: trade.trailing_structure_confirmation_idx === null || trade.trailing_structure_confirmation_idx === undefined ? null : asFinite(trade.trailing_structure_confirmation_idx, `trailing structure confirmation index for trade ${tradeNumber}`),
    trailingStructurePrice: trade.trailing_structure_price === null || trade.trailing_structure_price === undefined ? null : asFinite(trade.trailing_structure_price, `trailing structure price for trade ${tradeNumber}`),
  }
  if (reasonCode === 'OPPOSITE_SIGNAL_CLOSE') {
    const exitSignal = drawingsByIdx.get(trade.exit_idx)
    exit.signalIdx = Number.isInteger(trade.exit_idx) ? trade.exit_idx : 0
    exit.signalTime = asFinite(exitSignal?.bar_open_time ?? exitTime, `exit signal time for trade ${tradeNumber}`)
    exit.setup = nonEmpty(exitSignal?.setup, `反向信号 #${trade.exit_idx}`)
    exit.reason = nonEmpty(exitSignal?.reason, '回放结果记录的反向公开信号平仓。')
  }
  const result = {
    barsHeld: asFinite(trade.bars_held_including_entry, `bars held for trade ${tradeNumber}`),
    rMultiple: asFinite(trade.r_multiple, `R multiple for trade ${tradeNumber}`),
    pnlUsd: asFinite(trade.fixed_risk_sizing?.pnl_usd ?? trade.pnl_usd, `PnL USD for trade ${tradeNumber}`),
  }
  return { tradeNumber, side: trade.side, entry, exit, result }
})

const entryTimes = new Set(trades.map((trade) => trade.entry.time))
const exitTimes = new Set(trades.map((trade) => trade.exit.time))
const longCount = trades.filter((trade) => trade.side === 'long').length
const exitReasonCounts = Object.fromEntries([...SUPPORTED_REASONS].map((reason) => [reason, trades.filter((trade) => trade.exit.reasonCode === reason).length]))
const sourceId = `${safeId(symbol)}-${interval}-${safeId(scenario)}-${inputSha256.slice(0, 16)}`
const firstTime = Math.min(...trades.map((trade) => trade.entry.time))
const lastTime = Math.max(...trades.map((trade) => trade.exit.time))
const defaultName = `${symbol} ${timeframeMinutes}分回放 · ${beijingTime(firstTime).slice(0, 10)}`
const payload = {
  schemaVersion: 4,
  symbol,
  interval,
  timeframeSeconds,
  layer: { sourceId, name: nonEmpty(args.name, defaultName) },
  provenance: {
    backtestFile: basename(inputPath),
    backtestSha256: inputSha256,
    enrichedSignalsFile: signals ? basename(signals.path) : '',
    enrichedSignalsSha256: signalSha256,
    scenario,
    generatedBy: 'scripts/import-replay-layer.mjs',
    sourceDataSha256,
    ruleSetKey,
    ruleSetId,
    ruleSetSha256,
    model: nonEmpty(signalMetadata.model, nonEmpty(backtest.model, '')),
    reasoningEffort: nonEmpty(signalMetadata.reasoning_effort, nonEmpty(backtest.reasoning_effort, '')),
    serviceTier: nonEmpty(signalMetadata.service_tier, nonEmpty(backtest.service_tier, '')),
    derivationMode: nonEmpty(backtest.derivation?.mode, ''),
    ...(Number.isInteger(replayStartedAtEpoch) && replayStartedAtEpoch > 0 ? { replayStartedAtEpoch } : {}),
    ...(Number.isInteger(replayFinishedAtEpoch) && replayFinishedAtEpoch > 0 ? { replayFinishedAtEpoch } : {}),
  },
  summary: {
    trades: trades.length,
    long: longCount,
    short: trades.length - longCount,
    entryMarkers: trades.length,
    exitMarkers: trades.length,
    uniqueTimes: new Set([...entryTimes, ...exitTimes]).size,
    sameBarOpenClose: trades.filter((trade) => trade.entry.time === trade.exit.time).length,
    exitReasonCounts,
  },
  trades,
}

const outputPath = resolve(args.output ?? join(projectDirectory, 'src', 'data', 'replay-trade-layers', `${sourceId}.json`))
if (!args.dryRun) {
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}
const result = {
  dryRun: Boolean(args.dryRun),
  outputPath,
  inputPath,
  signalsPath: signals?.path ?? null,
  sourceId,
  name: payload.layer.name,
  symbol,
  interval,
  trades: trades.length,
  markers: trades.length * 2,
  startTime: firstTime,
  endTime: lastTime,
}
console.log(`Imported ${result.trades} trades / ${result.markers} markers as "${result.name}"${args.dryRun ? ' (dry run)' : ''}`)
console.log(`IMPORT_RESULT ${JSON.stringify(result)}`)
