import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = path.join(projectRoot, 'src', 'data', 'marketSnapshots.json')
const manifestPath = path.join(projectRoot, 'src', 'data', 'marketSnapshotManifest.json')
const publicDirectory = path.join(projectRoot, 'public', 'data', 'market-snapshots')

const fileNames = {
  XAUUSD: 'xauusd-1m.json',
  XAGUSD: 'xagusd-1m.json',
  US500: 'us500-1m.json',
  'BTCUSDT.P': 'btcusdt-p-1m.json',
}

const snapshot = JSON.parse(await readFile(sourcePath, 'utf8'))
const manifest = {
  fetchedAt: snapshot.fetchedAt,
  timezone: snapshot.timezone,
  series: {},
}

await mkdir(publicDirectory, { recursive: true })

for (const [symbol, series] of Object.entries(snapshot.series ?? {})) {
  const fileName = fileNames[symbol]
  if (!fileName || !Array.isArray(series?.bars) || series.bars.length === 0) continue
  const rows = series.bars.map(({ time, open, high, low, close, volume }) => [time, open, high, low, close, volume])
  const file = `data/market-snapshots/${fileName}`
  manifest.series[symbol] = {
    symbol: series.symbol,
    vendor: series.vendor,
    resolution: series.resolution,
    file,
    count: rows.length,
    firstTime: rows[0][0],
    lastTime: rows.at(-1)[0],
  }
  await writeFile(path.join(publicDirectory, fileName), JSON.stringify({
    symbol: series.symbol,
    vendor: series.vendor,
    resolution: series.resolution,
    fetchedAt: snapshot.fetchedAt,
    timezone: snapshot.timezone,
    rows,
  }))
  console.log(`${symbol}: ${rows.length.toLocaleString('en-US')} rows -> ${file}`)
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Manifest -> ${path.relative(projectRoot, manifestPath)}`)
