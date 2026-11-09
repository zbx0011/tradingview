import { describe, expect, it } from 'vitest'
import type { Candle } from './market'
import { computeSmartMoney } from './smartMoney'

function series(closes: number[], lows: Record<number, number> = {}, highs: Record<number, number> = {}): Candle[] {
  return closes.map((close, index) => {
    const open = index ? closes[index - 1] : close
    return { time: index * 300, open, close, high: highs[index] ?? Math.max(open, close) + 0.5, low: lows[index] ?? Math.min(open, close) - 0.5 } as Candle
  })
}

const FALSE_BREAK_DOWN = [110, 108, 106, 104, 102, 100, 103, 105, 107, 109, 111, 110, 109, 108, 107, 106, 105, 104, 103, 98, 101, 104, 106, 108, 110, 112, 114, 116, 118, 120]

describe('trapped-trader zones', () => {
  it('marks the band below a broken low when the next candle closes back above it', () => {
    const result = computeSmartMoney(series(FALSE_BREAK_DOWN, { 19: 96 }))
    const broken = result.structures.find((structure) => !structure.bullish && structure.toIndex === 19)!
    expect(broken).toBeTruthy()
    expect(result.orderBlocks).toEqual([{ startIndex: 19, top: broken.price, bottom: 96, bullish: true }])
  })

  it('removes the band once price comes back down through all of it', () => {
    const closes = [...FALSE_BREAK_DOWN, 110, 100, 96, 99]
    expect(computeSmartMoney(series(closes, { 19: 96 })).orderBlocks).toEqual([])
  })

  it('does not mark a break that keeps going', () => {
    const closes = [...FALSE_BREAK_DOWN.slice(0, 19), 98, 97, 96, 95, 94, 93]
    expect(computeSmartMoney(series(closes)).orderBlocks.filter((block) => block.bullish)).toEqual([])
  })

  it('marks the band above a broken high when price closes back below it', () => {
    const mirrored = FALSE_BREAK_DOWN.map((close) => 220 - close)
    const result = computeSmartMoney(series(mirrored, {}, { 19: 124 }))
    const broken = result.structures.find((structure) => structure.bullish && structure.toIndex === 19)!
    expect(result.orderBlocks).toEqual([{ startIndex: 19, top: 124, bottom: broken.price, bullish: false }])
  })
})
