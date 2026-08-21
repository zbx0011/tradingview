import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import snapshotManifest from '../data/marketSnapshotManifest.json'
import {
  fetchBybitMonthCandles, getDecisionReplayCandles, getSnapshotStatus, hasMarketSnapshot, mergeCandleHistory,
  parseBybitKlines, parseCompactHistory,
} from './liveMarket'

describe('real market history', () => {
  it('ships the frozen OANDA XAGUSD replay tape separately from refreshable market snapshots', () => {
    const bars = getDecisionReplayCandles('XAGUSD')
    expect(bars?.length).toBeGreaterThan(1_000)
    expect(bars?.[0]).toMatchObject({ time: 1784822400 })
    expect(bars?.at(-1)).toMatchObject({ time: 1786740900 })
    expect(getDecisionReplayCandles('XAUUSD')).toBeNull()
  })

  it('ships chronological one-minute TradingView snapshots for the four live symbols', () => {
    for (const symbol of ['XAUUSD', 'XAGUSD', 'US500', 'BTCUSDT.P'] as const) {
      const metadata = snapshotManifest.series[symbol]
      const payload = JSON.parse(readFileSync(path.join(process.cwd(), 'public', metadata.file), 'utf8')) as { rows: number[][] }
      expect(payload.rows.length).toBe(metadata.count)
      expect(payload.rows.length).toBeGreaterThan(10_000)
      expect(payload.rows[1][0] - payload.rows[0][0]).toBe(60)
      expect(payload.rows.at(-1)![0]).toBeGreaterThan(payload.rows[0][0])
      expect(hasMarketSnapshot(symbol)).toBe(true)
      expect(getSnapshotStatus(symbol).kind).toBe('snapshot')
    }
  })

  it('parses and sorts the Bybit reverse chronological response', () => {
    const bars = parseBybitKlines({ retCode: 0, result: { list: [
      ['120000', '11', '13', '10', '12', '7'],
      ['60000', '10', '12', '9', '11', '5'],
    ] } })
    expect(bars).toEqual([
      { time: 60, open: 10, high: 12, low: 9, close: 11, volume: 5 },
      { time: 120, open: 11, high: 13, low: 10, close: 12, volume: 7 },
    ])
  })

  it('parses compact TradingView rows and removes duplicate timestamps', () => {
    const bars = parseCompactHistory({ rows: [
      [120, 11, 13, 10, 12, 7],
      [60, 10, 12, 9, 11, 5],
      [120, 11, 14, 10, 13, 8],
    ] })
    expect(bars).toEqual([
      { time: 60, open: 10, high: 12, low: 9, close: 11, volume: 5 },
      { time: 120, open: 11, high: 14, low: 10, close: 13, volume: 8 },
    ])
  })

  it('paginates Bybit backwards until the requested history cutoff', async () => {
    const pages = [
      [['300000', '14', '16', '13', '15', '9'], ['240000', '13', '15', '12', '14', '8']],
      [['180000', '12', '14', '11', '13', '7'], ['120000', '11', '13', '10', '12', '6']],
      [['60000', '10', '12', '9', '11', '5'], ['0', '9', '11', '8', '10', '4']],
    ]
    let request = 0
    const fetcher = (async () => new Response(JSON.stringify({
      retCode: 0,
      result: { list: pages[request++] },
    }), { status: 200 })) as typeof fetch
    const progress: number[] = []
    const bars = await fetchBybitMonthCandles({
      nowMs: 300_000,
      days: 4 / 1440,
      pageLimit: 2,
      fetcher,
      onProgress: ({ page }) => progress.push(page),
    })
    expect(bars.map((bar) => bar.time)).toEqual([60, 120, 180, 240, 300])
    expect(progress).toEqual([1, 2, 3])
  })

  it('merges live updates into history within a cutoff', () => {
    const one = [{ time: 60, open: 1, high: 2, low: 1, close: 2, volume: 3 }]
    const two = [
      { time: 60, open: 2, high: 3, low: 2, close: 3, volume: 4 },
      { time: 120, open: 3, high: 4, low: 3, close: 4, volume: 5 },
    ]
    expect(mergeCandleHistory([one, two], 60, 120)).toEqual(two)
  })
})
