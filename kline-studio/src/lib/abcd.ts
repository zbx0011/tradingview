import type { Candle } from './market'

/**
 * AB=CD (Z说交易: 影线 / 实体 AB=CD; 阿布 leg 1 = leg 2):
 *   A = start of the first leg, B = its extreme, C = the extreme of the pullback from B,
 *   D = C + (B − A): the second leg CD is projected to the length of AB.
 *
 * Swings come from one zigzag: a swing high / low is confirmed once price has pulled back from it for
 * `minPullbackBars` bars and `minPullbackAtr` × ATR. The pullback BC sets the scale of the whole pattern:
 * pullbacks smaller than BC are part of a leg, they do not end it.
 *   - B is a confirmed swing high, C the lowest low since B.
 *   - A is the start of the whole advance into B. Going back from B, a pullback stays inside the AB leg
 *     while it is smaller than BC and gave back less than `maxInnerRetrace` of the advance before it;
 *     A is the low where that stops. C must hold above A.
 *   - Price moving beyond B makes C final and starts the CD leg. While that leg is still short of D it
 *     survives pullbacks smaller than BC; it ends when it pulls back as deep as BC, when C breaks, or
 *     when it expires.
 *   - Once the leg is at D (loosely: a little short `shortAtr`, a little past `overAtr`, or a spike through
 *     D that closes back on the near side, up to `pinAtr`) or through it, an ordinary qualified pullback ends it.
 * Only legs that END at D are drawn as completed AB=CDs; legs that end well short of D or run clearly
 * through it are not AB=CD turns.
 */
export interface AbcdOptions {
  atrPeriod: number
  minPullbackBars: number
  minPullbackAtr: number
  /** The AB leg must be at least this many ATR long, so micro legs are not measured. */
  minLegAtr: number
  /** The CD leg may stop this many ATR short of D and still count as reaching it. */
  shortAtr: number
  /** The CD leg's extreme may run this many ATR past D. */
  overAtr: number
  /** A spike may run up to this many ATR past D if that candle closes back on the near side of D. */
  pinAtr: number
  /** A pullback inside AB that gave back this share (or more) of the advance before it starts the leg over: A is its low. */
  maxInnerRetrace: number
  /** A CD leg is followed for at most this multiple of the A→C duration. */
  maxDurationMultiple: number
  maxHistoryBars: number
}

export const DEFAULT_ABCD_OPTIONS: AbcdOptions = {
  atrPeriod: 20,
  minPullbackBars: 2,
  minPullbackAtr: 1,
  minLegAtr: 3,
  shortAtr: 0.5,
  overAtr: 0.5,
  pinAtr: 1.5,
  maxInnerRetrace: 0.618,
  maxDurationMultiple: 3,
  maxHistoryBars: 20000,
}

export interface AbcdPoint { index: number, time: number, price: number }

export type AbcdOutcome = 'near' | 'short' | 'over'

export interface AbcdPattern {
  /** Direction of the AB and CD legs (up = projection above C). */
  direction: 'up' | 'down'
  a: AbcdPoint
  b: AbcdPoint
  c: AbcdPoint
  /** Wick target D = C + (B − A). */
  d: number
  /** Body target measured on the bodies of the A, B and C candles. */
  bodyD: number
  /** Extreme of the CD leg so far (null until price moves beyond B). */
  e: AbcdPoint | null
  /** Bar where price first moved beyond B (C final); -1 while C is provisional. */
  confirmedIndex: number
  /** Bar where the CD leg ended; -1 while it is still running. */
  endIndex: number
  /** Where the CD leg's extreme lies relative to D (so far, while it is still running). */
  outcome: AbcdOutcome | null
  /** ATR at B: the unit for leg size and the near-D tolerance. */
  atr: number
  /** A was broken while C was still provisional: this projection never became valid. */
  abandoned?: boolean
}

/** Draw only AB=CDs whose CD leg ended at D, or a running one whose extreme is at D right now. */
export function isAbcdAtTarget(pattern: AbcdPattern) {
  return pattern.outcome === 'near'
}

/**
 * Still in play at the last candle: C provisional (forming) or the CD leg running, and the leg has not
 * already run through D. These are drawn ahead of time so D can be prepared for.
 */
export function isAbcdLive(pattern: AbcdPattern) {
  return !pattern.abandoned && pattern.endIndex < 0 && pattern.outcome !== 'over'
}

