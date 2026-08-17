import { describe, expect, it } from 'vitest'
import { clampContextMenuPosition, countActiveIndicators } from './chartContext'

describe('chart context menu helpers', () => {
  it('keeps the menu inside the viewport', () => {
    expect(clampContextMenuPosition(1180, 760, 1200, 800)).toEqual({ left: 772, top: 72 })
    expect(clampContextMenuPosition(-20, -30, 1200, 800)).toEqual({ left: 8, top: 8 })
  })

  it('counts visible indicators for the destructive menu label', () => {
    expect(countActiveIndicators({ ma: true, ema: false, boll: true, volume: true })).toBe(3)
  })
})
