// Smart Money Concepts (market structure) calculation.
//
// This is a TypeScript port of the "Smart Money Concepts [LuxAlgo]" Pine script
// (© LuxAlgo, licensed under CC BY-NC-SA 4.0 — https://creativecommons.org/licenses/by-nc-sa/4.0/).
// The port keeps the original defaults: Historical mode, Colored style, internal
// + swing structure, EQH/EQL, strong/weak high & low and
// premium/discount zones. Fair value gaps follow the script's detection logic; filled
// gaps retain each first-filled price layer for stepped historical refill bands. MTF levels and
// swing order blocks, off by default in the script, are not ported.
//
// The script's order blocks are replaced by trapped-trader zones: when a candle closes through a
// BOS / CHoCH level and one of the next TRAP_REVERSAL_BARS candles closes back on the other side,
// the band between the broken level and the extreme of that false break is where the breakout
// traders are trapped. A failed break down (trapped shorts) is a blue support band, a failed break
// up (trapped longs) a pink resistance band. A band stays until price comes back through all of it.
//
// All positions are expressed as candle indexes so the overlay can map them to
// chart coordinates with the time scale's logical index.
import type { Candle } from './market'

export const SMC_COLORS = {
  green: '#089981',
  red: '#F23645',
  blue: '#2157f3',
  gray: '#878b94',
  yellow: '#d4b106',
  internalBullishOrderBlock: 'rgba(49, 121, 245, 0.2)',
  internalBearishOrderBlock: 'rgba(255, 0, 0, 0.4)',
  /** Premium / Equilibrium / Discount are drawn as plain black segments. */
  zoneLine: '#000000',
  bullishFairValueGap: '#ff9800',
  bearishFairValueGap: '#f0356b',
} as const

export interface SmcOptions {
  /** Pivot length of the swing structure ("Show Swings Points" length in the script). */
  swingLength: number
  /** Number of bars used to confirm equal highs / lows. */
  equalLength: number
  /** Sensitivity (0..0.5) of equal highs / lows, relative to ATR(200). */
  equalThreshold: number
  /** How many not-yet-refilled trapped-trader zones are kept for drawing (newest first). */
  internalOrderBlocks: number
  /** Maximum retained structure lines / equal lines (the script caps lines at 500). */
  maxLines: number
  /**
   * The script's "Auto Threshold" hides gaps whose middle candle body is below twice the average body.
   * It is measured over every loaded bar, so on the short windows used for practice it hides gaps the
   * full-history chart would show; it is therefore off by default and every unfilled gap is drawn.
   */
  fairValueGapAutoThreshold: boolean
}

export const DEFAULT_SMC_OPTIONS: SmcOptions = {
  swingLength: 50,
  equalLength: 3,
  equalThreshold: 0.1,
  internalOrderBlocks: 10,
  maxLines: 500,
  fairValueGapAutoThreshold: false,
}

export interface SmcStructure {
  /** Index of the pivot that was broken. */
  fromIndex: number
  /** Index of the candle whose close broke the pivot. */
  toIndex: number
  price: number
  tag: 'BOS' | 'CHoCH'
  bullish: boolean
  internal: boolean
}

export interface SmcEqual {
  fromIndex: number
  toIndex: number
  fromPrice: number
  toPrice: number
  /** true for equal highs (EQH), false for equal lows (EQL). */
  high: boolean
}

/** Trapped-trader zone (drawn where the script drew order blocks). */
export interface SmcOrderBlock {
  /** Candle whose close broke the structure level. */
  startIndex: number
  top: number
  bottom: number
  /** true: failed break down, shorts trapped below the level (support); false: longs trapped above (resistance). */
  bullish: boolean
}

interface PendingTrap {
  level: number
  breakIndex: number
  /** Lowest low (failed break down) or highest high (failed break up) since the break. */
  extreme: number
  bullish: boolean
}

/** A break only counts as a trap when price closes back across the level within this many candles. */
export const TRAP_REVERSAL_BARS = 3

