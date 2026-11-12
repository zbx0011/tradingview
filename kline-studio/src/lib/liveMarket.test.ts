import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import snapshotManifest from '../data/marketSnapshotManifest.json'
import type { SymbolId } from './market'
import {
  fetchBybitMonthCandles, getDecisionReplayCandles, getSnapshotStatus, hasMarketSnapshot, mergeCandleHistory,
  parseBybitKlines, parseCompactHistory,
} from './liveMarket'

afterEach(() => vi.unstubAllGlobals())

describe('real market history', () => {
  it('ships the frozen OANDA XAGUSD replay tape separately from refreshable market snapshots', () => {
    const bars = getDecisionReplayCandles('XAGUSD')
    expect(bars?.length).toBeGreaterThan(1_000)
    expect(bars?.[0]).toMatchObject({ time: 1784822400 })
    expect(bars?.at(-1)).toMatchObject({ time: 1786740900 })
    expect(getDecisionReplayCandles('XAUUSD')).toBeNull()
  })

  it('ships every primary manifest snapshot with matching count and time bounds', () => {
    for (const [name, metadata] of Object.entries(snapshotManifest.series)) {
      const symbol = name as SymbolId
      const payload = JSON.parse(readFileSync(path.join(process.cwd(), 'public', metadata.file), 'utf8')) as { rows: number[][] }
      expect(payload.rows.length).toBe(metadata.count)
      expect(payload.rows.length).toBeGreaterThan(10_000)
      expect(payload.rows[1][0] - payload.rows[0][0]).toBe(Number(metadata.resolution) * 60)
      expect(payload.rows.at(-1)![0]).toBeGreaterThan(payload.rows[0][0])
      expect(payload.rows[0][0]).toBe(metadata.firstTime)
      expect(payload.rows.at(-1)![0]).toBe(metadata.lastTime)
      expect(hasMarketSnapshot(symbol)).toBe(true)
      expect(getSnapshotStatus(symbol).kind).toBe('snapshot')
    }
  })

  it('falls back from an optional missing HTML page to the shipped snapshot with actual metadata', async () => {
    vi.resetModules()
    const originalCount = snapshotManifest.series['NQ1!'].count
    const { loadSnapshotCandles, getSnapshotStatus: status } = await import('./liveMarket')
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('<!doctype html><html>Vite fallback</html>', { headers: { 'Content-Type': 'text/html' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rows: [[60, 1, 3, 1, 2, 4], [120, 2, 4, 2, 3, 5]] })))
    vi.stubGlobal('fetch', fetcher)
    const bars = await loadSnapshotCandles('NQ1!')
    expect(bars?.map((bar) => bar.time)).toEqual([60, 120])
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `/${snapshotManifest.series['NQ1!'].preferredFile}?v=${snapshotManifest.series['NQ1!'].lastTime}`,
      `/${snapshotManifest.series['NQ1!'].file}?v=${snapshotManifest.series['NQ1!'].lastTime}`,
    ])
    expect(status('NQ1!')).toMatchObject({ fetchedAt: 120, detail: expect.stringContaining('2 根 1 分钟') })
    expect(await loadSnapshotCandles('NQ1!')).toBe(bars)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(snapshotManifest.series['NQ1!'].count).toBe(originalCount)
  })

  it('uses a valid optional extended snapshot without requesting the shipped fallback', async () => {
    vi.resetModules()
    const { loadSnapshotCandles, getSnapshotStatus: status } = await import('./liveMarket')
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ rows: [[30, 1, 3, 1, 2, 4], [90, 2, 4, 2, 3, 5], [150, 3, 5, 3, 4, 6]] })))
    vi.stubGlobal('fetch', fetcher)
    expect(await loadSnapshotCandles('NQ1!')).toHaveLength(3)
    expect(status('NQ1!')).toMatchObject({ fetchedAt: 150, detail: expect.stringContaining('3 根 1 分钟') })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not cache failed or empty sources and can retry after both candidates fail', async () => {
    vi.resetModules()
    const { loadSnapshotCandles, getSnapshotCandles } = await import('./liveMarket')
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('<!doctype html>'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rows: [] })))
      .mockResolvedValueOnce(new Response('{invalid-json'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rows: [[60, 1, 3, 1, 2, 4]] })))
    vi.stubGlobal('fetch', fetcher)
    await expect(loadSnapshotCandles('NQ1!')).rejects.toThrow('历史数据文件没有K线')
    expect(getSnapshotCandles('NQ1!')).toBeNull()
    await expect(loadSnapshotCandles('NQ1!')).resolves.toHaveLength(1)
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('shares the fallback request without letting one cancelled subscriber abort the others', async () => {
    vi.resetModules()
    const { loadSnapshotCandles } = await import('./liveMarket')
    let resolveResponse!: (response: Response) => void
    const response = new Promise<Response>((resolve) => { resolveResponse = resolve })
    const fetcher = vi.fn(() => response)
    vi.stubGlobal('fetch', fetcher)
    const controller = new AbortController()
    const first = expect(loadSnapshotCandles('NQ1!', '1m', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    const second = loadSnapshotCandles('NQ1!')
    controller.abort()
    resolveResponse(new Response(JSON.stringify({ rows: [[60, 1, 3, 1, 2, 4]] })))
    await first
    await expect(second).resolves.toHaveLength(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]).toEqual([expect.any(String), { cache: 'force-cache' }])
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
