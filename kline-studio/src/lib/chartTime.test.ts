import { TickMarkType, type UTCTimestamp } from 'lightweight-charts'
import { describe, expect, it } from 'vitest'
import { formatBeijingChartTime, formatBeijingTickMark } from './chartTime'

describe('Beijing chart time formatting', () => {
  const signal13Time = (Date.UTC(2026, 6, 27, 19, 30) / 1000) as UTCTimestamp

  it('maps the signal timestamp to its exact Beijing candle time', () => {
    expect(formatBeijingChartTime(signal13Time)).toBe('2026-07-28 03:30')
    expect(formatBeijingTickMark(signal13Time, TickMarkType.Time)).toBe('03:30')
  })

  it('handles the Beijing calendar-day boundary without using the host timezone', () => {
    const midnight = (Date.UTC(2026, 6, 27, 16, 0) / 1000) as UTCTimestamp
    expect(formatBeijingChartTime(midnight)).toBe('2026-07-28 00:00')
    expect(formatBeijingTickMark(midnight, TickMarkType.DayOfMonth)).toBe('07/28')
  })

  it('preserves business-day labels', () => {
    expect(formatBeijingChartTime({ year: 2026, month: 7, day: 28 })).toBe('2026-07-28 00:00')
    expect(formatBeijingTickMark('2026-07-28', TickMarkType.Month)).toBe('07月')
  })
})
