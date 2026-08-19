import legacyMarkerData from '../data/xauusd-entry-markers.json'
import type { SeriesMarker, UTCTimestamp } from 'lightweight-charts'
import type { IntervalId, SymbolId } from './market'
import type {
  TradeMarkerKind, XauTradeMarker, XauTradeMarkerSelection, XauTradeConnectionOutcome,
} from './tradeMarkers'
import { XAU_TRADE_CONNECTION_COLORS } from './tradeMarkers'

interface ReplayDatasetPayload {
  schemaVersion: number
  symbol: SymbolId
  interval: IntervalId
  timeframeSeconds: number
  layer?: {
    sourceId?: string
    name?: string
  }
  provenance: {
    backtestFile: string
    backtestSha256: string
    enrichedSignalsFile?: string
    enrichedSignalsSha256?: string
    scenario: string
    generatedBy: string
    replayStartedAtEpoch?: number
    replayFinishedAtEpoch?: number
  }
  summary: {
    trades: number
    long: number
    short: number
    entryMarkers: number
    exitMarkers: number
    uniqueTimes: number
    sameBarOpenClose: number
    exitReasonCounts: Record<string, number>
  }
  trades: XauTradeMarker[]
}

export interface ReplayTradeDatasetInfo {
  sourceId: string
  name: string
  symbol: SymbolId
  interval: IntervalId
  scenario: string
  backtestFile: string
  backtestSha256: string
  startTime: number
  endTime: number
  startedAt: number | null
  finishedAt: number | null
  tradeCount: number
  markerCount: number
}

export interface ReplayDecisionCandidate {
  key: string
  sourceId: string
  sourceName: string
  symbol: SymbolId
  interval: IntervalId
  scenario: string
  backtestSha256: string
  trade: XauTradeMarker
}

interface RegisteredReplayTradeDataset extends ReplayTradeDatasetInfo {
  trades: XauTradeMarker[]
}

export interface ReplayTradeMarkerSelection extends XauTradeMarkerSelection {
  sourceId: string
}

export interface ReplayTradeActiveSelection {
  sourceId: string
  tradeNumber: number
}

export interface ReplayTradeConnectionSpec {
  id: string
  sourceId: string
  tradeNumber: number
  entryTime: number
  entryPrice: number
  exitTime: number
  exitPrice: number
  pnlUsd: number
  outcome: XauTradeConnectionOutcome
  color: string
}

const importedModules = import.meta.glob<{ default: unknown }>('../data/replay-trade-layers/*.json', { eager: true })
const supportedSymbols: SymbolId[] = ['XAUUSD', 'XAGUSD', 'BTCUSDT.P', 'US500', 'ETHUSD']
const supportedIntervals: IntervalId[] = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w']
const supportedExitReasons = new Set(['INITIAL_STOP_LOSS', 'INITIAL_STOP_LOSS_GAP', 'TRAILING_STOP', 'TRAILING_STOP_GAP', 'OPPOSITE_SIGNAL_CLOSE', 'OPPOSITE_SIGNAL_NEXT_BAR_BREAK', 'END_OF_DATA_MARK_TO_MARKET', 'COURSE_TARGET', 'COURSE_TARGET_GAP'])

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function fallbackSourceId(payload: ReplayDatasetPayload) {
  const symbol = payload.symbol.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return `${symbol}-${payload.interval}-replay-${payload.provenance.backtestSha256.slice(0, 16)}`
}

