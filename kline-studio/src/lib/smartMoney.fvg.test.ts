import { describe, expect, it } from 'vitest'
import { computeSmartMoney } from './smartMoney'
import type { Candle } from './market'

const bar = (index: number, open: number, high: number, low: number, close: number): Candle => ({
  time: 1_700_000_000 + index * 60, open, high, low, close, volume: 1,
} as Candle)

// Quiet candles first so the script's "Auto Threshold" (twice the average body) stays small.
const quiet = Array.from({ length: 20 }, (_, index) => bar(index, 100, 100.5, 99.5, 100))

describe('smart money fair value gaps (LuxAlgo logic)', () => {
  it.each([false, true])('records each newly penetrated layer once and closes on exact far-boundary touch (bearish=%s)', bearish => {
    let candles = [...quiet,
      bar(20, 100, 101, 99, 100), bar(21, 100, 110, 100, 109),
      bar(22, 109, 112, 107, 111), // bullish gap 101..107
      bar(23, 111, 112, 107, 109), // near-boundary touch is not a layer
      bar(24, 109, 110, 105, 106), // first layer: 105..107
      bar(25, 106, 110, 106, 109), // shallower retest
      bar(26, 109, 110, 103, 104), // second layer: 103..105
      bar(27, 104, 108, 103, 107), // equal-depth retest
      bar(28, 107, 108, 101, 102), // exact far-boundary touch closes it
      bar(29, 102, 103, 99, 100), // never changes an already filled gap
    ]
    if (bearish) candles = candles.map(c => ({ ...c, open: 200 - c.open, close: 200 - c.close, high: 200 - c.low, low: 200 - c.high }))
    const allLayers = [
      { index: 24, top: 107, bottom: 105 },
      { index: 26, top: 105, bottom: 103 },
      { index: 28, top: 103, bottom: 101 },
    ].map(layer => bearish ? { index: layer.index, top: 200 - layer.bottom, bottom: 200 - layer.top } : layer)
    for (let length = 23; length <= candles.length; length += 1) {
      const result = computeSmartMoney(candles.slice(0, length))
      const open = result.fairValueGaps.filter(g => g.startIndex === 20)
      const filled = result.filledFairValueGaps.filter(g => g.startIndex === 20)
      const closed = length > 28
      expect(open).toHaveLength(closed ? 0 : 1)
      expect(filled).toHaveLength(closed ? 1 : 0)
      const gap = (closed ? filled : open)[0]
      const depth = length > 28 ? 101 : length > 26 ? 103 : length > 24 ? 105 : 107
      expect(gap).toMatchObject({
        bullish: !bearish,
        top: bearish ? 99 : 107,
        bottom: bearish ? 93 : 101,
        remainingTop: bearish ? 99 : depth,
        remainingBottom: bearish ? 200 - depth : 101,
        endIndex: closed ? 28 : null,
        refills: allLayers.filter(layer => layer.index < length),
      })
      expect(gap.refills).toHaveLength(allLayers.filter(layer => layer.index < length).length)
    }
    // Independent prefix recomputations must not mutate previously returned gap state.
    const before = computeSmartMoney(candles.slice(0, 25))
    const snapshot = JSON.stringify(before)
    computeSmartMoney(candles)
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it('records only the first full refill and exposes it only after that candle is revealed', () => {
    const candles = [...quiet,
      bar(20, 100, 101, 99, 100), bar(21, 100, 106, 100, 105),
      bar(22, 105, 108, 103, 107), bar(23, 107, 108, 102, 103),
      bar(24, 103, 104, 100, 101), bar(25, 101, 102, 98, 99),
    ]
    expect(computeSmartMoney(candles.slice(0, 24)).filledFairValueGaps.some(g => g.startIndex === 20)).toBe(false)
    const fills = computeSmartMoney(candles).filledFairValueGaps.filter(g => g.startIndex === 20)
    expect(fills).toHaveLength(1)
    expect(fills[0]).toMatchObject({ top: 103, bottom: 101, bullish: true, endIndex: 24, remainingTop: 101, remainingBottom: 101 })
    expect(fills[0].refills).toEqual([{ index: 23, top: 103, bottom: 102 }, { index: 24, top: 102, bottom: 101 }])
    const inverted = candles.map(c => ({ ...c, open: 200 - c.open, close: 200 - c.close, high: 200 - c.low, low: 200 - c.high }))
    expect(computeSmartMoney(inverted).filledFairValueGaps.find(g => g.startIndex === 20)).toMatchObject({ bullish: false, endIndex: 24 })
  })
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
