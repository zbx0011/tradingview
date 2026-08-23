import { describe, expect, it } from 'vitest'
import { isExcludedCommodityTrade, UNFINISHED_POSITION_EXIT_REASON } from './tradeEligibility'

const trade = (entryTime: number, exitTime: number, reasonCode = 'TRAILING_STOP') => ({
  entry: { time: entryTime },
  exit: { time: exitTime, reasonCode },
})

describe('commodity trade eligibility', () => {
  it('excludes only gold and silver trades that cross the Beijing date', () => {
    expect(isExcludedCommodityTrade('XAUUSD', trade(57_300, 57_900))).toBe(true)
    expect(isExcludedCommodityTrade('XAGUSD', trade(57_300, 57_900))).toBe(true)
    expect(isExcludedCommodityTrade('XAUUSD', trade(57_900, 58_200))).toBe(false)
    expect(isExcludedCommodityTrade('BTCUSDT.P', trade(57_300, 57_900))).toBe(false)
  })

  it('excludes mark-to-market positions even when both timestamps share a date', () => {
    expect(isExcludedCommodityTrade('XAUUSD', trade(100, 200, UNFINISHED_POSITION_EXIT_REASON))).toBe(true)
    expect(isExcludedCommodityTrade('XAGUSD', trade(100, 200, UNFINISHED_POSITION_EXIT_REASON))).toBe(true)
    expect(isExcludedCommodityTrade('US500', trade(100, 200, UNFINISHED_POSITION_EXIT_REASON))).toBe(false)
  })
})
