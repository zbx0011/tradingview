import { describe, expect, it } from 'vitest'
import type { Candle } from './market'
import { aggregateCandles } from './market'
import { computeChartThreePushes, DEFAULT_THREE_PUSH_OPTIONS, detectThreePushes } from './threePush'
import nqFirstPushFixture from './fixtures/nq-20241126-false-first-push.json'

const START = Date.UTC(2024, 10, 26, 0, 0) / 1000
const bar = (index: number, high: number, low: number, close = (high + low) / 2, seconds = 60): Candle =>
  ({ time: START + index * seconds, open: close, high, low, close, volume: 1 })
const UP = [
  ...Array.from({ length: 20 }, (_, i) => bar(i, 100, 99)),
  bar(20, 102, 99.5), bar(21, 106, 101),
  bar(22, 105, 103), bar(23, 104, 102), bar(24, 108, 103),
  bar(25, 107, 105), bar(26, 106, 104), bar(27, 110, 105),
  bar(28, 112, 109), bar(29, 111, 109), bar(30, 110, 108), bar(31, 114, 109),
  bar(32, 113, 111), bar(33, 112, 110), bar(34, 116, 111),
]
const upPatterns = (candles: Candle[]) => detectThreePushes(candles).filter((p) => p.direction === 'up')
const mirror = (c: Candle): Candle => ({ ...c, high: 300 - c.low, low: 300 - c.high, open: 300 - c.open, close: 300 - c.close })
const expandFiveMinute = (data: Candle[]): Candle[] => data.flatMap((c, i) =>
  Array.from({ length: 5 }, (_, j) => ({ ...c, time: START + i * 300 + j * 60 })))

