import type { SeriesMarker, UTCTimestamp } from 'lightweight-charts'
import type { IntervalId, SymbolId } from './market'

const CUSTOM_V2_SETUPS = new Set([
  '震荡真突破',
  '震荡反转',
  '窄通道首次回调顺势',
  '窄通道回调顺势',
  '支撑压力反转',
  '两天以上支撑压力反转',
])
const CUSTOM_V2_RULE_VERSIONS = new Set([
  'custom_v2_range_lifecycle_bound_effective_swing_sr',
  'custom_v2',
  'custom_v2_range30_one_sided',
  'custom_v2_range30_one_sided_unanchored_pullback',
  'custom_v2_range30_one_sided_unanchored_pullback_five_close_breakout',
  'custom_v2_range30_one_sided_anchor_required_five_close_breakout',
  'custom_v2_range30_one_sided_anchor_candle_contact_five_close_breakout',
  'custom_v2_range30_one_sided_any_pullback_body50_anchor_contact_five_close_breakout',
  'custom_v2_range30_one_sided_strict_narrow_channel_any_pullback_body50_anchor_contact_five_close_breakout',
  'custom_v2_range30_one_sided_strict_narrow_channel_ema20_two_close_any_pullback_body50_anchor_contact_five_close_breakout',
  'custom_v2_range30_one_sided_strict_narrow_channel_ema20_two_close_any_pullback_body50_anchor_contact_five_close_breakout_effective_swing_sr',
])

export interface ReplaySignalContext {
  rule_version: string
  family: string
  variant: string
  signal_bar_idx: number
  structure_indices: number[]
  entry_trigger_price: number
  initial_stop_price: number
  initial_stop_reference_idx: number
  [key: string]: unknown
}

export interface ReplaySignal {
  signalNumber: number
  idx: number
  time: number
  beijingTime: string
  side: 'long' | 'short'
  setup: string
  reason: string
  displayReason: string
  evidenceIndices: number[]
  referenceCandles: Array<{
    internalIndex: number
    time: number
    beijingTime: string
  }>
  recordSha256: string
  chainSha256: string
  signalContext: ReplaySignalContext
}

interface ReplaySignalPayload {
  schemaVersion: number
  symbol: SymbolId
  interval: IntervalId
  timeframeSeconds: number
  layer: {
    sourceId: string
    name: string
  }
  provenance: {
    rawSignalsFile: string
    rawSignalsSha256: string
    ruleSetId: string
    ruleSetSha256: string
    sourceDataSha256: string
    frozenDataFile: string
    frozenDataSha256: string
    inputMode: string
    signalMode: string
    generatedBy: string
  }
  window: {
    startTime: number
    endTime: number
    firstBeijingTime: string
    lastBeijingTime: string
  }
  summary: {
    signals: number
    long: number
    short: number
    setupCounts: Record<string, number>
  }
  signals: ReplaySignal[]
}

export interface ReplaySignalDatasetInfo {
  sourceId: string
  name: string
  symbol: SymbolId
  interval: IntervalId
  rawSignalsFile: string
  rawSignalsSha256: string
  ruleSetId: string
  ruleSetSha256: string
  startTime: number
  endTime: number
  signalCount: number
  longCount: number
  shortCount: number
  setupCounts: Record<string, number>
}

export interface ReplaySignalMarkerSelection {
  id: string
  sourceId: string
  name: string
  ruleSetId: string
  ruleSetSha256: string
  rawSignalsSha256: string
  signal: ReplaySignal
}

export interface ReplaySignalRangeSpec {
  id: string
  sourceId: string
  signalNumbers: number[]
  startTime: number
  endTime: number
  upperZoneLow: number
  upperZoneHigh: number
  lowerZoneLow: number
  lowerZoneHigh: number
  midpoint: number
}


interface ReplaySignalRangeGeometry {
  upper_zone_low: number
  upper_zone_high: number
  lower_zone_low: number
  lower_zone_high: number
  midpoint: number
}

interface RegisteredReplaySignalDataset extends ReplaySignalDatasetInfo {
  timeframeSeconds: number
  signals: ReplaySignal[]
}

