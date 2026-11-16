import { describe, expect, it } from 'vitest'
import { detectBarCounts } from './barCount'
import type { Candle } from './market'

/** Candles walking through the given closes (open = previous close), 0.25 wicks. */
function walk(closes: number[]): Candle[] {
  return closes.map((close, i) => {
    const open = i ? closes[i - 1] : close
    return { time: 1_700_000_000 + i * 60, open, high: Math.max(open, close) + 0.25, low: Math.min(open, close) - 0.25, close, volume: 1 }
  })
}

const run = (from: number, to: number) => Array.from({ length: Math.abs(to - from) }, (_, k) => from + Math.sign(to - from) * (k + 1))
const labels = (closes: number[]) => detectBarCounts(walk(closes)).map((m) => `${m.kind}${m.count}@${m.index}`)

// 100 → 110 bull leg; indexes: 0 = 100, 10 = 110.
const bull = [100, ...run(100, 110)]
const bear = [110, ...run(110, 100)]

describe('detectBarCounts', () => {
  it('marks High 1 on the first bar above the prior high after a pullback', () => {
    const marks = detectBarCounts(walk([...bull, 109, 108, 109.5]))
    const h = marks.filter((m) => m.kind === 'H')
    expect(h).toHaveLength(1)
    expect(h[0].count).toBe(1)
    expect(h[0].index).toBe(13)
    expect(h[0].entry).toBeCloseTo(109.25)
  })

  it('counts High 2 only after the pullback makes another leg down', () => {
    // 14 = 108 (no lower low than the H1 bar), 15 = 107 (new leg down), 16 = 108.5 → H2.
    expect(labels([...bull, 109, 108, 109.5, 108, 107, 108.5]).filter((x) => x.startsWith('H'))).toEqual(['H1@13', 'H2@16'])
  })

  it('does not count a second push without a new leg down', () => {
    // After H1, an inside bar then a higher high: still only H1.
    expect(labels([...bull, 109, 108, 109.5, 109.25, 109.75]).filter((x) => x.startsWith('H'))).toEqual(['H1@13'])
  })

  it('restarts the count after a new high of the leg', () => {
    const closes = [...bull, 109, 108, 109.5, ...run(109.5, 112), 111, 110, 111.5]
    const h = detectBarCounts(walk(closes)).filter((m) => m.kind === 'H')
    expect(h.map((m) => m.count)).toEqual([1, 1])
  })

  it('starts again from High 1 once the buy has worked (a rise of 2 ATR) without a new high', () => {
    const closes = [...bull, ...run(110, 104), 105.5, 106.5, 107.5, 108, 107, 106, 107.5]
    expect(detectBarCounts(walk(closes)).filter((m) => m.kind === 'H').map((m) => m.count)).toEqual([1, 1])
  })

  it('counts Low 1 and Low 2 in a rally of a bear leg (mirror image)', () => {
    expect(labels([...bear, 101, 102, 100.5, 102, 103, 101.5]).filter((x) => x.startsWith('L'))).toEqual(['L1@13', 'L2@16'])
  })

  it('counts Low 1 in every new rally: a rally that starts after the sell worked counts from 1 again', () => {
    // Rally 100 → 106.5, L1 at 10, the sell works (drop of 2 ATR), new rally to 105, then a lower low = L1 again (not L2).
    const closes = [100, ...run(100, 106), 105, 106.5, ...run(106.5, 102), 103, 104, 105, 103.5]
    expect(detectBarCounts(walk(closes)).filter((m) => m.kind === 'L').map((m) => `L${m.count}@${m.index}`)).toEqual(['L1@10', 'L1@16'])
  })

  it('labels at most High 3', () => {
    const closes = [...bull, 109, 108, 109.5, 108, 107, 108.5, 107.5, 106, 107.75, 106.5, 105, 106.5]
    expect(detectBarCounts(walk(closes)).filter((m) => m.kind === 'H').map((m) => m.count)).toEqual([1, 2, 3])
  })
})
