import type { SeriesMarker, UTCTimestamp } from 'lightweight-charts'
import type { Candle, IntervalId, SymbolId } from './market'

/**
 * Research signal layers are visual evidence only.  They deliberately do not
 * implement the replay-trade contract and never create an order, entry, stop,
 * exit, or PnL record.
 */
export type ResearchSignalBar = Candle

export interface ResearchSignalWindow {
  id: string
  startTime: number
  endTime: number
  startIdx?: number
  endIdxExclusive?: number
  sourceSha256?: string
  bars?: ResearchSignalBar[]
}

export interface ResearchSignal {
  id: string
  windowId: string
  idx: number
  time: number
  beijingTime?: string
  side: 'long' | 'short'
  price?: number
  reason: string
  context: unknown
  evidenceIndices: number[]
  reviewNote: string
  reviewVerdict?: 'keep' | 'filter' | 'uncertain'
  /** Optional display overrides for a research-only marker. */
  markerLabel?: string
  markerColor?: string
  filterReview?: {
    supportingEvidence: string[]
    counterEvidence: string[]
    decisiveDifference: string
    waitConditions: string
    annotatedImage: string
    disputes: string[]
    revisionNote: string
    cases: { caseId: string; similarities: string; differences: string; basis: string; effect: string; images: string[]; originalImages: string[] }[]
  }
  [key: string]: unknown
}

export interface ResearchSignalPayload {
  schemaVersion: 1
  sourceId: string
  name: string
  symbol: SymbolId
  interval: IntervalId
  reviewNote: string
  provenance?: Record<string, unknown>
  auditPoints?: unknown
  signals: ResearchSignal[]
  windows: ResearchSignalWindow[]
  [key: string]: unknown
}

export interface ResearchSignalDatasetInfo {
  sourceId: string
  name: string
  symbol: SymbolId
  interval: IntervalId
  reviewNote: string
  signalCount: number
  longCount: number
  shortCount: number
  windowCount: number
  auditedPointCount: number | null
}

export interface ResearchSignalDataset extends ResearchSignalDatasetInfo {
  provenance?: Record<string, unknown>
  auditPoints?: unknown
  signals: ResearchSignal[]
  windows: ResearchSignalWindow[]
}

export interface ResearchSignalMarkerSelection {
  id: string
  sourceId: string
  name: string
  symbol: SymbolId
  interval: IntervalId
  reviewNote: string
  provenance?: Record<string, unknown>
  auditPoints?: unknown
  signal: ResearchSignal
  window: ResearchSignalWindow
}

const supportedSymbols: SymbolId[] = ['XAUUSD', 'XAGUSD', 'BTCUSDT.P', 'US500', 'ETHUSD']
const supportedIntervals: IntervalId[] = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w']

/** Top-level signal keys which would turn an evidence marker into an order. */
export const RESEARCH_SIGNAL_FORBIDDEN_FIELDS = [
  'entry', 'entryPrice', 'initialStop', 'initialStopPrice', 'stop', 'stopLoss',
  'takeProfit', 'exit', 'exitPrice', 'fill', 'order', 'orderId', 'quantity',
  'pnl', 'pnlUsd', 'profit', 'position', 'trade', 'risk',
] as const

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function causalIndices(value: unknown, signalIdx: number): value is number[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((idx) => integer(idx) && idx >= 0 && idx <= signalIdx)
}

function validateBar(value: unknown, origin: string, windowId: string, index: number): ResearchSignalBar {
  if (!value || typeof value !== 'object') throw new Error(`研究信号冻结 K 线无效：${origin} ${windowId} #${index}`)
  const bar = value as Partial<ResearchSignalBar>
  if (!integer(bar.time) || bar.time <= 0 || !finite(bar.open) || !finite(bar.high) || !finite(bar.low) || !finite(bar.close) || !finite(bar.volume)) {
    throw new Error(`研究信号冻结 K 线字段无效：${origin} ${windowId} #${index}`)
  }
  if (bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) || bar.low > bar.high || bar.volume < 0) {
    throw new Error(`研究信号冻结 K 线 OHLCV 无效：${origin} ${windowId} #${index}`)
  }
  return {
    time: bar.time,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  }
}