const importedModules = import.meta.glob<{ default: unknown }>('../data/replay-signal-layers/*.json', { eager: true })
const supportedSymbols: SymbolId[] = ['XAUUSD', 'XAGUSD', 'BTCUSDT.P', 'US500', 'ETHUSD']
const supportedIntervals: IntervalId[] = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w']

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function causalIndices(value: unknown, signalIdx: number): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((idx) => Number.isInteger(idx) && idx <= signalIdx)
}

function validRangeGeometry(value: unknown): value is ReplaySignalRangeGeometry {
  if (!value || typeof value !== 'object') return false
  const range = value as Partial<ReplaySignalRangeGeometry>
  return finite(range.upper_zone_low)
    && finite(range.upper_zone_high)
    && finite(range.lower_zone_low)
    && finite(range.lower_zone_high)
    && finite(range.midpoint)
    && range.lower_zone_low <= range.lower_zone_high
    && range.lower_zone_high < range.upper_zone_low
    && range.upper_zone_low <= range.upper_zone_high
    && range.midpoint >= range.lower_zone_high
    && range.midpoint <= range.upper_zone_low
}

function validActiveRangeGeometry(value: unknown, requireLifecycleId = false): boolean {
  if (!value || typeof value !== 'object') return false
  const range = value as Record<string, unknown>
  if (requireLifecycleId && (typeof range.range_lifecycle_id !== 'string' || !range.range_lifecycle_id.startsWith('range-lifecycle-'))) return false
  if (range.kind === 'one_sided_edge') {
    const edge = range.active_edge
    if (edge !== 'upper' && edge !== 'lower') return false
    const low = range[`${edge}_zone_low`]
    const high = range[`${edge}_zone_high`]
    const touches = range[`${edge}_touch_indices`]
    return Number.isInteger(range.start_idx) && Number.isInteger(range.end_idx)
      && Number(range.end_idx) - Number(range.start_idx) + 1 >= 30
      && finite(low) && finite(high) && low <= high
      && Array.isArray(touches) && touches.length >= 3
  }
  if (range.kind === 'two_sided_range') {
    return Number.isInteger(range.start_idx) && Number.isInteger(range.end_idx)
      && Number(range.end_idx) - Number(range.start_idx) + 1 >= 30
      && validRangeGeometry(range)
      && Array.isArray(range.upper_touch_indices) && range.upper_touch_indices.length >= 2
      && Array.isArray(range.lower_touch_indices) && range.lower_touch_indices.length >= 2
  }
  return validRangeGeometry(range)
}