export interface SmcFairValueGap {
  /** Index of the first candle of the three-candle pattern. */
  startIndex: number
  top: number
  bottom: number
  bullish: boolean
  /** Unfilled price bounds shrink on every deeper penetration, never on a shallower retest. */
  remainingTop: number
  remainingBottom: number
  /** Disjoint price layers, each ending at the first candle that filled it. */
  refills: { index: number; top: number; bottom: number }[]
  /** Index of the candle that fully filled the gap, or null while it is still open. */
  endIndex: number | null
}

export interface SmcTrailing {
  top: number
  bottom: number
  topIndex: number
  bottomIndex: number
  /** Index of the latest swing pivot (start of the premium/discount zones). */
  pivotIndex: number
}

export interface SmcResult {
  structures: SmcStructure[]
  equals: SmcEqual[]
  orderBlocks: SmcOrderBlock[]
  fairValueGaps: SmcFairValueGap[]
  filledFairValueGaps: SmcFairValueGap[]
  trailing: SmcTrailing | null
  /** Current swing trend: 1 bullish, -1 bearish, 0 unknown. */
  swingBias: number
  lastIndex: number
}

interface Pivot {
  current: number
  last: number
  crossed: boolean
  barIndex: number
}

interface LegState {
  leg: number
  previous: number | null
}

const BULLISH = 1
const BEARISH = -1
const BEARISH_LEG = 0
const BULLISH_LEG = 1
const ATR_LENGTH = 200

const newPivot = (): Pivot => ({ current: Number.NaN, last: Number.NaN, crossed: false, barIndex: 0 })

/** An internal pivot that no close has broken yet. */
interface OpenLevel {
  price: number
  barIndex: number
}

export function emptySmcResult(): SmcResult {
  return { structures: [], equals: [], orderBlocks: [], fairValueGaps: [], filledFairValueGaps: [], trailing: null, swingBias: 0, lastIndex: -1 }
}