export function atrValues(candles: readonly Candle[], period: number) {
  const result = new Float64Array(candles.length)
  let sum = 0, previous = 0
  for (let i = 0; i < candles.length; i += 1) {
    const candle = candles[i]
    const lastClose = i ? candles[i - 1].close : candle.close
    const range = Math.max(candle.high - candle.low, Math.abs(candle.high - lastClose), Math.abs(candle.low - lastClose))
    if (i < period) { sum += range; previous = sum / (i + 1) } else previous = (previous * (period - 1) + range) / period
    result[i] = previous
  }
  return result
}

/** A confirmed zigzag swing. */
interface Pivot { index: number, price: number, high: boolean }

/** A swing high B whose pullback is still under way (price has not moved beyond B yet). */
interface Forming {
  /** Position of B in the pivot list. */
  position: number
  b: number
  c: number
  cIndex: number
  pattern: AbcdPattern | null
}

interface Tracking {
  pattern: AbcdPattern
  /** Depth of the BC pullback: a CD leg still short of D ends when it pulls back this far. */
  bcDepth: number
  extreme: number
  /** Close of the candle that made the extreme (same up-space as `extreme`). */
  extremeClose: number
  pullbackBars: number
  pullbackLow: number
  limit: number
}

export function detectAbcd(candles: readonly Candle[], overrides: Partial<AbcdOptions> = {}): AbcdPattern[] {
  if (candles.length < 3) return []
  const options = { ...DEFAULT_ABCD_OPTIONS, ...overrides }
  const atr = atrValues(candles, Math.max(1, Math.floor(options.atrPeriod)))
  const patterns: AbcdPattern[] = []

  // One zigzag for both directions. `rising`: the last confirmed pivot is a low and `extreme` is the running high.
  const pivots: Pivot[] = [{ index: 0, price: candles[0].low, high: false }]
  let rising = true, extreme = candles[0].high, extremeIndex = 0
  /** Since the running extreme: bars, and the furthest price against it. */
  let backBars = 0, back = Infinity, backIndex = 0

  // Each direction works in "up" space: the leg extreme is the high, the pullback extreme the low.
  const sides = (['up', 'down'] as const).map((direction) => {
    const sign = direction === 'up' ? 1 : -1
    return {
      direction, sign,
      high: (i: number) => sign > 0 ? candles[i].high : -candles[i].low,
      low: (i: number) => sign > 0 ? candles[i].low : -candles[i].high,
      bodyHigh: (i: number) => sign > 0 ? Math.max(candles[i].open, candles[i].close) : -Math.min(candles[i].open, candles[i].close),
      bodyLow: (i: number) => sign > 0 ? Math.min(candles[i].open, candles[i].close) : -Math.max(candles[i].open, candles[i].close),
      forming: [] as Forming[],
      open: [] as Tracking[],
    }
  })
  type Side = typeof sides[number]
  const point = (index: number, price: number): AbcdPoint => ({ index, time: candles[index].time, price })

  const classify = (side: Side, t: Tracking) => {
    const d = side.sign * t.pattern.d, diff = t.extreme - d, unit = t.pattern.atr
    const pin = diff <= options.pinAtr * unit && t.extremeClose <= d
    t.pattern.outcome = diff < -options.shortAtr * unit ? 'short' : diff <= options.overAtr * unit || pin ? 'near' : 'over'
  }
  /** Follow the running CD legs through bar i. */
  const follow = (side: Side, i: number) => {
    const h = side.high(i), l = side.low(i)
    side.open = side.open.filter((t) => {
      if (h > t.extreme) {
        t.extreme = h; t.extremeClose = side.sign * candles[i].close; t.pattern.e = point(i, side.sign * h); t.pullbackBars = 0; t.pullbackLow = Infinity
      } else {
        t.pullbackBars += 1; t.pullbackLow = Math.min(t.pullbackLow, l)
      }
      classify(side, t)
      const depth = t.extreme - t.pullbackLow
      // Short of D the leg is still on its way: only a pullback as deep as BC ends it. At or past D any qualified pullback does.
      const pulledBack = t.pattern.outcome === 'short'
        ? depth >= t.bcDepth
        : t.pullbackBars >= options.minPullbackBars && depth >= options.minPullbackAtr * t.pattern.atr
      if (pulledBack || l < side.sign * t.pattern.c.price || i >= t.limit) { t.pattern.endIndex = i; return false }
      return true
    })
  }
  /** (Re)measure the pattern of a forming pullback: find A for the current C. */
  const measure = (side: Side, f: Forming) => {
    const value = (k: number) => side.sign * pivots[k].price
    const depth = f.b - f.c
    let k = f.position - 1
    // Back through every pullback that is part of the advance into B.
    while (k >= 2) {
      const top = value(k - 1), before = value(k - 2), dip = top - value(k)
      if (!(before < value(k) && top < f.b && dip < depth && dip < options.maxInnerRetrace * (top - before))) break
      k -= 2
    }
    const bIndex = pivots[f.position].index, unit = atr[bIndex]
    if (k < 0 || value(k) >= f.c || f.b - value(k) < options.minLegAtr * unit) {
      if (f.pattern) f.pattern.abandoned = true // C under A (or no measurable leg): not a valid projection, for now.
      return
    }
    const aIndex = pivots[k].index, a = value(k)
    if (!f.pattern) {
      f.pattern = {
        direction: side.direction, a: point(aIndex, side.sign * a), b: point(bIndex, side.sign * f.b), c: point(f.cIndex, side.sign * f.c),
        d: 0, bodyD: 0, e: null, confirmedIndex: -1, endIndex: -1, outcome: null, atr: unit,
      }
      patterns.push(f.pattern)
    } else {
      f.pattern.a = point(aIndex, side.sign * a); f.pattern.c = point(f.cIndex, side.sign * f.c)
      delete f.pattern.abandoned
    }
    f.pattern.d = side.sign * (f.c + (f.b - a))
    f.pattern.bodyD = side.sign * (side.bodyLow(f.cIndex) + (side.bodyHigh(bIndex) - side.bodyLow(aIndex)))
  }
  /** Pullbacks under way: a new low moves C; price beyond B makes C final and starts the CD leg. */
  const advance = (side: Side, i: number) => {
    const h = side.high(i), l = side.low(i)
    side.forming = side.forming.filter((f) => {
      if (h > f.b) {
        const pattern = f.pattern
        if (pattern && !pattern.abandoned) {
          pattern.confirmedIndex = i; pattern.e = point(i, side.sign * h)
          const t: Tracking = {
            pattern, bcDepth: f.b - f.c, extreme: h, extremeClose: side.sign * candles[i].close, pullbackBars: 0, pullbackLow: Infinity,
            limit: i + options.maxDurationMultiple * Math.max(1, pattern.c.index - pattern.a.index),
          }
          classify(side, t)
          side.open.push(t)
        }
        return false
      }
      if (l < f.c) { f.c = l; f.cIndex = i; measure(side, f) }
      return true
    })
  }

  for (let i = 1; i < candles.length; i += 1) {
    for (const side of sides) { follow(side, i); advance(side, i) }
    // Zigzag: a new extreme extends the swing; a qualified move against it confirms the extreme as a pivot.
    const candle = candles[i]
    const beyond = rising ? candle.high > extreme : candle.low < extreme
    if (beyond) {
      extreme = rising ? candle.high : candle.low; extremeIndex = i
      backBars = 0; back = rising ? Infinity : -Infinity
      continue
    }
    backBars += 1
    if (rising ? candle.low < back : candle.high > back) { back = rising ? candle.low : candle.high; backIndex = i }
    if (backBars < options.minPullbackBars || Math.abs(extreme - back) < options.minPullbackAtr * atr[extremeIndex]) continue
    pivots.push({ index: extremeIndex, price: extreme, high: rising })
    // The confirmed pivot is a swing high for one direction: its pullback starts forming there.
    const side = sides[rising ? 0 : 1]
    const f: Forming = { position: pivots.length - 1, b: side.sign * extreme, c: side.sign * back, cIndex: backIndex, pattern: null }
    side.forming.push(f)
    measure(side, f)
    // The swing now runs the other way from the pullback extreme.
    rising = !rising; extreme = back; extremeIndex = backIndex
    backBars = i - backIndex; back = rising ? Infinity : -Infinity
    for (let j = backIndex + 1; j <= i; j += 1) {
      if (rising ? candles[j].low < back : candles[j].high > back) { back = rising ? candles[j].low : candles[j].high; backIndex = j }
    }
  }
  return patterns.sort((x, y) => x.b.index - y.b.index)
}