function validateWindow(value: unknown, origin: string, seenWindowIds: Set<string>): ResearchSignalWindow {
  if (!value || typeof value !== 'object') throw new Error(`研究信号窗口无效：${origin}`)
  const window = value as Partial<ResearchSignalWindow>
  if (!nonEmpty(window.id) || seenWindowIds.has(window.id) || !finite(window.startTime) || !finite(window.endTime) || window.startTime > window.endTime) {
    throw new Error(`研究信号窗口身份或时间无效：${origin}`)
  }
  const bars = window.bars === undefined ? undefined : (() => {
    if (!Array.isArray(window.bars) || window.bars.length === 0) throw new Error(`研究信号窗口冻结 K 线缺失：${origin} ${window.id}`)
    const next = window.bars.map((bar, index) => validateBar(bar, origin, window.id!, index))
    for (let index = 1; index < next.length; index += 1) {
      if (next[index].time <= next[index - 1].time) throw new Error(`研究信号窗口 K 线时间未严格递增：${origin} ${window.id}`)
    }
    // The generated windows expose the complete 420-bar frozen context while
    // startTime marks the 300-bar evaluation boundary.  Earlier context bars
    // are intentional and are needed when a signal is selected.
    if (next.at(-1)!.time > window.endTime) {
      throw new Error(`研究信号窗口 K 线超出窗口边界：${origin} ${window.id}`)
    }
    return next
  })()
  seenWindowIds.add(window.id)
  if (window.startIdx !== undefined && (!integer(window.startIdx) || window.startIdx < 0)) throw new Error(`研究信号窗口起始索引无效：${origin} ${window.id}`)
  if (window.endIdxExclusive !== undefined && (!integer(window.endIdxExclusive) || window.endIdxExclusive <= 0)) throw new Error(`研究信号窗口结束索引无效：${origin} ${window.id}`)
  if (window.sourceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(window.sourceSha256)) throw new Error(`研究信号窗口来源哈希无效：${origin} ${window.id}`)
  return {
    id: window.id,
    startTime: window.startTime,
    endTime: window.endTime,
    ...(window.startIdx !== undefined ? { startIdx: window.startIdx } : {}),
    ...(window.endIdxExclusive !== undefined ? { endIdxExclusive: window.endIdxExclusive } : {}),
    ...(window.sourceSha256 !== undefined ? { sourceSha256: window.sourceSha256 } : {}),
    ...(bars ? { bars } : {}),
  }
}

function auditedPointCount(value: unknown): number | null {
  if (Array.isArray(value)) return value.length
  if (value && typeof value === 'object') return Object.keys(value).length
  return null
}

