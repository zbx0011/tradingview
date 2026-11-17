// Splits the NQ 1m history into one small file per trading session for the phone app (scripts/build-apk.ps1).
// Usage: node scripts/build-mobile-data.mjs <output-dir>
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2]
if (!out) throw new Error('Usage: node scripts/build-mobile-data.mjs <output-dir>')
const source = ['public/data/market-snapshots/nq-c0-1m-2020-2026.json', 'public/data/market-snapshots/nq-c0-1m.json'].find((file) => existsSync(file))
if (!source) throw new Error('No NQ 1m snapshot found in public/data/market-snapshots')

const SESSION_GAP_SECONDS = 30 * 60
const MIN_SESSION_MINUTES = 600
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
const weekdayFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'America/New_York', weekday: 'short' })

const { rows } = JSON.parse(readFileSync(source, 'utf8'))
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const segments = []
let start = 0
const flush = (end, last) => {
  const slice = rows.slice(start, end)
  if (slice.length === 0) return
  const lastTime = slice.at(-1)[0]
  const date = dateFormatter.format(new Date(lastTime * 1000))
  const id = segments.length
  // The newest session may still be in progress in the snapshot, so it is context only.
  const day = slice.length >= MIN_SESSION_MINUTES && !last
  segments.push({ id, start: slice[0][0], end: lastTime + 60, n: slice.length, day, label: `${date}（${weekdayFormatter.format(new Date(lastTime * 1000))}）` })
  // [time, open, high, low, close]; volume is not shown on the phone.
  writeFileSync(join(out, `${id}.json`), JSON.stringify(slice.map((row) => row.slice(0, 5))))
}
for (let index = 1; index < rows.length; index += 1) {
  if (rows[index][0] - rows[index - 1][0] >= SESSION_GAP_SECONDS) { flush(index, false); start = index }
}
flush(rows.length, true)
writeFileSync(join(out, 'index.json'), JSON.stringify({ symbol: 'NQ1!', source, segments }))
console.log(`Wrote ${segments.length} sessions (${segments.filter((item) => item.day).length} trading days) from ${source} to ${out}`)
