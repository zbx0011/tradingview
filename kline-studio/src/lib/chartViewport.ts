interface RealtimeFollowDecision {
  shouldFocusLatest: boolean
  hasVisibleRange?: boolean
  followLatest: boolean
  wasAtRealtime: boolean
  previousLength: number
  nextLength: number
}

interface ViewportProjectionSyncDecision {
  wheelZoomBurstActive: boolean
  mousePanBurstActive: boolean
}

interface DataUpdateViewportDecision {
  focusReady: boolean
  hasVisibleRange: boolean
  followLatest: boolean
  wasAtRealtime: boolean
  previousLength: number
  nextLength: number
}

export type DataUpdateViewportAction = 'center' | 'realtime' | 'preserve' | 'none'

export interface LogicalRangeLike {
  from: number
  to: number
}

export function centeredLatestLogicalRange(length: number): LogicalRangeLike {
  const latestIndex = Math.max(0, length - 1)
  const halfSpan = Math.min(110, Math.max(1, latestIndex))
  return { from: latestIndex - halfSpan, to: latestIndex + halfSpan }
}

export function initialChartLogicalRange(
  length: number,
  cachedRange: LogicalRangeLike | undefined,
  centerLatestByDefault: boolean,
): LogicalRangeLike {
  if (centerLatestByDefault) return centeredLatestLogicalRange(length)
  return cachedRange ?? { from: Math.max(0, length - 360), to: length + 8 }
}

export function shouldFollowRealtime({
  shouldFocusLatest,
  hasVisibleRange = false,
  followLatest,
  wasAtRealtime,
  previousLength,
  nextLength,
}: RealtimeFollowDecision) {
  return (!hasVisibleRange && shouldFocusLatest) || (
    followLatest
    && wasAtRealtime
    && nextLength >= previousLength
  )
}

export function viewportActionAfterDataUpdate({
  focusReady,
  hasVisibleRange,
  followLatest,
  wasAtRealtime,
  previousLength,
  nextLength,
}: DataUpdateViewportDecision): DataUpdateViewportAction {
  // Candidate switches can transiently publish an empty causal window.
  // Never ask lightweight-charts to apply a logical range with no bars.
  if (nextLength <= 0) return 'none'
  if (focusReady) return 'center'
  if (shouldFollowRealtime({
    shouldFocusLatest: false,
    hasVisibleRange,
    followLatest,
    wasAtRealtime,
    previousLength,
    nextLength,
  })) return 'realtime'
  return hasVisibleRange ? 'preserve' : 'none'
}

export function isRealtimeScrollPosition(scrollPosition: number) {
  return scrollPosition <= 1
}

export function shouldDeferViewportProjectionSync(input: ViewportProjectionSyncDecision) {
  // Continuous gestures stay on the native/compositor path. React/SVG
  // projections receive one exact update when the gesture settles.
  return input.wheelZoomBurstActive || input.mousePanBurstActive
}
