import { describe, expect, it } from 'vitest'
import { calculateChartMeasurement, formatMeasurementDuration, formatMeasurementVolume, formatSignedMeasurement } from './measurement'
import type { Candle } from './market'

const candles: Candle[] = Array.from({ length: 4 }, (_, index) => ({
  time: 1_800_000_000 + index * 300,
  open: 4300 + index,
  high: 4302 + index,
  low: 4299 + index,
  close: 4301 + index,
  volume: 1000 * (index + 1),
}))

describe('TradingView-style chart measurement', () => {
  it('calculates real price, time, bar and volume values', () => {
    expect(calculateChartMeasurement(
      { time: candles[0].time, price: 4300 },
      { time: candles[3].time, price: 4260 },
      candles,
      'XAUUSD',
    )).toMatchObject({
      priceChange: -40,
      ticks: -4000,
      bars: 4,
      durationSeconds: 900,
      volume: 10_000,
      direction: 'down',
    })
  })

  it('calculates measurement data in chart whitespace without requiring candles', () => {
    const afterLastCandle = candles.at(-1)!.time + 300
    expect(calculateChartMeasurement(
      { time: afterLastCandle, price: 4300 },
      { time: afterLastCandle + 900, price: 4280 },
      candles,
      'XAUUSD',
    )).toMatchObject({
      startTime: afterLastCandle,
      endTime: afterLastCandle + 900,
      priceChange: -20,
      ticks: -2000,
      bars: 4,
      durationSeconds: 900,
      volume: 0,
    })

    expect(calculateChartMeasurement(
      { time: candles[0].time - 900, price: 4300 },
      { time: candles[0].time - 300, price: 4280 },
      candles,
      'XAUUSD',
    )).toMatchObject({ bars: 3, durationSeconds: 600, volume: 0 })
  })

  it('keeps real volume when a whitespace measurement overlaps candle data', () => {
    expect(calculateChartMeasurement(
      { time: candles[0].time - 300, price: 4300 },
      { time: candles[1].time, price: 4310 },
      candles,
      'XAUUSD',
    )).toMatchObject({ bars: 3, durationSeconds: 600, volume: 3000 })
  })

  it('formats the three information-card rows', () => {
    expect(formatSignedMeasurement(-78.06, 3)).toBe('-78.060')
    expect(formatMeasurementDuration(18_600)).toBe('5小时 10分钟')
    expect(formatMeasurementVolume(70_810)).toBe('70.81K')
  })
})
