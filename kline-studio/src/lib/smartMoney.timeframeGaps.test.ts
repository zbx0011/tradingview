import { describe, expect, it } from 'vitest'
import type { Candle } from './market'
import { computeHigherTimeframeGaps, computeTimeframeGaps } from './smartMoney'

const START = 1_700_000_100 - (1_700_000_100 % 3600) // aligned to the hour
const bar = (index: number, open: number, high: number, low: number, close: number): Candle =>
  ({ time: START + index * 300, open, high, low, close, volume: 1 } as Candle)

// Three 15m candles (three 5m bars each): base around 100, a rally, then a third candle that stays above 105.
const FIFTEEN_MINUTE_GAP: Candle[] = [
  bar(0, 100, 101, 99, 100), bar(1, 100, 101, 99, 100.5), bar(2, 100.5, 101, 99.5, 101),
  bar(3, 101, 104, 101, 104), bar(4, 104, 108, 104, 108), bar(5, 108, 110, 107, 110),
  bar(6, 110, 112, 106, 111), bar(7, 111, 112, 105, 106), bar(8, 106, 109, 105.5, 108),
  bar(9, 108, 108.5, 103, 104), bar(10, 104, 104.5, 100, 101), bar(11, 101, 102, 100, 101.5),
]

describe('higher-timeframe fair value gaps', () => {
  it('finds a 15m gap on 5m candles, anchored at the middle 15m candle', () => {
    const [gap] = computeTimeframeGaps(FIFTEEN_MINUTE_GAP.slice(0, 9), { label: '15m', seconds: 900 })
    expect(gap).toMatchObject({ timeframe: '15m', bullish: true, top: 105, bottom: 101, anchorIndex: 3, createdIndex: 8, endIndex: null })
  })

  it('marks the 5m candle that actually ran through the gap, not just the first one of the middle candle', () => {
    const candles = FIFTEEN_MINUTE_GAP.slice(0, 9).map((c, index) => index === 3 ? bar(3, 101, 101.5, 100.5, 101) : index === 4 ? bar(4, 101, 108, 101, 108) : c)
    expect(computeTimeframeGaps(candles, { label: '15m', seconds: 900 })[0]).toMatchObject({ top: 105, bottom: 101, anchorIndex: 4 })
  })

  it('waits for the third 15m candle to close before the gap exists', () => {
    expect(computeTimeframeGaps(FIFTEEN_MINUTE_GAP.slice(0, 8), { label: '15m', seconds: 900 })).toEqual([])
  })

  it('shrinks the gap candle by candle and ends it when fully filled', () => {
    const [gap] = computeTimeframeGaps(FIFTEEN_MINUTE_GAP, { label: '15m', seconds: 900 })
    expect(gap.refills).toEqual([{ index: 9, top: 105, bottom: 103 }, { index: 10, top: 103, bottom: 101 }])
    expect(gap.endIndex).toBe(10)
  })

  it('mirrors bearish gaps', () => {
    const [gap] = computeTimeframeGaps(FIFTEEN_MINUTE_GAP.slice(0, 9).map((c) => ({ ...c, open: 200 - c.open, close: 200 - c.close, high: 200 - c.low, low: 200 - c.high })), { label: '15m', seconds: 900 })
    expect(gap).toMatchObject({ bullish: false, top: 99, bottom: 95, anchorIndex: 3 })
  })

  it('skips timeframes that are not longer than the chart candles', () => {
    const fifteenMinuteBars = FIFTEEN_MINUTE_GAP.map((c, index) => ({ ...c, time: START + index * 900 }))
    expect(computeHigherTimeframeGaps(fifteenMinuteBars).every((gap) => gap.timeframe !== '15m')).toBe(true)
  })
})
