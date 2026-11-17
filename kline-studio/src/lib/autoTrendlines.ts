// Ports of two TradingView-style studies ("Auto Trendlines" and "Auto Trend Detector", from their Pine ports).
// Both are recomputed from the candles shown so far, so in replay they never use bars beyond the last one.
import type { Candle } from './market'

export type TrendlineKind = 'support' | 'resistance' | 'flat'

export interface AutoTrendline {
  source: 'trendlines' | 'detector' | 'pairs'
  kind: TrendlineKind
  /** Candle indices (into the array given to the compute function) and prices of the two anchors. */
  x1: number
  y1: number
  x2: number
  y2: number
  /** Where the drawn segment ends; with extendRight the line runs on past it at the same slope. */
  endX: number
  endY: number
  extendRight: boolean
  /** Auto Trendlines: large-pivot line. Auto Trend Detector: the active line that sets the trend. */
  major: boolean
  touches: number
  /** True once a third pivot (besides the two anchors) sits on the line. With only the two anchors the line is not yet a trendline. */
  confirmed: boolean
}

export interface AutoTrendlinesOptions {
  lineSize: 'small' | 'large' | 'both'
  analysisBars: number
  largeLeft: number
  largeRight: number
  smallLeft: number
  smallRight: number
  largeAtrMult: number
  smallAtrMult: number
  barsToBreakout: number
  maxExtendMult: number
  conflictAtr: number
  maxLines: number
  maxPivots: number
  laterPerAnchor: number
}

export const DEFAULT_AUTO_TRENDLINES_OPTIONS: AutoTrendlinesOptions = {
  lineSize: 'both', analysisBars: 5000, largeLeft: 25, largeRight: 25, smallLeft: 5, smallRight: 5,
  largeAtrMult: 5, smallAtrMult: 2, barsToBreakout: 3, maxExtendMult: 2, conflictAtr: 2.5, maxLines: 80, maxPivots: 80, laterPerAnchor: 6,
}

export interface AutoTrendDetectorOptions {
  atrPeriod: number
  pivotLeft: number
  pivotRight: number
  barsToBreakout: number
  /** Percent of ATR below which two pivots count as level (a sideways line). */
  flatThreshold: number
  analysisBars: number
  maxLines: number
}

export const DEFAULT_AUTO_TREND_DETECTOR_OPTIONS: AutoTrendDetectorOptions = {
  atrPeriod: 30, pivotLeft: 10, pivotRight: 10, barsToBreakout: 2, flatThreshold: 1.5, analysisBars: 5000, maxLines: 60,
}

export type AutoTrend = 'up' | 'down' | 'sideways'
export interface AutoTrendDetectorResult { lines: AutoTrendline[]; trend: AutoTrend | null }

interface Pivot { pos: number; price: number }

/** Wilder ATR (Pine ta.atr); NaN until the period is filled. */
function atr(candles: readonly Candle[], period: number): Float64Array {
  const result = new Float64Array(candles.length).fill(Number.NaN)
  let sum = 0, value = 0
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i]
    const range = i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close))
    if (i < period) {
      sum += range
      if (i === period - 1) { value = sum / period; result[i] = value }
    } else {
      value = (value * (period - 1) + range) / period
      result[i] = value
    }
  }
  return result
}

/** Pine ta.pivothigh / ta.pivotlow: the extreme of `left` bars before and `right` bars after, known `right` bars later. */
function pivots(candles: readonly Candle[], left: number, right: number, high: boolean, from: number): Pivot[] {
  const result: Pivot[] = []
  for (let i = Math.max(left, from); i < candles.length - right; i += 1) {
    const value = high ? candles[i].high : candles[i].low
    let ok = true
    for (let k = i - left; k < i && ok; k += 1) ok = high ? candles[k].high <= value : candles[k].low >= value
    for (let k = i + 1; k <= i + right && ok; k += 1) ok = high ? candles[k].high < value : candles[k].low > value
    if (ok) result.push({ pos: i, price: value })
  }
  return result
}

/** Pivots other than the two anchors that lie on the line (within half an ATR) up to `end`: a third touch confirms a trendline. */
function extraTouches(list: readonly Pivot[], x1: number, y1: number, x2: number, y2: number, end: number, atrValue: Float64Array): number {
  const slope = (y2 - y1) / (x2 - x1)
  let count = 0
  for (const pivot of list) {
    if (pivot.pos <= x1 || pivot.pos === x2 || pivot.pos > end) continue
    const pivotAtr = atrValue[pivot.pos]
    if (Number.isFinite(pivotAtr) && Math.abs(pivot.price - (y1 + slope * (pivot.pos - x1))) <= 0.5 * pivotAtr) count += 1
  }
  return count
}

