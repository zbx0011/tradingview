import type { Drawing } from './drawings'

/** Historical structures must not disclose future anchors, even their earlier half. */
export function drawingIsRevealed(
  drawing: Drawing,
  replayIds: ReadonlySet<string> | null | undefined,
  lastCandleTime: number | null,
  intervalSeconds: number,
): boolean {
  if (!replayIds?.has(drawing.id)) return true
  if (lastCandleTime === null || !Number.isFinite(lastCandleTime) || !Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return false
  const revealedEnd = lastCandleTime + intervalSeconds
  return drawing.points.length > 0 && drawing.points.every(point => Number.isFinite(point.time) && point.time! < revealedEnd)
}
