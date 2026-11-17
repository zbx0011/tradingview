import type { Candle } from './market'
import { chartBarSeconds } from './smartMoney'

/** Numeric definitions supplement 三推判定规则; they are adjustable, not calibrated trading signals. */
export interface ThreePushOptions {
  atrPeriod: number
  minPullbackBars: number
  minPullbackAtr: number
  equalExtremeToleranceAtr: number
  /** A wedge has at most this many pushes; the next push starts a new count from the last pullback. */
  maxPushes: number
  maxHistoryBars: number
}

export const DEFAULT_THREE_PUSH_OPTIONS: Readonly<ThreePushOptions> = {
  atrPeriod: 20,
  minPullbackBars: 2,
  minPullbackAtr: 1,
  equalExtremeToleranceAtr: 0.1,
  maxPushes: 5,
  maxHistoryBars: 20_000,
}

export type ThreePushDirection = 'up' | 'down'
export type ThreePushTimeframe = '1m' | '5m' | '15m'
export interface ThreePushPoint { index: number; time: number; price: number }
export interface ThreePushLeg {
  /** The causally known swing low/high from which this leg advances. */
  start: ThreePushPoint
  peak: ThreePushPoint
  /** First candle crossing the previous push extreme, not its eventual peak. */
  breakoutIndex: number
  breakoutTime: number
  breakoutThreshold: number
}
export interface ThreePushPullback {
  trough: ThreePushPoint
  bars: number
  depth: number
  atr: number
}
export interface ThreePushPattern {
  direction: ThreePushDirection
  start: ThreePushPoint
  pushes: ThreePushLeg[]
  pullbacks: ThreePushPullback[]
  confirmedIndex: number
  confirmedTime: number
  equalExtreme: boolean
  quality: number
}
export interface ChartThreePush extends ThreePushPattern {
  timeframes: ThreePushTimeframe[]
  label: string
}

export interface ThreePushChartOptions extends Partial<ThreePushOptions> {
  timeframes?: readonly ThreePushTimeframe[]
  mergeOverlaps?: boolean
  /** Touch screens: a tap on a pattern selects it (and a tap elsewhere clears it) instead of mouse hover. */
  tapToSelect?: boolean
}

function atrValues(candles: readonly Candle[], period: number): Float64Array {
  const result = new Float64Array(candles.length)
  let sum = 0, previous = 0
  for (let i = 0; i < candles.length; i += 1) {
    const candle = candles[i]
    const lastClose = i ? candles[i - 1].close : candle.close
    const range = Math.max(candle.high - candle.low, Math.abs(candle.high - lastClose), Math.abs(candle.low - lastClose))
    if (i < period) { sum += range; previous = sum / (i + 1) }
    else previous = (previous * (period - 1) + range) / period
    result[i] = previous
  }
  return result
}

