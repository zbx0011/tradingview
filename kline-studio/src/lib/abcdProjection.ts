import type { DrawingPoint } from './drawings'

/** Derive D from the three stored anchors without changing them. */
export function projectAbCd(points: readonly DrawingPoint[]): DrawingPoint | null {
  if (points.length < 3) return null
  const [a, b, c] = points
  if (![a, b, c].every((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y))) return null

  const hasAbPrices = Number.isFinite(a.price) && Number.isFinite(b.price)
  if (hasAbPrices ? a.price === b.price : a.x === b.x && a.y === b.y) return null

  const result: DrawingPoint = { x: c.x + b.x - a.x, y: c.y + b.y - a.y }
  if (!Number.isFinite(result.x) || !Number.isFinite(result.y)) return null

  // Keep price arithmetic independent of chart pixels, including on log scales.
  if ([a.price, b.price, c.price].every(Number.isFinite)) {
    result.price = c.price! + b.price! - a.price!
    if (!Number.isFinite(result.price)) return null
  }
  if ([a.time, b.time, c.time].every(Number.isFinite)) {
    result.time = c.time! + b.time! - a.time!
    if (!Number.isFinite(result.time)) return null
  }
  return result
}