function validatePayload(value: unknown, origin: string): RegisteredReplayTradeDataset {
  if (!value || typeof value !== 'object') throw new Error(`回放图层不是对象：${origin}`)
  const payload = value as ReplayDatasetPayload
  if (payload.schemaVersion !== 4 || !supportedSymbols.includes(payload.symbol) || !supportedIntervals.includes(payload.interval)) throw new Error(`回放图层元数据无效：${origin}`)
  if (!Number.isInteger(payload.timeframeSeconds) || payload.timeframeSeconds <= 0 || !payload.provenance || !nonEmpty(payload.provenance.backtestFile) || !nonEmpty(payload.provenance.backtestSha256) || !nonEmpty(payload.provenance.scenario) || !Array.isArray(payload.trades) || !payload.summary || payload.trades.length !== payload.summary.trades) throw new Error(`回放图层来源或数量无效：${origin}`)
  const seenTradeNumbers = new Set<number>()
  for (const trade of payload.trades) {
    if (!Number.isInteger(trade.tradeNumber) || trade.tradeNumber < 1 || seenTradeNumbers.has(trade.tradeNumber) || trade.side !== 'long' && trade.side !== 'short') throw new Error(`回放图层交易编号无效：${origin}`)
    seenTradeNumbers.add(trade.tradeNumber)
    if (!trade.entry || !Number.isInteger(trade.entry.time) || trade.entry.time % payload.timeframeSeconds !== 0 || !finite(trade.entry.price) || !finite(trade.entry.stopLoss) || !nonEmpty(trade.entry.beijingTime) || !nonEmpty(trade.entry.setup) || !nonEmpty(trade.entry.reason)) throw new Error(`回放图层开仓数据无效：${origin} #${trade.tradeNumber}`)
    if (!trade.exit || !Number.isInteger(trade.exit.time) || trade.exit.time % payload.timeframeSeconds !== 0 || trade.exit.time < trade.entry.time || !finite(trade.exit.price) || !nonEmpty(trade.exit.beijingTime) || !supportedExitReasons.has(trade.exit.reasonCode)) throw new Error(`回放图层平仓数据无效：${origin} #${trade.tradeNumber}`)
    if (!trade.result || !finite(trade.result.barsHeld) || !finite(trade.result.rMultiple) || !finite(trade.result.pnlUsd)) throw new Error(`回放图层结果无效：${origin} #${trade.tradeNumber}`)
  }
  if (payload.trades.length === 0) throw new Error(`回放图层没有交易：${origin}`)
  const sourceId = nonEmpty(payload.layer?.sourceId) ? payload.layer.sourceId : fallbackSourceId(payload)
  const name = nonEmpty(payload.layer?.name) ? payload.layer.name : `${payload.symbol} 回放交易`
  const replayStartedAtEpoch = payload.provenance.replayStartedAtEpoch
  const startedAt = typeof replayStartedAtEpoch === 'number' && Number.isInteger(replayStartedAtEpoch) && replayStartedAtEpoch > 0 ? replayStartedAtEpoch : null
  const replayFinishedAtEpoch = payload.provenance.replayFinishedAtEpoch
  const finishedAt = typeof replayFinishedAtEpoch === 'number' && Number.isInteger(replayFinishedAtEpoch) && replayFinishedAtEpoch > 0 ? replayFinishedAtEpoch : null
  return {
    sourceId,
    name,
    symbol: payload.symbol,
    interval: payload.interval,
    scenario: payload.provenance.scenario,
    backtestFile: payload.provenance.backtestFile,
    backtestSha256: payload.provenance.backtestSha256,
    startTime: Math.min(...payload.trades.map((trade) => trade.entry.time)),
    endTime: Math.max(...payload.trades.map((trade) => trade.exit.time)),
    startedAt,
    finishedAt,
    tradeCount: payload.trades.length,
    markerCount: payload.trades.length * 2,
    trades: payload.trades,
  }
}

function buildRegistry() {
  const candidates: { origin: string; payload: unknown }[] = [
    { origin: 'xauusd-entry-markers.json', payload: legacyMarkerData },
    ...Object.entries(importedModules).map(([origin, module]) => ({ origin, payload: module.default })),
  ]
  const registry = new Map<string, RegisteredReplayTradeDataset>()
  for (const candidate of candidates) {
    const dataset = validatePayload(candidate.payload, candidate.origin)
    if (registry.has(dataset.sourceId)) throw new Error(`重复的回放图层 sourceId：${dataset.sourceId}`)
    registry.set(dataset.sourceId, dataset)
  }
  return registry
}

const registry = buildRegistry()

export function replayTradeDatasetInfos(): ReplayTradeDatasetInfo[] {
  return [...registry.values()].map((dataset) => ({
    sourceId: dataset.sourceId,
    name: dataset.name,
    symbol: dataset.symbol,
    interval: dataset.interval,
    scenario: dataset.scenario,
    backtestFile: dataset.backtestFile,
    backtestSha256: dataset.backtestSha256,
    startTime: dataset.startTime,
    endTime: dataset.endTime,
    startedAt: dataset.startedAt,
    finishedAt: dataset.finishedAt,
    tradeCount: dataset.tradeCount,
    markerCount: dataset.markerCount,
  }))
}