/** A directional state is scanned once; new extremes without a qualified pullback stay in the same push. */
export function detectThreePushes(candles: readonly Candle[], overrides: Partial<ThreePushOptions> = {}): ThreePushPattern[] {
  if (!candles.length) return []
  const options = { ...DEFAULT_THREE_PUSH_OPTIONS, ...overrides }
  const atr = atrValues(candles, Math.max(1, Math.floor(options.atrPeriod)))
  const patterns: ThreePushPattern[] = []
  for (const direction of ['up', 'down'] as const) {
    const sign = direction === 'up' ? 1 : -1
    const high = (i: number) => direction === 'up' ? candles[i].high : -candles[i].low
    const low = (i: number) => direction === 'up' ? candles[i].low : -candles[i].high
    const point = (index: number, value: number): ThreePushPoint => ({ index, time: candles[index].time, price: sign * value })
    let pushes: ThreePushLeg[] = []
    let pullbacks: ThreePushPullback[] = []
    let peak = 0, origin = 0, originIndex = 0
    let pullbackBars = 0, trough = Infinity, troughIndex = 0, peakAtr = 0
    let qualified = false, equalExtreme = false

    const save = () => {
      if (pushes.length < 3) return
      const last = pushes.length - 1
      const a = pushes[last - 2].peak, b = pushes[last - 1].peak, c = pushes[last].peak
      const r1 = pullbacks[last - 2], r2 = pullbacks[last - 1]
      const shrinking = sign * (c.price - b.price) < sign * (b.price - a.price)
      const risingTroughs = sign * (r2.trough.price - r1.trough.price) > 0 || r2.depth < r1.depth
      const upperSlope = sign * (b.price - a.price) / Math.max(1, b.index - a.index)
      const lowerSlope = sign * (r2.trough.price - r1.trough.price) / Math.max(1, r2.trough.index - r1.trough.index)
      const converging = lowerSlope > upperSlope
      const projected = a.price + (b.price - a.price) * (c.index - a.index) / Math.max(1, b.index - a.index)
      const overshoot = sign * (c.price - projected) > 0 && sign * (candles[c.index].close - projected) < 0
      patterns.push({
        direction, start: pushes[0].start,
        pushes, pullbacks,
        confirmedIndex: pushes[2].breakoutIndex, confirmedTime: pushes[2].breakoutTime,
        equalExtreme,
        quality: Number(shrinking) + Number(risingTroughs) + Number(converging) + Number(overshoot),
      })
    }
    const reset = (i: number) => {
      // This candle only establishes a candidate swing. Its other extreme may
      // have occurred BEFORE that swing (e.g. the high of a bearish new-low
      // candle), so it cannot supply a completed first push as well.
      origin = low(i); originIndex = i; peak = -Infinity; peakAtr = atr[i]
      pushes = []
      pullbacks = []
      pullbackBars = 0; trough = Infinity; qualified = false; equalExtreme = false
    }
    reset(0)
    for (let i = 1; i < candles.length; i += 1) {
      const h = high(i), l = low(i)
      // Breaking the latest leg's starting swing also exceeds that entire leg's advance.
      if (l < origin) { save(); reset(i); continue }
      if (!pushes.length) {
        if (h <= origin) continue
        // A later candle is observable after the swing, including a one-bar
        // spike. It need not exceed the resetting candle's opposite extreme.
        peak = h; peakAtr = atr[i]
        pushes.push({ start: point(originIndex, origin), peak: point(i, h), breakoutIndex: i, breakoutTime: candles[i].time, breakoutThreshold: sign * h })
        continue
      }
      const threshold = peak - options.equalExtremeToleranceAtr * peakAtr
      if (qualified && (h > peak || (options.equalExtremeToleranceAtr > 0 && h >= threshold))) {
        if (pushes.length >= Math.max(3, Math.floor(options.maxPushes))) {
          // Too many pushes for one wedge: keep it, then count again from the last pullback (this push is the new count's first).
          save()
          pullbacks = []; equalExtreme = false
          origin = trough
          pushes = [{ start: point(troughIndex, trough), peak: point(i, h), breakoutIndex: i, breakoutTime: candles[i].time, breakoutThreshold: sign * threshold }]
          peak = h; peakAtr = atr[i]
          pullbackBars = 0; trough = Infinity; qualified = false
          continue
        }
        pullbacks.push({ trough: point(troughIndex, trough), bars: pullbackBars, depth: peak - trough, atr: peakAtr })
        equalExtreme ||= h <= peak
        origin = trough
        pushes.push({ start: point(troughIndex, trough), peak: point(i, h), breakoutIndex: i, breakoutTime: candles[i].time, breakoutThreshold: sign * threshold })
        peak = h; peakAtr = atr[i]
        pullbackBars = 0; trough = Infinity; qualified = false
      } else if (h >= peak) {
        // Equal highs are pauses unless a qualifying retracement has already separated the legs.
        if (h > peak) {
          peak = h; peakAtr = atr[i]
          pushes[pushes.length - 1].peak = point(i, h)
        }
        pullbackBars = 0; trough = Infinity; qualified = false
      } else {
        pullbackBars += 1
        if (l < trough) { trough = l; troughIndex = i }
        qualified ||= pullbackBars >= options.minPullbackBars && peak - trough >= peakAtr * options.minPullbackAtr
      }
    }
    save()
  }
  return patterns.sort((a, b) => a.confirmedIndex - b.confirmedIndex)
}

interface Bucket {
  candle: Candle
  first: number
  last: number
  highIndex: number
  lowIndex: number
}

