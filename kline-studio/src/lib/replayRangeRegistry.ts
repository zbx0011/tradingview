import type { IntervalId, SymbolId } from './market'

export interface ReplayRangeDatasetInfo {
  sourceId: string
  name: string
  symbol: SymbolId
  interval: IntervalId
  startTime: number
  endTime: number
  rangeCount: number
  twoSidedCount: number
  oneSidedCount: number
  ruleSetId: string
  ruleSetSha256: string
}

interface ReplayRangeCommon {
  rangeId: string
  kind: 'two_sided_range' | 'one_sided_edge'
  startIdx: number
  formationEndIdx: number
  firstDetectedIdx: number
  lastObservedIdx: number
  startTime: number
  formationEndTime: number
  firstDetectedTime: number
  lastObservedTime: number
  displayEndTime: number
  status: 'active' | 'broken'
  brokenAtTime: number | null
  userConfirmedDisplaySupplement?: boolean
  evidenceSource?: string
  supplementReason?: string
}

interface ReplayTwoSidedRange extends ReplayRangeCommon {
  kind: 'two_sided_range'
  upperZoneLow: number
  upperZoneHigh: number
  lowerZoneLow: number
  lowerZoneHigh: number
  midpoint: number
  upperTouchIndices: number[]
  lowerTouchIndices: number[]
}

interface ReplayOneSidedRange extends ReplayRangeCommon {
  kind: 'one_sided_edge'
  activeEdge: 'upper' | 'lower'
  edgeZoneLow: number
  edgeZoneHigh: number
  touchIndices: number[]
}

type ReplayRange = ReplayTwoSidedRange | ReplayOneSidedRange

interface ReplayRangePayload {
  schemaVersion: number
  symbol: SymbolId
  interval: IntervalId
  timeframeSeconds: number
  layer: { sourceId: string; name: string }
  provenance: {
    recognizedRangesFile: string
    recognizedRangesSha256: string
    sourceDecisionsSha256: string
    sourceDataSha256: string
    ruleSetId: string
    ruleSetSha256: string
    generatedBy: string
  }
  window: { startTime: number; endTime: number }
  summary: { ranges: number; twoSided: number; oneSided: number; userConfirmedSupplements?: number }
  ranges: ReplayRange[]
}

interface RegisteredReplayRangeDataset extends ReplayRangeDatasetInfo {
  ranges: ReplayRange[]
}

export type ReplayRangeSpec = ReplayRange & {
  id: string
  sourceId: string
  name: string
  endTime: number
}

// Current presentation preference: keep complete two-sided lifecycles in the
// audited dataset, but render only independently proven one-sided edges.
// Centralizing the policy prevents another browser/session or the signal-range
// fallback from bringing full boxes back onto the chart.
export function shouldRenderReplayRangeSpec(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'one_sided_edge')
}

const importedModules = import.meta.glob<{ default: unknown }>('../data/replay-range-layers/*.json', { eager: true })
const supportedRuleSetIds = new Set([
  'tvfloat_user_custom_v2_range_lifecycle_bound_20260812',
  'tvfloat_user_custom_v2_effective_swing_sr_20260812',
  'tvfloat_user_custom_v2_strict_narrow_channel_ema20_two_close_any_pullback_20260812',
  'tvfloat_user_custom_v2_strict_narrow_channel_any_pullback_20260812',
  'tvfloat_user_custom_v2_any_pullback_body50_anchor_contact_20260811',
  'tvfloat_user_custom_v2_anchor_candle_contact_first_pullback_20260811',
  'tvfloat_user_custom_v2_anchor_required_first_pullback_20260811',
  'tvfloat_user_custom_v2_range30_one_sided_20260810',
  'tvfloat_user_custom_v2_range30_unanchored_pullback_20260810',
  'tvfloat_user_custom_v2_five_close_breakout_20260811',
])
const supportedSymbols: SymbolId[] = ['XAUUSD', 'XAGUSD', 'BTCUSDT.P', 'US500', 'ETHUSD']
const supportedIntervals: IntervalId[] = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w']

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function orderedIndices(value: unknown, minimum: number, maximum: number): value is number[] {
  return Array.isArray(value)
    && value.length >= minimum
    && value.every((item, index) => Number.isInteger(item) && item >= 0 && item <= maximum && (index === 0 || item > value[index - 1]))
}

