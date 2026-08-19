import { describe, expect, it } from 'vitest'
import {
  isRealtimeScrollPosition,
  shouldDeferViewportProjectionSync,
  shouldFollowRealtime,
} from './chartViewport'

describe('chart viewport live-follow behavior', () => {
  it('keeps following live data while the viewport is already at the realtime edge', () => {
    expect(shouldFollowRealtime({
      shouldFocusLatest: false,
      followLatest: true,
      wasAtRealtime: true,
      previousLength: 100,
      nextLength: 101,
    })).toBe(true)
  })

  it('preserves a historical viewport during a live data refresh', () => {
    expect(shouldFollowRealtime({
      shouldFocusLatest: false,
      followLatest: true,
      wasAtRealtime: false,
      previousLength: 100,
      nextLength: 101,
    })).toBe(false)
  })

  it('allows an explicit symbol or dataset focus to jump to the latest candle', () => {
    expect(shouldFollowRealtime({
      shouldFocusLatest: true,
      hasVisibleRange: false,
      followLatest: false,
      wasAtRealtime: false,
      previousLength: 100,
      nextLength: 90,
    })).toBe(true)
  })

  it('does not overwrite an existing viewport when a data hydration key changes', () => {
    expect(shouldFollowRealtime({
      shouldFocusLatest: true,
      hasVisibleRange: true,
      followLatest: false,
      wasAtRealtime: false,
      previousLength: 100,
      nextLength: 120,
    })).toBe(false)
  })

  it('treats zero, future whitespace, and a sub-bar offset as realtime', () => {
    expect(isRealtimeScrollPosition(0)).toBe(true)
    expect(isRealtimeScrollPosition(-8)).toBe(true)
    expect(isRealtimeScrollPosition(0.8)).toBe(true)
    expect(isRealtimeScrollPosition(2)).toBe(false)
  })
})

describe('chart viewport projection scheduling', () => {
  it('defers expensive overlays during either continuous input burst', () => {
    expect(shouldDeferViewportProjectionSync({
      wheelZoomBurstActive: true,
      mousePanBurstActive: false,
    })).toBe(true)
    expect(shouldDeferViewportProjectionSync({
      wheelZoomBurstActive: false,
      mousePanBurstActive: true,
    })).toBe(true)
  })

  it('allows one projection sync after zooming and panning are idle', () => {
    expect(shouldDeferViewportProjectionSync({
      wheelZoomBurstActive: false,
      mousePanBurstActive: false,
    })).toBe(false)
  })
})