/** First bar of the first run of `bars` closes beyond the line after its second anchor, or -1. */
function findBreakout(candles: readonly Candle[], support: boolean, x1: number, y1: number, x2: number, y2: number, bars: number): number {
  const slope = (y2 - y1) / (x2 - x1)
  let streak = 0, start = -1
  for (let x = x2 + 1; x < candles.length; x += 1) {
    const line = y1 + slope * (x - x1)
    const outside = support ? candles[x].close < line : candles[x].close > line
    if (outside) {
      if (streak === 0) start = x
      streak += 1
      if (streak >= bars) return start
    } else { streak = 0; start = -1 }
  }
  return -1
}

function tail<T extends readonly Candle[]>(candles: T, analysisBars: number) {
  // Extra bars before the window warm up the ATR and let window-edge pivots confirm.
  const offset = Math.max(0, candles.length - analysisBars - 200)
  return { offset, bars: offset === 0 ? candles : candles.slice(offset), oldest: Math.max(0, candles.length - 1 - analysisBars - offset) }
}

export function computeAutoTrendlines(allCandles: readonly Candle[], partial: Partial<AutoTrendlinesOptions> = {}): AutoTrendline[] {
  const o = { ...DEFAULT_AUTO_TRENDLINES_OPTIONS, ...partial }
  const { offset, bars: candles, oldest } = tail(allCandles, o.analysisBars)
  const last = candles.length - 1
  if (last < 20) return []
  const atr14 = atr(candles, 14)
  const touchHigh = pivots(candles, 3, 3, true, oldest), touchLow = pivots(candles, 3, 3, false, oldest)
  interface Candidate extends AutoTrendline { base: number; score: number; atr: number; large: boolean }
  const candidates: Candidate[] = []
  const add = (support: boolean, large: boolean, list: Pivot[], touchPivots: Pivot[]) => {
    if ((large && o.lineSize === 'small') || (!large && o.lineSize === 'large')) return
    for (let i = Math.max(0, list.length - o.maxPivots); i < list.length; i += 1) {
      for (let j = i + 1; j <= Math.min(list.length - 1, i + o.laterPerAnchor); j += 1) {
        const a = list[i], b = list[j], atrAt = atr14[a.pos]
        if (b.pos <= a.pos || !Number.isFinite(atrAt) || atrAt <= 0) continue
        if (Math.abs(b.price - a.price) < atrAt * (large ? o.largeAtrMult : o.smallAtrMult)) continue
        const slope = (b.price - a.price) / (b.pos - a.pos)
        const broken = findBreakout(candles, support, a.pos, a.price, b.pos, b.price, o.barsToBreakout)
        let endX = b.pos, endY = b.price, extendRight = false
        if (broken >= 0) { endX = broken; endY = a.price + slope * (broken - a.pos) }
        else if (last + 1 - b.pos <= o.maxExtendMult * (b.pos - a.pos)) { endX = last + 1; endY = a.price + slope * (endX - a.pos); extendRight = true }
        const confirmed = extraTouches(touchPivots, a.pos, a.price, b.pos, b.price, endX, atr14) > 0
        let touches = 0
        for (const pivot of touchPivots) {
          if (pivot.pos < a.pos || pivot.pos > endX) continue
          const pivotAtr = atr14[pivot.pos]
          if (Number.isFinite(pivotAtr) && Math.abs(pivot.price - (a.price + slope * (pivot.pos - a.pos))) <= 0.5 * pivotAtr) touches += 1
        }
        candidates.push({
          source: 'trendlines', kind: support ? 'support' : 'resistance', x1: a.pos, y1: a.price, x2: b.pos, y2: b.price, endX, endY, extendRight, major: large, touches, confirmed,
          large, base: b.pos - a.pos, atr: atrAt, score: touches * 1e7 + (endX - a.pos) * 1e3 + Math.abs(b.price - a.price) / atrAt,
        })
      }
    }
  }
  add(false, true, pivots(candles, o.largeLeft, o.largeRight, true, oldest), touchHigh)
  add(true, true, pivots(candles, o.largeLeft, o.largeRight, false, oldest), touchLow)
  add(false, false, pivots(candles, o.smallLeft, o.smallRight, true, oldest), touchHigh)
  add(true, false, pivots(candles, o.smallLeft, o.smallRight, false, oldest), touchLow)

  // Best score first; drop a line that shares its first anchor with, or runs alongside, a better one of the same side.
  candidates.sort((a, b) => b.score - a.score)
  const selected: Candidate[] = []
  for (const best of candidates) {
    if (selected.length >= o.maxLines) break
    const slopeBest = (best.y2 - best.y1) / Math.max(1, best.x2 - best.x1)
    const reject = selected.some((kept) => {
      if (kept.kind !== best.kind) return false
      if (kept.large === best.large && kept.x1 === best.x1) return true
      const left = Math.max(best.x1, kept.x1), right = Math.min(best.x2, kept.x2)
      if (right <= left) return false
      const slopeKept = (kept.y2 - kept.y1) / Math.max(1, kept.x2 - kept.x1)
      const gap = Math.abs(best.y1 + slopeBest * (left - best.x1) - (kept.y1 + slopeKept * (left - kept.x1)))
      return (right - left) / Math.max(1, best.base, kept.base) > 0.3 && gap < o.conflictAtr * Math.max(best.atr, kept.atr)
    })
    if (!reject) selected.push(best)
  }
  return selected.map(({ source, kind, x1, y1, x2, y2, endX, endY, extendRight, major, touches, confirmed }) => ({
    source, kind, x1: x1 + offset, y1, x2: x2 + offset, y2, endX: endX + offset, endY, extendRight, major, touches, confirmed,
  }))
}

