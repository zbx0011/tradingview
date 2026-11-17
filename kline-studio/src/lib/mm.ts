import type { Candle } from './market'

/**
 * MM（测量移动），按 Z说交易 的定义：
 *   一个波段高点 H 被实体突破（收盘越过 H）时，从突破前的波段低点 L 量到 H，再从 H 往上翻一倍：
 *   目标 T = H + (H − L)。被突破的 H 就是这段走势的"中点"，H 处留下的突破缺口没被回补，就倾向走到 T。
 *   下跌完全对称：波段低点被实体跌破，从突破前的波段高点量到它，再往下翻一倍。
 *
 * 波段多大，像人读图一样由图自己决定，不预设尺度：
 * - 每个还没被超过的高点都是候选 H（从右往左看，一级比一级高的那串高点）。被收盘越过的那些就是"被突破的高点"。
 * - L = H 之后、突破之前的最低点。H 到 L 就是这个波段（或区间）的高度：H 是区间顶，L 就是区间底。
 *   H 左边（到左边更高的高点为止）还有一个更低、但相差不到 `doubleBottomAtr` 个 ATR 的低点（双底），区间底取那个更低的。
 * - 每个 H 打一个"突出度"分 = min(左边跌幅, 右边跌幅)，用 H 处的 ATR 衡量（地形学里山峰的独立高度）：
 *     左边跌幅 = H 减去 [左边更高的那个高点, H] 之间的最低价；右边跌幅 = H − L。
 *   分数小的是区间里的小波动，分数大的是人眼里的波段顶、区间顶。一根K线同时突破好几个高点时，每个都量，按分数排。
 * - 影线 MM 用 H、L 的最高价、最低价；实体 MM 用这两根K线的实体（开盘、收盘中较高 / 较低者）。
 * - 只量"测量缺口"式的突破（Z：突破后有跟随、缺口不被回补才会去 MM）：突破K线够大（`minBreakoutRangeAtr`）、
 *   实体饱满（`minBreakoutBody`）、收在突破方向的一端（`minBreakoutClose`），并且下一根K线收盘继续越过突破K线的收盘
 *   （`followThrough`）。
 * - 突破之后一直跟踪到：到达 T（`reachAtr` 以内算到）、缺口被回补（默认按收盘，Z 的"实体补"）、跌破 L，或超时。
 *
 * NQ 5 分钟检验（2020-11 至 2023 / 2024 至 2026-11 留出）：到达影线 MM 约 42% / 42%，实体 MM 约 61% / 61%，每天约 7 个。
 * 波段越大越难到：H − L 只有 2–3 个 ATR 时约 60% 到影线 MM，8 个 ATR 以上（大区间）只有约 20%。
 * （旧版用固定 zigzag 波段点、L 取最近的小低点，到达率约 55%，但量的常常是区间里的一小段。）
 */
export interface MmOptions {
  atrPeriod: number
  /** 突出度（也就是 H − L 和左边跌幅中较小的）至少这么多个 ATR，太小的波动不量。 */
  minLegAtr: number
  /** 'close'：收盘越过 H 才算突破（实体突破）；'high'：最高价越过就算。 */
  breakout: 'close' | 'high'
  /** 离 T 这么多个 ATR 以内就算到了。 */
  reachAtr: number
  /** 回补缺口：'wick' 最低价回到 H 以内；'body' 收盘回到 H 以内。 */
  fill: 'wick' | 'body'
  /** 突破K线的振幅至少这么多个 ATR。 */
  minBreakoutRangeAtr: number
  /** 突破K线的实体至少占振幅的这个比例。 */
  minBreakoutBody: number
  /** 突破K线的收盘在振幅里，离突破方向反面一端至少这个比例（0.67 = 收在靠突破方向的三分之一）。 */
  minBreakoutClose: number
  /** 下一根K线收盘要继续越过突破K线的收盘。 */
  followThrough: boolean
  /** 突破后最多跟踪 (突破 − L) 的这么多倍根数。 */
  maxDurationMultiple: number
  /** 影线冲过顶部不到这么多个 ATR、收盘回到这根K线远离影线的那一半（突破失败、留下影线）：这根影线成为新的顶，区间不变。 */
  overshootAtr: number
  /**
   * H 左边（到左边更高的高点为止）有更低的低点，并且和 H 右边的低点相差不到这么多个 ATR（双底，同一个区间的底）：
   * L 取那个更低的。
   */
  doubleBottomAtr: number
  maxHistoryBars: number
}

