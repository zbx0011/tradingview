export interface TradeLabelObstacle {
  left: number
  right: number
  top: number
  bottom: number
}

export interface TradeEndpointLabelLayout {
  boxX: number
  boxY: number
  boxWidth: number
  boxHeight: number
  edgeX: number
  edgeY: number
  obstacleOverlapArea: number
  reservedOverlapArea: number
}

export const TRADE_ENDPOINT_LABEL_WIDTH = 184
export const TRADE_ENDPOINT_LABEL_HEIGHT = 44

const VIEWPORT_MARGIN = 8
const TOP_SAFE_INSET = 96
const BOTTOM_SAFE_INSET = 44
const POINT_GAP = 10
const CANDLE_CLEARANCE = 8

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

function intersectionArea(left: TradeLabelObstacle, right: TradeLabelObstacle) {
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left))
  const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top))
  return width * height
}

function nearestEdge(pointX: number, pointY: number, rectangle: TradeLabelObstacle) {
  const edgeX = clamp(pointX, rectangle.left, rectangle.right)
  const edgeY = clamp(pointY, rectangle.top + 11, rectangle.bottom - 11)
  return { edgeX, edgeY }
}

function uniqueClamped(values: readonly number[], minimum: number, maximum: number) {
  const result: number[] = []
  for (const value of values) {
    const clamped = clamp(value, minimum, maximum)
    if (!result.some((current) => Math.abs(current - clamped) < 0.5)) result.push(clamped)
  }
  return result
}

export function tradeEndpointLabelLayout(
  pointX: number,
  pointY: number,
  kind: 'entry' | 'exit',
  viewportWidth: number,
  viewportHeight: number,
  candleObstacles: readonly TradeLabelObstacle[] = [],
  reservedObstacles: readonly TradeLabelObstacle[] = [],
): TradeEndpointLabelLayout {
  const boxWidth = Math.min(TRADE_ENDPOINT_LABEL_WIDTH, Math.max(120, viewportWidth - VIEWPORT_MARGIN * 2))
  const boxHeight = TRADE_ENDPOINT_LABEL_HEIGHT
  const maxX = Math.max(VIEWPORT_MARGIN, viewportWidth - boxWidth - VIEWPORT_MARGIN)
  const maxY = Math.max(VIEWPORT_MARGIN, viewportHeight - boxHeight - BOTTOM_SAFE_INSET)
  const minY = Math.min(TOP_SAFE_INSET, maxY)
  const rightX = pointX + POINT_GAP
  const leftX = pointX - boxWidth - POINT_GAP
  const centeredX = pointX - boxWidth / 2
  const preferRight = pointX <= viewportWidth - boxWidth - POINT_GAP - VIEWPORT_MARGIN
  const xCandidates = uniqueClamped(
    preferRight ? [rightX, leftX, centeredX] : [leftX, rightX, centeredX],
    VIEWPORT_MARGIN,
    maxX,
  )

  let best: TradeEndpointLabelLayout | null = null
  let bestScore = Number.POSITIVE_INFINITY

  xCandidates.forEach((boxX, horizontalRank) => {
    const horizontalObstacles = candleObstacles.filter((obstacle) => obstacle.right > boxX && obstacle.left < boxX + boxWidth)
    const localTop = horizontalObstacles.length > 0 ? Math.min(...horizontalObstacles.map((obstacle) => obstacle.top)) : pointY
    const localBottom = horizontalObstacles.length > 0 ? Math.max(...horizontalObstacles.map((obstacle) => obstacle.bottom)) : pointY
    const aboveLocalCandles = localTop - boxHeight - CANDLE_CLEARANCE
    const belowLocalCandles = localBottom + CANDLE_CLEARANCE
    const abovePoint = pointY - boxHeight - POINT_GAP
    const belowPoint = pointY + POINT_GAP
    const obstacleEdgeCandidates = horizontalObstacles.flatMap((obstacle) => [
      obstacle.top - boxHeight - CANDLE_CLEARANCE,
      obstacle.bottom + CANDLE_CLEARANCE,
    ])
    const preferredY = kind === 'entry'
      ? [aboveLocalCandles, abovePoint, belowLocalCandles, belowPoint, ...obstacleEdgeCandidates, minY, maxY]
      : [belowLocalCandles, belowPoint, aboveLocalCandles, abovePoint, ...obstacleEdgeCandidates, maxY, minY]
    const yCandidates = uniqueClamped(preferredY, minY, maxY)

    yCandidates.forEach((boxY, verticalRank) => {
      const rectangle: TradeLabelObstacle = { left: boxX, right: boxX + boxWidth, top: boxY, bottom: boxY + boxHeight }
      const obstacleOverlapArea = candleObstacles.reduce((total, obstacle) => total + intersectionArea(rectangle, obstacle), 0)
      const reservedOverlapArea = reservedObstacles.reduce((total, obstacle) => total + intersectionArea(rectangle, obstacle), 0)
      const { edgeX, edgeY } = nearestEdge(pointX, pointY, rectangle)
      const leaderDistance = Math.hypot(pointX - edgeX, pointY - edgeY)
      const wrongVerticalSide = kind === 'entry' ? boxY >= pointY : boxY + boxHeight <= pointY
      const score = obstacleOverlapArea * 10_000
        + reservedOverlapArea * 20_000
        + leaderDistance
        + horizontalRank * 5
        + verticalRank * 2
        + (wrongVerticalSide ? 12 : 0)

      if (score >= bestScore) return
      bestScore = score
      best = { boxX, boxY, boxWidth, boxHeight, edgeX, edgeY, obstacleOverlapArea, reservedOverlapArea }
    })
  })

  if (best) return best
  const boxX = clamp(pointX + POINT_GAP, VIEWPORT_MARGIN, maxX)
  const boxY = clamp(pointY - boxHeight - POINT_GAP, minY, maxY)
  const rectangle = { left: boxX, right: boxX + boxWidth, top: boxY, bottom: boxY + boxHeight }
  const { edgeX, edgeY } = nearestEdge(pointX, pointY, rectangle)
  return { boxX, boxY, boxWidth, boxHeight, edgeX, edgeY, obstacleOverlapArea: 0, reservedOverlapArea: 0 }
}

export function labelLayoutObstacle(layout: TradeEndpointLabelLayout, padding = 4): TradeLabelObstacle {
  return {
    left: layout.boxX - padding,
    right: layout.boxX + layout.boxWidth + padding,
    top: layout.boxY - padding,
    bottom: layout.boxY + layout.boxHeight + padding,
  }
}
