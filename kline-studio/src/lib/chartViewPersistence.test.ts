import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureChartView, loadChartView, restoredChartRange, saveChartView } from './chartViewPersistence'

afterEach(() => vi.unstubAllGlobals())

describe('chart viewport persistence', () => {
  it('anchors to a candle timestamp rather than a changing history index', () => {
    const snapshot = captureChartView([100, 200, 300, 400], { from: .5, to: 3.5 }, { from: 90, to: 120 })!
    expect(restoredChartRange([50, 100, 200, 300, 400], snapshot)).toEqual({ from: 1.5, to: 4.5 })
    expect(restoredChartRange([500, 600], snapshot)).toBeNull()
  })

  it('retains off-chart whitespace and manual price zoom across a new page', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
    const snapshot = captureChartView([100, 200, 300], { from: -20, to: 70 }, { from: 50, to: 80 })!
    saveChartView('NQ1!', '5m', snapshot)
    expect(loadChartView('NQ1!', '5m')).toEqual(snapshot)
    expect(restoredChartRange([100, 200, 300], loadChartView('NQ1!', '5m')!)).toEqual({ from: -20, to: 70 })
    expect(loadChartView('NQ1!', '1m')).toBeNull()
  })

  it('rejects damaged state without breaking chart initialization', () => {
    vi.stubGlobal('localStorage', { getItem: () => '{"anchorTime":null,"anchorOffset":0,"span":10}' })
    expect(loadChartView('NQ1!', '5m')).toBeNull()
    expect(captureChartView([], { from: 0, to: 10 }, null)).toBeNull()
  })
})
