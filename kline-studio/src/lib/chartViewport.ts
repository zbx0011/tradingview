interface RealtimeFollowDecision {
  shouldFocusLatest: boolean
  hasVisibleRange?: boolean
  followLatest: boolean
  wasAtRealtime: boolean
  previousLength: number
  nextLength: number
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