export function replayDecisionCandidates(sourceIds?: readonly string[]): ReplayDecisionCandidate[] {
  const allowed = sourceIds ? new Set(sourceIds) : null
  const priority = new Map(sourceIds?.map((sourceId, index) => [sourceId, index]) ?? [])
  const candidates = [...registry.values()]
    .filter((dataset) => !allowed || allowed.has(dataset.sourceId))
    .sort((left, right) => (priority.get(left.sourceId) ?? Number.MAX_SAFE_INTEGER) - (priority.get(right.sourceId) ?? Number.MAX_SAFE_INTEGER))
    .flatMap((dataset) => dataset.trades.map((trade) => ({
      // Source files can overlap when the same market window was re-run. The
      // identity deliberately excludes sourceId so an identical signal/entry
      // can never be sampled twice in this or a later practice session.
      key: `${dataset.symbol}:${dataset.interval}:${trade.side}:${trade.entry.signalTime}:${trade.entry.time}`,
      sourceId: dataset.sourceId,
      sourceName: dataset.name,
      symbol: dataset.symbol,
      interval: dataset.interval,
      scenario: dataset.scenario,
      backtestSha256: dataset.backtestSha256,
      trade,
    })))
  return [...new Map(candidates.map((candidate) => [candidate.key, candidate])).values()]
}

function datasetsFor(symbol: SymbolId, interval: IntervalId, sourceIds: readonly string[]) {
  const allowed = new Set(sourceIds)
  return [...registry.values()].filter((dataset) => allowed.has(dataset.sourceId) && dataset.symbol === symbol && dataset.interval === interval)
}

function markerId(sourceId: string, tradeNumber: number, kind: TradeMarkerKind) {
  return `replay-trade-${sourceId}-${tradeNumber}-${kind}`
}

function markerFor(sourceId: string, trade: XauTradeMarker, kind: TradeMarkerKind, active?: ReplayTradeActiveSelection | null): SeriesMarker<UTCTimestamp> {
  const entry = kind === 'entry'
  const long = trade.side === 'long'
  const isActive = active?.sourceId === sourceId && active.tradeNumber === trade.tradeNumber
  return {
    time: (entry ? trade.entry.time : trade.exit.time) as UTCTimestamp,
    position: entry ? (long ? 'belowBar' : 'aboveBar') : (long ? 'aboveBar' : 'belowBar'),
    shape: entry ? (long ? 'arrowUp' : 'arrowDown') : 'circle',
    color: isActive ? '#facc15' : entry ? (long ? '#22ab94' : '#f7525f') : '#f59e0b',
    text: entry ? (long ? '开多' : '开空') : (long ? '平多' : '平空'),
    size: isActive ? 2 : 1,
    id: markerId(sourceId, trade.tradeNumber, kind),
  }
}

export function toReplayTradeSeriesMarkers(symbol: SymbolId, interval: IntervalId, sourceIds: readonly string[], revealedThrough?: number, active?: ReplayTradeActiveSelection | null) {
  return datasetsFor(symbol, interval, sourceIds)
    .flatMap((dataset) => dataset.trades.flatMap((trade) => [markerFor(dataset.sourceId, trade, 'entry', active), markerFor(dataset.sourceId, trade, 'exit', active)]))
    .filter((marker) => revealedThrough === undefined || Number(marker.time) <= revealedThrough)
    .sort((left, right) => Number(left.time) - Number(right.time) || String(left.id).localeCompare(String(right.id)))
}

interface ReplayDecisionSignalEvent {
  sourceId: string
  time: number
  side: XauTradeMarker['side']
}

function oppositeSide(side: XauTradeMarker['side']): XauTradeMarker['side'] {
  return side === 'long' ? 'short' : 'long'
}

/**
 * Builds the causal signal-only stream used by decision replay.
 *
 * Normal replay markers are intentionally unsuitable here: their entry marker
 * is anchored to the later fill candle and they also reveal the system exit and
 * result. Decision replay instead shows a signal exactly when its signal candle
 * becomes known, including an explicit opposite signal that closed a previous
 * system position, without exposing any future fill or PnL information.
 */
