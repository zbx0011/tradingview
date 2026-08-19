export type PositionSide = 'long' | 'short'

/** TradingView-style position controls. */
export type PositionHandle = 'target' | 'entry' | 'stop' | 'width'

/**
 * Position points use a four-anchor model:
 * 0 entry-left, 1 entry-right, 2 target, 3 stop.
 *
 * Older saved drawings only contain a diagonal pair. The geometry resolver
 * below keeps those drawings readable and upgrades them on the first drag.
 */
export const DEFAULT_POSITION_HEIGHT = 0.16
export const DEFAULT_POSITION_WIDTH = 0.24
export const MIN_POSITION_WIDTH = 0.04
export const MIN_POSITION_HEIGHT = 0.01

export interface PositionPoint {
  x: number
  y: number
}

export interface PositionGeometry<T extends PositionPoint = PositionPoint> {
  entryLeft: T
  entryRight: T
  target: T
  stop: T
  left: number
  right: number
  entryY: number
  targetY: number
  stopY: number
}

const clampUnit = (value: number) => Math.max(0, Math.min(1, value))

/** Create the compact 1:1 position that TradingView places after one click. */
export function createDefaultPositionPoints(point: PositionPoint, side: PositionSide = 'long'): PositionPoint[] {
  const halfHeight = DEFAULT_POSITION_HEIGHT / 2
  const entryY = Math.max(halfHeight + 0.02, Math.min(1 - halfHeight - 0.02, point.y))
  const width = Math.min(DEFAULT_POSITION_WIDTH, 1 - MIN_POSITION_WIDTH)
  const left = Math.max(0.02, Math.min(1 - width - 0.02, point.x))
  const right = left + width
  const targetY = side === 'long' ? entryY - halfHeight : entryY + halfHeight
  const stopY = side === 'long' ? entryY + halfHeight : entryY - halfHeight

  return [
    { x: left, y: entryY },
    { x: right, y: entryY },
    { x: left, y: targetY },
    { x: left, y: stopY },
  ]
}

/** Resolve both new four-anchor drawings and legacy diagonal-pair drawings. */
export function resolvePositionGeometry<T extends PositionPoint>(points: T[], side: PositionSide): PositionGeometry<T> | null {
  if (points.length < 2) return null

  if (points.length >= 4) {
    const rawLeft = points[0]
    const rawRight = points[1]
    const left = Math.min(rawLeft.x, rawRight.x)
    const right = Math.max(rawLeft.x, rawRight.x)
    const entryY = rawLeft.y
    return {
      entryLeft: { ...rawLeft, x: left, y: entryY } as T,
      entryRight: { ...rawRight, x: right, y: entryY } as T,
      target: { ...points[2], x: left } as T,
      stop: { ...points[3], x: left } as T,
      left,
      right,
      entryY,
      targetY: points[2].y,
      stopY: points[3].y,
    }
  }

  const first = points[0]
  const last = points.at(-1)!
  const leftPoint = first.x <= last.x ? first : last
  const rightPoint = first.x <= last.x ? last : first
  const left = Math.min(first.x, last.x)
  const right = Math.max(first.x, last.x)
  const top = Math.min(first.y, last.y)
  const bottom = Math.max(first.y, last.y)
  const entryY = (top + bottom) / 2
  const targetY = side === 'long' ? top : bottom
  const stopY = side === 'long' ? bottom : top

  return {
    entryLeft: { ...leftPoint, x: left, y: entryY } as T,
    entryRight: { ...rightPoint, x: right, y: entryY } as T,
    target: { ...leftPoint, x: left, y: targetY } as T,
    stop: { ...leftPoint, x: left, y: stopY } as T,
    left,
    right,
    entryY,
    targetY,
    stopY,
  }
}

/**
 * Move exactly one TradingView anchor. Target and stop are independent of the
 * entry line; the width handle changes time span only; the entry handle moves
 * the complete drawing while retaining its reward/risk distances.
 */