export function computeSmartMoney(candles: readonly Candle[], partial: Partial<SmcOptions> = {}): SmcResult {
  const options = { ...DEFAULT_SMC_OPTIONS, ...partial }
  const count = candles.length
  if (count < 3) return emptySmcResult()

  // ATR(200) with Wilder smoothing (Pine's ta.atr).
  const atr = new Float64Array(count).fill(Number.NaN)
  {
    let sum = 0
    let value = Number.NaN
    for (let index = 0; index < count; index += 1) {
      const candle = candles[index]
      const previousClose = index > 0 ? candles[index - 1].close : candle.close
      const trueRange = Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose))
      if (index < ATR_LENGTH) {
        sum += trueRange
        if (index === ATR_LENGTH - 1) {
          value = sum / ATR_LENGTH
          atr[index] = value
        }
      } else {
        value = (value * (ATR_LENGTH - 1) + trueRange) / ATR_LENGTH
        atr[index] = value
      }
    }
  }

  const swingHigh = newPivot()
  const swingLow = newPivot()
  const internalHigh = newPivot()
  const internalLow = newPivot()
  const equalHigh = newPivot()
  const equalLow = newPivot()
  const swingTrend = { bias: 0 }
  const internalTrend = { bias: 0 }
  // The original script only watches the most recent internal pivot, so an older, more important
  // high (or low) is forgotten as soon as a smaller pivot forms after it, and its later break gets
  // no BOS / CHoCH. Every unbroken internal pivot is kept instead (highs strictly falling from old
  // to new, lows strictly rising); a pivot that a newer one exceeds was already swept and is dropped.
  const openHighs: OpenLevel[] = []
  const openLows: OpenLevel[] = []
  const trailing = {
    top: Number.NaN, bottom: Number.NaN, topIndex: 0, bottomIndex: 0, pivotIndex: 0, seen: false,
  }

  const swingLeg: LegState = { leg: 0, previous: null }
  const internalLeg: LegState = { leg: 0, previous: null }
  const equalLeg: LegState = { leg: 0, previous: null }

  const structures: SmcStructure[] = []
  const equals: SmcEqual[] = []
  let internalOrderBlocks: SmcOrderBlock[] = []
  let pendingTraps: PendingTrap[] = []
  const fairValueGaps: SmcFairValueGap[] = []
  let openGaps: SmcFairValueGap[] = []
  let deltaSum = 0

  function updateLeg(state: LegState, size: number, index: number) {
    if (index >= size) {
      const pivotCandle = candles[index - size]
      let highest = -Infinity
      let lowest = Infinity
      for (let cursor = index - size + 1; cursor <= index; cursor += 1) {
        if (candles[cursor].high > highest) highest = candles[cursor].high
        if (candles[cursor].low < lowest) lowest = candles[cursor].low
      }
      if (pivotCandle.high > highest) state.leg = BEARISH_LEG
      else if (pivotCandle.low < lowest) state.leg = BULLISH_LEG
    }
    const change = state.previous === null ? 0 : state.leg - state.previous
    state.previous = state.leg
    return change
  }

  function structureStep(state: LegState, size: number, index: number, kind: 'swing' | 'internal' | 'equal') {
    const change = updateLeg(state, size, index)
    if (change === 0) return
    const pivotIndex = index - size
    const pivotCandle = candles[pivotIndex]
    if (change === 1) {
      const pivot = kind === 'equal' ? equalLow : kind === 'internal' ? internalLow : swingLow
      if (kind === 'equal' && Math.abs(pivot.current - pivotCandle.low) < options.equalThreshold * atr[index]) {
        equals.push({ fromIndex: pivot.barIndex, toIndex: pivotIndex, fromPrice: pivot.current, toPrice: pivotCandle.low, high: false })
      }
      pivot.last = pivot.current
      pivot.current = pivotCandle.low
      pivot.crossed = false
      pivot.barIndex = pivotIndex
      if (kind === 'internal') {
        while (openLows.length > 0 && openLows[openLows.length - 1].price >= pivot.current) openLows.pop()
        openLows.push({ price: pivot.current, barIndex: pivotIndex })
      }
      if (kind === 'swing') {
        trailing.bottom = pivot.current
        trailing.pivotIndex = pivot.barIndex
        trailing.bottomIndex = pivot.barIndex
      }
    } else {
      const pivot = kind === 'equal' ? equalHigh : kind === 'internal' ? internalHigh : swingHigh
      if (kind === 'equal' && Math.abs(pivot.current - pivotCandle.high) < options.equalThreshold * atr[index]) {
        equals.push({ fromIndex: pivot.barIndex, toIndex: pivotIndex, fromPrice: pivot.current, toPrice: pivotCandle.high, high: true })
      }
      pivot.last = pivot.current
      pivot.current = pivotCandle.high
      pivot.crossed = false
      pivot.barIndex = pivotIndex
      if (kind === 'internal') {
        while (openHighs.length > 0 && openHighs[openHighs.length - 1].price <= pivot.current) openHighs.pop()
        openHighs.push({ price: pivot.current, barIndex: pivotIndex })
      }
      if (kind === 'swing') {
        trailing.top = pivot.current
        trailing.pivotIndex = pivot.barIndex
        trailing.topIndex = pivot.barIndex
      }
    }
  }

  function watchTrap(level: number, index: number, bullish: boolean) {
    if (pendingTraps.some((trap) => trap.level === level && trap.breakIndex === index)) return
    const candle = candles[index]
    pendingTraps.push({ level, breakIndex: index, extreme: bullish ? candle.low : candle.high, bullish })
  }

  function displayInternalStructure(index: number) {
    const candle = candles[index]
    const trend = internalTrend
    // One close can clear several stacked levels; label the highest (lowest) one, the most important.
    let brokenHigh: OpenLevel | null = null
    while (openHighs.length > 0 && candle.close > openHighs[openHighs.length - 1].price) brokenHigh = openHighs.pop()!
    if (brokenHigh && !(brokenHigh.price === swingHigh.current && brokenHigh.barIndex === swingHigh.barIndex)) {
      const tag = trend.bias === BEARISH ? 'CHoCH' : 'BOS'
      trend.bias = BULLISH
      structures.push({ fromIndex: brokenHigh.barIndex, toIndex: index, price: brokenHigh.price, tag, bullish: true, internal: true })
      watchTrap(brokenHigh.price, index, false)
    }

    let brokenLow: OpenLevel | null = null
    while (openLows.length > 0 && candle.close < openLows[openLows.length - 1].price) brokenLow = openLows.pop()!
    if (brokenLow && !(brokenLow.price === swingLow.current && brokenLow.barIndex === swingLow.barIndex)) {
      const tag = trend.bias === BULLISH ? 'CHoCH' : 'BOS'
      trend.bias = BEARISH
      structures.push({ fromIndex: brokenLow.barIndex, toIndex: index, price: brokenLow.price, tag, bullish: false, internal: true })
      watchTrap(brokenLow.price, index, true)
    }
  }

  function displaySwingStructure(index: number) {
    const internal = false
    const candle = candles[index]
    const previousClose = candles[index - 1].close
    const trend = swingTrend

    const highPivot = swingHigh
    if (candle.close > highPivot.current && previousClose <= highPivot.current && !highPivot.crossed) {
      const tag = trend.bias === BEARISH ? 'CHoCH' : 'BOS'
      highPivot.crossed = true
      trend.bias = BULLISH
      structures.push({ fromIndex: highPivot.barIndex, toIndex: index, price: highPivot.current, tag, bullish: true, internal })
      watchTrap(highPivot.current, index, false)
    }

    const lowPivot = swingLow
    if (candle.close < lowPivot.current && previousClose >= lowPivot.current && !lowPivot.crossed) {
      const tag = trend.bias === BULLISH ? 'CHoCH' : 'BOS'
      lowPivot.crossed = true
      trend.bias = BEARISH
      structures.push({ fromIndex: lowPivot.barIndex, toIndex: index, price: lowPivot.current, tag, bullish: false, internal })
      watchTrap(lowPivot.current, index, true)
    }
  }

  for (let index = 0; index < count; index += 1) {
    const candle = candles[index]
    // updateTrailingExtremes(): math.max(high, na) stays na until the first swing pivot.
    trailing.top = Math.max(candle.high, trailing.top)
    if (trailing.top === candle.high) trailing.topIndex = index
    trailing.bottom = Math.min(candle.low, trailing.bottom)
    if (trailing.bottom === candle.low) trailing.bottomIndex = index

    structureStep(swingLeg, options.swingLength, index, 'swing')
    structureStep(internalLeg, 5, index, 'internal')
    structureStep(equalLeg, options.equalLength, index, 'equal')

    if (index > 0) {
      displayInternalStructure(index)
      displaySwingStructure(index)
    }

    // Mitigate only the newly touched layer. Recording its first candle gives
    // the historical band a staircase edge instead of waiting for a full fill.
    // Process existing gaps before creating a gap from [i-2], [i-1], [i].
    if (openGaps.length > 0) {
      openGaps = openGaps.filter((gap) => {
        if (gap.bullish) {
          const nextTop = Math.max(gap.bottom, Math.min(gap.remainingTop, candle.low))
          if (nextTop < gap.remainingTop) {
            gap.refills.push({ index, top: gap.remainingTop, bottom: nextTop })
            gap.remainingTop = nextTop
          }
        } else {
          const nextBottom = Math.min(gap.top, Math.max(gap.remainingBottom, candle.high))
          if (nextBottom > gap.remainingBottom) {
            gap.refills.push({ index, top: nextBottom, bottom: gap.remainingBottom })
            gap.remainingBottom = nextBottom
          }
        }
        const filled = gap.remainingTop <= gap.remainingBottom
        if (filled) gap.endIndex = index
        return !filled
      })
    }
    if (index >= 1) {
      const middle = candles[index - 1]
      const barDeltaPercent = (middle.close - middle.open) / (middle.open * 100)
      deltaSum += Math.abs(barDeltaPercent)
      if (index >= 2) {
        const first = candles[index - 2]
        const threshold = options.fairValueGapAutoThreshold ? (deltaSum / index) * 2 : 0 // "Auto Threshold"
        let gap: SmcFairValueGap | null = null
        if (candle.low > first.high && middle.close > first.high && barDeltaPercent > threshold) {
          gap = { startIndex: index - 2, top: candle.low, bottom: first.high, remainingTop: candle.low, remainingBottom: first.high, refills: [], bullish: true, endIndex: null }
        } else if (candle.high < first.low && middle.close < first.low && -barDeltaPercent > threshold) {
          gap = { startIndex: index - 2, top: first.low, bottom: candle.high, remainingTop: first.low, remainingBottom: candle.high, refills: [], bullish: false, endIndex: null }
        }
        if (gap) {
          fairValueGaps.push(gap)
          openGaps.push(gap)
        }
      }
    }

    // A zone disappears once price has come back through all of it (the trapped side can get out).
    if (internalOrderBlocks.length > 0) {
      internalOrderBlocks = internalOrderBlocks.filter((block) => block.bullish ? !(candle.low <= block.bottom) : !(candle.high >= block.top))
    }

    // Failed breaks: a close back across the broken level within TRAP_REVERSAL_BARS candles makes a zone.
    if (pendingTraps.length > 0) {
      pendingTraps = pendingTraps.filter((trap) => {
        if (index === trap.breakIndex) return true
        if (trap.bullish) {
          trap.extreme = Math.min(trap.extreme, candle.low)
          if (candle.close > trap.level) {
            internalOrderBlocks.unshift({ startIndex: trap.breakIndex, top: trap.level, bottom: trap.extreme, bullish: true })
            return false
          }
        } else {
          trap.extreme = Math.max(trap.extreme, candle.high)
          if (candle.close < trap.level) {
            internalOrderBlocks.unshift({ startIndex: trap.breakIndex, top: trap.extreme, bottom: trap.level, bullish: false })
            return false
          }
        }
        return index - trap.breakIndex < TRAP_REVERSAL_BARS
      })
      if (internalOrderBlocks.length > 100) internalOrderBlocks.length = 100
    }
  }

  const finalTrailing: SmcTrailing | null = Number.isFinite(trailing.top) && Number.isFinite(trailing.bottom)
    ? { top: trailing.top, bottom: trailing.bottom, topIndex: trailing.topIndex, bottomIndex: trailing.bottomIndex, pivotIndex: trailing.pivotIndex }
    : null

  return {
    structures: structures.slice(-options.maxLines),
    equals: equals.slice(-options.maxLines),
    orderBlocks: internalOrderBlocks.slice(0, options.internalOrderBlocks),
    // Preserve the first fully filled candle separately; never use unrevealed bars.
    fairValueGaps: openGaps,
    filledFairValueGaps: fairValueGaps.filter(gap => gap.endIndex !== null),
    trailing: finalTrailing,
    swingBias: swingTrend.bias,
    lastIndex: count - 1,
  }
}

