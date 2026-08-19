import markerData from '../data/xauusd-entry-markers.json'
import type { SeriesMarker, UTCTimestamp } from 'lightweight-charts'
import type { IntervalId, SymbolId } from './market'

export type TradeSide = 'long' | 'short'
export type TradeMarkerKind = 'entry' | 'exit'
export type TradeExitReasonCode = 'INITIAL_STOP_LOSS' | 'INITIAL_STOP_LOSS_GAP' | 'TRAILING_STOP' | 'TRAILING_STOP_GAP' | 'OPPOSITE_SIGNAL_CLOSE' | 'OPPOSITE_SIGNAL_NEXT_BAR_BREAK' | 'END_OF_DATA_MARK_TO_MARKET' | 'COURSE_TARGET' | 'COURSE_TARGET_GAP'

export interface XauTradeEntryDetails {
  signalIdx: number
  signalTime: number
  time: number
  beijingTime: string
  price: number
  setup: string
  reason: string
  ruleVersion: string
  triggerReference: string
  triggerCondition: string
  stopLoss: number
  takeProfit: null
  noFixedTakeProfitAtEntry: true
  stopMethod: string
  trailingRule?: string
  trailingActivationUsd: number | null
  trailingDistanceUsd: number | null
}

export interface XauTradeExitDetails {
  idx: number
  time: number
  beijingTime: string
  price: number
  reasonCode: TradeExitReasonCode
  ambiguous: boolean
  finalActiveStop: number
  trailingActivated: boolean
  trailingActivationIdx: number | null
  trailingStructureIdx?: number | null
  trailingStructureConfirmationIdx?: number | null
  trailingStructurePrice?: number | null
  signalIdx?: number
  signalTime?: number
  setup?: string
  reason?: string
}

export interface XauTradeResult {
  barsHeld: number
  rMultiple: number
  pnlUsd: number
}

export interface XauTradeMarker {
  tradeNumber: number
  side: TradeSide
  entry: XauTradeEntryDetails
  exit: XauTradeExitDetails
  result: XauTradeResult
}

export type TradeEntryMarker = XauTradeMarker

interface TradeMarkerProvenance {
  backtestFile: string
  backtestSha256: string
  enrichedSignalsFile: string
  enrichedSignalsSha256: string
  scenario: string
  generatedBy: string
}

interface TradeMarkerDataset {
  schemaVersion: 4
  symbol: 'XAUUSD'
  interval: '5m'
  timeframeSeconds: 300
  provenance: TradeMarkerProvenance
  summary: {
    trades: number
    long: number
    short: number
    entryMarkers: number
    exitMarkers: number
    uniqueTimes: number
    sameBarOpenClose: number
    exitReasonCounts: Partial<Record<TradeExitReasonCode, number>>
  }
  trades: XauTradeMarker[]
}

export interface XauTradeMarkerDatasetInfo {
  sourceId: string
  name: string
  symbol: 'XAUUSD'
  interval: '5m'
  scenario: string
  generatedBy: string
  backtestFile: string
  backtestSha256: string
  startTime: number
  endTime: number
  tradeCount: number
  markerCount: number
}

export interface XauTradeMarkerSelection {
  id: string
  kind: TradeMarkerKind
  trade: XauTradeMarker
}

const EXPECTED_BACKTEST_SHA256 = 'a702a57a46cb714317380ad8bdcc50851a93ba345ca18afeb229e2c5f380f51c'
const EXPECTED_SIGNALS_SHA256 = '1a03e2efb24085071ba271064f1a89591c210d80355a30acdebbc5ee2bdeb3ad'
const dataset = markerData as TradeMarkerDataset
const reasonCodes: TradeExitReasonCode[] = ['INITIAL_STOP_LOSS', 'INITIAL_STOP_LOSS_GAP', 'TRAILING_STOP', 'TRAILING_STOP_GAP', 'OPPOSITE_SIGNAL_CLOSE', 'OPPOSITE_SIGNAL_NEXT_BAR_BREAK', 'END_OF_DATA_MARK_TO_MARKET', 'COURSE_TARGET', 'COURSE_TARGET_GAP']

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isIntegerNumber(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value)
}