function validatePayload(value: unknown, origin: string): RegisteredReplaySignalDataset {
  if (!value || typeof value !== 'object') throw new Error(`回放信号层不是对象：${origin}`)
  const payload = value as ReplaySignalPayload
  if (payload.schemaVersion !== 2 || !supportedSymbols.includes(payload.symbol) || !supportedIntervals.includes(payload.interval)) throw new Error(`回放信号层元数据无效：${origin}`)
  if (!Number.isInteger(payload.timeframeSeconds) || payload.timeframeSeconds <= 0 || !payload.layer || !nonEmpty(payload.layer.sourceId) || !nonEmpty(payload.layer.name)) throw new Error(`回放信号层身份无效：${origin}`)
  if (!payload.provenance || !nonEmpty(payload.provenance.rawSignalsFile) || !sha256(payload.provenance.rawSignalsSha256) || !nonEmpty(payload.provenance.ruleSetId) || !sha256(payload.provenance.ruleSetSha256) || !sha256(payload.provenance.sourceDataSha256) || !nonEmpty(payload.provenance.frozenDataFile) || payload.provenance.frozenDataSha256 !== payload.provenance.sourceDataSha256 || payload.provenance.inputMode !== 'image/png' || payload.provenance.signalMode !== 'raw_non_deduplicated') throw new Error(`回放信号层来源无效：${origin}`)
  if (!payload.summary || !Array.isArray(payload.signals) || payload.signals.length === 0 || payload.signals.length !== payload.summary.signals || payload.summary.long + payload.summary.short !== payload.summary.signals) throw new Error(`回放信号层数量无效：${origin}`)

  const seenNumbers = new Set<number>()
  const seenIndices = new Set<number>()
  const seenTimes = new Set<number>()
  const actualSetups: Record<string, number> = {}
  let actualLong = 0
  let actualShort = 0
  for (const signal of payload.signals) {
    if (!Number.isInteger(signal.signalNumber) || signal.signalNumber < 1 || seenNumbers.has(signal.signalNumber) || !Number.isInteger(signal.idx) || seenIndices.has(signal.idx)) throw new Error(`回放信号层编号无效：${origin}`)
    if (!Number.isInteger(signal.time) || signal.time % payload.timeframeSeconds !== 0 || seenTimes.has(signal.time) || !nonEmpty(signal.beijingTime)) throw new Error(`回放信号层时间无效：${origin} #${signal.signalNumber}`)
    if (signal.side !== 'long' && signal.side !== 'short' || !CUSTOM_V2_SETUPS.has(signal.setup) || !nonEmpty(signal.reason)) throw new Error(`回放信号层规则无效：${origin} #${signal.signalNumber}`)
    if (!nonEmpty(signal.displayReason) || !Array.isArray(signal.referenceCandles) || signal.referenceCandles.length === 0) throw new Error(`回放信号层显示时间无效：${origin} #${signal.signalNumber}`)
    if (!causalIndices(signal.evidenceIndices, signal.idx) || !sha256(signal.recordSha256) || !sha256(signal.chainSha256)) throw new Error(`回放信号层证据无效：${origin} #${signal.signalNumber}`)
    if (!CUSTOM_V2_RULE_VERSIONS.has(signal.signalContext?.rule_version) || signal.signalContext?.signal_bar_idx !== signal.idx || !nonEmpty(signal.signalContext.family) || !nonEmpty(signal.signalContext.variant) || !causalIndices(signal.signalContext.structure_indices, signal.idx) || !finite(signal.signalContext.entry_trigger_price) || !finite(signal.signalContext.initial_stop_price) || !Number.isInteger(signal.signalContext.initial_stop_reference_idx) || signal.signalContext.initial_stop_reference_idx > signal.idx) throw new Error(`回放信号层上下文无效：${origin} #${signal.signalNumber}`)
    if (['range_true_breakout', 'range_reversal'].includes(signal.signalContext.family) && !validActiveRangeGeometry(signal.signalContext.range, signal.signalContext.rule_version === 'custom_v2_range_lifecycle_bound_effective_swing_sr')) throw new Error(`回放信号层震荡区间无效：${origin} #${signal.signalNumber}`)
    const referenceTimes = new Map<number, string>()
    for (const candle of signal.referenceCandles) {
      if (!Number.isInteger(candle.internalIndex) || candle.internalIndex > signal.idx || referenceTimes.has(candle.internalIndex) || !Number.isInteger(candle.time) || candle.time % payload.timeframeSeconds !== 0 || !nonEmpty(candle.beijingTime)) throw new Error(`回放信号层引用时间无效：${origin} #${signal.signalNumber}`)
      referenceTimes.set(candle.internalIndex, candle.beijingTime)
    }
    const requiredIndices = new Set([signal.idx, ...signal.evidenceIndices, ...signal.signalContext.structure_indices, signal.signalContext.initial_stop_reference_idx])
    if ([...requiredIndices].some((idx) => !referenceTimes.has(idx))) throw new Error(`回放信号层引用时间缺失：${origin} #${signal.signalNumber}`)
    if (referenceTimes.get(signal.idx) !== signal.beijingTime) throw new Error(`回放信号层信号时间不一致：${origin} #${signal.signalNumber}`)
    seenNumbers.add(signal.signalNumber)
    seenIndices.add(signal.idx)
    seenTimes.add(signal.time)
    actualSetups[signal.setup] = (actualSetups[signal.setup] ?? 0) + 1
    if (signal.side === 'long') actualLong += 1
    else actualShort += 1
  }
  if (actualLong !== payload.summary.long || actualShort !== payload.summary.short) throw new Error(`回放信号层方向汇总无效：${origin}`)
  for (const setup of CUSTOM_V2_SETUPS) {
    if ((payload.summary.setupCounts[setup] ?? 0) !== (actualSetups[setup] ?? 0)) throw new Error(`回放信号层 setup 汇总无效：${origin}`)
  }
  const startTime = Math.min(...payload.signals.map((signal) => signal.time))
  const endTime = Math.max(...payload.signals.map((signal) => signal.time))
  if (payload.window?.startTime !== startTime || payload.window?.endTime !== endTime) throw new Error(`回放信号层窗口无效：${origin}`)

  return {
    sourceId: payload.layer.sourceId,
    name: payload.layer.name,
    symbol: payload.symbol,
    interval: payload.interval,
    rawSignalsFile: payload.provenance.rawSignalsFile,
    rawSignalsSha256: payload.provenance.rawSignalsSha256,
    ruleSetId: payload.provenance.ruleSetId,
    ruleSetSha256: payload.provenance.ruleSetSha256,
    startTime,
    endTime,
    signalCount: payload.summary.signals,
    longCount: payload.summary.long,
    shortCount: payload.summary.short,
    setupCounts: payload.summary.setupCounts,
    timeframeSeconds: payload.timeframeSeconds,
    signals: payload.signals,
  }
}