describe('three pushes', () => {
  it('defaults to the usable two-bar / one ATR(20) pullback threshold', () => {
    expect(DEFAULT_THREE_PUSH_OPTIONS).toMatchObject({ atrPeriod: 20, minPullbackBars: 2, minPullbackAtr: 1, maxPushes: 5, maxHistoryBars: 20_000 })
  })

  it('does not count the resetting selloff as an upward first push (or its downward mirror)', () => {
    const data = [
      ...UP.slice(0, 20),
      { ...bar(20, 102, 90, 91), open: 101 }, // A selloff cannot supply its own subsequent up leg.
      bar(21, 96, 91), bar(22, 95, 92), bar(23, 105, 93),
      bar(24, 104, 98), bar(25, 103, 97), bar(26, 108, 100),
      bar(27, 107, 101), bar(28, 106, 100), bar(29, 111, 102),
    ]
    for (const mirrored of [false, true]) {
      const candles = mirrored ? data.map(mirror) : data
      const direction = mirrored ? 'down' : 'up'
      const patterns = detectThreePushes(candles).filter((p) => p.direction === direction)
      expect(patterns).toHaveLength(1)
      expect(patterns[0].pushes.map((p) => p.peak.index)).toEqual([23, 26, 29])
      expect(patterns[0].start.index).toBe(20)
      expect(patterns[0].confirmedIndex).toBe(29)
      expect(detectThreePushes(candles.slice(0, 29)).filter((p) => p.direction === direction)).toEqual([])
    }
  })

  it('allows a real first push below the resetting candle high, including a single-candle spike', () => {
    const data = [
      ...UP.slice(0, 20), { ...bar(20, 110, 90, 91), open: 109 },
      { ...bar(21, 100, 91, 92), open: 99 }, // A later spike can count even if its body closes down.
      bar(22, 99, 95), bar(23, 98, 94), bar(24, 103, 96),
      bar(25, 102, 97), bar(26, 101, 96), bar(27, 106, 98),
    ]
    for (const candles of [data, data.map(mirror)]) {
      const direction = candles === data ? 'up' : 'down'
      const patterns = detectThreePushes(candles).filter((p) => p.direction === direction)
      expect(patterns).toHaveLength(1)
      expect(patterns[0].pushes.map((p) => p.peak.index)).toEqual([21, 24, 27])
      expect(patterns[0].pushes[0].start.index).toBeLessThan(patterns[0].pushes[0].peak.index)
    }
  })

  it('reveals a three-push pattern on the third breakout candle, with no future pivot confirmation', () => {
    expect(upPatterns(UP.slice(0, 27))).toHaveLength(0)
    expect(upPatterns(UP.slice(0, 28))).toHaveLength(1)
    expect(upPatterns(UP.slice(0, 28))[0]).toMatchObject({ confirmedIndex: 27, confirmedTime: UP[27].time })
    expect(upPatterns(UP.slice(0, 28))[0].pushes.map((p) => p.peak.index)).toEqual([21, 24, 27])
    for (let length = 1; length <= UP.length; length += 1) {
      expect(detectThreePushes(UP.slice(0, length)).every((p) => p.confirmedIndex < length && p.pushes.every((push) => push.start.index < push.peak.index && push.peak.index < length))).toBe(true)
    }
  })

  it('keeps continuing highs in the same push, then counts four and five qualified pushes', () => {
    expect(upPatterns(UP.slice(0, 29))[0].pushes).toHaveLength(3)
    expect(upPatterns(UP.slice(0, 29))[0].pushes[2].peak.index).toBe(28)
    expect(upPatterns(UP.slice(0, 32))[0].pushes).toHaveLength(4)
    expect(upPatterns(UP)[0].pushes).toHaveLength(5)
    expect(upPatterns(UP)[0].confirmedIndex).toBe(27)
  })

  it('does not split a microchannel or shallow / one-bar pauses into new pushes', () => {
    expect(detectThreePushes(Array.from({ length: 80 }, (_, i) => bar(i, 100 + i, 99 + i)))).toEqual([])
    const oneBar = UP.filter((_, i) => ![23, 26, 30, 33].includes(i))
    expect(upPatterns(oneBar)).toEqual([])
    const shallow = UP.map((c, i) => {
      if (![22, 23, 25, 26, 29, 30, 32, 33].includes(i)) return c
      const peak = UP[i - (i === 22 || i === 25 || i === 29 || i === 32 ? 1 : 2)].high
      return { ...c, high: peak - .02, low: peak - .03, open: peak - .025, close: peak - .025 }
    })
    expect(upPatterns(shallow)).toEqual([])
  })

  it('mirrors lows for downward pushes and retains completed shapes after structural failure', () => {
    const down = detectThreePushes(UP.map(mirror)).find((p) => p.direction === 'down')!
    expect(down.pushes).toHaveLength(5)
    expect(down.confirmedIndex).toBe(27)
    const broken = [...UP.slice(0, 28), bar(28, 109, 100)]
    expect(upPatterns(broken)[0].pushes).toHaveLength(3)
    expect(upPatterns(broken)[0].pushes[2].peak.index).toBe(27)
  })

  it('marks EQH (equal extreme) and allows the thresholds to be changed in one options object', () => {
    const equal = UP.slice(0, 28).map((c, i) => i === 27 ? { ...c, high: 108 } : c)
    expect(upPatterns(equal)[0]).toMatchObject({ equalExtreme: true })
    expect(detectThreePushes(equal, { equalExtremeToleranceAtr: 0 }).filter((p) => p.direction === 'up')).toHaveLength(0)
    const oneBar = UP.filter((_, i) => ![23, 26, 30, 33].includes(i))
    expect(detectThreePushes(oneBar, { minPullbackBars: 1, minPullbackAtr: .5 }).some((p) => p.direction === 'up' && p.pushes.length >= 3)).toBe(true)
  })
})

/** n pushes: 20 flat candles, then per push one spike candle followed by a two-candle pullback of 4 points. */
const wedge = (n: number): Candle[] => [
  ...Array.from({ length: 20 }, (_, i) => bar(i, 100, 99)),
  bar(20, 102, 99.5),
  ...Array.from({ length: n }, (_, k) => [bar(21 + 3 * k, 106 + 2 * k, 101 + 2 * k), bar(22 + 3 * k, 105 + 2 * k, 103 + 2 * k), bar(23 + 3 * k, 104 + 2 * k, 102 + 2 * k)]).flat(),
]