/* ------------------------------------------------------------------ */
/* Higher-timeframe fair value gaps on a lower-timeframe chart          */
/* ------------------------------------------------------------------ */

export interface SmcTimeframe {
  /** Short label drawn on the chart, e.g. "15m". */
  label: string
  seconds: number
}

/** Gap timeframes shown on intraday charts; only those longer than the chart's own bars are used. */
export const HIGHER_TIMEFRAME_GAPS: readonly SmcTimeframe[] = [
  { label: '15m', seconds: 15 * 60 },
  { label: '30m', seconds: 30 * 60 },
  { label: '1H', seconds: 60 * 60 },
]

export interface SmcTimeframeGap extends SmcFairValueGap {
  timeframe: string
  /**
   * Chart index of the chart candle that actually ran through the gap: inside the higher-timeframe middle candle,
   * the one covering most of the gap's price range (the earliest on a tie). The marker sits right of it.
   */
  anchorIndex: number
  /** Chart index of the last chart candle inside that middle candle (where the box ends). */
  anchorEndIndex: number
  /** Chart index of the last chart candle of the third higher-timeframe candle: the gap exists from here on. */
  createdIndex: number
}

/** Typical spacing of the chart's candles in seconds (median of the gaps between neighbours). */
export function chartBarSeconds(candles: readonly Candle[]): number {
  const steps: number[] = []
  for (let index = Math.max(1, candles.length - 200); index < candles.length; index += 1) {
    const step = candles[index].time - candles[index - 1].time
    if (step > 0) steps.push(step)
  }
  if (!steps.length) return 0
  steps.sort((a, b) => a - b)
  return steps[Math.floor(steps.length / 2)]
}

