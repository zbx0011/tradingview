import { describe, expect, it } from 'vitest'
import { decodeCompactSnapshot, encodeCompactSnapshot, gunzipIfNeeded } from './compactSnapshot'
import type { Candle } from './market'

const bars: Candle[] = [
  { time: 1_700_000_000, open: 18000, high: 18002.5, low: 17999.25, close: 18001.75, volume: 120 },
  { time: 1_700_000_060, open: 18001.5, high: 18001.5, low: 17990, close: 17990.25, volume: 5 },
  // A session break: the time step is not one minute.
  { time: 1_700_003_660, open: 17995, high: 18010, low: 17994.75, close: 18010, volume: 0 },
]

describe('compact snapshot', () => {
  it('round-trips bars on the tick grid exactly', () => {
    expect(decodeCompactSnapshot(encodeCompactSnapshot(bars, 4))).toEqual(bars)
  })

  it('rejects data that is not a compact snapshot', () => {
    expect(() => decodeCompactSnapshot(new ArrayBuffer(40))).toThrow()
    const truncated = encodeCompactSnapshot(bars, 4).slice(0, 60)
    expect(() => decodeCompactSnapshot(truncated)).toThrow()
  })

  it('passes bytes through when they are not gzip (already decoded by the server)', async () => {
    const raw = encodeCompactSnapshot(bars, 4)
    expect(await gunzipIfNeeded(raw)).toBe(raw)
  })
})