function validateDataset(value: TradeMarkerDataset): XauTradeMarker[] {
  if (value.schemaVersion !== 4 || value.symbol !== 'XAUUSD' || value.interval !== '5m' || value.timeframeSeconds !== 300) {
    throw new Error('XAUUSD trade marker dataset metadata is invalid')
  }
  if (value.provenance.backtestSha256 !== EXPECTED_BACKTEST_SHA256 || value.provenance.enrichedSignalsSha256 !== EXPECTED_SIGNALS_SHA256) {
    throw new Error('XAUUSD trade marker source hashes are not the expected replay artifacts')
  }
  if (!Array.isArray(value.trades) || value.trades.length !== value.summary.trades) {
    throw new Error('XAUUSD trade marker dataset trade count is invalid')
  }
  const entryTimes = new Set<number>()
  const exitTimes = new Set<number>()
  let longCount = 0
  const exitReasonCounts: Record<TradeExitReasonCode, number> = { INITIAL_STOP_LOSS: 0, INITIAL_STOP_LOSS_GAP: 0, TRAILING_STOP: 0, TRAILING_STOP_GAP: 0, OPPOSITE_SIGNAL_CLOSE: 0, OPPOSITE_SIGNAL_NEXT_BAR_BREAK: 0, END_OF_DATA_MARK_TO_MARKET: 0, COURSE_TARGET: 0, COURSE_TARGET_GAP: 0 }
  for (const [index, trade] of value.trades.entries()) {
    if (trade.tradeNumber !== index + 1 || trade.side !== 'long' && trade.side !== 'short') {
      throw new Error('XAUUSD trade marker dataset contains an invalid trade identity')
    }
    if (!isIntegerNumber(trade.entry.signalIdx) || !isIntegerNumber(trade.entry.signalTime) || !isIntegerNumber(trade.entry.time) || trade.entry.time % value.timeframeSeconds !== 0 || trade.entry.signalTime % value.timeframeSeconds !== 0) {
      throw new Error(`Entry time is not a valid 5m boundary for trade ${trade.tradeNumber}`)
    }
    if (!isNonEmptyString(trade.entry.beijingTime) || !isNonEmptyString(trade.entry.setup) || !isNonEmptyString(trade.entry.reason) || !isNonEmptyString(trade.entry.ruleVersion) || !isNonEmptyString(trade.entry.triggerReference) || !isNonEmptyString(trade.entry.triggerCondition) || !isNonEmptyString(trade.entry.stopMethod)) {
      throw new Error(`Entry details are incomplete for trade ${trade.tradeNumber}`)
    }
    const hasUsdTrailing = isFiniteNumber(trade.entry.trailingActivationUsd) && isFiniteNumber(trade.entry.trailingDistanceUsd)
    const hasStructuralTrailing = trade.entry.trailingActivationUsd === null && trade.entry.trailingDistanceUsd === null
    const invalidUsdTrailing = hasUsdTrailing && (
      (trade.entry.trailingActivationUsd ?? 0) <= 0 ||
      (trade.entry.trailingDistanceUsd ?? 0) <= 0
    )
    if (!isFiniteNumber(trade.entry.price) || !isFiniteNumber(trade.entry.stopLoss) || !hasUsdTrailing && !hasStructuralTrailing || invalidUsdTrailing || trade.entry.takeProfit !== null || trade.entry.noFixedTakeProfitAtEntry !== true) {
      throw new Error(`Entry numeric details are incomplete for trade ${trade.tradeNumber}`)
    }
    if (!isIntegerNumber(trade.exit.idx) || !isIntegerNumber(trade.exit.time) || trade.exit.time % value.timeframeSeconds !== 0 || trade.exit.time < trade.entry.time) {
      throw new Error(`Exit time is not a valid 5m boundary for trade ${trade.tradeNumber}`)
    }
    if (!isNonEmptyString(trade.exit.beijingTime) || !isFiniteNumber(trade.exit.price) || !isFiniteNumber(trade.exit.finalActiveStop) || typeof trade.exit.trailingActivated !== 'boolean' || trade.exit.trailingActivationIdx !== null && !isIntegerNumber(trade.exit.trailingActivationIdx) || !isNonEmptyString(trade.exit.reasonCode) || !reasonCodes.includes(trade.exit.reasonCode)) {
      throw new Error(`Exit details are incomplete for trade ${trade.tradeNumber}`)
    }
    if ((trade.exit.reasonCode === 'OPPOSITE_SIGNAL_CLOSE' || trade.exit.reasonCode === 'OPPOSITE_SIGNAL_NEXT_BAR_BREAK') && (!isIntegerNumber(trade.exit.signalIdx) || !isIntegerNumber(trade.exit.signalTime) || trade.exit.signalTime % value.timeframeSeconds !== 0 || !isNonEmptyString(trade.exit.setup) || !isNonEmptyString(trade.exit.reason))) {
      throw new Error(`Opposite-signal exit details are incomplete for trade ${trade.tradeNumber}`)
    }
    if (!isFiniteNumber(trade.result.barsHeld) || !isFiniteNumber(trade.result.rMultiple) || !isFiniteNumber(trade.result.pnlUsd)) {
      throw new Error(`Result details are incomplete for trade ${trade.tradeNumber}`)
    }
    if (entryTimes.has(trade.entry.time) || exitTimes.has(trade.exit.time)) throw new Error('XAUUSD entry and exit timestamps must each be unique')
    entryTimes.add(trade.entry.time)
    exitTimes.add(trade.exit.time)
    if (trade.side === 'long') longCount += 1
    exitReasonCounts[trade.exit.reasonCode] += 1
  }
  const uniqueTimes = new Set([...entryTimes, ...exitTimes]).size
  const sameBarOpenClose = value.trades.filter((trade) => trade.entry.time === trade.exit.time).length
  if (longCount !== value.summary.long || value.trades.length - longCount !== value.summary.short || value.summary.entryMarkers !== value.trades.length || value.summary.exitMarkers !== value.trades.length || value.summary.uniqueTimes !== uniqueTimes || value.summary.sameBarOpenClose !== sameBarOpenClose) {
    throw new Error('XAUUSD trade marker dataset summary is invalid')
  }
  for (const reasonCode of reasonCodes) if ((value.summary.exitReasonCounts[reasonCode] ?? 0) !== exitReasonCounts[reasonCode]) throw new Error('XAUUSD exit reason summary is invalid')
  if (uniqueTimes !== 182 || sameBarOpenClose !== 6 || exitReasonCounts.INITIAL_STOP_LOSS !== 26 || exitReasonCounts.INITIAL_STOP_LOSS_GAP !== 0 || exitReasonCounts.TRAILING_STOP !== 20 || exitReasonCounts.TRAILING_STOP_GAP !== 1 || exitReasonCounts.OPPOSITE_SIGNAL_CLOSE !== 47 || exitReasonCounts.END_OF_DATA_MARK_TO_MARKET !== 0 || exitReasonCounts.COURSE_TARGET !== 0 || exitReasonCounts.COURSE_TARGET_GAP !== 0) throw new Error('XAUUSD trade marker cardinality is invalid')
  return value.trades
}

