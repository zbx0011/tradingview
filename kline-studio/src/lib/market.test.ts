import { describe, expect, it } from 'vitest'
import { aggregateCandles, generateCandles } from './market'

describe('market data', () => {
  it('generates deterministic valid OHLCV candles', () => {
    const first = generateCandles('XAUUSD', '5m', 12)
    const second = generateCandles('XAUUSD', '5m', 12)
    expect(first).toEqual(second)
    expect(first).toHaveLength(12)
    for (const candle of first) {
      expect(candle.high).toBeGreaterThanOrEqual(Math.max(candle.open, candle.close))
      expect(candle.low).toBeLessThanOrEqual(Math.min(candle.open, candle.close))
      expect(candle.volume).toBeGreaterThan(0)
    }
  })

  it('aggregates open, high, low, close and volume by bucket', () => {
    const source = [
      { time: 60, open: 10, high: 14, low: 9, close: 12, volume: 5 },
      { time: 120, open: 12, high: 16, low: 11, close: 15, volume: 7 },
      { time: 300, open: 15, high: 18, low: 13, close: 14, volume: 4 },
    ]
    expect(aggregateCandles(source, 300)).toEqual([
      { time: 0, open: 10, high: 16, low: 9, close: 15, volume: 12 },
      { time: 300, open: 15, high: 18, low: 13, close: 14, volume: 4 },
    ])
  })

  it('supports the TradingView-style two-hour interval', () => {
    const candles = generateCandles('XAUUSD', '2h', 3)
    expect(candles[1].time - candles[0].time).toBe(7200)
    expect(candles[2].time - candles[1].time).toBe(7200)
  })
})
