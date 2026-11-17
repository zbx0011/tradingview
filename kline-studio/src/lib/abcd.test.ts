import { describe, expect, it } from 'vitest'
import { detectAbcd, detectSpikeChannelAbcd, isAbcdAtTarget, isAbcdLive } from './abcd'
import { computeChartAbcd } from './abcdChart'
import type { Candle } from './market'

/** Candles walking through the given closes (open = previous close), 0.25 wicks. */
function walk(closes: number[], seconds = 60): Candle[] {
  return closes.map((close, i) => {
    const open = i ? closes[i - 1] : close
    return { time: 1_700_000_000 + i * seconds, open, high: Math.max(open, close) + 0.25, low: Math.min(open, close) - 0.25, close, volume: 1 }
  })
}

const run = (from: number, to: number) => Array.from({ length: Math.abs(to - from) }, (_, k) => from + Math.sign(to - from) * (k + 1))

// A = 100, B = 110, pullback to C = 105: D = 104.75 + (110.25 − 99.75) = 115.25.
const base = [100, 100, ...run(100, 110), ...run(110, 105)]
const up = (closes: number[]) => detectAbcd(walk(closes)).filter((p) => p.direction === 'up')

describe('detectAbcd', () => {
  it('projects D = C + (B − A) on wicks and on bodies', () => {
    const [p] = up([...base, ...run(105, 115), ...run(115, 110)])
    expect(p.a.price).toBeCloseTo(99.75)
    expect(p.b.price).toBeCloseTo(110.25)
    expect(p.c.price).toBeCloseTo(104.75)
    expect(p.d).toBeCloseTo(115.25)
    expect(p.bodyD).toBeCloseTo(105 + (110 - 100))
  })

  it('keeps a CD leg that ends at D', () => {
    const [p] = up([...base, ...run(105, 115), ...run(115, 110)])
    expect(p.e!.price).toBeCloseTo(115.25)
    expect(p.outcome).toBe('near')
    expect(isAbcdAtTarget(p)).toBe(true)
  })

  it('drops a CD leg that stops short of D', () => {
    const [p] = up([...base, ...run(105, 112), ...run(112, 107)])
    expect(p.outcome).toBe('short')
    expect(isAbcdAtTarget(p)).toBe(false)
  })

  it('keeps a CD leg that stops a little short of D', () => {
    const [p] = up([...base, ...run(105, 114), 114.5, ...run(114, 109)])
    expect(p.outcome).toBe('near')
  })

  it('keeps a pin that spikes through D and closes back below it', () => {
    const candles = walk([...base, ...run(105, 115), ...run(115, 110)])
    const k = candles.findIndex((c, i) => i > 20 && c.close === 115)
    candles[k] = { ...candles[k], high: 116.75 }
    const [p] = detectAbcd(candles).filter((x) => x.direction === 'up')
    expect(p.e!.price).toBeCloseTo(116.75)
    expect(p.outcome).toBe('near')
  })

  it('drops a CD leg that runs through D', () => {
    const [p] = up([...base, ...run(105, 120), ...run(120, 115)])
    expect(p.outcome).toBe('over')
    expect(isAbcdAtTarget(p)).toBe(false)
  })

  it('has no outcome while C is provisional, and is live', () => {
    const [p] = up([...base, 106, 107])
    expect(p.confirmedIndex).toBe(-1)
    expect(p.outcome).toBe(null)
    expect(isAbcdLive(p)).toBe(true)
  })

  it('stays live while the CD leg runs below D', () => {
    const [p] = up([...base, ...run(105, 113)])
    expect(p.outcome).toBe('short')
    expect(isAbcdLive(p)).toBe(true)
  })

  it('is not live once the CD leg has run through D', () => {
    const [p] = up([...base, ...run(105, 118)])
    expect(p.outcome).toBe('over')
    expect(isAbcdLive(p)).toBe(false)
  })

  it('keeps the CD leg running through a pullback smaller than BC', () => {
    // CD stalls at 112 and pulls back 3.5 (BC was 5.5): still on its way to D = 115.25.
    const stalled = up([...base, ...run(105, 112), ...run(112, 109)])
    expect(stalled[0].d).toBeCloseTo(115.25)
    expect(stalled[0].endIndex).toBe(-1)
    expect(stalled[0].outcome).toBe('short')
    expect(isAbcdLive(stalled[0])).toBe(true)
    // The smaller AB=CD forming inside that leg is found as well: A = the outer C.
    expect(stalled[1].a.price).toBeCloseTo(104.75)
    expect(stalled[1].b.price).toBeCloseTo(112.25)
    // The leg then goes on to D and ends there.
    const [done] = up([...base, ...run(105, 112), ...run(112, 109), ...run(109, 115), ...run(115, 112)])
    expect(done.e!.price).toBeCloseTo(115.25)
    expect(done.outcome).toBe('near')
    expect(done.endIndex).toBeGreaterThan(0)
  })

  it('ends a CD leg short of D once it pulls back as deep as BC', () => {
    const [p] = up([...base, ...run(105, 112), ...run(112, 106)])
    expect(p.outcome).toBe('short')
    expect(p.endIndex).toBeGreaterThan(0)
    expect(isAbcdLive(p)).toBe(false)
  })

  it('measures AB from the start of the advance, through pullbacks smaller than BC', () => {
    // 100 → 106, a 2.5 dip, → 112, then a 5.5 pullback: AB is the whole advance 99.75 → 112.25.
    const found = up([100, 100, ...run(100, 106), ...run(106, 104), ...run(104, 112), ...run(112, 107)])
    const p = found[found.length - 1]
    expect(p.a.price).toBeCloseTo(99.75)
    expect(p.b.price).toBeCloseTo(112.25)
    expect(p.c.price).toBeCloseTo(106.75)
    expect(p.d).toBeCloseTo(119.25)
  })

  it('starts AB at the later low when the pullback before it gave back most of the advance', () => {
    // Low 99.75, bounce to 103.25, back to 100.25 (a double bottom): the leg into B starts at 100.25.
    const found = up([105, ...run(105, 100), ...run(100, 103), 102, 101, 100.5, ...run(100.5, 110.5), ...run(110.5, 105.5)])
    const p = found[found.length - 1]
    expect(p.a.price).toBeCloseTo(100.25)
    expect(p.b.price).toBeCloseTo(110.75)
  })

  it('abandons the projection when A breaks before B is exceeded', () => {
    const [p] = up([...base, ...run(105, 95)])
    expect(p.abandoned).toBe(true)
    expect(isAbcdLive(p)).toBe(false)
  })
})