describe('three-push count limit', () => {
  it('stops a wedge at five pushes and counts again from the last pullback', () => {
    const counts = (n: number) => upPatterns(wedge(n)).map((p) => p.pushes.length)
    expect(counts(5)).toEqual([5])
    // A sixth and seventh push are only the first and second of a new count: nothing to show yet.
    expect(counts(7)).toEqual([5])
    const restarted = upPatterns(wedge(8))
    expect(restarted.map((p) => p.pushes.map((push) => push.peak.index))).toEqual([[21, 24, 27, 30, 33], [36, 39, 42]])
    expect(restarted[1].start.index).toBe(35)
    expect(restarted[1].pullbacks).toHaveLength(2)
    // The same candles mirrored behave the same.
    const down = detectThreePushes(wedge(8).map(mirror)).filter((p) => p.direction === 'down')
    expect(down.map((p) => p.pushes.length)).toEqual([5, 3])
  })

  it('takes the limit from the options', () => {
    expect(detectThreePushes(wedge(6), { maxPushes: 3 }).filter((p) => p.direction === 'up').map((p) => p.pushes.length)).toEqual([3, 3])
  })
})

describe('three-push chart timeframes', () => {
  it('reproduces the reported NQ selloff and keeps the real three upward pushes on both chart intervals', () => {
    // Actual 2024-11-26 tape, with enough preceding bars to warm up ATR(20).
    const minutes: Candle[] = nqFirstPushFixture.rows.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }))
    const at = (time: string) => Date.parse(`2024-11-26T${time}+08:00`) / 1000
    const seedMinutes = minutes.filter((c) => c.time >= at('03:20:00') && c.time < at('03:25:00'))
    expect(seedMinutes.find((c) => c.high === 20860.5)!.time).toBe(at('03:20:00'))
    expect(seedMinutes.find((c) => c.low === 20825.5)!.time).toBe(at('03:23:00'))
    for (const data of [minutes, aggregateCandles(minutes, 300)]) {
      const pattern = computeChartThreePushes(data).find((p) => p.direction === 'up' && p.timeframes.includes('5m') && p.start.price === 20825.5 && p.pushes.at(-1)!.peak.price === 20933.5)!
      expect(pattern).toBeDefined()
      expect(pattern.label).toBe('三推 5m')
      expect(pattern.pushes.map((p) => p.peak.price)).toEqual([20879.5, 20918, 20933.5])
      expect(pattern.pushes[0].peak.time).toBe(at('03:50:00'))
      expect(pattern.pushes.every((p) => p.start.index < p.peak.index)).toBe(true)
    }
    for (const [time, present] of [['05:59:00', false], ['07:00:00', true]] as const) {
      const patterns = computeChartThreePushes(minutes.filter((c) => c.time <= at(time)))
      expect(patterns.some((p) => p.direction === 'up' && p.timeframes.includes('5m') && p.pushes[0].peak.price === 20879.5 && p.pushes[1].peak.price === 20918)).toBe(present)
    }
  })

  it('filters unsupported lower levels on 5m / 15m charts and emits nothing above 15m', () => {
    for (const seconds of [60, 300, 900, 1800]) {
      const patterns = computeChartThreePushes(UP.map((c, i) => ({ ...c, time: START + i * seconds })))
      if (seconds <= 900) expect(patterns.length).toBeGreaterThan(0)
      expect(patterns.every((p) => p.timeframes.every((level) => ({ '1m': 60, '5m': 300, '15m': 900 })[level] >= seconds))).toBe(true)
      if (seconds > 900) expect(patterns).toEqual([])
    }
  })

  it('merges the same underlying price extremes into a single 1m·5m label', () => {
    const patterns = computeChartThreePushes(expandFiveMinute(UP.slice(0, 28)))
    const same = patterns.filter((p) => p.direction === 'up' && p.timeframes.includes('1m') && p.timeframes.includes('5m'))
    expect(same).toHaveLength(1)
    expect(same[0].label).toBe('三推 1m·5m')
    expect(same[0].pushes.map((p) => p.peak.index)).toEqual([105, 120, 135])
  })

  it('filters levels before merging so switching off one does not hide the other', () => {
    const data = expandFiveMinute(UP.slice(0, 28))
    for (const timeframe of ['1m', '5m'] as const) {
      const patterns = computeChartThreePushes(data, { timeframes: [timeframe] }).filter((p) => p.direction === 'up')
      expect(patterns).toHaveLength(1)
      expect(patterns[0].timeframes).toEqual([timeframe])
      expect(patterns[0].label).toBe(`三推 ${timeframe}`)
    }
    expect(computeChartThreePushes(data, { timeframes: [] })).toEqual([])
  })

  it('keeps coincident levels separate when showing multiple overlapping shapes', () => {
    const patterns = computeChartThreePushes(expandFiveMinute(UP.slice(0, 28)), { mergeOverlaps: false }).filter((p) => p.direction === 'up')
    expect(patterns.map((p) => p.label)).toEqual(['三推 1m', '三推 5m'])
    expect(patterns.every((p) => p.timeframes.length === 1)).toBe(true)
    expect(patterns.map((p) => p.pushes.map((push) => push.peak.index))).toEqual([[105, 120, 135], [105, 120, 135]])
  })

  it('keeps different complete structures separate when only their last three peaks match', () => {
    const data = expandFiveMinute(UP.slice(0, 28))
    const extraPushes = [
      [101, 99.5], [100.8, 99.5], [100.7, 99.5], [102, 100], [101.8, 100.5],
      [101.7, 100.5], [103, 101], [104, 102], [105, 103], [105, 103],
    ]
    extraPushes.forEach(([high, low], i) => { data[95 + i] = bar(95 + i, high, low) })
    const patterns = computeChartThreePushes(data).filter((p) => p.direction === 'up')
    expect(patterns.some((p) => p.label === '五推 1m')).toBe(true)
    expect(patterns.some((p) => p.label === '三推 5m')).toBe(true)
    expect(patterns.some((p) => p.timeframes.includes('1m') && p.timeframes.includes('5m'))).toBe(false)
  })

  it('maps a higher-timeframe breakout to the actual revealed source candle in both directions', () => {
    // Equal to the previous peak is insufficient when EQH tolerance is disabled.
    const expanded = expandFiveMinute(UP.slice(0, 28)).map((c, i) => i >= 135 && i < 138 ? { ...c, high: 108, close: 106 } : c)
    for (const mirrored of [false, true]) {
      const data = mirrored ? expanded.map(mirror) : expanded
      const direction = mirrored ? 'down' : 'up'
      expect(computeChartThreePushes(data.slice(0, 138), { equalExtremeToleranceAtr: 0 }).filter((p) => p.direction === direction && p.timeframes.includes('5m'))).toEqual([])
      const pattern = computeChartThreePushes(data.slice(0, 139), { equalExtremeToleranceAtr: 0 }).find((p) => p.direction === direction && p.timeframes.includes('5m'))!
      expect(pattern.confirmedIndex).toBe(138)
      expect(pattern.confirmedTime).toBe(data[138].time)
    }
  })

  it('rejects a higher-timeframe first push whose extreme preceded its resetting swing', () => {
    const expanded = expandFiveMinute(UP.slice(0, 28)).map((c, i) => i === 109 ? { ...c, high: 104, low: 98, close: 103, open: 103 } : c)
    for (const data of [expanded, expanded.map(mirror)]) {
      const patterns = computeChartThreePushes(data)
      expect(patterns.every((p) => p.pushes.every((push) => push.start.index <= push.peak.index))).toBe(true)
      expect(patterns.some((p) => p.timeframes.includes('5m'))).toBe(false)
    }
  })

  it('already has every reported timeframe at its confirmation prefix', () => {
    const data = expandFiveMinute(UP)
    for (const p of computeChartThreePushes(data)) {
      const prefix = computeChartThreePushes(data.slice(0, p.confirmedIndex + 1))
      for (const timeframe of p.timeframes) {
        expect(prefix.some((q) => q.direction === p.direction && q.start.time === p.start.time && q.timeframes.includes(timeframe))).toBe(true)
      }
    }
  })

  it('bounds work to the last 20000 bars and returns global chart indices', () => {
    const prefix = Array.from({ length: 30_000 }, (_, i) => bar(i, 90, 89))
    const candles = [...prefix, ...UP.map((c, i) => ({ ...c, time: START + (30_000 + i) * 60 }))]
    const full = computeChartThreePushes(candles)
    const tail = computeChartThreePushes(candles.slice(-20_000))
    expect(full.length).toBeGreaterThan(0)
    expect(full.map((p) => p.confirmedIndex)).toEqual(tail.map((p) => p.confirmedIndex + candles.length - 20_000))
    expect(full.every((p) => p.pushes.every((push) => candles[push.peak.index].time === push.peak.time))).toBe(true)
  })
})
