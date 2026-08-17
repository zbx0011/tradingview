import { createHash } from 'node:crypto'
import { basename, dirname, resolve } from 'node:path'
import { readFile, mkdir, writeFile } from 'node:fs/promises'

const defaultDirectory = 'C:/Users/diffzhou/Documents/tradingview-checkpoint-20260809/outputs/xauusd_replay_5m_20260809-week-full-sol-image-pngguard-162858'
const defaultBacktestSource = `${defaultDirectory}/backtest_raw244_fixed_risk_100usd_trailing_100usd_v2.json`
const defaultSignalSource = `${defaultDirectory}/tradingview_drawings_sol_image_raw244_trade_levels_no_fixed_tp_trailing_v2.json`
const sourcePath = process.env.XAU_REPLAY_SOURCE ?? defaultBacktestSource
const signalPath = process.env.XAU_ENRICHED_SIGNALS_SOURCE ?? defaultSignalSource
const outputPath = process.env.XAU_ENTRY_MARKERS_OUTPUT ?? resolve('src/data/xauusd-entry-markers.json')
const scenarioName = 'conservative_stop_first'
const expectedBacktestSha256 = 'a702a57a46cb714317380ad8bdcc50851a93ba345ca18afeb229e2c5f380f51c'
const expectedSignalSha256 = '1a03e2efb24085071ba271064f1a89591c210d80355a30acdebbc5ee2bdeb3ad'

const [sourceBytes, signalBytes] = await Promise.all([readFile(sourcePath), readFile(signalPath)])
const backtestSha256 = createHash('sha256').update(sourceBytes).digest('hex')
const signalSha256 = createHash('sha256').update(signalBytes).digest('hex')
if (backtestSha256 !== expectedBacktestSha256) throw new Error(`Unexpected backtest SHA-256: ${backtestSha256}`)
if (signalSha256 !== expectedSignalSha256) throw new Error(`Unexpected enriched signal SHA-256: ${signalSha256}`)

const backtest = JSON.parse(sourceBytes.toString('utf8'))
const enriched = JSON.parse(signalBytes.toString('utf8'))
const trades = backtest?.scenarios?.[scenarioName]?.trades
const drawings = enriched?.drawings
if (!Array.isArray(trades)) throw new Error(`Missing scenarios.${scenarioName}.trades in ${sourcePath}`)
if (!Array.isArray(drawings)) throw new Error(`Missing drawings in ${signalPath}`)

const drawingsByIdx = new Map()
for (const drawing of drawings) {
  if (!Number.isInteger(drawing.idx) || drawingsByIdx.has(drawing.idx)) throw new Error(`Duplicate or invalid drawing idx ${drawing.idx}`)
  if (typeof drawing.setup !== 'string' || !drawing.setup.trim() || typeof drawing.reason !== 'string' || !drawing.reason.trim()) {
    throw new Error(`Drawing ${drawing.idx} must have non-empty public setup/reason`)
  }
  drawingsByIdx.set(drawing.idx, drawing)
}

const reasonCodes = new Set(['INITIAL_STOP_LOSS', 'INITIAL_STOP_LOSS_GAP', 'TRAILING_STOP', 'TRAILING_STOP_GAP', 'OPPOSITE_SIGNAL_CLOSE', 'END_OF_DATA_MARK_TO_MARKET'])
const records = trades.map((trade, index) => {
  if (trade.trade_number !== index + 1) throw new Error(`Trade numbering is not contiguous at index ${index}`)
  if (trade.side !== 'long' && trade.side !== 'short') throw new Error(`Invalid side for trade ${trade.trade_number}`)
  if (!reasonCodes.has(trade.exit_reason)) throw new Error(`Invalid exit reason for trade ${trade.trade_number}`)

  const entrySignal = drawingsByIdx.get(trade.entry_signal_idx)
  if (!entrySignal || (trade.side === 'long' ? entrySignal.side !== 'L' : entrySignal.side !== 'S')) {
    throw new Error(`Entry signal ${trade.entry_signal_idx} does not match trade ${trade.trade_number}`)
  }
  const plan = entrySignal.trade_plan
  if (!plan || plan.calculated_at_signal_idx !== trade.entry_signal_idx || plan.level_inputs_max_idx > trade.entry_signal_idx || plan.no_future_data_used_for_levels !== true || plan.entry?.valid_bar_idx !== trade.entry_idx || plan.entry?.valid_bar_open_time !== trade.entry_bar_open_time || plan.entry?.status !== 'TRIGGERED' || Number(plan.entry?.simulated_fill_price) !== Number(trade.entry_price)) {
    throw new Error(`Entry signal ${trade.entry_signal_idx} contains future or incomplete planning fields`)
  }
  if (plan.take_profit?.enabled_at_entry !== false || plan.take_profit?.price !== null || trade.take_profit !== null || trade.fixed_take_profit !== null || trade.no_fixed_take_profit_at_entry !== true) {
    throw new Error(`Trade ${trade.trade_number} unexpectedly contains a fixed take-profit`)
  }
  const entryTime = Number(trade.entry_bar_open_time)
  const exitTime = Number(trade.exit_bar_open_time)
  if (!Number.isInteger(entryTime) || entryTime % 300 !== 0) throw new Error(`Entry time is not a 5m boundary for trade ${trade.trade_number}`)
  if (!Number.isInteger(exitTime) || exitTime % 300 !== 0 || exitTime < entryTime) throw new Error(`Exit time is not a valid 5m boundary for trade ${trade.trade_number}`)

  const entry = {
    signalIdx: trade.entry_signal_idx,
    signalTime: Number(trade.entry_signal_bar_open_time),
    time: entryTime,
    beijingTime: trade.entry_bar_beijing_open_time,
    price: Number(trade.entry_price),
    setup: entrySignal.setup,
    reason: entrySignal.reason,
    ruleVersion: plan.rule_version,
    triggerReference: plan.entry?.trigger_reference,
    triggerCondition: plan.entry?.trigger_condition,
    stopLoss: Number(trade.initial_stop_loss),
    takeProfit: null,
    noFixedTakeProfitAtEntry: true,
    stopMethod: trade.stop_method,
    trailingActivationUsd: Number(trade.trailing_activation_usd),
    trailingDistanceUsd: Number(trade.trailing_distance_usd),
  }

  const exit = {
    idx: trade.exit_idx,
    time: exitTime,
    beijingTime: trade.exit_bar_beijing_close_time,
    price: Number(trade.exit_price),
    reasonCode: trade.exit_reason,
    ambiguous: Boolean(trade.ambiguous_ohlc_order),
    finalActiveStop: Number(trade.final_active_stop),
    trailingActivated: Boolean(trade.trailing_activated),
    trailingActivationIdx: trade.trailing_activation_idx === null ? null : Number(trade.trailing_activation_idx),
  }
  if (trade.exit_reason === 'OPPOSITE_SIGNAL_CLOSE') {
    const exitSignal = drawingsByIdx.get(trade.exit_idx)
    const opposite = trade.side === 'long' ? 'S' : 'L'
    if (!exitSignal || exitSignal.side !== opposite || exitSignal.idx !== trade.exit_idx) {
      throw new Error(`Exit signal ${trade.exit_idx} does not match opposite trade ${trade.trade_number}`)
    }
    exit.signalIdx = exitSignal.idx
    exit.signalTime = Number(exitSignal.bar_open_time)
    exit.setup = exitSignal.setup
    exit.reason = exitSignal.reason
  }

  const result = {
    barsHeld: Number(trade.bars_held_including_entry),
    rMultiple: Number(trade.r_multiple),
    pnlUsd: Number(trade.fixed_risk_sizing?.pnl_usd),
  }
  if (!Object.entries(entry).every(([key, value]) => key === 'takeProfit' ? value === null : value !== undefined && value !== null && value !== '' && (!Number.isNaN(value) || typeof value !== 'number'))) {
    throw new Error(`Incomplete entry details for trade ${trade.trade_number}`)
  }
  if (!Object.values(result).every((value) => Number.isFinite(value))) throw new Error(`Incomplete result for trade ${trade.trade_number}`)
  return { tradeNumber: trade.trade_number, side: trade.side, entry, exit, result }
})