describe('computeChartAbcd', () => {
  it('returns only patterns at D, labelled with their level', () => {
    const candles = walk([...base, ...run(105, 115), ...run(115, 110), ...run(110, 120), ...run(120, 116)])
    const found = computeChartAbcd({ candles }, {}, ['1m'])
    expect(found.length).toBeGreaterThan(0)
    expect(found.every((p) => p.timeframe === '1m' && (p.live || p.outcome === 'near'))).toBe(true)
  })

  it('draws the newest live projection ahead of time, with D to the right of C', () => {
    const candles = walk([...base, ...run(105, 113)])
    const live = computeChartAbcd({ candles }, {}, ['1m']).filter((p) => p.live)
    expect(live).toHaveLength(1)
    expect(live[0].d).toBeCloseTo(115.25)
    expect(live[0].dIndex).toBeGreaterThan(live[0].c.index)
  })

  it('draws every projection still in play: the larger AB=CD and the smaller one inside its CD leg', () => {
    const candles = walk([...base, ...run(105, 112), ...run(112, 109)])
    const live = computeChartAbcd({ candles }, {}, ['1m']).filter((p) => p.live)
    expect(live.map((p) => p.d)).toEqual([115.25, 116.25])
  })

  it('does not build levels finer than the chart without a minute tape', () => {
    const candles = walk([...base, ...run(105, 115), ...run(115, 110)], 300)
    expect(computeChartAbcd({ candles }, {}, ['1m'])).toHaveLength(0)
  })
})

describe('detectSpikeChannelAbcd', () => {
  // Quiet bars (ATR about 0.75), a spike 100 → 109 in three big bars, a small pullback, then a channel.
  const quiet = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 ? 0.5 : 0))
  const build = (after: number[]) => {
    const candles = walk([...quiet, 100])
    const t = candles[candles.length - 1].time
    const spike = [[100, 103], [103, 106], [106, 109]].map(([o, c], k) => ({ time: t + 60 * (k + 1), open: o, high: c + 0.25, low: o - 0.25, close: c, volume: 1 }))
    const rest = walk([109, ...after]).slice(1).map((c, k) => ({ ...c, time: t + 60 * (k + 4) }))
    return [...candles, ...spike, ...rest]
  }
  // Pullback to 107 (low 106.75), then a slow channel of 0.5 steps.
  const pullback = [108.5, 108, 107.5, 107]
  const channel = (to: number) => Array.from({ length: Math.round((to - 107) / 0.5) }, (_, k) => 107 + 0.5 * (k + 1))

  it('measures from the spike start to the spike top, projected from the start of the channel', () => {
    const [p] = detectSpikeChannelAbcd(build([...pullback, ...channel(110)])).filter((x) => x.direction === 'up')
    expect(p.kind).toBe('spike')
    expect(p.a.price).toBeCloseTo(99.75)
    expect(p.b.price).toBeCloseTo(109.25)
    expect(p.c.price).toBeCloseTo(106.75)
    expect(p.d).toBeCloseTo(116.25)
    expect(isAbcdLive(p)).toBe(true)
  })

  it('ends at D when the channel gets there', () => {
    const [p] = detectSpikeChannelAbcd(build([...pullback, ...channel(116)])).filter((x) => x.direction === 'up')
    expect(p.outcome).toBe('near')
    expect(isAbcdAtTarget(p)).toBe(true)
  })

  it('is not a spike and channel when the pullback gives back most of the spike', () => {
    expect(detectSpikeChannelAbcd(build([107, 105, 103, 101.5, 103, 105, 107, 109, 110])).filter((x) => x.direction === 'up')).toHaveLength(0)
  })
})