export function validateReplayRangePayload(value: unknown, origin = 'inline'): RegisteredReplayRangeDataset {
  if (!value || typeof value !== 'object') throw new Error(`回放区间层不是对象：${origin}`)
  const payload = value as ReplayRangePayload
  if (payload.schemaVersion !== 1 || !supportedSymbols.includes(payload.symbol) || !supportedIntervals.includes(payload.interval)) throw new Error(`回放区间层元数据无效：${origin}`)
  if (!Number.isInteger(payload.timeframeSeconds) || payload.timeframeSeconds <= 0 || !nonEmpty(payload.layer?.sourceId) || !nonEmpty(payload.layer?.name)) throw new Error(`回放区间层身份无效：${origin}`)
  const provenance = payload.provenance
  if (!provenance || !nonEmpty(provenance.recognizedRangesFile) || !sha256(provenance.recognizedRangesSha256) || !sha256(provenance.sourceDecisionsSha256) || !sha256(provenance.sourceDataSha256) || !supportedRuleSetIds.has(provenance.ruleSetId) || !sha256(provenance.ruleSetSha256)) throw new Error(`回放区间层来源无效：${origin}`)
  if (!Array.isArray(payload.ranges) || !payload.summary || payload.summary.ranges !== payload.ranges.length || payload.summary.twoSided + payload.summary.oneSided !== payload.summary.ranges) throw new Error(`回放区间层数量无效：${origin}`)
  const ids = new Set<string>()
  let twoSided = 0
  let userConfirmedSupplements = 0
  for (const range of payload.ranges) {
    const indices = [range.startIdx, range.formationEndIdx, range.firstDetectedIdx, range.lastObservedIdx]
    const times = [range.startTime, range.formationEndTime, range.firstDetectedTime, range.lastObservedTime, range.displayEndTime]
    const brokenStatusValid = range.status === 'broken'
      ? finite(range.brokenAtTime) && range.displayEndTime <= range.brokenAtTime
      : range.status === 'active' && range.brokenAtTime === null && range.displayEndTime >= range.formationEndTime
    const supplementValid = range.userConfirmedDisplaySupplement !== true
      || (range.evidenceSource === 'frozen_ohlc_user_confirmation' && nonEmpty(range.supplementReason))
    if (!nonEmpty(range.rangeId) || ids.has(range.rangeId) || !indices.every(Number.isInteger) || !times.every(finite) || range.firstDetectedIdx - range.startIdx + 1 < 30 || range.formationEndIdx < range.startIdx || range.formationEndIdx > range.lastObservedIdx || range.firstDetectedIdx < range.startIdx || range.firstDetectedIdx > range.lastObservedIdx || range.startTime > range.formationEndTime || range.formationEndTime > range.lastObservedTime || range.firstDetectedTime < range.startTime || range.firstDetectedTime > range.lastObservedTime || range.displayEndTime < range.formationEndTime || !brokenStatusValid || !supplementValid) throw new Error(`回放区间生命周期无效：${origin}`)
    ids.add(range.rangeId)
    if (range.userConfirmedDisplaySupplement === true) userConfirmedSupplements += 1
    if (range.kind === 'two_sided_range') {
      const upperProvenAtDetection = orderedIndices(range.upperTouchIndices, 2, range.lastObservedIdx) && range.upperTouchIndices.filter((idx) => idx <= range.firstDetectedIdx).length >= 2
      const lowerProvenAtDetection = orderedIndices(range.lowerTouchIndices, 2, range.lastObservedIdx) && range.lowerTouchIndices.filter((idx) => idx <= range.firstDetectedIdx).length >= 2
      if (![range.upperZoneLow, range.upperZoneHigh, range.lowerZoneLow, range.lowerZoneHigh, range.midpoint].every(finite) || !(range.lowerZoneLow <= range.lowerZoneHigh && range.lowerZoneHigh < range.midpoint && range.midpoint < range.upperZoneLow && range.upperZoneLow <= range.upperZoneHigh) || !upperProvenAtDetection || !lowerProvenAtDetection) throw new Error(`完整回放区间无效：${origin} ${range.rangeId}`)
      twoSided += 1
    } else if (range.kind === 'one_sided_edge') {
      const detectedTouches = orderedIndices(range.touchIndices, 3, range.lastObservedIdx)
        ? range.touchIndices.filter((idx) => idx <= range.firstDetectedIdx)
        : []
      if (!['upper', 'lower'].includes(range.activeEdge) || !finite(range.edgeZoneLow) || !finite(range.edgeZoneHigh) || range.edgeZoneLow > range.edgeZoneHigh || detectedTouches.length < 3 || detectedTouches.at(-1)! - detectedTouches[0] + 1 < 30) throw new Error(`单边回放区间无效：${origin} ${range.rangeId}`)
    } else {
      throw new Error(`未知回放区间类型：${origin}`)
    }
  }
  if (payload.summary.twoSided !== twoSided || payload.summary.oneSided !== payload.ranges.length - twoSided) throw new Error(`回放区间分类汇总无效：${origin}`)
  if (payload.summary.userConfirmedSupplements !== undefined && payload.summary.userConfirmedSupplements !== userConfirmedSupplements) throw new Error(`回放区间人工补充汇总无效：${origin}`)
  return {
    sourceId: payload.layer.sourceId,
    name: payload.layer.name,
    symbol: payload.symbol,
    interval: payload.interval,
    startTime: payload.window.startTime,
    endTime: payload.window.endTime,
    rangeCount: payload.summary.ranges,
    twoSidedCount: payload.summary.twoSided,
    oneSidedCount: payload.summary.oneSided,
    ruleSetId: provenance.ruleSetId,
    ruleSetSha256: provenance.ruleSetSha256,
    ranges: payload.ranges,
  }
}