export function computeAutoTrendDetector(allCandles: readonly Candle[], partial: Partial<AutoTrendDetectorOptions> = {}): AutoTrendDetectorResult {
  const o = { ...DEFAULT_AUTO_TREND_DETECTOR_OPTIONS, ...partial }
  const { offset, bars: candles, oldest } = tail(allCandles, o.analysisBars)
  const last = candles.length - 1
  if (last < o.atrPeriod) return { lines: [], trend: null }
  const atrValue = atr(candles, o.atrPeriod)
  const mainHigh = pivots(candles, o.pivotLeft, o.pivotRight, true, oldest), mainLow = pivots(candles, o.pivotLeft, o.pivotRight, false, oldest)
  const smallWindow = Math.max(1, Math.floor(Math.min(o.pivotLeft, o.pivotRight) / 2))
  const smallHigh = pivots(candles, smallWindow, smallWindow, true, oldest), smallLow = pivots(candles, smallWindow, smallWindow, false, oldest)

  // Alternating high/low sequence: of two highs (lows) in a row only the more extreme stays.
  const alternating: (Pivot & { high: boolean })[] = []
  let hi = 0, lo = 0
  while (hi < mainHigh.length || lo < mainLow.length) {
    const takeHigh = lo >= mainLow.length || (hi < mainHigh.length && mainHigh[hi].pos <= mainLow[lo].pos)
    const pivot = takeHigh ? mainHigh[hi++] : mainLow[lo++]
    const previous = alternating.at(-1)
    if (!previous) alternating.push({ ...pivot, high: takeHigh })
    else if (previous.high === takeHigh) {
      if (takeHigh ? pivot.price >= previous.price : pivot.price <= previous.price) { previous.pos = pivot.pos; previous.price = pivot.price }
    } else if (pivot.pos !== previous.pos) alternating.push({ ...pivot, high: takeHigh })
  }

  interface Candidate { kind: TrendlineKind; x1: number; y1: number; x2: number; y2: number; broken: number; touches: number; confirmed: boolean; score: number }
  const candidates: Candidate[] = []
  const countTouches = (kind: TrendlineKind, x1: number, y1: number, x2: number, y2: number, broken: number) => {
    const slope = (y2 - y1) / (x2 - x1), end = broken >= 0 ? broken : last
    let touches = 0
    for (let x = x1; x <= end; x += 1) {
      const price = kind === 'support' ? candles[x].low : kind === 'resistance' ? candles[x].high : candles[x].close
      if (Number.isFinite(atrValue[x]) && Math.abs(price - (y1 + slope * (x - x1))) <= 0.5 * atrValue[x]) touches += 1
    }
    return touches
  }
  const minBase = 2 * o.pivotRight + o.barsToBreakout + 4
  for (const high of [true, false]) {
    const sequence = alternating.filter((pivot) => pivot.high === high)
    for (let i = 0; i + 1 < sequence.length; i += 1) {
      const a = sequence[i], b = sequence[i + 1], atr1 = atrValue[a.pos]
      if (b.pos <= a.pos || !Number.isFinite(atr1) || atr1 <= 0) continue
      const kind: TrendlineKind = Math.abs(b.price - a.price) / atr1 * 100 < o.flatThreshold ? 'flat' : high ? 'resistance' : 'support'
      const broken = kind === 'flat' ? -1 : findBreakout(candles, kind === 'support', a.pos, a.price, b.pos, b.price, o.barsToBreakout)
      const survival = broken >= 0 ? broken - b.pos : last - b.pos
      if (broken >= 0 && broken <= b.pos + o.barsToBreakout) continue
      if (b.pos - a.pos < minBase || survival < Math.max(10, o.pivotRight)) continue
      const touches = countTouches(kind, a.pos, a.price, b.pos, b.price, broken)
      const confirmed = extraTouches(high ? smallHigh : smallLow, a.pos, a.price, b.pos, b.price, broken >= 0 ? broken : last, atrValue) > 0
      candidates.push({ kind, x1: a.pos, y1: a.price, x2: b.pos, y2: b.price, broken, touches, confirmed, score: (broken < 0 ? 1e12 : 0) + touches * 1e7 + survival * 1e3 + (b.pos - a.pos) })
    }
  }
  // Projection: the most extreme of the last three main pivots joined to the first later small pivot that still holds.
  for (const high of [true, false]) {
    const main = high ? mainHigh : mainLow, small = high ? smallHigh : smallLow
    if (main.length === 0 || small.length < 2) continue
    let first = main[Math.max(0, main.length - 3)]
    for (let i = Math.max(0, main.length - 3) + 1; i < main.length; i += 1) if (high ? main[i].price >= first.price : main[i].price <= first.price) first = main[i]
    const firstAtr = atrValue[first.pos]
    if (!Number.isFinite(firstAtr) || firstAtr <= 0) continue
    for (const second of small) {
      const directional = high ? second.price < first.price : second.price > first.price
      if (second.pos <= first.pos || !directional || Math.abs(second.price - first.price) / firstAtr * 100 < o.flatThreshold) continue
      const kind: TrendlineKind = high ? 'resistance' : 'support'
      if (findBreakout(candles, !high, first.pos, first.price, second.pos, second.price, o.barsToBreakout) >= 0) continue
      const touches = countTouches(kind, first.pos, first.price, second.pos, second.price, -1)
      const confirmed = extraTouches(small, first.pos, first.price, second.pos, second.price, last, atrValue) > 0
      candidates.push({ kind, x1: first.pos, y1: first.price, x2: second.pos, y2: second.price, broken: -1, touches, confirmed, score: 1e12 + 1e11 + touches * 1e7 + (last - second.pos) * 1e3 + (second.pos - first.pos) })
      break
    }
  }
  // One line per first anchor (the best); the best of all is the active line that names the trend.
  const kept = candidates.filter((candidate, i) => !candidates.some((other, j) => i !== j && other.x1 === candidate.x1 && (other.score > candidate.score || (other.score === candidate.score && j < i))))
  let active: Candidate | null = null
  for (const candidate of kept) if (!active || candidate.score > active.score) active = candidate
  const lines = kept.slice(0, o.maxLines).map((c): AutoTrendline => {
    const slope = (c.y2 - c.y1) / (c.x2 - c.x1)
    const endX = c.broken >= 0 ? c.x2 : last + 1
    return {
      source: 'detector', kind: c.kind, x1: c.x1 + offset, y1: c.y1, x2: c.x2 + offset, y2: c.y2,
      endX: endX + offset, endY: c.y1 + slope * (endX - c.x1), extendRight: c.broken < 0, major: c === active, touches: c.touches, confirmed: c.confirmed,
    }
  })
  return { lines, trend: !active ? null : active.kind === 'support' ? 'up' : active.kind === 'resistance' ? 'down' : 'sideways' }
}

