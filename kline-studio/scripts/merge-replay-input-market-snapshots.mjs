import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const replayDataRoot = path.resolve(projectRoot, '..', '..', 'replay_data')
const snapshotPath = path.join(projectRoot, 'src', 'data', 'marketSnapshots.json')

const sourceDefinitions = {
  XAUUSD: { symbol: 'OANDA:XAUUSD', vendor: 'OANDA' },
  'BTCUSDT.P': { symbol: 'BYBIT:BTCUSDT.P', vendor: 'BYBIT' },
  // ETHUSD is the application's canonical name for the replay's
  // BYBIT:ETHUSDT.P feed.
  ETHUSD: { symbol: 'BYBIT:ETHUSDT.P', vendor: 'BYBIT' },
}

const inputDirectories = [
  {
    directory: path.join(replayDataRoot, 'june_weekly_2026_v5_inputs_tradingview'),
    match: /^tradingview_xauusd_5m_.*\.json$/,
  },
  {
    directory: path.join(replayDataRoot, 'v5_0818_batch_20260821', 'inputs'),
    match: /^(?:xauusd|btcusdtp|ethusdtp)-5m-.*\.json$/,
  },
]

function canonicalSymbol(sourceSymbol) {
  if (sourceSymbol === 'OANDA:XAUUSD') return 'XAUUSD'
  if (sourceSymbol === 'BYBIT:BTCUSDT.P') return 'BTCUSDT.P'
  if (sourceSymbol === 'BYBIT:ETHUSDT.P') return 'ETHUSD'
  return null
}

function toBar(value, sourcePath) {
  if (!value || typeof value !== 'object') throw new Error(`K线记录无效：${sourcePath}`)
  const bar = {
    time: Number(value.time),
    open: Number(value.open),
    high: Number(value.high),
    low: Number(value.low),
    close: Number(value.close),
    volume: Number(value.volume),
  }
  if (!Object.values(bar).every(Number.isFinite)) throw new Error(`K线数值无效：${sourcePath}`)
  return bar
}

const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'))
const seriesBySymbol = new Map()
for (const [symbol, definition] of Object.entries(sourceDefinitions)) {
  const existing = snapshot.series?.[symbol]
  const bars = new Map((existing?.bars ?? []).map((bar) => [Number(bar.time), toBar(bar, snapshotPath)]))
  seriesBySymbol.set(symbol, { ...definition, resolution: '5', bars })
}

let inputCount = 0
let importedBars = 0
for (const { directory, match } of inputDirectories) {
  const names = (await readdir(directory)).filter((name) => match.test(name)).sort()
  for (const name of names) {
    const sourcePath = path.join(directory, name)
    const payload = JSON.parse(await readFile(sourcePath, 'utf8'))
    if (Number(payload.timeframe_minutes) !== 5 || !Array.isArray(payload.bars)) continue
    const symbol = canonicalSymbol(payload.symbol)
    if (!symbol) continue
    const target = seriesBySymbol.get(symbol)
    if (!target) continue
    inputCount += 1
    for (const value of payload.bars) {
      const bar = toBar(value, sourcePath)
      target.bars.set(bar.time, bar)
      importedBars += 1
    }
  }
}

const nextSeries = { ...(snapshot.series ?? {}) }
for (const [symbol, target] of seriesBySymbol) {
  const bars = [...target.bars.values()].sort((left, right) => left.time - right.time)
  if (bars.length === 0) throw new Error(`没有可用的 ${symbol} 5 分钟 K 线`)
  nextSeries[symbol] = {
    symbol: target.symbol,
    vendor: target.vendor,
    resolution: target.resolution,
    bars,
  }
  console.log(`${symbol}: ${bars.length.toLocaleString('en-US')} bars, ${new Date(bars[0].time * 1000).toISOString()} → ${new Date(bars.at(-1).time * 1000).toISOString()}`)
}

const output = {
  ...snapshot,
  fetchedAt: new Date().toISOString(),
  series: nextSeries,
}
await writeFile(snapshotPath, `${JSON.stringify(output)}\n`, 'utf8')
console.log(`merged ${inputCount} frozen replay files / ${importedBars.toLocaleString('en-US')} bar records into ${snapshotPath}`)
