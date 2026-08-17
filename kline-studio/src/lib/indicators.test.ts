import { describe, expect, it } from 'vitest'
import { bollinger, ema, sma, volumeSma } from './indicators'
import type { Candle } from './market'

const candles: Candle[] = [1, 2, 3, 4, 5].map((close, index) => ({ time: index, open: close, high: close, low: close, close, volume: close * 10 }))

describe('indicators', () => {
  it('calculates SMA and volume SMA', () => {
    expect(sma(candles, 3).map((item) => item.value)).toEqual([2, 3, 4])
    expect(volumeSma(candles, 2).map((item) => item.value)).toEqual([15, 25, 35, 45])
  })

  it('calculates EMA using the conventional multiplier', () => {
    expect(ema(candles, 3).map((item) => item.value)).toEqual([1, 1.5, 2.25, 3.125, 4.0625])
  })

  it('calculates Bollinger bands', () => {
    const values = bollinger(candles, 3, 2)
    expect(values).toHaveLength(3)
    expect(values[0].middle).toBe(2)
    expect(values[0].upper).toBeGreaterThan(2)
    expect(values[0].lower).toBeLessThan(2)
  })
})
