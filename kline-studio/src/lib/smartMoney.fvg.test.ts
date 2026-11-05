import { describe, expect, it } from 'vitest'
import { computeSmartMoney } from './smartMoney'
import type { Candle } from './market'

const bar = (index: number, open: number, high: number, low: number, close: number): Candle => ({
  time: 1_700_000_000 + index * 60, open, high, low, close, volume: 1,
} as Candle)

// Quiet candles first so the script's "Auto Threshold" (twice the average body) stays small.
const quiet = Array.from({ length: 20 }, (_, index) => bar(index, 100, 100.5, 99.5, 100))

describe('smart money fair value gaps (LuxAlgo logic)', () => {
  it('keeps only gaps that price has not filled yet', () => {
    const candles = [
      ...quiet,
      bar(20, 100, 101, 99, 100),
      bar(21, 100, 106, 100, 105), // strong candle closing above candle 20 high
      bar(22, 105, 108, 103, 107), // low 103 > high 101 -> bullish gap 101..103
      bar(23, 107, 109, 105, 108),
      bar(24, 108, 108, 100, 101), // low 100 < 101 -> fills the bullish gap
      bar(25, 101, 101, 95, 96),
      bar(26, 96, 97, 93, 94), // high 97 < candle 24 low 100 -> bearish gap 97..100
    ]
    const gaps = computeSmartMoney(candles).fairValueGaps
    expect(gaps.some((gap) => gap.bullish && gap.startIndex === 20)).toBe(false)
    expect(gaps.find((gap) => !gap.bullish && gap.startIndex === 24)).toMatchObject({ bottom: 97, top: 100 })
  })

  it('keeps a bullish gap while price stays above it', () => {
    const candles = [
      ...quiet,
      bar(20, 100, 101, 99, 100),
      bar(21, 100, 106, 100, 105),
      bar(22, 105, 108, 103, 107),
      bar(23, 107, 110, 106, 109),
    ]
    const gap = computeSmartMoney(candles).fairValueGaps.find((item) => item.bullish && item.startIndex === 20)
    expect(gap).toMatchObject({ bottom: 101, top: 103 })
  })

  it('can hide gaps whose middle candle is smaller than the auto threshold', () => {
    const candles = [
      ...Array.from({ length: 20 }, (_, index) => bar(index, 100, 110, 90, index % 2 === 0 ? 108 : 92)),
      bar(20, 100, 101, 99, 100),
      bar(21, 100, 101.4, 100, 101.2), // tiny body
      bar(22, 101.2, 103, 101.1, 102),
    ]
    expect(computeSmartMoney(candles, { fairValueGapAutoThreshold: true }).fairValueGaps.some((gap) => gap.startIndex === 20)).toBe(false)
    expect(computeSmartMoney(candles).fairValueGaps.some((gap) => gap.startIndex === 20)).toBe(true)
  })

  it('ignores overlapping candles', () => {
    const candles = [...quiet, bar(20, 100, 102, 99, 101), bar(21, 101, 104, 100, 103), bar(22, 103, 105, 101, 104)]
    expect(computeSmartMoney(candles).fairValueGaps.length).toBe(0)
  })
})
