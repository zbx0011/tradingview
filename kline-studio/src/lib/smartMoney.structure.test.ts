import { describe, expect, it } from 'vitest'
import type { Candle } from './market'
import { computeSmartMoney } from './smartMoney'

function series(closes: number[]): Candle[] {
  return closes.map((close, index) => {
    const open = index ? closes[index - 1] : close
    return { time: index * 300, open, close, high: Math.max(open, close) + 0.5, low: Math.min(open, close) - 0.5 } as Candle
  })
}

// Rally to a major high (130), pull back, a smaller lower high (118), dip, then rally through both.
const MAJOR_HIGH_RETEST = [
  100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120, 122, 124, 126, 128, 130,
  127, 124, 121, 118, 115, 112, 110, 108, 106,
  109, 112, 115, 118, 115, 112, 109, 106, 104, 102,
  105, 108, 111, 114, 117, 120, 123, 126, 129, 132, 134, 136, 138, 140,
]

describe('internal structure breaks', () => {
  it('still marks the break of an older major high after a smaller high formed below it', () => {
    const structures = computeSmartMoney(series(MAJOR_HIGH_RETEST)).structures.filter((item) => item.bullish && item.internal)
    expect(structures.some((item) => item.price === 118.5 && item.fromIndex === 29)).toBe(true)
    const major = structures.find((item) => item.price === 130.5)
    expect(major).toMatchObject({ fromIndex: 16, toIndex: 44, tag: 'BOS' })
  })

  it('labels only the highest level when one close clears several', () => {
    const closes = [...MAJOR_HIGH_RETEST.slice(0, 35), 140, 141, 142, 143, 144, 145, 146]
    const structures = computeSmartMoney(series(closes)).structures.filter((item) => item.bullish && item.toIndex === 35)
    expect(structures.map((item) => item.price)).toEqual([130.5])
  })

  it('mirrors the rule for an older major low', () => {
    const structures = computeSmartMoney(series(MAJOR_HIGH_RETEST.map((close) => 240 - close))).structures.filter((item) => !item.bullish && item.internal)
    expect(structures.find((item) => item.price === 109.5)).toMatchObject({ fromIndex: 16, toIndex: 44, tag: 'BOS' })
  })
})
