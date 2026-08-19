import { readFile, writeFile } from 'node:fs/promises'
import { getHistoricalRates } from 'dukascopy-node'

const SNAPSHOT_FILE = new URL('../src/data/marketSnapshots.json', import.meta.url)
const DEFAULT_FROM = '2026-06-01T00:00:00.000Z'
const BAR_SECONDS = 60

const series = [
  { id: 'XAUUSD', instrument: 'xauusd', symbol: 'DUKASCOPY:XAUUSD' },
  { id: 'XAGUSD', instrument: 'xagusd', symbol: 'DUKASCOPY:XAGUSD' },
  { id: 'US500', instrument: 'usa500idxusd', symbol: 'DUKASCOPY:USA500IDXUSD' },
]

function parseDate(value, fallback) {
  const date = new Date(value ?? fallback)
  if (!Number.isFinite(date.getTime())) throw new Error(`无效日期: ${value}`)
  return date
}

function nextUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1))
}

const from = parseDate(process.env.MARKET_FROM, DEFAULT_FROM)
const to = process.env.MARKET_TO
  ? parseDate(process.env.MARKET_TO)
  : nextUtcDay(new Date())
if (to <= from) throw new Error('MARKET_TO 必须晚于 MARKET_FROM')

function normaliseBars(rows, id) {
  const deduplicated = new Map()
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue
    const [rawTime, rawOpen, rawHigh, rawLow, rawClose, rawVolume] = row.map(Number)
    const values = [rawTime, rawOpen, rawHigh, rawLow, rawClose, rawVolume]
    if (!values.every(Number.isFinite)) continue
    const time = Math.floor(rawTime / 1000)
    const bar = { time, open: rawOpen, high: rawHigh, low: rawLow, close: rawClose, volume: rawVolume }
    if (time <= 0 || rawOpen <= 0 || rawHigh <= 0 || rawLow <= 0 || rawClose <= 0 || rawVolume < 0) continue
    if (rawHigh < Math.max(rawOpen, rawClose) || rawLow > Math.min(rawOpen, rawClose) || rawHigh < rawLow) {
      throw new Error(`${id} 收到无效 OHLC: ${JSON.stringify(row)}`)
    }
    deduplicated.set(time, bar)
  }
  const bars = [...deduplicated.values()].sort((left, right) => left.time - right.time)
  if (bars.length < 1_000) throw new Error(`${id} 只获取到 ${bars.length} 根，数据源响应不完整`)
  for (let index = 1; index < bars.length; index += 1) {
    if (bars[index].time <= bars[index - 1].time) throw new Error(`${id} K 线存在重复或倒序时间戳`)
  }
  const first = bars[0].time * 1000
  const last = bars.at(-1).time * 1000
  if (first < from.getTime() - BAR_SECONDS * 1000 || last > to.getTime() + BAR_SECONDS * 1000) {
    throw new Error(`${id} 时间范围校验失败: ${new Date(first).toISOString()} → ${new Date(last).toISOString()}`)
  }
  return bars
}

const snapshot = JSON.parse(await readFile(SNAPSHOT_FILE, 'utf8'))
for (const item of series) {
  console.log(`${item.id}: fetching ${from.toISOString()} → ${to.toISOString()}`)
  const rows = await getHistoricalRates({
    instrument: item.instrument,
    dates: { from, to },
    timeframe: 'm1',
    priceType: 'bid',
    volumes: true,
    volumeUnits: 'units',
    ignoreFlats: false,
    format: 'array',
    batchSize: 20,
    pauseBetweenBatchesMs: 250,
    retryCount: 3,
    retryOnEmpty: true,
    failAfterRetryCount: true,
    pauseBetweenRetriesMs: 500,
  })
  const bars = normaliseBars(rows, item.id)
  snapshot.series[item.id] = {
    symbol: item.symbol,
    vendor: 'DUKASCOPY',
    resolution: '1',
    bars,
  }
  console.log(`${item.id}: ${bars.length.toLocaleString('en-US')} bars, ${new Date(bars[0].time * 1000).toISOString()} → ${new Date(bars.at(-1).time * 1000).toISOString()}`)
}

snapshot.fetchedAt = new Date().toISOString()
snapshot.timezone = 'UTC'
await writeFile(SNAPSHOT_FILE, `${JSON.stringify(snapshot)}\n`, 'utf8')
console.log(`wrote ${SNAPSHOT_FILE.pathname}`)
