import { describe, expect, it } from 'vitest'
import type { Candle } from './market'
import { advanceReplayTime, nearestReplayTime, replayCandles, replayResolutions, REPLAY_SPEEDS } from './replay'

const candles: Candle[] = [
  { time: 0, open: 100, high: 112, low: 96, close: 110, volume: 1000 },
  { time: 300, open: 110, high: 114, low: 101, close: 104, volume: 800 },
  { time: 600, open: 104, high: 109, low: 102, close: 108, volume: 900 },
]

describe('bar replay model', () => {
  it('uses the same nine speed choices and delays as the TradingView control', () => {
    expect(REPLAY_SPEEDS.map((item) => item.label)).toEqual(['10x', '7x', '5x', '3x', '1x', '0.5x', '0.3x', '0.2x', '0.1x'])
    expect(REPLAY_SPEEDS.map((item) => item.delay)).toEqual([100, 143, 200, 333, 1000, 2000, 3000, 5000, 10000])
  })

  it('only exposes replay resolutions that evenly divide the chart interval', () => {
    expect(replayResolutions('15m').map((item) => item.shortLabel)).toEqual(['1分', '3分', '5分', '15分'])
    expect(replayResolutions('2h').at(-1)?.shortLabel).toBe('2小时')
    expect(replayResolutions('1w').map((item) => item.shortLabel)).toEqual(['1天', '1周'])
  })

  it('snaps a requested timestamp to the bar at or immediately before it', () => {
    expect(nearestReplayTime(candles, -5)).toBe(0)
    expect(nearestReplayTime(candles, 455)).toBe(300)
    expect(nearestReplayTime(candles, 999)).toBe(600)
  })

  it('hides future candles and constructs the current candle progressively', () => {
    const atOpen = replayCandles(candles, 300, 300)
    expect(atOpen).toHaveLength(2)
    expect(atOpen[1]).toMatchObject({ open: 110, high: 110, low: 110, close: 110 })
    const partial = replayCandles(candles, 450, 300)
    expect(partial).toHaveLength(2)
    expect(partial[1].volume).toBe(400)
    expect(partial[1].high).toBeGreaterThanOrEqual(partial[1].close)
    expect(partial[1].low).toBeLessThanOrEqual(partial[1].close)
  })

  it('advances by the selected update interval and stops at the data end', () => {
    expect(advanceReplayTime(300, 60, candles, 300)).toEqual({ time: 360, ended: false })
    expect(advanceReplayTime(899, 60, candles, 300)).toEqual({ time: 900, ended: true })
  })
})
