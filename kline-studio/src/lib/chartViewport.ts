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

export function isRealtimeScrollPosition(scrollPosition: number) {
  return scrollPosition <= 1
}

export function shouldDeferViewportProjectionSync({
  wheelZoomBurstActive,
  mousePanBurstActive,
}: ViewportProjectionSyncDecision) {
  return wheelZoomBurstActive || mousePanBurstActive
}