const entryTimes = new Set(records.map((record) => record.entry.time))
const exitTimes = new Set(records.map((record) => record.exit.time))
const uniqueTimes = new Set([...entryTimes, ...exitTimes]).size
const sameBarCount = records.filter((record) => record.entry.time === record.exit.time).length
const longCount = records.filter((record) => record.side === 'long').length
const shortCount = records.length - longCount
const exitReasonCounts = records.reduce((counts, record) => {
  counts[record.exit.reasonCode] += 1
  return counts
}, { INITIAL_STOP_LOSS: 0, INITIAL_STOP_LOSS_GAP: 0, TRAILING_STOP: 0, TRAILING_STOP_GAP: 0, OPPOSITE_SIGNAL_CLOSE: 0, END_OF_DATA_MARK_TO_MARKET: 0 })
if (entryTimes.size !== 94 || exitTimes.size !== 94 || uniqueTimes !== 182 || sameBarCount !== 6) throw new Error('Entry/exit timestamp cardinality is invalid')
if (records.length !== 94 || longCount !== 44 || shortCount !== 50) throw new Error('Trade side counts are invalid')
if (exitReasonCounts.INITIAL_STOP_LOSS !== 26 || exitReasonCounts.INITIAL_STOP_LOSS_GAP !== 0 || exitReasonCounts.TRAILING_STOP !== 20 || exitReasonCounts.TRAILING_STOP_GAP !== 1 || exitReasonCounts.OPPOSITE_SIGNAL_CLOSE !== 47 || exitReasonCounts.END_OF_DATA_MARK_TO_MARKET !== 0) throw new Error('Exit reason counts are invalid')
if (new Set(records.map((record) => record.entry.signalIdx)).size !== records.length) throw new Error('Entry signal indices must be unique')
if (new Set(records.filter((record) => record.exit.reasonCode === 'OPPOSITE_SIGNAL_CLOSE').map((record) => record.exit.signalIdx)).size !== 47) throw new Error('Opposite-signal exit indices must be unique')

const payload = {
  schemaVersion: 4,
  symbol: 'XAUUSD',
  interval: '5m',
  timeframeSeconds: 300,
  provenance: {
    backtestFile: basename(sourcePath),
    backtestSha256,
    enrichedSignalsFile: basename(signalPath),
    enrichedSignalsSha256: signalSha256,
    scenario: scenarioName,
    generatedBy: 'scripts/export-xau-entry-markers.mjs',
  },
  summary: {
    trades: records.length,
    long: longCount,
    short: shortCount,
    entryMarkers: records.length,
    exitMarkers: records.length,
    uniqueTimes,
    sameBarOpenClose: sameBarCount,
    exitReasonCounts,
  },
  trades: records,
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
console.log(`Wrote ${records.length} trades / ${records.length * 2} markers (${longCount} long, ${shortCount} short) to ${outputPath}`)
console.log(`Unique times: ${uniqueTimes}; same-bar open/close: ${sameBarCount}`)
console.log(`Exit reasons: ${JSON.stringify(exitReasonCounts)}`)
console.log(`Backtest SHA-256: ${backtestSha256}`)
console.log(`Enriched signals SHA-256: ${signalSha256}`)
