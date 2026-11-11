import { describe, expect, it } from 'vitest'
import { mergeGapZones, type SmcFairValueGap } from './smartMoney'

const gap = (top: number, bottom: number, bullish = false, endIndex: number | null = null): SmcFairValueGap =>
  ({ startIndex: 0, top, bottom, remainingTop: top, remainingBottom: bottom, refills: [], bullish, endIndex })

describe('merged gap zones', () => {
  it('joins gaps that share a price area into one marker at the earliest candle, counting the overlap', () => {
    const zones = mergeGapZones([{ gap: gap(110, 100), anchorIndex: 10 }, { gap: gap(108, 104), anchorIndex: 13 }], 36)
    expect(zones).toEqual([{ bullish: false, anchorIndex: 10, top: 110, bottom: 100, layers: [
      { top: 110, bottom: 108, count: 1 }, { top: 108, bottom: 104, count: 2 }, { top: 104, bottom: 100, count: 1 },
    ] }])
  })

  it('keeps gaps apart when they differ in direction, price area or are far apart in time', () => {
    expect(mergeGapZones([{ gap: gap(110, 100), anchorIndex: 10 }, { gap: gap(108, 104, true), anchorIndex: 11 }], 36)).toHaveLength(2)
    expect(mergeGapZones([{ gap: gap(110, 100), anchorIndex: 10 }, { gap: gap(98, 95), anchorIndex: 11 }], 36)).toHaveLength(2)
    expect(mergeGapZones([{ gap: gap(110, 100), anchorIndex: 10 }, { gap: gap(108, 104), anchorIndex: 90 }], 36)).toHaveLength(2)
  })

  it('ignores filled gaps', () => {
    expect(mergeGapZones([{ gap: gap(110, 100, false, 20), anchorIndex: 10 }], 36)).toEqual([])
  })
})
