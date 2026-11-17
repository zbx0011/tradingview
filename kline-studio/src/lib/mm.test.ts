import { describe, expect, it } from 'vitest'
import { detectMm, detectSpikeMm, isMmLive } from './mm'
import type { Candle } from './market'

/** Candles walking through the given closes (open = previous close), 0.25 wicks. */
function walk(closes: number[], seconds = 60): Candle[] {
  return closes.map((close, i) => {
    const open = i ? closes[i - 1] : close
    return { time: 1_700_000_000 + i * seconds, open, high: Math.max(open, close) + 0.25, low: Math.min(open, close) - 0.25, close, volume: 1 }
  })
}

const run = (from: number, to: number) => Array.from({ length: Math.abs(to - from) }, (_, k) => from + Math.sign(to - from) * (k + 1))

// H = 110.25 (bar 10), pullback to L = 105.75 (bar 14), breakout bar 19 closes 111 > H, bar 20 follows through.
const base = [100, ...run(100, 110), ...run(110, 106), ...run(106, 112)]
// The walk's bars are exactly one ATR long; allow a little under so rounding in the ATR does not decide.
const ups = (candles: Candle[]) => detectMm(candles, { minBreakoutRangeAtr: 0.95 }).filter((p) => p.direction === 'up')

describe('detectMm', () => {
  it('measures from the swing low before the breakout to the broken high, doubled from the high', () => {
    const [p] = ups(walk(base))
    expect(p.h.price).toBeCloseTo(110.25)
    expect(p.l.price).toBeCloseTo(105.75)
    expect(p.target).toBeCloseTo(114.75)
    // Body version: body top of the high bar 110, body bottom of the low bar 106.
    expect(p.bodyTarget).toBeCloseTo(114)
    expect(p.breakoutIndex).toBe(19)
    expect(p.confirmedIndex).toBe(20)
    expect(p.status).toBe('live')
    expect(isMmLive(p)).toBe(true)
  })

  it('marks the MM reached when price gets there', () => {
    const [p] = ups(walk([...base, ...run(112, 115)]))
    expect(p.status).toBe('reached')
    expect(p.bodyReachedIndex).toBeGreaterThan(0)
    expect(isMmLive(p)).toBe(false)
  })

  it('ends the MM when the breakout gap is filled first', () => {
    const [p] = ups(walk([...base, ...run(112, 110)]))
    expect(p.status).toBe('filled')
  })

  it('needs follow-through: no MM when the bar after the breakout closes back', () => {
    const closes = [100, ...run(100, 110), ...run(110, 106), ...run(106, 111), 110.75, 110.5]
    expect(ups(walk(closes))).toHaveLength(0)
  })

  it('waits for the follow-through bar before the MM counts', () => {
    const [p] = ups(walk([100, ...run(100, 110), ...run(110, 106), ...run(106, 111)]))
    expect(p.status).toBe('pending')
    expect(isMmLive(p)).toBe(true)
  })

  it('needs a strong breakout bar: a small-bodied bar closing above the high does not count', () => {
    const candles = walk(base)
    candles[19] = { ...candles[19], open: 110.75, close: 111, high: 112, low: 109.5 }
    expect(ups(candles)).toHaveLength(0)
  })

  it('measures a range from its top to its bottom, and smaller tops inside it by their own swings', () => {
    // Top 120.25, a smaller top 115.75 inside the range, bottom 107.75, then a rally through both.
    const inner = [111, 112, 113, 114, 115.5, 114.5, 113.5, 112.5, 111.5, 110.5, 109.5, 108.5, 108]
    const closes = [100, ...run(100, 120), ...run(120, 110), ...inner, ...run(108, 124)]
    const found = ups(walk(closes))
    const top = found.find((p) => p.h.price === 120.25)!
    expect(top.l.price).toBeCloseTo(107.75)
    expect(top.target).toBeCloseTo(132.75)
    const small = found.find((p) => p.h.price === 115.75)!
    expect(small.l.price).toBeCloseTo(107.75)
    expect(small.target).toBeCloseTo(123.75)
    expect(top.prominence).toBeGreaterThan(small.prominence)
  })

  it('keeps the range when a wick pokes just above the top and closes back inside', () => {
    const candles = walk([100, ...run(100, 120), ...run(120, 110), ...run(110, 115), ...run(115, 108), ...run(108, 119)])
    const t = candles[candles.length - 1].time
    candles.push({ time: t + 60, open: 119, high: 120.75, low: 118.75, close: 119.25, volume: 1 })
    const rest = walk([119.25, ...run(119, 117), ...run(117, 124)]).slice(1).map((c, k) => ({ ...c, time: t + 120 + k * 60 }))
    const [p] = ups([...candles, ...rest]).filter((x) => x.h.price === 120.75)
    expect(p.l.price).toBeCloseTo(107.75)
    expect(p.target).toBeCloseTo(133.75)
  })

  it('measures from the lower bottom of a double bottom on the left of H', () => {
    // Bottom 99.75, H 106.25, a slightly higher second bottom 100.75, then the breakout: the range bottom is 99.75.
    const closes = [104, ...run(104, 100), ...run(100, 106), ...run(106, 101), ...run(101, 110)]
    const [p] = ups(walk(closes)).filter((x) => x.h.price === 106.25)
    expect(p.l.price).toBeCloseTo(99.75)
    expect(p.target).toBeCloseTo(112.75)
  })

  it('mirrors downwards', () => {
    const mirror = (c: Candle): Candle => ({ ...c, open: 200 - c.open, close: 200 - c.close, high: 200 - c.low, low: 200 - c.high })
    const [p] = detectMm(walk(base).map(mirror)).filter((x) => x.direction === 'down')
    expect(p.h.price).toBeCloseTo(89.75)
    expect(p.l.price).toBeCloseTo(94.25)
    expect(p.target).toBeCloseTo(85.25)
    expect(p.bodyTarget).toBeCloseTo(86)
  })
})

describe('detectSpikeMm', () => {
  // A quiet stretch (ATR about 1.5), then three big bull bars 100 → 103 → 106 → 109.
  const quiet = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 ? 0.5 : 0))
  const spike = (extra: number[]) => {
    const candles = walk([...quiet, 100])
    const t = candles[candles.length - 1].time
    const bars = [[100, 103], [103, 106], [106, 109]].map(([o, c], k) => ({ time: t + 60 * (k + 1), open: o, high: c + 0.25, low: o - 0.25, close: c, volume: 1 }))
    const rest = walk([109, ...extra]).slice(1).map((c, k) => ({ ...c, time: t + 60 * (k + 4) }))
    return [...candles, ...bars, ...rest]
  }

  it('doubles the body of the run of big bars from its last close, and the wick run from its high', () => {
    const [p] = detectSpikeMm(spike([108.5, 108])).filter((x) => x.direction === 'up')
    expect(p.kind).toBe('spike')
    expect(p.bodyTarget).toBeCloseTo(118)
    expect(p.l.price).toBeCloseTo(99.75)
    expect(p.h.price).toBeCloseTo(109.25)
    expect(p.target).toBeCloseTo(118.75)
    expect(p.status).toBe('live')
  })

  it('reaches, or fails when price closes back below the first open', () => {
    const [up] = detectSpikeMm(spike([108.5, 110, 111.5, 113, 114.5, 116, 117.5, 119])).filter((x) => x.direction === 'up')
    expect(up.status).toBe('reached')
    const [down] = detectSpikeMm(spike([105, 102, 99])).filter((x) => x.direction === 'up')
    expect(down.status).toBe('failed')
  })
})
