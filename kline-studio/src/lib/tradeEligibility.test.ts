import { describe, expect, it } from 'vitest'
import { isExcludedCommodityTrade, UNFINISHED_POSITION_EXIT_REASON } from './tradeEligibility'

const trade = (entryTime: number, exitTime: number, reasonCode = 'TRAILING_STOP') => ({
  entry: { time: entryTime },
  exit: { time: exitTime, reasonCode },
})

describe('commodity trade eligibility', () => {
  it('uses the 06:00 Beijing session boundary instead of calendar midnight', () => {
    const at = (date: string) => Math.floor(new Date(`${date}+08:00`).getTime() / 1000)
    expect(isExcludedCommodityTrade('XAUUSD', trade(at('2026-06-30 23:20'), at('2026-07-01 01:35')))).toBe(false)
    expect(isExcludedCommodityTrade('XAGUSD', trade(at('2026-06-30 23:20'), at('2026-07-01 01:35')))).toBe(false)
    expect(isExcludedCommodityTrade('US500', trade(at('2026-06-30 23:20'), at('2026-07-01 01:35')))).toBe(false)
    expect(isExcludedCommodityTrade('XAUUSD', trade(at('2026-07-01 04:00'), at('2026-07-01 06:50')))).toBe(true)
    expect(isExcludedCommodityTrade('BTCUSDT.P', trade(at('2026-07-01 04:00'), at('2026-07-01 06:50')))).toBe(false)
  })

  it('excludes mark-to-market positions for every closed-session symbol', () => {
    expect(isExcludedCommodityTrade('XAUUSD', trade(100, 200, UNFINISHED_POSITION_EXIT_REASON))).toBe(true)
    expect(isExcludedCommodityTrade('XAGUSD', trade(100, 200, UNFINISHED_POSITION_EXIT_REASON))).toBe(true)
    expect(isExcludedCommodityTrade('US500', trade(100, 200, UNFINISHED_POSITION_EXIT_REASON))).toBe(true)
    expect(isExcludedCommodityTrade('BTCUSDT.P', trade(100, 200, UNFINISHED_POSITION_EXIT_REASON))).toBe(false)
  })

  it('excludes the first and last ten candles of the Beijing session', () => {
    const at = (date: string) => Math.floor(new Date(`${date}+08:00`).getTime() / 1000)
    expect(isExcludedCommodityTrade('XAUUSD', trade(at('2026-08-03 06:00'), at('2026-08-03 06:05')), '5m')).toBe(true)
    expect(isExcludedCommodityTrade('XAUUSD', trade(at('2026-08-03 06:45'), at('2026-08-03 06:50')), '5m')).toBe(true)
    expect(isExcludedCommodityTrade('XAUUSD', trade(at('2026-08-03 06:50'), at('2026-08-03 06:55')), '5m')).toBe(false)
    expect(isExcludedCommodityTrade('US500', trade(at('2026-08-03 04:10'), at('2026-08-03 04:15')), '5m')).toBe(true)
    expect(isExcludedCommodityTrade('US500', trade(at('2026-08-03 04:55'), at('2026-08-03 04:55')), '5m')).toBe(true)
    expect(isExcludedCommodityTrade('US500', trade(at('2026-08-03 05:00'), at('2026-08-03 05:05')), '5m')).toBe(false)
    expect(isExcludedCommodityTrade('BTCUSDT.P', trade(at('2026-08-03 06:00'), at('2026-08-03 06:05')), '5m')).toBe(false)
  })
})