interface Bucket {
  open: number
  high: number
  low: number
  close: number
  first: number
  last: number
}

/**
 * Fair value gaps of a higher timeframe, built from the chart's own candles and expressed in chart indices.
 * A higher-timeframe candle only counts once it has closed (the next one has started, or the chart reached its
 * end time), so a replay never shows a gap before it really exists. Fills are tracked candle by candle on the chart.
 */
export function computeTimeframeGaps(candles: readonly Candle[], timeframe: SmcTimeframe, barSeconds = chartBarSeconds(candles)): SmcTimeframeGap[] {
  if (candles.length < 3 || barSeconds <= 0 || timeframe.seconds <= barSeconds) return []
  const size = timeframe.seconds
  const buckets: Bucket[] = []
  let currentKey = Number.NaN
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]
    const key = Math.floor(candle.time / size)
    const bucket = buckets[buckets.length - 1]
    if (key !== currentKey || !bucket) {
      currentKey = key
      buckets.push({ open: candle.open, high: candle.high, low: candle.low, close: candle.close, first: index, last: index })
    } else {
      bucket.high = Math.max(bucket.high, candle.high)
      bucket.low = Math.min(bucket.low, candle.low)
      bucket.close = candle.close
      bucket.last = index
    }
  }
  const lastCandle = candles[candles.length - 1]
  const lastClosed = Math.floor(lastCandle.time / size) * size + size <= lastCandle.time + barSeconds
  const closedCount = lastClosed ? buckets.length : buckets.length - 1

  const gaps: SmcTimeframeGap[] = []
  for (let index = 2; index < closedCount; index += 1) {
    const first = buckets[index - 2]
    const middle = buckets[index - 1]
    const third = buckets[index]
    let top: number, bottom: number, bullish: boolean
    if (third.low > first.high && middle.close > first.high) {
      top = third.low; bottom = first.high; bullish = true
    } else if (third.high < first.low && middle.close < first.low) {
      top = first.low; bottom = third.high; bullish = false
    } else continue
    // Price only crossed the gap during the middle candle (the first and third stay outside it).
    let anchor = middle.first
    let bestOverlap = -1
    for (let chartIndex = middle.first; chartIndex <= middle.last; chartIndex += 1) {
      const overlap = Math.min(top, candles[chartIndex].high) - Math.max(bottom, candles[chartIndex].low)
      if (overlap > bestOverlap) { bestOverlap = overlap; anchor = chartIndex }
    }
    gaps.push({ timeframe: timeframe.label, startIndex: anchor - 1, anchorIndex: anchor, anchorEndIndex: middle.last, createdIndex: third.last, refills: [], endIndex: null, top, bottom, remainingTop: top, remainingBottom: bottom, bullish })
  }

  // Same layered mitigation as the chart's own gaps, starting with the candle after the gap was confirmed.
  for (const gap of gaps) {
    for (let index = gap.createdIndex + 1; index < candles.length; index += 1) {
      const candle = candles[index]
      if (gap.bullish) {
        const nextTop = Math.max(gap.bottom, Math.min(gap.remainingTop, candle.low))
        if (nextTop < gap.remainingTop) {
          gap.refills.push({ index, top: gap.remainingTop, bottom: nextTop })
          gap.remainingTop = nextTop
        }
      } else {
        const nextBottom = Math.min(gap.top, Math.max(gap.remainingBottom, candle.high))
        if (nextBottom > gap.remainingBottom) {
          gap.refills.push({ index, top: nextBottom, bottom: gap.remainingBottom })
          gap.remainingBottom = nextBottom
        }
      }
      if (gap.remainingTop <= gap.remainingBottom) {
        gap.endIndex = index
        break
      }
    }
  }
  return gaps
}

