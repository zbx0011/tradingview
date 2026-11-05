// Smart Money Concepts (market structure) calculation.
//
// This is a TypeScript port of the "Smart Money Concepts [LuxAlgo]" Pine script
// (© LuxAlgo, licensed under CC BY-NC-SA 4.0 — https://creativecommons.org/licenses/by-nc-sa/4.0/).
// The port keeps the original defaults: Historical mode, Colored style, internal
// + swing structure, internal order blocks, EQH/EQL, strong/weak high & low and
// premium/discount zones. Fair value gaps follow the script's detection logic; filled
// gaps retain each first-filled price layer for stepped historical refill bands. MTF levels and
// swing order blocks, off by default in the script, are not ported.
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
  internalBearishOrderBlock: 'rgba(247, 124, 128, 0.2)',
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
  /** How many unmitigated internal order blocks are kept for drawing. */
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
  internalOrderBlocks: 5,
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

export interface SmcOrderBlock {
  startIndex: number
  top: number
  bottom: number
  bullish: boolean
}

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

  const parsedHighs = new Float64Array(count)
  const parsedLows = new Float64Array(count)

  const swingHigh = newPivot()
  const swingLow = newPivot()
  const internalHigh = newPivot()
  const internalLow = newPivot()
  const equalHigh = newPivot()
  const equalLow = newPivot()
  const swingTrend = { bias: 0 }
  const internalTrend = { bias: 0 }
  const trailing = {
    top: Number.NaN, bottom: Number.NaN, topIndex: 0, bottomIndex: 0, pivotIndex: 0, seen: false,
  }

  const swingLeg: LegState = { leg: 0, previous: null }
  const internalLeg: LegState = { leg: 0, previous: null }
  const equalLeg: LegState = { leg: 0, previous: null }

  const structures: SmcStructure[] = []
  const equals: SmcEqual[] = []
  let internalOrderBlocks: SmcOrderBlock[] = []
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
      if (kind === 'swing') {
        trailing.top = pivot.current
        trailing.pivotIndex = pivot.barIndex
        trailing.topIndex = pivot.barIndex
      }
    }
  }

  function storeOrderBlock(pivot: Pivot, bias: number, index: number) {
    if (index <= pivot.barIndex) return
    let best = pivot.barIndex
    if (bias === BEARISH) {
      for (let cursor = pivot.barIndex; cursor < index; cursor += 1) if (parsedHighs[cursor] > parsedHighs[best]) best = cursor
    } else {
      for (let cursor = pivot.barIndex; cursor < index; cursor += 1) if (parsedLows[cursor] < parsedLows[best]) best = cursor
    }
    if (internalOrderBlocks.length >= 100) internalOrderBlocks.pop()
    internalOrderBlocks.unshift({ startIndex: best, top: parsedHighs[best], bottom: parsedLows[best], bullish: bias === BULLISH })
  }

  function displayStructure(internal: boolean, index: number) {
    const candle = candles[index]
    const previousClose = candles[index - 1].close
    const trend = internal ? internalTrend : swingTrend

    const highPivot = internal ? internalHigh : swingHigh
    const bullishExtra = internal ? internalHigh.current !== swingHigh.current : true
    if (candle.close > highPivot.current && previousClose <= highPivot.current && !highPivot.crossed && bullishExtra) {
      const tag = trend.bias === BEARISH ? 'CHoCH' : 'BOS'
      highPivot.crossed = true
      trend.bias = BULLISH
      structures.push({ fromIndex: highPivot.barIndex, toIndex: index, price: highPivot.current, tag, bullish: true, internal })
      if (internal) storeOrderBlock(highPivot, BULLISH, index)
    }

    const lowPivot = internal ? internalLow : swingLow
    const bearishExtra = internal ? internalLow.current !== swingLow.current : true
    if (candle.close < lowPivot.current && previousClose >= lowPivot.current && !lowPivot.crossed && bearishExtra) {
      const tag = trend.bias === BULLISH ? 'CHoCH' : 'BOS'
      lowPivot.crossed = true
      trend.bias = BEARISH
      structures.push({ fromIndex: lowPivot.barIndex, toIndex: index, price: lowPivot.current, tag, bullish: false, internal })
      if (internal) storeOrderBlock(lowPivot, BEARISH, index)
    }
  }

  for (let index = 0; index < count; index += 1) {
    const candle = candles[index]
    const highVolatility = candle.high - candle.low >= 2 * atr[index]
    parsedHighs[index] = highVolatility ? candle.low : candle.high
    parsedLows[index] = highVolatility ? candle.high : candle.low

    // updateTrailingExtremes(): math.max(high, na) stays na until the first swing pivot.
    trailing.top = Math.max(candle.high, trailing.top)
    if (trailing.top === candle.high) trailing.topIndex = index
    trailing.bottom = Math.min(candle.low, trailing.bottom)
    if (trailing.bottom === candle.low) trailing.bottomIndex = index

    structureStep(swingLeg, options.swingLength, index, 'swing')
    structureStep(internalLeg, 5, index, 'internal')
    structureStep(equalLeg, options.equalLength, index, 'equal')

    if (index > 0) {
      displayStructure(true, index)
      displayStructure(false, index)
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

    // deleteOrderBlocks(): mitigated order blocks disappear.
    if (internalOrderBlocks.length > 0) {
      internalOrderBlocks = internalOrderBlocks.filter((block) => block.bullish ? !(candle.low < block.bottom) : !(candle.high > block.top))
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