function aggregate(candles: readonly Candle[], seconds: number): Bucket[] {
  const buckets: Bucket[] = []
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i], time = Math.floor(c.time / seconds) * seconds
    const last = buckets[buckets.length - 1]
    if (!last || last.candle.time !== time) {
      buckets.push({ candle: { ...c, time }, first: i, last: i, highIndex: i, lowIndex: i })
    } else {
      if (c.high > last.candle.high) { last.candle.high = c.high; last.highIndex = i }
      if (c.low < last.candle.low) { last.candle.low = c.low; last.lowIndex = i }
      last.candle.high = Math.max(last.candle.high, c.high)
      last.candle.low = Math.min(last.candle.low, c.low)
      last.candle.close = c.close; last.candle.volume += c.volume; last.last = i
    }
  }
  return buckets
}

const TIMEFRAMES = [{ label: '1m', seconds: 60 }, { label: '5m', seconds: 300 }, { label: '15m', seconds: 900 }] as const
export function threePushCountLabel(count: number): string {
  return count === 3 ? '三推' : count === 4 ? '四推' : count === 5 ? '五推' : `${count}推`
}

/** Uses only supplied/revealed candles, including the currently forming higher-timeframe candle. */
export function computeChartThreePushes(candles: readonly Candle[], overrides: ThreePushChartOptions = {}): ChartThreePush[] {
  const barSeconds = chartBarSeconds(candles)
  if (!barSeconds || barSeconds > 900) return []
  const options = { ...DEFAULT_THREE_PUSH_OPTIONS, ...overrides }
  const offset = Math.max(0, candles.length - Math.max(1, Math.floor(options.maxHistoryBars)))
  const data = offset ? candles.slice(offset) : candles
  const merged = new Map<string, ChartThreePush>()
  for (const timeframe of TIMEFRAMES) {
    if (overrides.timeframes && !overrides.timeframes.includes(timeframe.label)) continue
    if (barSeconds > timeframe.seconds || timeframe.seconds % barSeconds !== 0) continue
    const buckets = aggregate(data, timeframe.seconds)
    for (const pattern of detectThreePushes(buckets.map((b) => b.candle), options)) {
      const up = pattern.direction === 'up'
      const mapPoint = (p: ThreePushPoint, isPeak: boolean): ThreePushPoint => {
        const b = buckets[p.index]
        const index = (up === isPeak ? b.highIndex : b.lowIndex) + offset
        return { ...p, index, time: candles[index].time }
      }
      const pushes = pattern.pushes.map((push, i) => {
        const b = buckets[push.breakoutIndex]
        let index = b.first
        if (i) {
          const crosses = (candle: Candle) => options.equalExtremeToleranceAtr > 0
            ? (up ? candle.high >= push.breakoutThreshold : candle.low <= push.breakoutThreshold)
            : (up ? candle.high > push.breakoutThreshold : candle.low < push.breakoutThreshold)
          while (index < b.last && !crosses(data[index])) index += 1
        }
        index += offset
        return { ...push, start: mapPoint(push.start, false), peak: mapPoint(push.peak, true), breakoutIndex: index, breakoutTime: candles[index].time }
      })
      const mapped: ChartThreePush = {
        ...pattern, start: mapPoint(pattern.start, false), pushes,
        pullbacks: pattern.pullbacks.map((p) => ({ ...p, trough: mapPoint(p.trough, false) })),
        confirmedIndex: pushes[2].breakoutIndex, confirmedTime: pushes[2].breakoutTime,
        timeframes: [timeframe.label], label: '',
      }
      // OHLC alone does not encode the order of the two extremes in a bucket.
      // When source candles prove the reset low/high occurred AFTER the first
      // push's extreme, that leg never happened in that order: omit the shape.
      if (pushes.some((push) => push.start.index > push.peak.index)) continue
      // Identical underlying chart extremes identify the same shape even when its start differs by a bucket.
      const key = `${overrides.mergeOverlaps === false ? `${timeframe.label}:` : ''}${pattern.direction}:${pushes.map((p) => p.peak.index).join(':')}`
      const previous = merged.get(key)
      if (previous) {
        previous.timeframes.push(timeframe.label)
        // A combined label is only fully confirmed once all its levels exist.
        if (mapped.confirmedIndex > previous.confirmedIndex) {
          previous.confirmedIndex = mapped.confirmedIndex
          previous.confirmedTime = mapped.confirmedTime
        }
      } else merged.set(key, mapped)
    }
  }
  return [...merged.values()].map((p) => ({ ...p, label: `${threePushCountLabel(p.pushes.length)} ${p.timeframes.join('·')}` })).sort((a, b) => a.confirmedIndex - b.confirmedIndex)
}
