import snapshotManifestJson from '../data/marketSnapshotManifest.json'
import { aggregateCandles, INTERVALS, type Candle, type IntervalId, type SymbolId } from './market'

interface SnapshotManifestSeries {
  symbol: string
  vendor: string
  resolution: string
  file: string
  count: number
  firstTime: number
  lastTime: number
}

interface SnapshotManifest {
  fetchedAt: string
  timezone: string
  series: Partial<Record<SymbolId, SnapshotManifestSeries>>
}

interface CompactHistoryFile {
  symbol?: string
  interval?: string
  rows?: unknown[]
}

interface CandleCacheEntry {
  key: string
  fetchedAt: number
  bars: Candle[]
}

export interface MarketDataStatus {
  kind: 'live' | 'snapshot' | 'simulated'
  label: string
  vendor: string
  fetchedAt: number | null
  detail: string
}

export interface BybitHistoryProgress {
  page: number
  totalPages: number
  bars: number
}

export interface BybitHistoryOptions {
  signal?: AbortSignal
  onProgress?: (progress: BybitHistoryProgress) => void
  nowMs?: number
  days?: number
  pageLimit?: number
  fetcher?: typeof fetch
}

const snapshotManifest = snapshotManifestJson as SnapshotManifest
const snapshotSourceCache = new Map<SymbolId, Candle[]>()
const snapshotCandleCache = new Map<string, Candle[]>()
const snapshotLoadCache = new Map<SymbolId, Promise<Candle[] | null>>()
const BYBIT_KLINE_ENDPOINT = 'https://api.bybit.com/v5/market/kline'
const XAU_MONTH_URL = `${import.meta.env.BASE_URL}data/xauusd-1m-30d.json`
const CACHE_DB_NAME = 'kline-studio-market-v1'
const CACHE_STORE_NAME = 'histories'
export const MARKET_HISTORY_DAYS = 30
export const MARKET_HISTORY_SECONDS = MARKET_HISTORY_DAYS * 24 * 60 * 60

export function hasMarketSnapshot(symbol: SymbolId): boolean {
  return Boolean(snapshotManifest.series[symbol]?.count)
}

export function getSnapshotCandles(symbol: SymbolId, interval: IntervalId = '1m'): Candle[] | null {
  const bars = snapshotSourceCache.get(symbol)
  if (!bars?.length) return null
  const cacheKey = `${symbol}:${interval}`
  const cached = snapshotCandleCache.get(cacheKey)
  if (cached) return cached
  const result = interval === '1m' ? bars : aggregateCandles(bars, INTERVALS[interval].seconds)
  snapshotCandleCache.set(cacheKey, result)
  return result
}

export async function loadSnapshotCandles(symbol: SymbolId, interval: IntervalId = '1m', signal?: AbortSignal): Promise<Candle[] | null> {
  const cached = getSnapshotCandles(symbol, interval)
  if (cached) return cached
  const series = snapshotManifest.series[symbol]
  if (!series) return null

  let pending = snapshotLoadCache.get(symbol)
  if (!pending) {
    pending = (async () => {
      // Keep the shared request independent from a component's AbortSignal.
      // React development mode intentionally mounts and cleans effects twice;
      // aborting that first subscriber must not cancel the cached request used
      // by the second mount or by decision-history hydration.
      const response = await fetch(`${import.meta.env.BASE_URL}${series.file}`, { cache: 'force-cache' })
      if (!response.ok) throw new Error(`${symbol} 历史数据 HTTP ${response.status}`)
      const bars = parseCompactHistory(await response.json())
      snapshotSourceCache.set(symbol, bars)
      snapshotCandleCache.set(`${symbol}:1m`, bars)
      return bars
    })().finally(() => snapshotLoadCache.delete(symbol))
    snapshotLoadCache.set(symbol, pending)
  }
  await pending
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  return getSnapshotCandles(symbol, interval)
}

export function getSnapshotStatus(symbol: SymbolId): MarketDataStatus {
  const series = snapshotManifest.series[symbol]
  if (!series) return { kind: 'simulated', label: '模拟数据', vendor: 'LOCAL', fetchedAt: null, detail: '本地确定性模拟行情' }
  return {
    kind: 'snapshot',
    label: `${series.vendor} 最新`,
    vendor: series.vendor,
    fetchedAt: series.lastTime,
    detail: `${series.symbol} · ${series.vendor} 静态快照 · ${series.count.toLocaleString('zh-CN')} 根 1 分钟 K 线 · UTC`,
  }
}

function toCandle(item: unknown): Candle {
  if (!Array.isArray(item) || item.length < 6) throw new Error('K线字段不完整')
  const [time, open, high, low, close, volume] = item
  const bar = {
    time: Number(time),
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume),
  }
  if (!Object.values(bar).every(Number.isFinite)) throw new Error('K线包含无效数值')
  return bar
}

export function mergeCandleHistory(series: Candle[][], fromTime = -Infinity, toTime = Infinity): Candle[] {
  const deduplicated = new Map<number, Candle>()
  for (const bars of series) {
    for (const bar of bars) {
      if (bar.time >= fromTime && bar.time <= toTime) deduplicated.set(bar.time, bar)
    }
  }
  return [...deduplicated.values()].sort((a, b) => a.time - b.time)
}

