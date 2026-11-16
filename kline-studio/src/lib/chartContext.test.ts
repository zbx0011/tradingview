import { describe, expect, it } from 'vitest'
import { clampContextMenuPosition, countActiveIndicators } from './chartContext'

describe('chart context menu helpers', () => {
  it('keeps the menu inside the viewport', () => {
    expect(clampContextMenuPosition(1180, 760, 1200, 800)).toEqual({ left: 772, top: 72 })
    expect(clampContextMenuPosition(-20, -30, 1200, 800)).toEqual({ left: 8, top: 8 })
  })

  it('counts visible indicators for the destructive menu label', () => {
    expect(countActiveIndicators({ ma: true, ema: false, boll: true, volume: true, smc: false, threePush: false })).toBe(3)
    // Both overlays are on unless explicitly switched off, including old workspaces.
    expect(countActiveIndicators({ ma: true, ema: false, boll: true, volume: true })).toBe(5)
    expect(countActiveIndicators({ ma: false, ema: false, boll: false, volume: false, smc: false, threePush: true })).toBe(1)
    expect(countActiveIndicators({ ma: false, ema: false, boll: false, volume: false, smc: false, threePushTimeframes: { '1m': false, '5m': false, '15m': false } })).toBe(0)
  })
})
