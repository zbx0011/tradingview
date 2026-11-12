import { describe, expect, it } from 'vitest'
import { candlesForHistoryWindow, historyIndexAtTime, historyTimeAtIndex, MAX_CHART_BARS, planChartHistoryWindow } from './chartHistoryWindow'
import type { Candle } from './market'

const bars = (count: number): Candle[] => Array.from({ length: count }, (_, index) => ({
  time: 1_600_000_020 + index * 60, open: index + 10, high: index + 12, low: index + 8, close: index + 11, volume: 3,
}))

describe('bounded chart history', () => {
  it('keeps ordinary charts and their candle identities intact', () => {
    const source = bars(100)
    const plan = planChartHistoryWindow(source, 10, 80, 60)
    expect(candlesForHistoryWindow(source, plan, 60)).toBe(source)
  })

  it('bounds minute detail at the beginning, middle, and end of a large history', () => {
    const source = bars(100_000)
    for (const center of [0, 50_000, 99_999]) {
      const plan = planChartHistoryWindow(source, center - 100, center + 100, 60)
      const rendered = candlesForHistoryWindow(source, plan, 60)
      expect(rendered).toHaveLength(MAX_CHART_BARS)
      expect(rendered).toContain(source[center])
      expect(plan.seconds).toBe(60)
    }
  })

  it('rebases a fractional viewport without shifting its timestamps across a market gap', () => {
    const source = bars(100_000)
    for (let index = 30_000; index < source.length; index++) source[index].time += 2 * 86_400
    const first = planChartHistoryWindow(source, 28_000, 28_100, 60)
    const oldWindow = candlesForHistoryWindow(source, first, 60)
    const time = historyTimeAtIndex(oldWindow, 125.75, 60)
    const sourceIndex = historyIndexAtTime(source, time, 60)
    const next = planChartHistoryWindow(source, sourceIndex, sourceIndex + 100, 60)
    const newWindow = candlesForHistoryWindow(source, next, 60)
    const rebased = historyIndexAtTime(newWindow, time, 60)
    expect(historyTimeAtIndex(newWindow, rebased, 60)).toBe(time)
    const gapTime = (source[29_999].time + source[30_000].time) / 2
    expect(historyIndexAtTime(source, gapTime, 60)).toBe(29_999.5)
  })

  it('renders the entire history as bounded OHLCV aggregates and returns to minute detail on zoom', () => {
    const source = bars(100_000)
    const overview = planChartHistoryWindow(source, 0, source.length - 1, 60)
    const rendered = candlesForHistoryWindow(source, overview, 60)
    expect(rendered.length).toBeLessThanOrEqual(MAX_CHART_BARS)
    expect(overview.seconds).toBeGreaterThan(60)
    expect(rendered[0].open).toBe(source[0].open)
    expect(rendered.at(-1)!.close).toBe(source.at(-1)!.close)
    expect(rendered.reduce((total, candle) => total + candle.volume, 0)).toBe(300_000)
    const detail = planChartHistoryWindow(source, 400, 550, 60)
    expect(detail.seconds).toBe(60)
  })

  it('never loads candles beyond the causal replay prefix, including a shortened prefix', () => {
    const source = bars(100_000).slice(0, 20_000)
    const plan = planChartHistoryWindow(source, 19_900, 30_000, 60)
    const rendered = candlesForHistoryWindow(source, plan, 60)
    expect(rendered.at(-1)!.time).toBe(source.at(-1)!.time)
    expect(plan.end).toBe(source.length)
  })
})
