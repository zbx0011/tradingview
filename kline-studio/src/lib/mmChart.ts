import type { Candle } from './market'
import { chartBarSeconds } from './smartMoney'
import { DEFAULT_MM_OPTIONS, detectMm, detectSpikeMm, isMmLive, type MmOptions, type MmPattern, type MmPoint } from './mm'

export const MM_TIMEFRAMES = [
  { label: '1m', seconds: 60 },
  { label: '5m', seconds: 300 },
  { label: '15m', seconds: 900 },
  { label: '30m', seconds: 1800 },
  { label: '1h', seconds: 3600 },
] as const

export type MmTimeframe = typeof MM_TIMEFRAMES[number]['label']

/** A pattern whose point indexes are (fractional) logical indexes on the chart's own candles. */
export interface ChartMm extends MmPattern {
  timeframe: MmTimeframe
  /** Still in play at the last candle: the target lines run to the right edge. */
  live: boolean
}

interface Bucket { candle: Candle, highTime: number, lowTime: number }

/** OHLC buckets that remember when, inside the bucket, the high and the low happened. */
function aggregate(candles: readonly Candle[], seconds: number): Bucket[] {
  const buckets: Bucket[] = []
  for (const c of candles) {
    const time = Math.floor(c.time / seconds) * seconds
    const last = buckets[buckets.length - 1]
    if (!last || last.candle.time !== time) {
      buckets.push({ candle: { ...c, time }, highTime: c.time, lowTime: c.time })
      continue
    }
    if (c.high > last.candle.high) { last.candle.high = c.high; last.highTime = c.time }
    if (c.low < last.candle.low) { last.candle.low = c.low; last.lowTime = c.time }
    last.candle.close = c.close
    last.candle.volume += c.volume
  }
  return buckets
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

export interface MmChartInput {
  /** The chart's candles. */
  candles: readonly Candle[]
  /** Optional one-minute tape (exclusive `endTime`) for levels finer than the chart's own bars. */
  minutes?: { candles: readonly Candle[], endTime: number }
}

/**
 * Z-style MM on 1m / 5m / 15m / 30m / 1h, mapped onto the chart's logical indexes by time. Returned: MMs still in
 * play at the last candle (gap open, target not reached, including a breakout still waiting for its follow-through
 * bar), and MMs that reached their target. Filled, failed and expired ones are not drawn.
 */
export function computeChartMm(input: MmChartInput, overrides: Partial<MmOptions> = {}, levels: readonly MmTimeframe[] = MM_TIMEFRAMES.map((t) => t.label), kinds: readonly MmPattern['kind'][] = ['swing', 'spike']): ChartMm[] {
  const { candles } = input
  const seconds = chartBarSeconds(candles)
  if (!candles.length || !seconds) return []
  const options = { ...DEFAULT_MM_OPTIONS, ...overrides }
  const minuteTape = input.minutes && chartBarSeconds(input.minutes.candles) === 60
    ? input.minutes.candles.slice(lowerBound(input.minutes.candles, candles[0].time), lowerBound(input.minutes.candles, input.minutes.endTime))
    : null
  const indexAt = (time: number) => {
    const bucket = Math.floor(time / seconds) * seconds
    const index = lowerBound(candles, bucket)
    if (index < candles.length && candles[index].time === bucket) return index + (time - bucket) / seconds
    if (index === 0) return (time - candles[0].time) / seconds
    return index - 1 + (time - candles[index - 1].time) / seconds
  }
  const result: ChartMm[] = []
  for (const timeframe of MM_TIMEFRAMES) {
    if (!levels.includes(timeframe.label)) continue
    let source: readonly Candle[] | null = null
    if (timeframe.seconds >= seconds && timeframe.seconds % seconds === 0) source = candles
    else if (minuteTape?.length && timeframe.seconds % 60 === 0) source = minuteTape
    if (!source) continue
    let buckets = aggregate(source, timeframe.seconds)
    if (buckets.length > options.maxHistoryBars) buckets = buckets.slice(-options.maxHistoryBars)
    const bars = buckets.map((b) => b.candle)
    const found = [
      ...(kinds.includes('swing') ? detectMm(bars, options) : []),
      ...(kinds.includes('spike') ? detectSpikeMm(bars, { atrPeriod: options.atrPeriod, reachAtr: options.reachAtr }) : []),
    ]
    for (const pattern of found) {
      const live = isMmLive(pattern)
      if (!live && pattern.status !== 'reached') continue
      const up = pattern.direction === 'up'
      // L is a low of an up MM (a high of a down one); H and the extreme the opposite.
      const map = (p: MmPoint, isHigh: boolean): MmPoint => {
        const b = buckets[p.index]
        const time = up === isHigh ? b.highTime : b.lowTime
        return { ...p, time, index: indexAt(time) }
      }
      const at = (index: number) => index < 0 ? -1 : indexAt(buckets[index].candle.time)
      result.push({
        ...pattern, timeframe: timeframe.label, live,
        l: map(pattern.l, false), h: map(pattern.h, true), extreme: map(pattern.extreme, true),
        breakoutIndex: at(pattern.breakoutIndex), confirmedIndex: at(pattern.confirmedIndex),
        endIndex: at(pattern.endIndex), bodyReachedIndex: at(pattern.bodyReachedIndex),
      })
    }
  }
  return result.sort((x, y) => x.breakoutIndex - y.breakoutIndex)
}