export function toReplayDecisionSignalSeriesMarkers(
  symbol: SymbolId,
  interval: IntervalId,
  sourceIds: readonly string[],
  revealedThrough?: number,
  afterSignalTime?: number | null,
): SeriesMarker<UTCTimestamp>[] {
  const events = datasetsFor(symbol, interval, sourceIds).flatMap((dataset): ReplayDecisionSignalEvent[] => dataset.trades.flatMap((trade) => {
    const tradeEvents: ReplayDecisionSignalEvent[] = []
    if (finite(trade.entry.signalTime)) {
      tradeEvents.push({ sourceId: dataset.sourceId, time: trade.entry.signalTime, side: trade.side })
    }
    if (
      (trade.exit.reasonCode === 'OPPOSITE_SIGNAL_CLOSE' || trade.exit.reasonCode === 'OPPOSITE_SIGNAL_NEXT_BAR_BREAK')
      && finite(trade.exit.signalTime)
    ) {
      tradeEvents.push({ sourceId: dataset.sourceId, time: trade.exit.signalTime, side: oppositeSide(trade.side) })
    }
    return tradeEvents
  }))
  const uniqueEvents = [...new Map(events.map((event) => [
    `${event.sourceId}:${event.time}:${event.side}`,
    event,
  ])).values()]
  return uniqueEvents
    .filter((event) => (afterSignalTime === undefined || afterSignalTime === null || event.time > afterSignalTime)
      && (revealedThrough === undefined || event.time <= revealedThrough))
    .map((event): SeriesMarker<UTCTimestamp> => {
      const long = event.side === 'long'
      return {
        time: event.time as UTCTimestamp,
        position: long ? 'belowBar' : 'aboveBar',
        shape: long ? 'arrowUp' : 'arrowDown',
        color: long ? '#22ab94' : '#f7525f',
        text: long ? '多头信号' : '空头信号',
        size: 1,
        id: `decision-signal-${event.sourceId}-${event.time}-${event.side}`,
      }
    })
    .sort((left, right) => Number(left.time) - Number(right.time) || String(left.id).localeCompare(String(right.id)))
}

export function toReplayTradeConnectionSpecs(symbol: SymbolId, interval: IntervalId, sourceIds: readonly string[], revealedThrough?: number): ReplayTradeConnectionSpec[] {
  return datasetsFor(symbol, interval, sourceIds).flatMap((dataset) => dataset.trades
    .filter((trade) => revealedThrough === undefined || trade.exit.time <= revealedThrough)
    .map((trade) => {
      const outcome: XauTradeConnectionOutcome = trade.result.pnlUsd > 0 ? 'profit' : trade.result.pnlUsd < 0 ? 'loss' : 'breakeven'
      return {
        id: `replay-connection-${dataset.sourceId}-${trade.tradeNumber}`,
        sourceId: dataset.sourceId,
        tradeNumber: trade.tradeNumber,
        entryTime: trade.entry.time,
        entryPrice: trade.entry.price,
        exitTime: trade.exit.time,
        exitPrice: trade.exit.price,
        pnlUsd: trade.result.pnlUsd,
        outcome,
        color: XAU_TRADE_CONNECTION_COLORS[outcome],
      }
    }))
}

export function resolveReplayTradeMarker(symbol: SymbolId, interval: IntervalId, sourceIds: readonly string[], id: unknown): ReplayTradeMarkerSelection | null {
  if (typeof id !== 'string') return null
  for (const dataset of datasetsFor(symbol, interval, sourceIds)) {
    const prefix = `replay-trade-${dataset.sourceId}-`
    if (!id.startsWith(prefix)) continue
    const match = /^(\d+)-(entry|exit)$/.exec(id.slice(prefix.length))
    if (!match) return null
    const tradeNumber = Number(match[1])
    const trade = dataset.trades.find((item) => item.tradeNumber === tradeNumber)
    return trade ? { id, sourceId: dataset.sourceId, kind: match[2] as TradeMarkerKind, trade } : null
  }
  return null
}
