export type PositionSide = 'long' | 'short'

interface PositionMetricsInput {
  side: PositionSide
  topPrice: number
  bottomPrice: number
  currentPrice: number
  tickSize: number
  quantity?: number
  stopAmount?: number
  targetAmount?: number
}

export interface PositionMetrics {
  entryPrice: number
  stopPrice: number
  targetPrice: number
  distance: number
  percent: number
  ticks: number
  quantity: number
  pnl: number
  riskReward: number
  stopAmount: number
  targetAmount: number
}

export function calculatePositionMetrics({
  side,
  topPrice,
  bottomPrice,
  currentPrice,
  tickSize,
  quantity = 5,
  stopAmount = 750,
  targetAmount = 1250,
}: PositionMetricsInput): PositionMetrics {
  const high = Math.max(topPrice, bottomPrice)
  const low = Math.min(topPrice, bottomPrice)
  const entryPrice = (high + low) / 2
  const stopPrice = side === 'long' ? low : high
  const targetPrice = side === 'long' ? high : low
  const stopDistance = Math.abs(entryPrice - stopPrice)
  const targetDistance = Math.abs(targetPrice - entryPrice)
  const safeTickSize = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0.01
  const pnlPerUnit = side === 'long' ? currentPrice - entryPrice : entryPrice - currentPrice
  return {
    entryPrice,
    stopPrice,
    targetPrice,
    distance: stopDistance,
    percent: entryPrice === 0 ? 0 : stopDistance / entryPrice * 100,
    ticks: stopDistance / safeTickSize,
    quantity,
    pnl: pnlPerUnit * quantity,
    riskReward: stopDistance === 0 ? 0 : targetDistance / stopDistance,
    stopAmount,
    targetAmount,
  }
}

export function formatPositionNumber(value: number, digits = 3) {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  })
}
