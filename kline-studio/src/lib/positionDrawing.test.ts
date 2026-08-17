import { describe, expect, it } from 'vitest'
import { calculatePositionMetrics, formatPositionNumber } from './positionDrawing'

describe('TradingView-style long/short position metrics', () => {
  it('places the stop above and the target below for a short position', () => {
    const metrics = calculatePositionMetrics({
      side: 'short', topPrice: 105, bottomPrice: 95, currentPrice: 102, tickSize: .01,
    })
    expect(metrics).toMatchObject({
      entryPrice: 100,
      stopPrice: 105,
      targetPrice: 95,
      distance: 5,
      percent: 5,
      ticks: 500,
      quantity: 5,
      pnl: -10,
      riskReward: 1,
      stopAmount: 750,
      targetAmount: 1250,
    })
  })

  it('places the target above and the stop below for a long position', () => {
    const metrics = calculatePositionMetrics({
      side: 'long', topPrice: 105, bottomPrice: 95, currentPrice: 102, tickSize: .01,
    })
    expect(metrics.stopPrice).toBe(95)
    expect(metrics.targetPrice).toBe(105)
    expect(metrics.pnl).toBe(10)
  })

  it('formats labels with grouped decimals', () => {
    expect(formatPositionNumber(4739.1, 1)).toBe('4,739.1')
    expect(formatPositionNumber(-132.373)).toBe('-132.373')
  })
})