function buildRegistry() {
  const registry = new Map<string, RegisteredReplaySignalDataset>()
  for (const [origin, module] of Object.entries(importedModules)) {
    const dataset = validatePayload(module.default, origin)
    if (registry.has(dataset.sourceId)) throw new Error(`重复的回放信号层 sourceId：${dataset.sourceId}`)
    registry.set(dataset.sourceId, dataset)
  }
  return registry
}

const registry = buildRegistry()

export function replaySignalDatasetInfos(): ReplaySignalDatasetInfo[] {
  return [...registry.values()].map((dataset) => ({
    sourceId: dataset.sourceId,
    name: dataset.name,
    symbol: dataset.symbol,
    interval: dataset.interval,
    rawSignalsFile: dataset.rawSignalsFile,
    rawSignalsSha256: dataset.rawSignalsSha256,
    ruleSetId: dataset.ruleSetId,
    ruleSetSha256: dataset.ruleSetSha256,
    startTime: dataset.startTime,
    endTime: dataset.endTime,
    signalCount: dataset.signalCount,
    longCount: dataset.longCount,
    shortCount: dataset.shortCount,
    setupCounts: dataset.setupCounts,
  }))
}

function markerFor(sourceId: string, signal: ReplaySignal): SeriesMarker<UTCTimestamp> {
  const long = signal.side === 'long'
  return {
    time: signal.time as UTCTimestamp,
    position: long ? 'belowBar' : 'aboveBar',
    shape: long ? 'arrowUp' : 'arrowDown',
    color: long ? '#22ab94' : '#f7525f',
    text: long ? 'V2多' : 'V2空',
    size: 1,
    id: `replay-signal-${sourceId}-${signal.signalNumber}`,
  }
}

export function toReplaySignalSeriesMarkers(symbol: SymbolId, interval: IntervalId, revealedThrough?: number) {
  return [...registry.values()]
    .filter((dataset) => dataset.symbol === symbol && dataset.interval === interval)
    .flatMap((dataset) => dataset.signals.map((signal) => markerFor(dataset.sourceId, signal)))
    .filter((marker) => revealedThrough === undefined || Number(marker.time) <= revealedThrough)
    .sort((left, right) => Number(left.time) - Number(right.time) || String(left.id).localeCompare(String(right.id)))
}

