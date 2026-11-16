import type { Candle } from './market'
import { chartBarSeconds } from './smartMoney'
import { DEFAULT_THREE_PUSH_OPTIONS, threePushCountLabel, type ChartThreePush, type ThreePushPoint } from './threePush'

/** endTime is exclusive: future minute prices may exist in storage but remain hidden. */
export interface ThreePushMinuteSource {
  candles: readonly Candle[]
  endTime: number
}

/** lightweight-charts 5.2 returns x=0 for fractional logical indices. Interpolate integer slots instead. */
export function threePushCoordinate(index: number, coordinateAt: (index: number) => number | null): number | null {
  if (!Number.isFinite(index)) return null
  const left = Math.floor(index), fraction = index - left
  const from = coordinateAt(left)
  if (from === null || fraction === 0) return from
  const to = coordinateAt(left + 1)
  return to === null ? null : from + (to - from) * fraction
}

function lowerBound(candles: readonly Candle[], time: number) {
  let low = 0, high = candles.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (candles[mid].time < time) low = mid + 1
    else high = mid
  }
  return low
}

/** Bound work around the viewport, including context, rather than scanning the full minute tape. */
export function threePushMinuteWindow(source: ThreePushMinuteSource, chartCandles: readonly Candle[], visibleTo = Infinity) {
  const seconds = chartBarSeconds(chartCandles)
  if (!seconds || chartBarSeconds(source.candles) !== 60 || !chartCandles.length) return { from: 0, to: 0 }
  // Reuse this window through small pan/zoom changes; revealing the next minute
  // still changes `to` immediately because source.endTime remains the upper cap.
  const last = Math.min(chartCandles.length - 1, Math.max(0, Math.ceil((visibleTo + 200) / 250) * 250))
  const endTime = Math.min(source.endTime, chartCandles[last].time + seconds)
  const to = lowerBound(source.candles, endTime)
  const from = Math.max(lowerBound(source.candles, chartCandles[0].time), to - DEFAULT_THREE_PUSH_OPTIONS.maxHistoryBars)
  return { from: Math.min(from, to), to }
}

/** Preserve the order of minute swings inside a five-minute candle. Never use minute array indices on the chart. */
export function projectThreePushesToChart(patterns: readonly ChartThreePush[], chartCandles: readonly Candle[]): ChartThreePush[] {
  const seconds = chartBarSeconds(chartCandles)
  if (!chartCandles.length || !seconds) return []
  const indexAt = (time: number) => {
    const bucket = Math.floor(time / seconds) * seconds
    const index = lowerBound(chartCandles, bucket)
    if (index < chartCandles.length && chartCandles[index].time === bucket) return index + (time - bucket) / seconds
    if (index === 0) return (time - chartCandles[0].time) / seconds
    return index - 1 + (time - chartCandles[index - 1].time) / seconds
  }
  const point = (p: ThreePushPoint): ThreePushPoint => ({ ...p, index: indexAt(p.time) })
  return patterns.map((p) => ({
    ...p,
    start: point(p.start),
    pushes: p.pushes.map((push) => ({ ...push, start: point(push.start), peak: point(push.peak), breakoutIndex: indexAt(push.breakoutTime) })),
    pullbacks: p.pullbacks.map((pullback) => ({ ...pullback, trough: point(pullback.trough) })),
    confirmedIndex: indexAt(p.confirmedTime),
  }))
}

/** Only merge a complete matching shape, retaining its finer geometry and all enabled level labels. */
export function mergeProjectedThreePushes(patterns: readonly ChartThreePush[]): ChartThreePush[] {
  const merged = new Map<string, ChartThreePush>()
  for (const pattern of patterns) {
    const key = `${pattern.direction}:${pattern.pushes.map((p) => `${Math.floor(p.peak.index)}@${p.peak.price}`).join(':')}`
    const previous = merged.get(key)
    if (!previous) { merged.set(key, { ...pattern, timeframes: [...pattern.timeframes] }); continue }
    previous.timeframes = [...new Set([...previous.timeframes, ...pattern.timeframes])]
    if (pattern.confirmedTime > previous.confirmedTime) {
      previous.confirmedTime = pattern.confirmedTime
      previous.confirmedIndex = pattern.confirmedIndex
    }
  }
  return [...merged.values()].map((p) => ({ ...p, label: `${threePushCountLabel(p.pushes.length)} ${p.timeframes.join('·')}` }))
}