const xauTradeMarkers = validateDataset(dataset)

export const XAU_TRADE_MARKER_SOURCE_ID = `xauusd-replay-${dataset.provenance.backtestSha256.slice(0, 16)}`

export function xauTradeMarkerDatasetInfo(): XauTradeMarkerDatasetInfo {
  return {
    sourceId: XAU_TRADE_MARKER_SOURCE_ID,
    name: 'XAUUSD 回放交易',
    symbol: dataset.symbol,
    interval: dataset.interval,
    scenario: dataset.provenance.scenario,
    generatedBy: dataset.provenance.generatedBy,
    backtestFile: dataset.provenance.backtestFile,
    backtestSha256: dataset.provenance.backtestSha256,
    startTime: Math.min(...xauTradeMarkers.map((trade) => trade.entry.time)),
    endTime: Math.max(...xauTradeMarkers.map((trade) => trade.exit.time)),
    tradeCount: dataset.summary.trades,
    markerCount: dataset.summary.entryMarkers + dataset.summary.exitMarkers,
  }
}

export function getXauTradeMarkers(symbol: SymbolId, interval: IntervalId): readonly XauTradeMarker[] {
  return symbol === 'XAUUSD' && interval === '5m' ? xauTradeMarkers : []
}

interface SortableSeriesMarker {
  marker: SeriesMarker<UTCTimestamp>
  kind: TradeMarkerKind
  tradeNumber: number
}

function markerFor(trade: XauTradeMarker, kind: TradeMarkerKind, activeTradeNumber?: number | null): SortableSeriesMarker {
  const entry = kind === 'entry'
  const long = trade.side === 'long'
  const active = activeTradeNumber !== undefined && activeTradeNumber !== null && trade.tradeNumber === activeTradeNumber
  return {
    marker: {
      time: (entry ? trade.entry.time : trade.exit.time) as UTCTimestamp,
      position: entry ? (long ? 'belowBar' : 'aboveBar') : (long ? 'aboveBar' : 'belowBar'),
      shape: entry ? (long ? 'arrowUp' : 'arrowDown') : 'circle',
      color: active ? '#facc15' : entry ? (long ? '#22ab94' : '#f7525f') : '#f59e0b',
      text: entry ? (long ? '开多' : '开空') : (long ? '平多' : '平空'),
      size: active ? 2 : 1,
      id: `xau-trade-${trade.tradeNumber}-${kind}`,
    },
    kind,
    tradeNumber: trade.tradeNumber,
  }
}