export function updatePositionPoints<T extends PositionPoint>(
  points: T[],
  handle: PositionHandle,
  pointer: PositionPoint,
  side: PositionSide = 'long',
): T[] {
  const geometry = resolvePositionGeometry(points, side)
  if (!geometry) return points

  let { entryLeft, entryRight, target, stop } = geometry
  const width = Math.max(MIN_POSITION_WIDTH, geometry.right - geometry.left)

  if (handle === 'target') {
    const y = side === 'long'
      ? Math.min(clampUnit(pointer.y), geometry.entryY - MIN_POSITION_HEIGHT)
      : Math.max(clampUnit(pointer.y), geometry.entryY + MIN_POSITION_HEIGHT)
    target = { ...target, x: geometry.left, y: clampUnit(y) } as T
  } else if (handle === 'stop') {
    const y = side === 'long'
      ? Math.max(clampUnit(pointer.y), geometry.entryY + MIN_POSITION_HEIGHT)
      : Math.min(clampUnit(pointer.y), geometry.entryY - MIN_POSITION_HEIGHT)
    stop = { ...stop, x: geometry.left, y: clampUnit(y) } as T
  } else if (handle === 'width') {
    const right = Math.min(1, Math.max(pointer.x, geometry.left + MIN_POSITION_WIDTH))
    entryRight = { ...entryRight, x: right, y: geometry.entryY } as T
  } else if (handle === 'entry') {
    const minY = Math.min(geometry.entryY, geometry.targetY, geometry.stopY)
    const maxY = Math.max(geometry.entryY, geometry.targetY, geometry.stopY)
    const requestedDeltaX = pointer.x - geometry.left
    const requestedDeltaY = pointer.y - geometry.entryY
    const deltaX = Math.max(-geometry.left, Math.min(1 - geometry.right, requestedDeltaX))
    const deltaY = Math.max(-minY, Math.min(1 - maxY, requestedDeltaY))
    entryLeft = { ...entryLeft, x: geometry.left + deltaX, y: geometry.entryY + deltaY } as T
    entryRight = { ...entryRight, x: geometry.left + deltaX + width, y: geometry.entryY + deltaY } as T
    target = { ...target, x: geometry.left + deltaX, y: geometry.targetY + deltaY } as T
    stop = { ...stop, x: geometry.left + deltaX, y: geometry.stopY + deltaY } as T
  }

  return [entryLeft, entryRight, target, stop]
}

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

interface PositionLevelMetricsInput {
  side: PositionSide
  entryPrice: number
  stopPrice: number
  targetPrice: number
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

export function calculatePositionMetricsFromLevels({
  side,
  entryPrice,
  stopPrice,
  targetPrice,
  currentPrice,
  tickSize,
  quantity = 5,
  stopAmount = 750,
  targetAmount = 1250,
}: PositionLevelMetricsInput): PositionMetrics {
  const stopDistance = Math.abs(entryPrice - stopPrice)
  const targetDistance = Math.abs(targetPrice - entryPrice)
  const safeTickSize = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0.01
  const pnlPerUnit = side === 'long' ? currentPrice - entryPrice : entryPrice - currentPrice
  return {
    entryPrice,
    stopPrice,
    targetPrice,
    distance: stopDistance,
    percent: entryPrice === 0 ? 0 : stopDistance / Math.abs(entryPrice) * 100,
    ticks: stopDistance / safeTickSize,
    quantity,
    pnl: pnlPerUnit * quantity,
    riskReward: stopDistance === 0 ? 0 : targetDistance / stopDistance,
    stopAmount,
    targetAmount,
  }
}

/** Legacy high/low metric entry point retained for saved two-point drawings. */
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
  return calculatePositionMetricsFromLevels({
    side,
    entryPrice,
    stopPrice: side === 'long' ? low : high,
    targetPrice: side === 'long' ? high : low,
    currentPrice,
    tickSize,
    quantity,
    stopAmount,
    targetAmount,
  })
}

export function formatPositionNumber(value: number, digits = 3) {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  })
}
