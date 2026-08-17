import { describe, expect, it } from 'vitest'
import type { Candle } from './market'
import type { XauTradeMarker } from './tradeMarkers'
import { extractReasonCandleIndexes, resolveTradeCandleReferences, tradeReasonCandleIndexes } from './tradeCandleReferences'

function candle(time: number, value: number): Candle {
  return { time, open: value, high: value + 2, low: value - 2, close: value + 1, volume: 10 }
}

function sampleTrade(overrides?: Partial<XauTradeMarker>): XauTradeMarker {
  return {
    tradeNumber: 162,
    side: 'long',
    entry: {
      signalIdx: 1650,
      signalTime: 10_300,
      time: 10_600,
      beijingTime: '2026-08-08 02:35',
      price: 4337.935,
      setup: 'H2多头反转',
      reason: '靠近1639支撑带，且1648下破后迅速出现多头收回。当前回到1646低点上方，价格4075.90，EMA20，近100根区间。',
      ruleVersion: 'next_bar',
      triggerReference: 'signal_bar_high',
      triggerCondition: 'next_bar_high > signal_bar_high',
      stopLoss: 4332.255,
      takeProfit: null,
      noFixedTakeProfitAtEntry: true,
      stopMethod: 'latest_confirmed_pivot_low_below_entry',
      trailingActivationUsd: 100,
      trailingDistanceUsd: 100,
    },
    exit: {
      idx: 1656,
      time: 12_100,
      beijingTime: '2026-08-08 03:05',
      price: 4338.355,
      reasonCode: 'INITIAL_STOP_LOSS',
      ambiguous: false,
      finalActiveStop: 4332.255,
      trailingActivated: false,
      trailingActivationIdx: null,
    },
    result: { barsHeld: 6, rMultiple: 0.074, pnlUsd: 7.39 },
    ...overrides,
  }
}

describe('trade reason candle references', () => {
  it('extracts nearby replay indexes without mistaking prices, indicators or counts for indexes', () => {
    expect(extractReasonCandleIndexes(sampleTrade().entry.reason, [1650])).toEqual([1639, 1646, 1648])
    expect(extractReasonCandleIndexes('EMA20、H2、V2、20美元、近20根；K18与第19根K线形成支撑。', [20])).toEqual([18, 19])
  })

  it('accepts explicit idx ranges and keeps a unique ordered index list', () => {
    expect(extractReasonCandleIndexes('idx=298–299下破，idx299收回；价格4055.22，近100根。', [300])).toEqual([298, 299])
    expect(tradeReasonCandleIndexes(sampleTrade())).toEqual([1639, 1646, 1648])
  })

  it('maps indexes by candle ordinal around an exact time anchor, including across a market gap', () => {
    const data = [
      candle(1_000, 10), candle(1_300, 11), candle(1_600, 12),
      candle(10_000, 13), candle(10_300, 14), candle(10_600, 15), candle(10_900, 16), candle(11_200, 17), candle(11_500, 18), candle(11_800, 19), candle(12_100, 20),
    ]
    const trade = sampleTrade({
      entry: { ...sampleTrade().entry, signalIdx: 10, signalTime: 10_300, reason: 'idx8与9低点形成支撑，10信号K收回。' },
      exit: { ...sampleTrade().exit, idx: 16, time: 12_100 },
    })
    expect(resolveTradeCandleReferences(trade, data).map(({ index, time }) => ({ index, time }))).toEqual([
      { index: 8, time: 1_600 },
      { index: 9, time: 10_000 },
      { index: 10, time: 10_300 },
    ])
  })

  it('does not attach references to a nearest candle when the replay anchor is absent', () => {
    expect(resolveTradeCandleReferences(sampleTrade(), [candle(1_000, 10), candle(1_300, 11)])).toEqual([])
  })
})