/** Validate a research payload without applying the production replay schema. */
export function validateResearchSignalPayload(value: unknown, origin = 'research-signal-layer'): ResearchSignalDataset {
  if (!value || typeof value !== 'object') throw new Error(`研究信号层不是对象：${origin}`)
  const payload = value as Partial<ResearchSignalPayload>
  if (payload.schemaVersion !== 1 || !nonEmpty(payload.sourceId) || !nonEmpty(payload.name) || !supportedSymbols.includes(payload.symbol as SymbolId) || !supportedIntervals.includes(payload.interval as IntervalId)) {
    throw new Error(`研究信号层元数据无效：${origin}`)
  }
  if (!nonEmpty(payload.reviewNote) || !Array.isArray(payload.windows) || payload.windows.length === 0 || !Array.isArray(payload.signals)) {
    throw new Error(`研究信号层说明或集合无效：${origin}`)
  }
  const seenWindowIds = new Set<string>()
  const windows = payload.windows.map((window) => validateWindow(window, origin, seenWindowIds))
  const windowsById = new Map(windows.map((window) => [window.id, window]))
  const seenSignalIds = new Set<string>()
  const signals = payload.signals.map((value, signalIndex) => {
    if (!value || typeof value !== 'object') throw new Error(`研究信号记录无效：${origin} #${signalIndex + 1}`)
    const signal = value as ResearchSignal
    if (signal.reviewVerdict !== undefined && !['keep', 'filter', 'uncertain'].includes(signal.reviewVerdict)) throw new Error(`研究信号复核结论无效：${origin}`)
    const forbidden = RESEARCH_SIGNAL_FORBIDDEN_FIELDS.find((field) => Object.prototype.hasOwnProperty.call(signal, field))
    if (forbidden) throw new Error(`研究信号包含交易字段 ${forbidden}：${origin} #${signalIndex + 1}`)
    if (!nonEmpty(signal.id) || seenSignalIds.has(signal.id) || !nonEmpty(signal.windowId) || !windowsById.has(signal.windowId) || !integer(signal.idx) || signal.idx < 0 || !finite(signal.time) || (signal.side !== 'long' && signal.side !== 'short') || !nonEmpty(signal.reason) || signal.context === undefined || !causalIndices(signal.evidenceIndices, signal.idx) || !nonEmpty(signal.reviewNote)) {
      throw new Error(`研究信号字段无效：${origin} #${signalIndex + 1}`)
    }
    if (signal.beijingTime !== undefined && !nonEmpty(signal.beijingTime)) throw new Error(`研究信号北京时间无效：${origin} #${signalIndex + 1}`)
    if (signal.price !== undefined && !finite(signal.price)) throw new Error(`研究信号价格无效：${origin} #${signalIndex + 1}`)
    const window = windowsById.get(signal.windowId)!
    if (window.bars) {
      if (signal.idx >= window.bars.length || window.bars[signal.idx].time !== signal.time) throw new Error(`研究信号未绑定窗口冻结 K 线：${origin} #${signalIndex + 1}`)
      if (signal.price !== undefined && signal.price !== window.bars[signal.idx].close) throw new Error(`研究信号价格不是冻结收盘价：${origin} #${signalIndex + 1}`)
      if (signal.evidenceIndices.some((idx) => idx >= window.bars!.length)) throw new Error(`研究信号证据超出冻结窗口：${origin} #${signalIndex + 1}`)
    }
    seenSignalIds.add(signal.id)
    return { ...signal, evidenceIndices: [...signal.evidenceIndices] }
  })
  const longCount = signals.filter((signal) => signal.side === 'long').length
  return {
    sourceId: payload.sourceId,
    name: payload.name,
    symbol: payload.symbol as SymbolId,
    interval: payload.interval as IntervalId,
    reviewNote: payload.reviewNote,
    signalCount: signals.length,
    longCount,
    shortCount: signals.length - longCount,
    windowCount: windows.length,
    auditedPointCount: auditedPointCount(payload.auditPoints),
    provenance: payload.provenance,
    auditPoints: payload.auditPoints,
    signals,
    windows,
  }
}

const importedModules = import.meta.glob<{ default: unknown }>([
  '../data/research-signal-layers/*.json',
  '!../data/research-signal-layers/round2-baseline.json',
  '!../data/research-signal-layers/round2-candidate.json',
], { eager: true })

function buildRegistry() {
  const next = new Map<string, ResearchSignalDataset>()
  for (const [origin, module] of Object.entries(importedModules)) {
    const dataset = validateResearchSignalPayload(module.default, origin)
    if (next.has(dataset.sourceId)) throw new Error(`重复的研究信号层 sourceId：${dataset.sourceId}`)
    next.set(dataset.sourceId, dataset)
  }
  return next
}

const registry = buildRegistry()

export function researchSignalDatasetInfos(): ResearchSignalDatasetInfo[] {
  return [...registry.values()].map(({ sourceId, name, symbol, interval, reviewNote, signalCount, longCount, shortCount, windowCount, auditedPointCount }) => ({ sourceId, name, symbol, interval, reviewNote, signalCount, longCount, shortCount, windowCount, auditedPointCount }))
}

