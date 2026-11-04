import { describe, expect, it } from 'vitest'
import { futureTimeOffset, futureTradingBarTimes } from './futureTradingTimeline'

describe('future trading time projection', () => {
  it('places the first bar after the CME daily halt immediately after the last bar', () => {
    const last = Date.parse('2025-04-14T20:55:00Z') / 1000
    const next = Date.parse('2025-04-14T22:00:00Z') / 1000
    const future = futureTradingBarTimes([{ time: next }, { time: next + 60 }, { time: next + 300 }], last, 300)
    expect(future).toEqual([next, next + 300])
    expect(futureTimeOffset(next, last, future, 300)).toBe(1)
    expect(futureTimeOffset(next + 300, last, future, 300)).toBe(2)
  })

  it('compresses the weekend using observed timestamps and does not fabricate candles', () => {
    const friday = Date.parse('2025-04-11T20:55:00Z') / 1000
    const sunday = Date.parse('2025-04-13T22:00:00Z') / 1000
    const future = futureTradingBarTimes([{ time: sunday }], friday, 300)
    expect(future).toEqual([sunday])
    expect(futureTimeOffset(sunday, friday, future, 300)).toBe(1)
    expect(futureTradingBarTimes([], friday, 300)).toEqual([])
  })
})