function buildRegistry() {
  const result = new Map<string, RegisteredReplayRangeDataset>()
  for (const [origin, module] of Object.entries(importedModules)) {
    const dataset = validateReplayRangePayload(module.default, origin)
    if (result.has(dataset.sourceId)) throw new Error(`重复的回放区间层 sourceId：${dataset.sourceId}`)
    result.set(dataset.sourceId, dataset)
  }
  return result
}

const registry = buildRegistry()

export function replayRangeDatasetInfos(): ReplayRangeDatasetInfo[] {
  return [...registry.values()].map((dataset) => ({
    sourceId: dataset.sourceId,
    name: dataset.name,
    symbol: dataset.symbol,
    interval: dataset.interval,
    startTime: dataset.startTime,
    endTime: dataset.endTime,
    rangeCount: dataset.rangeCount,
    twoSidedCount: dataset.twoSidedCount,
    oneSidedCount: dataset.oneSidedCount,
    ruleSetId: dataset.ruleSetId,
    ruleSetSha256: dataset.ruleSetSha256,
  }))
}

export function hasReplayRangeDataset(
  symbol: SymbolId,
  interval: IntervalId,
  sourceIds: readonly string[],
): boolean {
  const visible = new Set(sourceIds)
  return [...registry.values()].some(
    (dataset) => visible.has(dataset.sourceId) && dataset.symbol === symbol && dataset.interval === interval,
  )
}

export function toReplayRangeSpecs(symbol: SymbolId, interval: IntervalId, sourceIds: readonly string[], revealedThrough?: number): ReplayRangeSpec[] {
  const visible = new Set(sourceIds)
  return [...registry.values()]
    .filter((dataset) => visible.has(dataset.sourceId) && dataset.symbol === symbol && dataset.interval === interval)
    .flatMap((dataset) => dataset.ranges
      .filter((range) => revealedThrough === undefined || range.firstDetectedTime <= revealedThrough)
      .map((range) => ({
        ...range,
        id: `replay-range-${dataset.sourceId}-${range.rangeId}`,
        sourceId: dataset.sourceId,
        name: dataset.name,
        endTime: revealedThrough === undefined ? range.displayEndTime : Math.min(range.displayEndTime, revealedThrough),
      })))
    .sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime || left.id.localeCompare(right.id))
}
