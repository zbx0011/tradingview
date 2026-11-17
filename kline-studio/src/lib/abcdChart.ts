import type { Candle } from './market'
import { chartBarSeconds } from './smartMoney'
import { DEFAULT_ABCD_OPTIONS, detectAbcd, detectSpikeChannelAbcd, isAbcdAtTarget, isAbcdLive, type AbcdOptions, type AbcdPattern, type AbcdPoint } from './abcd'

export const ABCD_TIMEFRAMES = [
  { label: '1m', seconds: 60 },
  { label: '5m', seconds: 300 },
  { label: '15m', seconds: 900 },
  { label: '30m', seconds: 1800 },
  { label: '1h', seconds: 3600 },
] as const

export type AbcdTimeframe = typeof ABCD_TIMEFRAMES[number]['label']

/** A pattern whose point indexes are (fractional) logical indexes on the chart's own candles. */
export interface ChartAbcd extends AbcdPattern {
  timeframe: AbcdTimeframe
  /** Still in play at the last candle: drawn ahead of time with D projected to the right. */
  live: boolean
  /** Where D falls in time if CD lasts as long as AB (chart logical index, may lie beyond the last candle). */
  dIndex: number
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

export interface AbcdChartInput {
  /** The chart's candles. */
  candles: readonly Candle[]
  /** Optional one-minute tape (exclusive `endTime`) for levels finer than the chart's own bars. */
  minutes?: { candles: readonly Candle[], endTime: number }
}

/**
 * AB=CD on 1m / 5m / 15m / 30m / 1h. Levels at or above the chart's bar size are built from the chart's
 * candles; finer levels need the minute tape. Returned, mapped onto the chart's logical indexes by time:
 * patterns whose CD leg is at D (`isAbcdAtTarget`), and every pattern still in play at the last candle
 * (`isAbcdLive`), so its D can be prepared for before price gets there.
 */
export function computeChartAbcd(input: AbcdChartInput, overrides: Partial<AbcdOptions> = {}, levels: readonly AbcdTimeframe[] = ABCD_TIMEFRAMES.map((t) => t.label), kinds: readonly ('leg' | 'spike')[] = ['leg', 'spike']): ChartAbcd[] {
  const { candles } = input
  const seconds = chartBarSeconds(candles)
  if (!candles.length || !seconds) return []
  const options = { ...DEFAULT_ABCD_OPTIONS, ...overrides }
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
  const result: ChartAbcd[] = []
  for (const timeframe of ABCD_TIMEFRAMES) {
    if (!levels.includes(timeframe.label)) continue
    let source: readonly Candle[] | null = null
    if (timeframe.seconds >= seconds && timeframe.seconds % seconds === 0) source = candles
    else if (minuteTape?.length && timeframe.seconds % 60 === 0) source = minuteTape
    if (!source) continue
    let buckets = aggregate(source, timeframe.seconds)
    if (buckets.length > options.maxHistoryBars) buckets = buckets.slice(-options.maxHistoryBars)
    const bars = buckets.map((b) => b.candle)
    const legs = kinds.includes('leg') ? detectAbcd(bars, options) : []
    // A spike and channel that the ordinary detector already measured (same C, same D) is drawn once, as the ordinary one.
    const spikes = (kinds.includes('spike') ? detectSpikeChannelAbcd(bars, { atrPeriod: options.atrPeriod, shortAtr: options.shortAtr, overAtr: options.overAtr }) : [])
      .filter((s) => !legs.some((l) => l.direction === s.direction && l.c.index === s.c.index && Math.abs(l.d - s.d) <= 0.25 * s.atr))
    const found = [...legs, ...spikes]
    for (const pattern of found) {
      // Every projection still in play is drawn: a larger AB=CD stays valid while a smaller one forms inside its CD leg.
      const live = isAbcdLive(pattern)
      if (!live && !(isAbcdAtTarget(pattern) && pattern.endIndex >= 0)) continue
      const up = pattern.direction === 'up'
      // A and C are lows of an up pattern (highs of a down one); B and E the opposite extreme.
      const map = (p: AbcdPoint, isLegExtreme: boolean): AbcdPoint => {
        const b = buckets[p.index]
        const time = up === isLegExtreme ? b.highTime : b.lowTime
        return { ...p, time, index: indexAt(time) }
      }
      result.push({
        ...pattern, timeframe: timeframe.label, live,
        dIndex: indexAt(buckets[pattern.c.index].candle.time + (pattern.b.index - pattern.a.index) * timeframe.seconds),
        a: map(pattern.a, false), b: map(pattern.b, true), c: map(pattern.c, false),
        e: pattern.e && map(pattern.e, true),
        confirmedIndex: pattern.confirmedIndex < 0 ? -1 : indexAt(buckets[pattern.confirmedIndex].candle.time),
        endIndex: pattern.endIndex < 0 ? -1 : indexAt(buckets[pattern.endIndex].candle.time),
      })
    }
  }
  return result.sort((x, y) => x.b.index - y.b.index)
}
