import { readFile, writeFile } from 'node:fs/promises'

const SNAPSHOT_FILE = new URL('../src/data/marketSnapshots.json', import.meta.url)
const PUBLIC_FILE = new URL('../public/data/btcusdt-p-1m-30d.json', import.meta.url)
const ENDPOINT = 'https://api-futures.kucoin.com/api/v1/kline/query'
const SYMBOL = 'XBTUSDTM'
const BAR_MS = 60_000
const DEFAULT_DAYS = 30
const PAGE_SIZE = 200
const MAX_CONCURRENCY = 6
const REQUEST_RETRIES = 4

const days = Number(process.env.BTC_DAYS ?? DEFAULT_DAYS)
if (!Number.isFinite(days) || days <= 0 || days > 90) throw new Error('BTC_DAYS 必须是 0 到 90 之间的数字')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function urlFor(fromMs, toMs) {
  const url = new URL(ENDPOINT)
  url.searchParams.set('symbol', SYMBOL)
  url.searchParams.set('granularity', '1')
  url.searchParams.set('from', String(fromMs))
  url.searchParams.set('to', String(toMs))
  return url
}

async function requestPage(fromMs, toMs) {
  let lastError
  for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
    try {
      const response = await fetch(urlFor(fromMs, toMs), {
        headers: { accept: 'application/json', 'user-agent': 'K-line-Studio/1.0' },
      })
      const payload = await response.json()
      if (!response.ok || payload.code !== '200000' || !Array.isArray(payload.data)) {
        throw new Error(`KuCoin HTTP ${response.status}: ${payload.msg ?? payload.code ?? '响应无效'}`)
      }
      return payload.data
    } catch (error) {
      lastError = error
      if (attempt < REQUEST_RETRIES) await sleep(250 * attempt)
    }
  }
  throw lastError
}

function parseRow(row) {
  if (!Array.isArray(row) || row.length < 6) return null
  // KuCoin futures order: [startMs, open, high, low, close, volume, turnover].
  const [rawTime, rawOpen, rawHigh, rawLow, rawClose, rawVolume] = row
  const values = [rawTime, rawOpen, rawHigh, rawLow, rawClose, rawVolume].map(Number)
  if (!values.every(Number.isFinite)) return null
  const [timeMs, open, high, low, close, volume] = values
  const time = Math.floor(timeMs / 1000)
  if (time <= 0 || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) return null
  if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) return null
  return { time, open, high, low, close, volume }
}

function validateBars(bars, cutoffMs, nowMs) {
  // KuCoin omits minutes with no trades; allow those natural gaps while still
  // rejecting a partially fetched month.
  if (bars.length < Math.floor(days * 24 * 60 * 0.8)) {
    throw new Error(`BTC 近${days}天只获取到 ${bars.length.toLocaleString('en-US')} 根，少于预期`)
  }
  for (let index = 1; index < bars.length; index += 1) {
    if (bars[index].time <= bars[index - 1].time) throw new Error('BTC K 线存在重复或倒序时间戳')
  }
  const firstMs = bars[0].time * 1000
  const lastMs = bars.at(-1).time * 1000
  if (firstMs < cutoffMs - BAR_MS || lastMs > nowMs + BAR_MS) throw new Error('BTC K 线时间范围校验失败')
  const missing = []
  for (let index = 1; index < bars.length; index += 1) {
    const gap = bars[index].time - bars[index - 1].time
    if (gap > 60) missing.push(gap / 60 - 1)
  }
  const missingCount = missing.reduce((sum, count) => sum + count, 0)
  return { missingCount, firstMs, lastMs }
}

const nowMs = Date.now()
const cutoffMs = nowMs - days * 86_400_000
const totalBars = Math.ceil(days * 24 * 60)
const pageCount = Math.ceil(totalBars / PAGE_SIZE) + 1
const pages = []
for (let index = 0; index < pageCount; index += 1) {
  const fromMs = cutoffMs + index * PAGE_SIZE * BAR_MS
  const toMs = Math.min(nowMs, fromMs + (PAGE_SIZE - 1) * BAR_MS)
  if (fromMs > nowMs) break
  pages.push({ index, fromMs, toMs })
}

const rows = []
let cursor = 0
async function worker() {
  while (true) {
    const index = cursor
    cursor += 1
    if (index >= pages.length) return
    const page = pages[index]
    const data = await requestPage(page.fromMs, page.toMs)
    rows.push(...data)
    console.log(`BTC KuCoin 页面 ${index + 1}/${pages.length} · ${data.length} 根`)
    await sleep(80)
  }
}
await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, pages.length) }, worker))

const deduplicated = new Map()
for (const row of rows) {
  const candle = parseRow(row)
  if (!candle) continue
  const timeMs = candle.time * 1000
  if (timeMs >= cutoffMs && timeMs <= nowMs + BAR_MS) deduplicated.set(candle.time, candle)
}
const bars = [...deduplicated.values()].sort((left, right) => left.time - right.time)
const validation = validateBars(bars, cutoffMs, nowMs)

const snapshot = JSON.parse(await readFile(SNAPSHOT_FILE, 'utf8'))
const fetchedAt = new Date().toISOString()
snapshot.fetchedAt = fetchedAt
snapshot.series['BTCUSDT.P'] = {
  symbol: 'KUCOIN:XBTUSDTM',
  vendor: 'KUCOIN',
  resolution: '1',
  bars,
}
await writeFile(SNAPSHOT_FILE, `${JSON.stringify(snapshot)}\n`, 'utf8')

await writeFile(PUBLIC_FILE, `${JSON.stringify({
  symbol: 'BTCUSDT.P',
  interval: '1m',
  vendor: 'KUCOIN:XBTUSDTM',
  fetchedAt,
  rows: bars.map((bar) => [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume]),
})}\n`, 'utf8')

console.log(`BTC 完成：${bars.length.toLocaleString('en-US')} 根 1 分钟K线`)
console.log(`${new Date(validation.firstMs).toISOString()} → ${new Date(validation.lastMs).toISOString()}`)
console.log(`缺失分钟：${validation.missingCount.toLocaleString('en-US')}（交易所无成交时可能存在自然空档）`)
