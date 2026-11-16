import type { Candle } from './market'

/**
 * 高1/2/3、低1/2/3（阿布 Al Brooks 数K线；Z 的 M2B/M2S 就是均线处的高2/低2）。
 *
 * 低（L）在每一段"上涨或反弹"里数，这一段从它自己的波段低点算起：
 * - 低1 = 这段上涨里，第一根低点低于前一根低点的K线（卖出停止单在前一根低点下方触发）；
 * - 再涨一腿（有K线高于低n那根的高点）之后，下一根低点低于前一根低点的K线 = 低(n+1)；
 * - 跌破这段上涨的起点：上涨结束，从新低重新开始；
 * - 从这段上涨的最高点回落了 `resetAtr` 个 ATR 以上（卖点已经走出来了）：这段上涨结束，
 *   之后从回落的低点开始算新的一段上涨，从 低1 重新数。
 * 高（H）完全对称：在每一段"下跌或回调"里，高点高于前一根高点的K线是高1，再跌一腿后的下一根是高2……
 * 创出这段下跌的新低之外的新高就重新开始；从最低点反弹 `resetAtr` 个 ATR 以上，就算新的一段下跌。
 */
export interface BarCountOptions {
  atrPeriod: number
  /** 反向走出多少个 ATR，就算这一段上涨（下跌）结束、下一段从 1 重新数。 */
  resetAtr: number
  /** 标到几（默认 3：高1–高3、低1–低3）。 */
  maxCount: number
  maxHistoryBars: number
}

export const DEFAULT_BAR_COUNT_OPTIONS: BarCountOptions = {
  atrPeriod: 20,
  resetAtr: 2,
  maxCount: 3,
  maxHistoryBars: 20000,
}

export interface BarCountMark {
  /** 'H' = 高n（回调里的买点），'L' = 低n（反弹里的卖点）。 */
  kind: 'H' | 'L'
  count: number
  /** 触发的那根K线（高点超过前一根高点 / 低点跌破前一根低点）。 */
  index: number
  time: number
  /** 前一根（信号K）的高点 / 低点：停止单的触发价。 */
  entry: number
  /** 计数所在这一段的起点和极值（高：这段下跌的起点高点、最低点；低：这段上涨的起点低点、最高点）。 */
  legStart: number
  legExtreme: number
}

function atrValues(candles: readonly Candle[], period: number) {
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

export function detectBarCounts(candles: readonly Candle[], overrides: Partial<BarCountOptions> = {}): BarCountMark[] {
  const options = { ...DEFAULT_BAR_COUNT_OPTIONS, ...overrides }
  const start = Math.max(0, candles.length - options.maxHistoryBars)
  const bars = candles.slice(start)
  if (bars.length < 3) return []
  const atr = atrValues(bars, Math.max(1, Math.floor(options.atrPeriod)))
  const marks: BarCountMark[] = []
  for (const kind of ['H', 'L'] as const) {
    const sign = kind === 'H' ? 1 : -1
    // 在"高"的方向里算：低的计数把价格取负，上涨就变成下跌，低点低于前一根就变成高点高于前一根。
    const high = (i: number) => sign > 0 ? bars[i].high : -bars[i].low
    const low = (i: number) => sign > 0 ? bars[i].low : -bars[i].high
    /** 这一段下跌（低的计数里：这一段上涨）的起点，和它目前走到的极值。 */
    let top = high(0), bottom = low(0)
    let count = 0, pulledBack = false, waitingForLeg = false, lastCountLow = 0
    const restart = (i: number) => {
      top = high(i); bottom = low(i)
      count = 0; pulledBack = false; waitingForLeg = false
    }
    for (let i = 1; i < bars.length; i += 1) {
      const h = high(i), l = low(i), previousHigh = high(i - 1)
      if (l < bottom) bottom = l
      if (waitingForLeg && l < lastCountLow) {
        // 又走了一腿：下一根突破前一根的K线就是下一个计数。
        waitingForLeg = false
      } else if (pulledBack && !waitingForLeg && h > previousHigh) {
        count += 1
        if (count <= options.maxCount) {
          marks.push({ kind, count, index: start + i, time: bars[i].time, entry: sign * previousHigh, legStart: sign * top, legExtreme: sign * bottom })
        }
        waitingForLeg = true; lastCountLow = l
      }
      // 超过这一段的起点：这一段结束，从这根K线重新开始（这根K线本身如果正好触发了计数，上面已经标上）。
      if (h > top) { restart(i); continue }
      if (h <= previousHigh) pulledBack = true
      // 反向走出 resetAtr 个 ATR：这一段结束，下一段从这根K线开始重新数。
      if (h - bottom >= options.resetAtr * atr[i]) restart(i)
    }
  }
  return marks.sort((a, b) => a.index - b.index || (a.kind === 'H' ? -1 : 1))
}
