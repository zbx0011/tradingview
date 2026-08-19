import { describe, expect, it } from 'vitest'
import { normalizedWheelDelta, zoomLogicalRangeAt } from './chartWheelZoom'

describe('chart wheel zoom', () => {
  it('normalizes pixel, line, and page deltas without discarding magnitude', () => {
    expect(normalizedWheelDelta(120, 0)).toBe(120)
    expect(normalizedWheelDelta(3, 1)).toBe(96)
    expect(normalizedWheelDelta(2, 2)).toBe(240)
    expect(normalizedWheelDelta(Number.NaN, 0)).toBe(0)
  })

  it('keeps the logical candle below the pointer fixed', () => {
    const current = { from: 0, to: 100 }
    const anchor = 25
    const next = zoomLogicalRangeAt(current, anchor, -120)
    const anchorRatioBefore = (anchor - current.from) / (current.to - current.from)
    const anchorRatioAfter = (anchor - next.from) / (next.to - next.from)

    expect(next.to - next.from).toBeLessThan(100)
    expect(anchorRatioAfter).toBeCloseTo(anchorRatioBefore, 10)
  })

  it('preserves every fast-wheel step when events are accumulated', () => {
    const current = { from: 0, to: 100 }
    const anchor = 40
    const first = zoomLogicalRangeAt(current, anchor, 120)
    const second = zoomLogicalRangeAt(first, anchor, 120)
    const accumulated = zoomLogicalRangeAt(current, anchor, 240)

    expect(accumulated.from).toBeCloseTo(second.from, 10)
    expect(accumulated.to).toBeCloseTo(second.to, 10)
  })

  it('respects the minimum and maximum visible spans', () => {
    const range = { from: 0, to: 100 }
    expect(zoomLogicalRangeAt(range, 50, -100_000, { minSpan: 6 }).to - zoomLogicalRangeAt(range, 50, -100_000, { minSpan: 6 }).from).toBe(6)
    expect(zoomLogicalRangeAt(range, 50, 100_000, { maxSpan: 500 }).to - zoomLogicalRangeAt(range, 50, 100_000, { maxSpan: 500 }).from).toBe(500)
  })
})
