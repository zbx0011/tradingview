// Builds the compact gzip-compressed binary copy of a large 1m snapshot (format: src/lib/compactSnapshot.ts) and
// records it in src/data/marketSnapshotManifest.json, so the browser downloads ~10 MB instead of ~106 MB of JSON.
// Run again whenever the JSON snapshot is refreshed.
// Usage: node scripts/build-compact-snapshot.mjs [symbol=NQ1!] [scale=4]
import { readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const symbol = process.argv[2] ?? 'NQ1!'
const scale = Number(process.argv[3] ?? 4)
const manifestPath = 'src/data/marketSnapshotManifest.json'
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const series = manifest.series[symbol]
if (!series) throw new Error(`${symbol} is not in ${manifestPath}`)
const source = series.preferredFile ?? series.file
const { rows } = JSON.parse(readFileSync(`public/${source}`, 'utf8'))
const count = rows.length
const HEADER = 28
const buffer = Buffer.alloc(HEADER + count * 24)
buffer.write('KLB1', 0, 'latin1')
buffer.writeUInt32LE(count, 4)
buffer.writeUInt32LE(scale, 8)
const ticks = (price) => {
  const value = Math.round(price * scale)
  if (Math.abs(value - price * scale) > 1e-6) throw new Error(`price ${price} is not on the 1/${scale} tick grid`)
  return value
}
buffer.writeDoubleLE(rows[0][0], 12)
buffer.writeDoubleLE(ticks(rows[0][1]), 20)
const column = (k) => HEADER + k * count * 4
let previousClose = ticks(rows[0][1]), previousTime = rows[0][0]
rows.forEach(([time, o, h, l, c, v], i) => {
  const open = ticks(o), close = ticks(c), high = ticks(h), low = ticks(l)
  if (!Number.isInteger(v) || v < 0) throw new Error(`volume ${v} at ${time} is not a whole number`)
  buffer.writeUInt32LE(time - previousTime, column(0) + i * 4)
  buffer.writeInt32LE(open - previousClose, column(1) + i * 4)
  buffer.writeInt32LE(close - open, column(2) + i * 4)
  buffer.writeUInt32LE(high - Math.max(open, close), column(3) + i * 4)
  buffer.writeUInt32LE(Math.min(open, close) - low, column(4) + i * 4)
  buffer.writeUInt32LE(v, column(5) + i * 4)
  previousClose = close; previousTime = time
})
const compactFile = source.replace(/\.json$/, '.klb')
const zipped = gzipSync(buffer, { level: 9 })
writeFileSync(`public/${compactFile}`, zipped)
series.compactFile = compactFile
// Part of the browser cache key: a rebuilt file with newer bars is downloaded again.
series.compactVersion = `${rows.at(-1)[0]}-${count}`
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`${source}: ${count} bars, ${(buffer.length / 1e6).toFixed(1)} MB → public/${compactFile} ${(zipped.length / 1e6).toFixed(1)} MB (gzip)`)