export function parseCompactHistory(payload: unknown): Candle[] {
  const file = payload as CompactHistoryFile
  if (!Array.isArray(file?.rows)) throw new Error('历史数据文件格式无效')
  const bars = file.rows.map(toCandle)
  const sorted = mergeCandleHistory([bars])
  if (sorted.length === 0) throw new Error('历史数据文件没有K线')
  return sorted
}

export async function fetchXauMonthCandles(signal?: AbortSignal): Promise<Candle[]> {
  const response = await fetch(XAU_MONTH_URL, { cache: 'force-cache', signal })
  if (!response.ok) throw new Error(`XAUUSD 历史数据 HTTP ${response.status}`)
  return parseCompactHistory(await response.json())
}

export function parseBybitKlines(payload: unknown): Candle[] {
  const response = payload as { retCode?: number; retMsg?: string; result?: { list?: unknown[] } }
  if (response.retCode !== 0 || !Array.isArray(response.result?.list)) throw new Error(response.retMsg || 'Bybit 行情响应无效')
  const bars = response.result.list.map((item) => {
    const bar = toCandle(item)
    return { ...bar, time: Math.floor(bar.time / 1000) }
  })
  const sorted = mergeCandleHistory([bars])
  if (sorted.length === 0) throw new Error('Bybit 没有返回K线')
  return sorted
}

function bybitKlineUrl(limit: number, end?: number): string {
  const url = new URL(BYBIT_KLINE_ENDPOINT)
  url.searchParams.set('category', 'linear')
  url.searchParams.set('symbol', 'BTCUSDT')
  url.searchParams.set('interval', '1')
  url.searchParams.set('limit', String(limit))
  if (end !== undefined) url.searchParams.set('end', String(Math.floor(end)))
  return url.toString()
}

async function fetchBybitPage(limit: number, signal?: AbortSignal, end?: number, fetcher: typeof fetch = fetch): Promise<Candle[]> {
  const response = await fetcher(bybitKlineUrl(limit, end), { cache: 'no-store', signal })
  if (!response.ok) throw new Error(`Bybit HTTP ${response.status}`)
  return parseBybitKlines(await response.json())
}

export async function fetchBybitMinuteCandles(signal?: AbortSignal): Promise<Candle[]> {
  return fetchBybitPage(1000, signal)
}

export async function fetchBybitMonthCandles(options: BybitHistoryOptions = {}): Promise<Candle[]> {
  const nowMs = options.nowMs ?? Date.now()
  const days = options.days ?? MARKET_HISTORY_DAYS
  const limit = Math.max(1, Math.min(1000, options.pageLimit ?? 1000))
  const cutoffSeconds = Math.floor((nowMs - days * 86_400_000) / 1000)
  const latestSeconds = Math.floor(nowMs / 1000)
  const expectedBars = Math.max(1, Math.ceil(days * 24 * 60))
  const totalPages = Math.ceil(expectedBars / limit)
  const pages: Candle[][] = []
  let end = nowMs

  for (let page = 1; page <= totalPages + 2; page += 1) {
    const bars = await fetchBybitPage(limit, options.signal, end, options.fetcher)
    pages.push(bars)
    const mergedCount = pages.reduce((sum, item) => sum + item.length, 0)
    options.onProgress?.({ page, totalPages, bars: mergedCount })
    const oldest = bars[0]?.time
    if (oldest === undefined || oldest <= cutoffSeconds) break
    const nextEnd = oldest * 1000 - 1
    if (nextEnd >= end || bars.length < limit) break
    end = nextEnd
  }

  const result = mergeCandleHistory(pages, cutoffSeconds, latestSeconds)
  if (result.length === 0) throw new Error('Bybit 近30天没有返回K线')
  return result
}

function openCacheDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CACHE_DB_NAME, 1)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(CACHE_STORE_NAME)) database.createObjectStore(CACHE_STORE_NAME, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function readCandleCache(key: string): Promise<CandleCacheEntry | null> {
  const database = await openCacheDatabase()
  if (!database) return null
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(CACHE_STORE_NAME, 'readonly')
    const request = transaction.objectStore(CACHE_STORE_NAME).get(key)
    request.onsuccess = () => resolve((request.result as CandleCacheEntry | undefined) ?? null)
    request.onerror = () => reject(request.error)
    transaction.oncomplete = () => database.close()
  })
}

export async function writeCandleCache(key: string, bars: Candle[], fetchedAt = Date.now()): Promise<void> {
  const database = await openCacheDatabase()
  if (!database) return
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(CACHE_STORE_NAME, 'readwrite')
    transaction.objectStore(CACHE_STORE_NAME).put({ key, fetchedAt, bars } satisfies CandleCacheEntry)
    transaction.oncomplete = () => { database.close(); resolve() }
    transaction.onerror = () => { database.close(); reject(transaction.error) }
  })
}

export function marketSnapshotMetadata() {
  return { fetchedAt: snapshotManifest.fetchedAt, timezone: snapshotManifest.timezone }
}