/** Higher-timeframe gaps for every timeframe longer than the chart's candles. */
export function computeHigherTimeframeGaps(candles: readonly Candle[], timeframes: readonly SmcTimeframe[] = HIGHER_TIMEFRAME_GAPS): SmcTimeframeGap[] {
  const barSeconds = chartBarSeconds(candles)
  return timeframes.flatMap((timeframe) => computeTimeframeGaps(candles, timeframe, barSeconds))
}

/** One marker on the chart: every unfilled gap (any timeframe) of one direction that shares a price area. */
export interface SmcGapZone {
  bullish: boolean
  /** Chart candle the marker sits next to: the earliest candle among the merged gaps. */
  anchorIndex: number
  top: number
  bottom: number
  /** Price layers from top to bottom; `count` is how many gaps cover that layer (more = deeper colour). */
  layers: { top: number; bottom: number; count: number }[]
}

/**
 * Merges unfilled gaps whose remaining price ranges overlap (same direction, formed within `maxBarsApart` chart
 * candles of each other) into single zones, so one price area gets one marker instead of several side by side.
 */
export function mergeGapZones(gaps: readonly { gap: SmcFairValueGap; anchorIndex: number }[], maxBarsApart: number): SmcGapZone[] {
  const open = gaps.filter(({ gap }) => gap.endIndex === null && gap.remainingTop > gap.remainingBottom)
  const parent = open.map((_, index) => index)
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]))
  for (let i = 0; i < open.length; i += 1) {
    for (let j = i + 1; j < open.length; j += 1) {
      const a = open[i], b = open[j]
      if (a.gap.bullish !== b.gap.bullish || Math.abs(a.anchorIndex - b.anchorIndex) > maxBarsApart) continue
      if (Math.min(a.gap.remainingTop, b.gap.remainingTop) >= Math.max(a.gap.remainingBottom, b.gap.remainingBottom)) parent[find(i)] = find(j)
    }
  }
  const groups = new Map<number, typeof open>()
  open.forEach((item, index) => {
    const root = find(index)
    const group = groups.get(root)
    if (group) group.push(item); else groups.set(root, [item])
  })
  const zones: SmcGapZone[] = []
  for (const group of groups.values()) {
    const prices = [...new Set(group.flatMap(({ gap }) => [gap.remainingTop, gap.remainingBottom]))].sort((a, b) => b - a)
    const layers: SmcGapZone['layers'] = []
    for (let index = 0; index + 1 < prices.length; index += 1) {
      const top = prices[index], bottom = prices[index + 1]
      const count = group.filter(({ gap }) => gap.remainingTop >= top && gap.remainingBottom <= bottom).length
      if (count > 0) layers.push({ top, bottom, count })
    }
    zones.push({
      bullish: group[0].gap.bullish,
      anchorIndex: Math.min(...group.map((item) => item.anchorIndex)),
      top: prices[0],
      bottom: prices[prices.length - 1],
      layers,
    })
  }
  return zones.sort((a, b) => a.anchorIndex - b.anchorIndex)
}