/**
 * Hand-drawn style lines: each swing high (low) joined to the next few swing highs (lows), whatever the slope or height.
 * Two points only, so these start dashed; the overlay drops any whose anchors are crossed by a wick in between.
 */
export function computePivotPairLines(allCandles: readonly Candle[], left = 5, right = 5, laterPerAnchor = 3, analysisBars = 3000, barsToBreakout = 2): AutoTrendline[] {
  const { offset, bars: candles, oldest } = tail(allCandles, analysisBars)
  const last = candles.length - 1
  if (last < left + right + 2) return []
  const lines: AutoTrendline[] = []
  for (const high of [true, false]) {
    const list = pivots(candles, left, right, high, oldest)
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j <= Math.min(list.length - 1, i + laterPerAnchor); j += 1) {
        const a = list[i], b = list[j]
        if (b.pos - a.pos < 3) continue
        const slope = (b.price - a.price) / (b.pos - a.pos)
        const broken = findBreakout(candles, !high, a.pos, a.price, b.pos, b.price, barsToBreakout)
        const endX = broken >= 0 ? broken : last + 1
        lines.push({
          source: 'pairs', kind: high ? 'resistance' : 'support', x1: a.pos + offset, y1: a.price, x2: b.pos + offset, y2: b.price,
          endX: endX + offset, endY: a.price + slope * (endX - a.pos), extendRight: broken < 0, major: false, touches: 2, confirmed: false,
        })
      }
    }
  }
  return lines
}
