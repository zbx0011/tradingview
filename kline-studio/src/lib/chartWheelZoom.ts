export interface LogicalRangeLike {
  from: number
  to: number
}

const LINE_DELTA_IN_PIXELS = 32
const PAGE_DELTA_IN_PIXELS = 120

/**
 * Normalise browser wheel units while preserving the complete input delta.
 * In particular, do not clamp each event to one zoom step: accelerated mouse
 * wheels regularly emit deltas much larger than a single notch.
 */
export function normalizedWheelDelta(deltaY: number, deltaMode: number): number {
  if (!Number.isFinite(deltaY)) return 0
  if (deltaMode === 1) return deltaY * LINE_DELTA_IN_PIXELS
  if (deltaMode === 2) return deltaY * PAGE_DELTA_IN_PIXELS
  return deltaY
}

export interface WheelZoomOptions {
  sensitivity?: number
  minSpan?: number
  maxSpan?: number
}

/**
 * Apply a wheel delta to a logical range while keeping the logical point under
 * the mouse stationary.  The exponential scale makes deltas additive, so ten
 * events coalesced into one animation frame produce the same zoom as ten
 * individual events and no fast-wheel input is lost.
 */
export function zoomLogicalRangeAt(
  range: LogicalRangeLike,
  anchorLogical: number,
  wheelDelta: number,
  options: WheelZoomOptions = {},
): LogicalRangeLike {
  const span = range.to - range.from
  if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(wheelDelta) || wheelDelta === 0) return range

  const sensitivity = options.sensitivity ?? 0.0015
  const minSpan = Math.max(1, options.minSpan ?? 6)
  const maxSpan = Math.max(minSpan, options.maxSpan ?? Number.POSITIVE_INFINITY)
  const safeAnchor = Number.isFinite(anchorLogical) ? anchorLogical : (range.from + range.to) / 2
  const anchorRatio = Math.max(0, Math.min(1, (safeAnchor - range.from) / span))
  // Bound only the exponent to avoid floating-point overflow. Normal UI limits
  // are applied to the resulting span below.
  const exponent = Math.max(-8, Math.min(8, wheelDelta * sensitivity))
  const nextSpan = Math.max(minSpan, Math.min(maxSpan, span * Math.exp(exponent)))
  const from = safeAnchor - nextSpan * anchorRatio
  return { from, to: from + nextSpan }
}
