import snapshotManifestJson from '../data/marketSnapshotManifest.json'
import oandaXagusdReplayJson from '../data/oandaXagusdReplay5m.json'
import { aggregateCandles, INTERVALS, type Candle, type IntervalId, type SymbolId } from './market'
import { decodeCompactSnapshot, gunzipIfNeeded } from './compactSnapshot'

interface SnapshotManifestSeries {
  symbol: string
  vendor: string
  resolution: string
  file: string
  /** Optional locally installed extension; the shipped file remains the fallback. */
  preferredFile?: string
  /** Gzip-compressed binary copy of the preferred file (scripts/build-compact-snapshot.mjs), loaded first. */
  compactFile?: string
  /** Version of the compact file; part of the browser cache key. */
  compactVersion?: string
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
const oandaXagusdReplay = oandaXagusdReplayJson as { symbol: string; vendor: string; resolution: string; bars: Candle[] }
const snapshotSourceCache = new Map<SymbolId, Candle[]>()
const snapshotCandleCache = new Map<string, Candle[]>()
const snapshotLoadCache = new Map<SymbolId, Promise<Candle[] | null>>()
const resolvedSnapshotSeries = new Map<SymbolId, SnapshotManifestSeries>()
const BYBIT_KLINE_ENDPOINT = 'https://api.bybit.com/v5/market/kline'
const XAU_MONTH_URL = `${import.meta.env.BASE_URL}data/xauusd-1m-30d.json`
const CACHE_DB_NAME = 'kline-studio-market-v1'
const CACHE_STORE_NAME = 'histories'
/** Downloaded compact snapshots are kept in IndexedDB, so a page refresh does not download them again. */
const SNAPSHOT_DB_NAME = 'kline-studio-snapshots-v1'
const SNAPSHOT_STORE_NAME = 'files'
export const MARKET_HISTORY_DAYS = 30
export const MARKET_HISTORY_SECONDS = MARKET_HISTORY_DAYS * 24 * 60 * 60

export function hasMarketSnapshot(symbol: SymbolId): boolean {
  return Boolean(snapshotManifest.series[symbol]?.count)
}

/**
 * Decision replay uses the exact frozen OANDA 5-minute tape for XAGUSD.
 * The normal market snapshot can be refreshed independently, but replay
 * answers and the candles shown while answering must share one source.
 */
export function getDecisionReplayCandles(symbol: SymbolId): Candle[] | null {
  return symbol === 'XAGUSD' ? oandaXagusdReplay.bars : null
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
      const commit = (file: string, bars: Candle[]) => {
        // Commit caches and metadata together, only after a complete valid load.
        resolvedSnapshotSeries.set(symbol, { ...series, file, count: bars.length, firstTime: bars[0].time, lastTime: bars[bars.length - 1].time })
        snapshotSourceCache.set(symbol, bars)
        snapshotCandleCache.set(`${symbol}:1m`, bars)
        return bars
      }
      const failures: string[] = []
      // The compact binary copy first: about a tenth of the JSON download, and cached in IndexedDB after that.
      if (series.compactFile) {
        try {
          const bars = await loadCompactSnapshot(series.compactFile, series.compactVersion ?? String(series.lastTime))
          if (bars.length) return commit(series.preferredFile ?? series.file, bars)
        } catch (error) {
          failures.push(`${series.compactFile}: ${error instanceof Error ? error.message : '请求失败'}`)
        }
      }
      // Keep the shared request independent from a component's AbortSignal.
      // React development mode intentionally mounts and cleans effects twice;
      // aborting that first subscriber must not cancel the cached request used
      // by the second mount or by decision-history hydration.
      // Version the URL with the manifest endpoint so a refreshed snapshot
      // cannot be masked by the browser's cache for the same compact file.
      const files = [...new Set([series.preferredFile, series.file].filter((file): file is string => Boolean(file)))]
      for (const file of files) {
        try {
          const response = await fetch(`${import.meta.env.BASE_URL}${file}?v=${series.lastTime}`, { cache: 'force-cache' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          if (response.headers?.get('content-type')?.toLowerCase().includes('text/html')) throw new Error('返回了网页，历史数据文件不存在或尚未加载')
          let payload: unknown
          try { payload = await response.json() } catch { throw new Error('历史数据文件不是有效 JSON') }
          return commit(file, parseCompactHistory(payload))
        } catch (error) {
          failures.push(`${file}: ${error instanceof Error ? error.message : '请求失败'}`)
        }
      }
      throw new Error(`${symbol} 历史数据加载失败：${failures.join('；')}`)
    })().finally(() => snapshotLoadCache.delete(symbol))
    snapshotLoadCache.set(symbol, pending)
  }
  await pending
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  return getSnapshotCandles(symbol, interval)
}

function openSnapshotDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(SNAPSHOT_DB_NAME, 1)
      request.onupgradeneeded = () => { request.result.createObjectStore(SNAPSHOT_STORE_NAME) }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    } catch { resolve(null) }
  })
}

async function readCachedSnapshot(key: string): Promise<ArrayBuffer | null> {
  const db = await openSnapshotDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const request = db.transaction(SNAPSHOT_STORE_NAME, 'readonly').objectStore(SNAPSHOT_STORE_NAME).get(key)
      request.onsuccess = () => { resolve(request.result instanceof ArrayBuffer ? request.result : null); db.close() }
      request.onerror = () => { resolve(null); db.close() }
    } catch { resolve(null); db.close() }
  })
}

/** Keeps only the newest copy of each file: older versions are removed when a new one is stored. */
async function writeCachedSnapshot(file: string, key: string, bytes: ArrayBuffer) {
  const db = await openSnapshotDb()
  if (!db) return
  try {
    const store = db.transaction(SNAPSHOT_STORE_NAME, 'readwrite').objectStore(SNAPSHOT_STORE_NAME)
    const keys = store.getAllKeys()
    keys.onsuccess = () => {
      for (const old of keys.result) if (typeof old === 'string' && old.startsWith(`${file}?`) && old !== key) store.delete(old)
      store.put(bytes, key)
    }
    store.transaction.oncomplete = () => db.close()
    store.transaction.onerror = () => db.close()
  } catch { db.close() }
}

/** The compact binary snapshot: from IndexedDB when this version was downloaded before, otherwise from the server. */
async function loadCompactSnapshot(file: string, version: string): Promise<Candle[]> {
  const key = `${file}?v=${version}`
  const cached = await readCachedSnapshot(key)
  if (cached) {
    try { return decodeCompactSnapshot(await gunzipIfNeeded(cached)) } catch { /* A damaged cache entry: download again. */ }
  }
  const response = await fetch(`${import.meta.env.BASE_URL}${key}`, { cache: 'force-cache' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  if (response.headers?.get('content-type')?.toLowerCase().includes('text/html')) throw new Error('返回了网页，紧凑历史数据文件不存在')
  const bytes = await response.arrayBuffer()
  const bars = decodeCompactSnapshot(await gunzipIfNeeded(bytes))
  void writeCachedSnapshot(file, key, bytes)
  return bars
}

export function getSnapshotStatus(symbol: SymbolId): MarketDataStatus {
  const series = resolvedSnapshotSeries.get(symbol) ?? snapshotManifest.series[symbol]
  if (!series) return { kind: 'simulated', label: '模拟数据', vendor: 'LOCAL', fetchedAt: null, detail: '本地确定性模拟行情' }
  return {
    kind: 'snapshot',
    label: symbol === 'NQ1!' ? 'DATABENTO 历史' : `${series.vendor} 最新`,
    vendor: series.vendor,
    fetchedAt: series.lastTime,
    detail: `${series.symbol} · ${series.vendor} 静态快照 · ${series.count.toLocaleString('zh-CN')} 根 ${series.resolution} 分钟 K 线 · UTC`,
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
  // Snapshot exports are normally strictly chronological. Reuse them directly
  // instead of building a second million-entry map for large histories.
  const ordered = bars.every((bar, index) => index === 0 || bars[index - 1].time < bar.time)
  const sorted = ordered ? bars : mergeCandleHistory([bars])
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