export const DEFAULT_MM_OPTIONS: MmOptions = {
  atrPeriod: 20,
  minLegAtr: 2,
  breakout: 'close',
  reachAtr: 0.25,
  fill: 'body',
  minBreakoutRangeAtr: 1,
  minBreakoutBody: 0.6,
  minBreakoutClose: 0.67,
  followThrough: true,
  maxDurationMultiple: 4,
  overshootAtr: 1,
  doubleBottomAtr: 1,
  maxHistoryBars: 20000,
}

export interface MmPoint { index: number, time: number, price: number }

/** pending = 突破K线合格、在等下一根K线的跟随。 */
export type MmStatus = 'pending' | 'live' | 'reached' | 'filled' | 'failed' | 'expired'

export interface MmPattern {
  /** up = 向上突破、目标在上方。 */
  direction: 'up' | 'down'
  /** 量的起点：H 之后、突破之前的最低点（区间底）。 */
  l: MmPoint
  /** 被突破的高点（区间顶、中点、缺口）。 */
  h: MmPoint
  /** 突破的那根K线。 */
  breakoutIndex: number
  /** 跟随K线（突破成立）；pending 时为 -1。 */
  confirmedIndex: number
  /** 影线目标 T = H + (H − L)。 */
  target: number
  /** 实体目标：用 H、L 两根K线的实体量。 */
  bodyTarget: number
  /** 突破后走到的最远处（到结束为止）。 */
  extreme: MmPoint
  status: MmStatus
  /** 到达、回补、跌破 L 或超时的那根K线；live 时为 -1。 */
  endIndex: number
  /** 到达实体目标的K线，没到为 -1。 */
  bodyReachedIndex: number
  /** H 处的 ATR：腿长和"到达"的单位。 */
  atr: number
  /** H 的突出度（ATR 个数）：越大越是人眼里的大波段顶、区间顶。急速 MM：这段急速的影线长度（ATR 个数）。 */
  prominence: number
  /** swing = 被突破的波段 / 区间高低点量的 MM；spike = 连续大阳线 / 大阴线（急速）量的 MM。 */
  kind: 'swing' | 'spike'
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

/** Range minimum with its index (earliest on ties), over a fixed array. */
function minTree(values: Float64Array) {
  let size = 1
  while (size < values.length) size *= 2
  const tree = new Int32Array(2 * size).fill(-1)
  for (let i = 0; i < values.length; i += 1) tree[size + i] = i
  const better = (a: number, b: number) => a < 0 ? b : b < 0 ? a : values[b] < values[a] ? b : a
  for (let k = size - 1; k >= 1; k -= 1) tree[k] = better(tree[2 * k], tree[2 * k + 1])
  /** Index of the lowest value in [from, to] (inclusive); -1 when empty. */
  return (from: number, to: number) => {
    let best = -1
    let lo = from + size, hi = to + size + 1
    while (lo < hi) {
      if (lo & 1) best = better(best, tree[lo++])
      if (hi & 1) best = better(best, tree[--hi])
      lo >>= 1; hi >>= 1
    }
    return best
  }
}

/**
 * A high not exceeded yet. `leftLow` = lowest price between the higher high to its left and it. `base` = where its
 * swing (range) began: itself, or the earlier top it pushed just above in a failed breakout (L is searched after it).
 */
interface Candidate { index: number, price: number, base: number, leftLow: number, leftLowIndex: number }

interface Running { pattern: MmPattern, limit: number }

interface Pending { pattern: MmPattern, limit: number, reachedOnBreakout: boolean }

export function detectMm(candles: readonly Candle[], overrides: Partial<MmOptions> = {}): MmPattern[] {
  if (candles.length < 3) return []
  const options = { ...DEFAULT_MM_OPTIONS, ...overrides }
  const atr = atrValues(candles, Math.max(1, Math.floor(options.atrPeriod)))
  const patterns: MmPattern[] = []
  /** Breakouts without follow-through: not a measuring gap, not returned. */
  const dropped = new Set<MmPattern>()

  const sides = (['up', 'down'] as const).map((direction) => {
    const sign = direction === 'up' ? 1 : -1
    const lows = Float64Array.from(candles, (c) => sign > 0 ? c.low : -c.high)
    return {
      direction, sign,
      high: (i: number) => sign > 0 ? candles[i].high : -candles[i].low,
      low: (i: number) => lows[i],
      lowest: minTree(lows),
      close: (i: number) => sign * candles[i].close,
      bodyHigh: (i: number) => sign > 0 ? Math.max(candles[i].open, candles[i].close) : -Math.min(candles[i].open, candles[i].close),
      bodyLow: (i: number) => sign > 0 ? Math.min(candles[i].open, candles[i].close) : -Math.max(candles[i].open, candles[i].close),
      /** Highs not exceeded yet, highest first (bottom of the stack) to the most recent. */
      stack: [] as Candidate[],
      running: [] as Running[],
      pending: [] as Pending[],
    }
  })
  type Side = typeof sides[number]
  const point = (side: Side, index: number, value: number): MmPoint => ({ index, time: candles[index].time, price: side.sign * value })

  /** A close beyond `c` at bar i: an MM when the swing is big enough and the breakout bar is a measuring-gap bar. */
  const measure = (side: Side, c: Candidate, i: number) => {
    if (i - c.index < 2) return
    let li = side.lowest(c.base + 1, i - 1)
    const unit = atr[c.index]
    // The same range's bottom on the other side of H (a double bottom): measure from the lower of the two.
    if (c.leftLow < side.low(li) && side.low(li) - c.leftLow <= options.doubleBottomAtr * unit) li = c.leftLowIndex
    const lValue = side.low(li)
    const prominence = Math.min(c.price - lValue, c.price - c.leftLow) / unit
    if (prominence < options.minLegAtr) return
    const bar = candles[i], range = bar.high - bar.low
    const closeAt = range > 0 ? (side.close(i) - side.low(i)) / range : 0
    if (range < options.minBreakoutRangeAtr * atr[i] || Math.abs(bar.close - bar.open) < options.minBreakoutBody * range || closeAt < options.minBreakoutClose) return
    const h = side.high(i)
    const bodyH = side.bodyHigh(c.index), bodyL = side.bodyLow(li)
    const target = c.price + (c.price - lValue), bodyTarget = bodyH + (bodyH - bodyL)
    const pattern: MmPattern = {
      direction: side.direction,
      l: point(side, li, lValue), h: point(side, c.index, c.price), breakoutIndex: i, confirmedIndex: -1,
      target: side.sign * target, bodyTarget: side.sign * bodyTarget,
      extreme: point(side, i, h), status: 'pending', endIndex: -1, bodyReachedIndex: -1, atr: unit, prominence, kind: 'swing',
    }
    patterns.push(pattern)
    const limit = i + options.maxDurationMultiple * Math.max(1, i - li)
    // The breakout bar itself may already reach the target.
    const reachedOnBreakout = h >= target - options.reachAtr * unit
    if (h >= bodyTarget - options.reachAtr * unit) pattern.bodyReachedIndex = i
    if (options.followThrough) side.pending.push({ pattern, limit, reachedOnBreakout })
    else {
      pattern.confirmedIndex = i
      if (reachedOnBreakout) { pattern.status = 'reached'; pattern.endIndex = i }
      else { pattern.status = 'live'; side.running.push({ pattern, limit }) }
    }
  }

  const step = (side: Side, i: number) => {
    const h = side.high(i), l = side.low(i)
    // Breakouts waiting for follow-through: this bar must close beyond the breakout bar's close.
    for (const q of side.pending) {
      const { pattern } = q
      if (side.close(i) > side.close(pattern.breakoutIndex)) {
        pattern.confirmedIndex = i
        if (q.reachedOnBreakout) { pattern.status = 'reached'; pattern.endIndex = pattern.breakoutIndex }
        else { pattern.status = 'live'; side.running.push({ pattern, limit: q.limit }) }
      } else dropped.add(pattern)
    }
    side.pending = []
    // Running MMs: reached, gap filled, L broken or expired.
    side.running = side.running.filter(({ pattern, limit }) => {
      const t = side.sign * pattern.target, hp = side.sign * pattern.h.price, lp = side.sign * pattern.l.price
      if (h > side.sign * pattern.extreme.price) pattern.extreme = point(side, i, h)
      if (pattern.bodyReachedIndex < 0 && h >= side.sign * pattern.bodyTarget - options.reachAtr * pattern.atr) pattern.bodyReachedIndex = i
      let status: MmStatus | null = null
      if (h >= t - options.reachAtr * pattern.atr) status = 'reached'
      else if (l < lp) status = 'failed'
      else if (options.fill === 'wick' ? l <= hp : side.close(i) <= hp) status = 'filled'
      else if (i >= limit) status = 'expired'
      if (!status) return true
      pattern.status = status; pattern.endIndex = i
      return false
    })
    // Highs this bar goes above: broken when it closes beyond them, otherwise just replaced by this higher bar.
    const { stack } = side
    const reach = options.breakout === 'close' ? side.close(i) : h
    let failed: Candidate | null = null
    // A failed breakout leaves a tail: the bar closes back in the half away from its poke. A bar closing near its
    // extreme is the trend going on, not a failed breakout, even when its close is still just inside the old top.
    const range = h - l
    const rejected = range > 0 && (h - side.close(i)) / range >= 0.5
    while (stack.length && stack[stack.length - 1].price < h) {
      const c = stack.pop()!
      if (reach > c.price) measure(side, c, i)
      // A wick just above a real top, closing back inside: a failed breakout. This bar is the new top, but the range
      // (where L is looked for) still starts at the old one.
      else if (rejected && h - c.price <= options.overshootAtr * atr[c.index] && c.price - c.leftLow >= options.minLegAtr * atr[c.index]) failed = c
    }
    if (failed) { stack.push({ index: i, price: h, base: failed.base, leftLow: failed.leftLow, leftLowIndex: failed.leftLowIndex }); return }
    // An equal high is the same top (double top): keep the first one.
    if (stack.length && stack[stack.length - 1].price === h) return
    const left = stack[stack.length - 1]
    const leftLowIndex = side.lowest(left ? left.index + 1 : 0, i)
    stack.push({ index: i, price: h, base: i, leftLow: side.low(leftLowIndex), leftLowIndex })
  }

  for (let i = 0; i < candles.length; i += 1) for (const side of sides) step(side, i)
  return patterns.filter((p) => !dropped.has(p)).sort((x, y) => x.breakoutIndex - y.breakoutIndex || y.prominence - x.prominence)
}

/** Still in play at the last candle: broken out (or waiting for follow-through), gap open, target not reached yet. */
export function isMmLive(pattern: MmPattern) {
  return pattern.status === 'live' || pattern.status === 'pending'
}

export interface SpikeMmOptions {
  atrPeriod: number
  /** 每根K线实体至少占振幅的这个比例。 */
  minBody: number
  /** 每根K线实体至少这么多个 ATR（太小的不算"大阳线"）。 */
  minBodyAtr: number
  /** 整段急速从第一根开盘到最后一根收盘至少这么多个 ATR（急速前的 ATR）。 */
  minSpikeAtr: number
  /** 离目标这么多个 ATR 以内就算到了。 */
  reachAtr: number
  /** 急速结束后最多跟踪这么多根K线。 */
  maxBars: number
}

export const DEFAULT_SPIKE_MM_OPTIONS: SpikeMmOptions = {
  atrPeriod: 20,
  minBody: 0.5,
  minBodyAtr: 0.5,
  minSpikeAtr: 3,
  reachAtr: 0.25,
  maxBars: 120,
}

/**
 * 急速 MM（Z：用连续大阳线 / 大阴线的实体测量 MM；阿布：spike 的 measured move）：
 * - 急速 = 连续几根同向的大趋势K线：每根实体占振幅一半以上、不小于 `minBodyAtr` 个 ATR、收盘比前一根更远；
 *   整段从第一根开盘到最后一根收盘至少 `minSpikeAtr` 个 ATR（用急速开始前的 ATR，急速本身会把 ATR 撑大）。
 * - 实体 MM：第一根的开盘到最后一根的收盘，从最后一根的收盘再量一倍。
 * - 影线 MM：第一根的最低价到急速里的最高价，从最高价再量一倍。
 * - 急速结束（下一根不再是同向大K线）后开始跟踪：到达影线目标、收盘跌回第一根开盘之下（急速被吃掉）或超时。
 *   急速还在走时为 pending。
 */
export function detectSpikeMm(candles: readonly Candle[], overrides: Partial<SpikeMmOptions> = {}): MmPattern[] {
  if (candles.length < 3) return []
  const options = { ...DEFAULT_SPIKE_MM_OPTIONS, ...overrides }
  const atr = atrValues(candles, Math.max(1, Math.floor(options.atrPeriod)))
  const patterns: MmPattern[] = []
  for (const sign of [1, -1]) {
    const direction = sign > 0 ? 'up' as const : 'down' as const
    const high = (i: number) => sign > 0 ? candles[i].high : -candles[i].low
    const low = (i: number) => sign > 0 ? candles[i].low : -candles[i].high
    const open = (i: number) => sign * candles[i].open
    const close = (i: number) => sign * candles[i].close
    const point = (index: number, value: number): MmPoint => ({ index, time: candles[index].time, price: sign * value })
    const big = (i: number) => {
      const body = close(i) - open(i), range = candles[i].high - candles[i].low
      return body > 0 && body >= options.minBody * range && body >= options.minBodyAtr * atr[Math.max(0, i - 1)]
        && (i === 0 || close(i) > close(i - 1))
    }
    let i = 0
    while (i < candles.length) {
      if (!big(i)) { i += 1; continue }
      const first = i
      while (i + 1 < candles.length && big(i + 1)) i += 1
      const last = i
      i += 1
      const unit = atr[Math.max(0, first - 1)]
      if (close(last) - open(first) < options.minSpikeAtr * unit) continue
      let top = first
      for (let k = first + 1; k <= last; k += 1) if (high(k) > high(top)) top = k
      const start = low(first), end = high(top)
      const target = end + (end - start), bodyTarget = close(last) + (close(last) - open(first))
      const pattern: MmPattern = {
        direction, l: point(first, start), h: point(top, end), breakoutIndex: last, confirmedIndex: -1,
        target: sign * target, bodyTarget: sign * bodyTarget, extreme: point(top, end),
        status: 'pending', endIndex: -1, bodyReachedIndex: -1, atr: unit, prominence: (end - start) / unit, kind: 'spike',
      }
      patterns.push(pattern)
      if (last + 1 >= candles.length) continue
      pattern.confirmedIndex = last + 1
      pattern.status = 'live'
      for (let k = last + 1; k < candles.length; k += 1) {
        if (high(k) > sign * pattern.extreme.price) pattern.extreme = point(k, high(k))
        if (pattern.bodyReachedIndex < 0 && high(k) >= bodyTarget - options.reachAtr * unit) pattern.bodyReachedIndex = k
        let status: MmStatus | null = null
        if (high(k) >= target - options.reachAtr * unit) status = 'reached'
        else if (close(k) < open(first)) status = 'failed'
        else if (k - last >= options.maxBars) status = 'expired'
        if (!status) continue
        pattern.status = status; pattern.endIndex = k
        break
      }
    }
  }
  return patterns.sort((x, y) => x.breakoutIndex - y.breakoutIndex)
}
