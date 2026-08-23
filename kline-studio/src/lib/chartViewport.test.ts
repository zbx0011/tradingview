import { describe, expect, it } from 'vitest'
import {
  centeredLatestLogicalRange,
  initialChartLogicalRange,
  isRealtimeScrollPosition,
  shouldDeferViewportProjectionSync,
  shouldFollowRealtime,
  viewportActionAfterDataUpdate,
} from './chartViewport'

describe('chart viewport default placement', () => {
  it('places the latest candle exactly at the horizontal center', () => {
    const range = centeredLatestLogicalRange(200)
    expect((range.from + range.to) / 2).toBe(199)
  })

  it('centers decision replay on first load instead of restoring an old viewport', () => {
    expect(initialChartLogicalRange(200, { from: 10, to: 50 }, true)).toEqual(centeredLatestLogicalRange(200))
    expect(initialChartLogicalRange(200, { from: 10, to: 50 }, false)).toEqual({ from: 10, to: 50 })
  })
})

describe('chart viewport live-follow behavior', () => {
  it('does not apply a viewport action while a decision candidate switches through empty data', () => {
    expect(viewportActionAfterDataUpdate({
      focusReady: true,
      hasVisibleRange: true,
      followLatest: true,
      wasAtRealtime: true,
      previousLength: 100,
      nextLength: 0,
    })).toBe('none')
  })

  it('preserves the complete decision viewport when key 1 reveals one more candle', () => {
    expect(viewportActionAfterDataUpdate({
      focusReady: false,
      hasVisibleRange: true,
      followLatest: false,
      wasAtRealtime: true,
      previousLength: 100,
      nextLength: 101,
    })).toBe('preserve')
  })

  it('only recenters a decision chart for an explicit candidate focus request', () => {
    expect(viewportActionAfterDataUpdate({
      focusReady: true,
      hasVisibleRange: true,
      followLatest: false,
      wasAtRealtime: false,
      previousLength: 100,
      nextLength: 101,
    })).toBe('center')
  })

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
  it('defers expensive overlays during a continuous wheel burst', () => {
    expect(shouldDeferViewportProjectionSync({
      wheelZoomBurstActive: true,
      mousePanBurstActive: false,
    })).toBe(true)
  })

  it('defers React projection while pointer panning uses a compositor preview', () => {
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