export function toReplaySignalRangeSpecs(symbol: SymbolId, interval: IntervalId, revealedThrough?: number): ReplaySignalRangeSpec[] {
  const grouped = new Map<string, ReplaySignalRangeSpec>()
  for (const dataset of registry.values()) {
    if (dataset.symbol !== symbol || dataset.interval !== interval) continue
    for (const signal of dataset.signals) {
      if (revealedThrough !== undefined && signal.time > revealedThrough) continue
      const range = signal.signalContext.range
      if (!validRangeGeometry(range)) continue
      const structureIndices = signal.signalContext.structure_indices
      const structureCandles = signal.referenceCandles.filter((candle) => structureIndices.includes(candle.internalIndex))
      if (structureCandles.length === 0) throw new Error(`信号 #${signal.signalNumber} 缺少震荡区间起点时间`)
      const rangeRecord = range as ReplaySignalRangeGeometry & Record<string, unknown>
      const lifecycleId = typeof rangeRecord.range_lifecycle_id === 'string'
        ? rangeRecord.range_lifecycle_id
        : null
      const lifecycleStartCandle = Number.isInteger(rangeRecord.start_idx)
        ? signal.referenceCandles.find((candle) => candle.internalIndex === rangeRecord.start_idx)
        : undefined
      if (lifecycleId && !lifecycleStartCandle) throw new Error(`信号 #${signal.signalNumber} 缺少实际区间生命周期起点时间`)
      const startTime = lifecycleStartCandle?.time ?? Math.min(...structureCandles.map((candle) => candle.time))
      const lifecycleTouchIndices = lifecycleId
        ? [...new Set([
            ...(Array.isArray(rangeRecord.upper_touch_indices) ? rangeRecord.upper_touch_indices : []),
            ...(Array.isArray(rangeRecord.lower_touch_indices) ? rangeRecord.lower_touch_indices : []),
          ].filter((idx): idx is number => Number.isInteger(idx)))]
        : []
      const lifecycleEndCandle = lifecycleId && lifecycleTouchIndices.length > 0
        ? signal.referenceCandles.find((candle) => candle.internalIndex === Math.max(...lifecycleTouchIndices))
        : undefined
      if (lifecycleId && !lifecycleEndCandle) throw new Error(`信号 #${signal.signalNumber} 缺少实际区间生命周期末次触碰时间`)
      const displayEndTime = lifecycleEndCandle?.time ?? signal.time
      const key = lifecycleId
        ? [dataset.sourceId, lifecycleId].join('|')
        : [
            dataset.sourceId, startTime,
            range.upper_zone_low, range.upper_zone_high,
            range.lower_zone_low, range.lower_zone_high,
            range.midpoint,
          ].join('|')
      const existing = grouped.get(key)
      if (existing) {
        existing.endTime = Math.max(existing.endTime, displayEndTime)
        existing.signalNumbers.push(signal.signalNumber)
        continue
      }
      grouped.set(key, {
        id: lifecycleId
          ? `replay-signal-range-${dataset.sourceId}-${lifecycleId}`
          : `replay-signal-range-${dataset.sourceId}-${signal.signalNumber}`,
        sourceId: dataset.sourceId,
        signalNumbers: [signal.signalNumber],
        startTime,
        endTime: displayEndTime,
        upperZoneLow: range.upper_zone_low,
        upperZoneHigh: range.upper_zone_high,
        lowerZoneLow: range.lower_zone_low,
        lowerZoneHigh: range.lower_zone_high,
        midpoint: range.midpoint,
      })
    }
  }
  return [...grouped.values()]
    .map((spec) => ({ ...spec, signalNumbers: [...spec.signalNumbers].sort((left, right) => left - right) }))
    .sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime || left.id.localeCompare(right.id))
}


export function resolveReplaySignalMarker(symbol: SymbolId, interval: IntervalId, id: unknown): ReplaySignalMarkerSelection | null {
  if (typeof id !== 'string') return null
  for (const dataset of registry.values()) {
    if (dataset.symbol !== symbol || dataset.interval !== interval) continue
    const prefix = `replay-signal-${dataset.sourceId}-`
    if (!id.startsWith(prefix)) continue
    const match = /^(\d+)$/.exec(id.slice(prefix.length))
    if (!match) return null
    const signal = dataset.signals.find((item) => item.signalNumber === Number(match[1]))
    if (!signal) return null
    return {
      id,
      sourceId: dataset.sourceId,
      name: dataset.name,
      ruleSetId: dataset.ruleSetId,
      ruleSetSha256: dataset.ruleSetSha256,
      rawSignalsSha256: dataset.rawSignalsSha256,
      signal,
    }
  }
  return null
}

export function toggleReplaySignalMarkerSelection(currentId: string | null, nextId: string): string | null {
  return currentId === nextId ? null : nextId
}

export function replaySignalCandleBeijingTime(signal: ReplaySignal, internalIndex: number): string {
  const candle = signal.referenceCandles.find((item) => item.internalIndex === internalIndex)
  if (!candle) throw new Error(`信号 #${signal.signalNumber} 缺少 K 线时间映射`)
  return candle.beijingTime
}
