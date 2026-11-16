import { describe, expect, it } from 'vitest'
import { aggregateCandles, type Candle } from './market'
import { computeChartThreePushes } from './threePush'
import { mergeProjectedThreePushes, projectThreePushesToChart, threePushCoordinate, threePushMinuteWindow } from './threePushProjection'
import fixture from './fixtures/nq-20241126-false-first-push.json'

const START = Date.UTC(2024, 10, 26) / 1000
const bar = (i: number, high: number, low: number): Candle => ({ time: START + i * 60, high, low, open: (high + low) / 2, close: (high + low) / 2, volume: 1 })
const minutes = [
  ...Array.from({ length: 20 }, (_, i) => bar(i, 100, 99)),
  bar(20, 102, 99.5), bar(21, 106, 101), bar(22, 105, 103), bar(23, 104, 102),
  bar(24, 108, 103), bar(25, 107, 105), bar(26, 106, 104), bar(27, 110, 105),
]
const fiveMinutes = aggregateCandles(minutes, 300)
const oneMinutePatterns = () => computeChartThreePushes(minutes, { timeframes: ['1m'] }).filter((p) => p.direction === 'up')

describe('minute three pushes on a five-minute chart', () => {
  it('interpolates integer chart coordinates rather than sending fractional indices to lightweight-charts', () => {
    const integerOnly = (index: number) => Number.isInteger(index) ? 100 + index * 10 : 0
    expect(threePushCoordinate(4.2, integerOnly)).toBe(142)
    expect(threePushCoordinate(-0.2, integerOnly)).toBe(98)
    expect(threePushCoordinate(5, integerOnly)).toBe(150)
    expect(threePushCoordinate(1.2, () => null)).toBe(null)
  })
  it('preserves chronological geometry for the actual NQ minute tape', () => {
    const raw: Candle[] = fixture.rows.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }))
    const projected = projectThreePushesToChart(computeChartThreePushes(raw, { timeframes: ['1m'] }), aggregateCandles(raw, 300))
    for (const p of projected) {
      const indices = [p.start.index, ...p.pushes.flatMap((push) => [push.start.index, push.peak.index])]
      expect(indices.every((index, i) => i === 0 || index >= indices[i - 1])).toBe(true)
    }
  })
  it('uses actual minute evidence and projects distinct swings within the same chart candle', () => {
    expect(computeChartThreePushes(fiveMinutes).some((p) => p.timeframes.includes('1m'))).toBe(false)
    const projected = projectThreePushesToChart(oneMinutePatterns(), fiveMinutes)
    expect(projected).toHaveLength(1)
    expect(projected[0].label).toBe('三推 1m')
    expect(projected[0].pushes.map((p) => p.peak.index)).toEqual([4.2, 4.8, 5.4])
    expect(projected[0].pushes.map((p) => p.peak.price)).toEqual([106, 108, 110])
    expect(projected[0].confirmedTime).toBe(minutes[27].time)
  })

  it('excludes unrevealed minutes inside the current five-minute candle', () => {
    const source = { candles: minutes, endTime: minutes[27].time }
    const before = threePushMinuteWindow(source, fiveMinutes)
    expect(before.to).toBe(27)
    expect(computeChartThreePushes(minutes.slice(before.from, before.to), { timeframes: ['1m'] })).toEqual([])
    const after = threePushMinuteWindow({ ...source, endTime: minutes[27].time + 60 }, fiveMinutes)
    expect(after.to).toBe(28)
    expect(computeChartThreePushes(minutes.slice(after.from, after.to), { timeframes: ['1m'] }).some((p) => p.direction === 'up')).toBe(true)
  })

  it('bounds calculation to 20000 minutes and follows the historical viewport', () => {
    const history = Array.from({ length: 100_000 }, (_, i) => bar(i, 100, 99))
    const chart = aggregateCandles(history, 300)
    const source = { candles: history, endTime: Infinity }
    const latest = threePushMinuteWindow(source, chart)
    expect(latest.to - latest.from).toBe(20_000)
    expect(latest.to).toBe(100_000)
    const historical = threePushMinuteWindow(source, chart, 200)
    expect(historical.to).toBeLessThan(3000)
    expect(historical.to - historical.from).toBeLessThanOrEqual(20_000)
    expect(threePushMinuteWindow({ candles: chart, endTime: Infinity }, chart)).toEqual({ from: 0, to: 0 })
  })

  it('keeps a minute point in its five-minute slot across a market closure', () => {
    const chart = [bar(0, 100, 99), bar(5, 100, 99), bar(120, 100, 99), bar(125, 100, 99)]
    const original = oneMinutePatterns()[0]
    const pattern = { ...original, pushes: original.pushes.map((push) => ({ ...push, peak: { ...push.peak, time: START + 9 * 60 } })) }
    expect(projectThreePushesToChart([pattern], chart)[0].pushes[0].peak.index).toBe(1.8)
  })

  it('merges the same complete cross-level shape without merging different prices', () => {
    const [fine] = projectThreePushesToChart(oneMinutePatterns(), fiveMinutes)
    const coarse = { ...fine, timeframes: ['5m' as const], pushes: fine.pushes.map((push) => ({ ...push, peak: { ...push.peak, index: Math.floor(push.peak.index) } })), label: '三推 5m' }
    const merged = mergeProjectedThreePushes([fine, coarse])
    expect(merged).toHaveLength(1)
    expect(merged[0].label).toBe('三推 1m·5m')
    expect(merged[0].pushes[0].peak.index).toBe(4.2)
    const other = { ...coarse, pushes: coarse.pushes.map((push) => ({ ...push, peak: { ...push.peak, price: push.peak.price + 1 } })) }
    expect(mergeProjectedThreePushes([fine, other])).toHaveLength(2)
  })
})