export function researchSignalDatasets(): ResearchSignalDataset[] {
  return [...registry.values()]
}

export function researchSignalDataset(sourceId: string): ResearchSignalDataset | null {
  return registry.get(sourceId) ?? null
}

export function researchSignalWindow(sourceId: string, windowId: string): ResearchSignalWindow | null {
  return registry.get(sourceId)?.windows.find((window) => window.id === windowId) ?? null
}

export function researchSignalSourceIds(symbol: SymbolId, interval: IntervalId): string[] {
  return [...registry.values()].filter((dataset) => dataset.symbol === symbol && dataset.interval === interval).map((dataset) => dataset.sourceId)
}

function markerId(sourceId: string, signalId: string) {
  return `research-signal-${sourceId}-${encodeURIComponent(signalId)}`
}

function markerFor(dataset: ResearchSignalDataset, signal: ResearchSignal): SeriesMarker<UTCTimestamp> {
  const long = signal.side === 'long'
  const candidate = dataset.sourceId.includes('candidate')
  const verdict = signal.reviewVerdict
  const reviewedColor = verdict === 'filter' ? '#8993a4' : verdict === 'uncertain' ? '#f4cf58' : '#2dd4bf'
  const reviewedLabel = verdict === 'filter' ? '已滤' : verdict === 'uncertain' ? '待定' : '保留'
  return {
    time: signal.time as UTCTimestamp,
    position: long ? 'belowBar' : 'aboveBar',
    shape: long ? 'arrowUp' : 'arrowDown',
    color: signal.markerColor ?? (verdict ? reviewedColor : candidate ? (long ? '#a855f7' : '#c026d3') : (long ? '#0ea5a4' : '#0891b2')),
    text: signal.markerLabel ?? `${verdict ? reviewedLabel : candidate ? '补充' : '原版'}${long ? '多' : '空'}`,
    size: 1,
    id: markerId(dataset.sourceId, signal.id),
  }
}

export function toResearchSignalSeriesMarkers(symbol: SymbolId, interval: IntervalId, sourceIds: readonly string[] = [], revealedThrough?: number, showAllReviews = true): SeriesMarker<UTCTimestamp>[] {
  const allowed = new Set(sourceIds)
  return [...registry.values()]
    .filter((dataset) => dataset.symbol === symbol && dataset.interval === interval && allowed.has(dataset.sourceId))
    .flatMap((dataset) => dataset.signals
      .filter((signal) => (revealedThrough === undefined || signal.time <= revealedThrough) && (showAllReviews || !signal.reviewVerdict || signal.reviewVerdict === 'keep'))
      .map((signal) => markerFor(dataset, signal)))
    .sort((left, right) => Number(left.time) - Number(right.time) || String(left.id).localeCompare(String(right.id)))
}

export function resolveResearchSignalMarker(symbol: SymbolId, interval: IntervalId, sourceIds: readonly string[], id: unknown): ResearchSignalMarkerSelection | null {
  if (typeof id !== 'string') return null
  const allowed = new Set(sourceIds)
  for (const dataset of registry.values()) {
    if (dataset.symbol !== symbol || dataset.interval !== interval || !allowed.has(dataset.sourceId)) continue
    const signal = dataset.signals.find((item) => markerId(dataset.sourceId, item.id) === id)
    if (!signal) continue
    const window = dataset.windows.find((item) => item.id === signal.windowId)
    if (!window) return null
    return { id, sourceId: dataset.sourceId, name: dataset.name, symbol: dataset.symbol, interval: dataset.interval, reviewNote: dataset.reviewNote, provenance: dataset.provenance, auditPoints: dataset.auditPoints, signal, window }
  }
  return null
}

export function researchSignalMarkerId(sourceId: string, signalId: string): string {
  return markerId(sourceId, signalId)
}