export function toXauTradeSeriesMarkers(symbol: SymbolId, interval: IntervalId, revealedThrough?: number, activeTradeNumber?: number | null): SeriesMarker<UTCTimestamp>[] {
  const markers: SortableSeriesMarker[] = []
  for (const trade of getXauTradeMarkers(symbol, interval)) markers.push(markerFor(trade, 'entry', activeTradeNumber), markerFor(trade, 'exit', activeTradeNumber))
  return markers.sort((left, right) => {
    const timeDelta = Number(left.marker.time) - Number(right.marker.time)
    if (timeDelta !== 0) return timeDelta
    if (left.kind !== right.kind) return left.kind === 'entry' ? -1 : 1
    return left.tradeNumber - right.tradeNumber
  }).map(({ marker }) => marker)
    .filter((marker) => revealedThrough === undefined || Number(marker.time) <= revealedThrough)
}

export type XauTradeConnectionOutcome = 'profit' | 'loss' | 'breakeven'

export interface XauTradeConnectionSpec {
  id: string
  tradeNumber: number
  entryTime: number
  entryPrice: number
  exitTime: number
  exitPrice: number
  pnlUsd: number
  outcome: XauTradeConnectionOutcome
  color: string
}

export const XAU_TRADE_CONNECTION_COLORS: Record<XauTradeConnectionOutcome, string> = {
  profit: '#22ab94',
  loss: '#f7525f',
  breakeven: '#f59e0b',
}

function connectionFor(trade: XauTradeMarker): XauTradeConnectionSpec {
  const pnlUsd = trade.result.pnlUsd
  const outcome: XauTradeConnectionOutcome = pnlUsd > 0 ? 'profit' : pnlUsd < 0 ? 'loss' : 'breakeven'
  return {
    id: `xau-trade-${trade.tradeNumber}-connection`,
    tradeNumber: trade.tradeNumber,
    entryTime: trade.entry.time,
    entryPrice: trade.entry.price,
    exitTime: trade.exit.time,
    exitPrice: trade.exit.price,
    pnlUsd,
    outcome,
    color: XAU_TRADE_CONNECTION_COLORS[outcome],
  }
}

/**
 * Returns one independent entry-to-exit connection spec per completed trade.
 * The replay cursor is applied to exit time only, so an open trade never gets
 * a future connection line while its exit remains unrevealed.
 */
export function toXauTradeConnectionSpecs(symbol: SymbolId, interval: IntervalId, revealedThrough?: number): XauTradeConnectionSpec[] {
  return getXauTradeMarkers(symbol, interval)
    .filter((trade) => revealedThrough === undefined || trade.exit.time <= revealedThrough)
    .map(connectionFor)
}

// Compatibility aliases make the connection data discoverable without changing
// the marker API used by existing callers.
export const getXauTradeConnectionSpecs = toXauTradeConnectionSpecs
export const toXauTradeConnections = toXauTradeConnectionSpecs
export const getXauTradeConnections = toXauTradeConnectionSpecs

const MARKER_ID_PATTERN = /^xau-trade-(\d+)-(entry|exit)$/

export function parseXauTradeMarkerId(value: unknown): { tradeNumber: number; kind: TradeMarkerKind } | null {
  if (typeof value !== 'string') return null
  const match = MARKER_ID_PATTERN.exec(value)
  if (!match) return null
  const tradeNumber = Number(match[1])
  if (!Number.isInteger(tradeNumber) || tradeNumber < 1 || tradeNumber > xauTradeMarkers.length) return null
  return { tradeNumber, kind: match[2] as TradeMarkerKind }
}

export function resolveXauTradeMarker(symbol: SymbolId, interval: IntervalId, id: unknown): XauTradeMarkerSelection | null {
  if (symbol !== 'XAUUSD' || interval !== '5m') return null
  const parsed = parseXauTradeMarkerId(id)
  if (!parsed) return null
  const trade = xauTradeMarkers[parsed.tradeNumber - 1]
  return trade ? { id: `xau-trade-${parsed.tradeNumber}-${parsed.kind}`, kind: parsed.kind, trade } : null
}

export function toggleXauTradeMarkerSelection(currentId: string | null, nextId: string): string | null {
  return currentId === nextId ? null : nextId
}

const exitReasonLabels: Record<TradeExitReasonCode, string> = {
  INITIAL_STOP_LOSS: '固定止损',
  INITIAL_STOP_LOSS_GAP: '固定止损跳空',
  TRAILING_STOP: '移动止盈',
  TRAILING_STOP_GAP: '移动止盈跳空',
  OPPOSITE_SIGNAL_CLOSE: '反向信号平仓',
  OPPOSITE_SIGNAL_NEXT_BAR_BREAK: '反向信号下一根确认',
  END_OF_DATA_MARK_TO_MARKET: '数据结束结算',
  COURSE_TARGET: '动态课程目标',
  COURSE_TARGET_GAP: '动态课程目标跳空',
}

const exitReasonDetails: Record<TradeExitReasonCode, (side: TradeSide) => string> = {
  INITIAL_STOP_LOSS: () => '价格触及信号时固定的初始止损；主口径把入场根风险侧触碰视为进场后发生。',
  INITIAL_STOP_LOSS_GAP: () => '本根开盘跳过固定初始止损，按可成交开盘价退出。',
  TRAILING_STOP: () => '此前已生效的移动止盈线被触及；移动线由上一根或更早 K 线收盘后确认。',
  TRAILING_STOP_GAP: () => '本根开盘跳过此前已生效的移动止盈线，按可成交开盘价退出。',
  OPPOSITE_SIGNAL_CLOSE: (side) => `出现与${side === 'long' ? '多' : '空'}仓相反的公开信号，按信号K线收盘价平仓且不反转。`,
  OPPOSITE_SIGNAL_NEXT_BAR_BREAK: (side) => `出现与${side === 'long' ? '多' : '空'}仓相反的信号后不立即平仓；下一根 K 线严格${side === 'long' ? '跌破信号K线低点' : '突破信号K线高点'}才按确认价平仓，未突破则继续持仓且不反转。`,
  END_OF_DATA_MARK_TO_MARKET: () => '回放数据结束，按最后一根 K 线收盘价结算。',
  COURSE_TARGET: () => '入场后按实际风险与结构因果生成的动态课程目标被触及。',
  COURSE_TARGET_GAP: () => '本根开盘跳过动态课程目标，按可成交开盘价退出。',
}

export function exitReasonLabel(reasonCode: TradeExitReasonCode): string {
  return exitReasonLabels[reasonCode] ?? '未知退出原因'
}

export function exitReasonDetail(reasonCode: TradeExitReasonCode, side: TradeSide): string {
  return exitReasonDetails[reasonCode]?.(side) ?? '退出原因代码未被界面映射，请核对回放记录。'
}

export function tradeRuleLabel(ruleVersion: string): string {
  if (ruleVersion === 'next_bar_breakout_initial_stop_no_fixed_target_v2_20260809') return '下一根K线突破入场（无固定止盈）'
  if (ruleVersion === 'next_bar_breakout_structural_levels_v1_20260809') return '下一根K线结构位突破（仅下一根有效）'
  if (ruleVersion.includes('structural_levels')) return '下一根K线结构位突破规则'
  if (ruleVersion.includes('breakout')) return '下一根K线突破入场规则'
  if (ruleVersion.includes('no_fixed_target')) return '无固定止盈的突破入场规则'
  return '按回放规则触发'
}

export function triggerConditionLabel(condition: string): string {
  if (condition === 'next_bar_high > signal_bar_high') return '下一根K线最高价突破信号K线高点'
  if (condition === 'next_bar_low < signal_bar_low') return '下一根K线最低价跌破信号K线低点'
  if (condition.includes('next_bar_high')) return '下一根K线向上突破信号K线高点'
  if (condition.includes('next_bar_low')) return '下一根K线向下跌破信号K线低点'
  return '按信号K线确认后触发'
}

export function tradeLevelMethodLabel(method: string): string {
  if (method === 'latest_confirmed_pivot_low_below_entry') return '最近确认的枢轴低点（入场价下方）'
  if (method === 'latest_confirmed_pivot_high_above_entry') return '最近确认的枢轴高点（入场价上方）'
  if (method === 'one_r_measured_move_no_known_profit_side_pivot') return '无已知盈利侧枢轴时使用 1R 测量移动'
  return method
}

export function tradeMarkerTitle(trade: XauTradeMarker, kind: TradeMarkerKind): string {
  const sideLabel = trade.side === 'long' ? '多' : '空'
  return `第 ${trade.tradeNumber} 笔 · ${kind === 'entry' ? '开' : '平'}${sideLabel}`
}

// Compatibility aliases keep existing callers source-compatible.
export const getXauEntryMarkers = getXauTradeMarkers
export const toXauEntrySeriesMarkers = toXauTradeSeriesMarkers

export function xauTradeMarkerSummary() {
  return dataset.summary
}

export const xauEntryMarkerSummary = xauTradeMarkerSummary
