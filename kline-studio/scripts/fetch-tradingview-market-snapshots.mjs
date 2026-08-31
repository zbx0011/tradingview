import { readFile, writeFile } from 'node:fs/promises'

const OUTPUT = new URL('../src/data/marketSnapshots.json', import.meta.url)
// Fetch enough history to cover the requested July-August window, then keep
// only that window in the bundled snapshot so the chart does not grow without
// bound when this script is reused.
const TARGET_BARS = Number(process.env.MARKET_TARGET_BARS ?? 80_000)
const REQUEST_BATCH = 5_000
const MARKET_RESOLUTION = process.env.MARKET_RESOLUTION ?? '1'
const SOCKET_URL = 'wss://prodata.tradingview.com/socket.io/websocket'
const RANGE_START = Math.floor(Date.parse(process.env.MARKET_RANGE_START ?? '2026-07-01T00:00:00Z') / 1000)
const RANGE_END = Math.floor(Date.parse(process.env.MARKET_RANGE_END ?? '2026-09-01T00:00:00Z') / 1000)
const requestedSeries = new Set((process.env.MARKET_SERIES ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean))

if (!Number.isInteger(TARGET_BARS) || TARGET_BARS <= 0) throw new Error('MARKET_TARGET_BARS 必须是正整数')
if (!Number.isFinite(RANGE_START) || !Number.isFinite(RANGE_END) || RANGE_START >= RANGE_END) throw new Error('MARKET_RANGE_START/END 必须是有效的时间范围')
if (!/^\d+$/.test(MARKET_RESOLUTION)) throw new Error('MARKET_RESOLUTION 必须是分钟数')
const SOCKET_OPTIONS = {
  headers: {
    Origin: 'https://prodata.tradingview.com',
    'User-Agent': 'Mozilla/5.0',
  },
}

const SERIES = [
  { id: 'XAUUSD', symbol: 'OANDA:XAUUSD', vendor: 'OANDA' },
  { id: 'XAGUSD', symbol: 'OANDA:XAGUSD', vendor: 'OANDA' },
  { id: 'US500', symbol: 'OANDA:SPX500USD', vendor: 'OANDA' },
  { id: 'BTCUSDT.P', symbol: 'BYBIT:BTCUSDT.P', vendor: 'BYBIT' },
  // The application uses ETHUSD as its canonical symbol. Keep the source
  // aligned with the replay registry so the decision bank can hydrate the
  // same Bybit perpetual feed instead of silently omitting it.
  { id: 'ETHUSD', symbol: 'BYBIT:ETHUSDT.P', vendor: 'BYBIT' },
]
const selectedSeries = SERIES.filter((series) => requestedSeries.size === 0 || requestedSeries.has(series.id))
if (selectedSeries.length === 0) throw new Error(`MARKET_SERIES 未匹配任何可用标的: ${[...requestedSeries].join(', ')}`)

let existingSnapshot = null
if (requestedSeries.size > 0) {
  try {
    existingSnapshot = JSON.parse(await readFile(OUTPUT, 'utf8'))
  } catch {
    // A filtered fetch can also initialise a new snapshot when no previous file exists.
  }
}

function frame(method, params) {
  const body = JSON.stringify({ m: method, p: params })
  return `~m~${body.length}~m~${body}`
}

function parseFrames(buffer, onHeartbeat) {
  const events = []
  let rest = buffer
  while (rest.length > 0) {
    if (!rest.startsWith('~m~')) {
      rest = rest.slice(1)
      continue
    }
    const delimiter = rest.indexOf('~m~', 3)
    if (delimiter < 0) break
    const length = Number(rest.slice(3, delimiter))
    const start = delimiter + 3
    if (!Number.isFinite(length) || rest.length < start + length) break
    const body = rest.slice(start, start + length)
    rest = rest.slice(start + length)
    if (body.startsWith('~h~')) {
      onHeartbeat(body)
      continue
    }
    try {
      events.push(JSON.parse(body))
    } catch {
      // Ignore non-JSON protocol frames.
    }
  }
  return { rest, events }
}

function fetchSeries(series) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SOCKET_URL, SOCKET_OPTIONS)
    const session = `cs_${Math.random().toString(36).slice(2, 14)}`
    const seriesId = 'sds_1'
    const bars = new Map()
    let buffer = ''
    let lastRequestedSize = 0
    let oldestTime = Infinity
    let moreRequestPending = false
    let moreRequestTimer
    let finished = false

    const finish = (error) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      clearTimeout(moreRequestTimer)
      try { ws.close() } catch { /* already closed */ }
      if (error) {
        reject(error)
        return
      }
      const result = [...bars.values()]
        .filter((bar) => bar.time >= RANGE_START && bar.time < RANGE_END)
        .sort((left, right) => left.time - right.time)
      if (result.length === 0) {
        reject(new Error(`${series.symbol} 没有覆盖请求时间范围`))
        return
      }
      resolve({
        symbol: series.symbol,
        vendor: series.vendor,
        bars: result,
      })
    }

    const send = (method, params) => ws.send(frame(method, params))
    const timeout = setTimeout(() => finish(new Error(`${series.symbol} TradingView 请求超时`)), 120_000)

    ws.addEventListener('open', () => {
      send('chart_create_session', [session, ''])
      send('set_auth_token', ['unauthorized_user_token'])
      send('resolve_symbol', [session, 'symbol_1', `=${JSON.stringify({ symbol: series.symbol, adjustment: 'splits' })}`])
      send('create_series', [session, seriesId, 's0', 'symbol_1', MARKET_RESOLUTION, REQUEST_BATCH, ''])
    })

    ws.addEventListener('message', (event) => {
      buffer += String(event.data)
      const parsed = parseFrames(buffer, (heartbeat) => ws.send(`~m~${heartbeat.length}~m~${heartbeat}`))
      buffer = parsed.rest

      for (const message of parsed.events) {
        if (message.session_id) continue
        const params = message.p ?? []
        if (message.m === 'timescale_update') {
          const points = params[1]?.[seriesId]?.s ?? []
          const sizeBefore = bars.size
          for (const point of points) {
            const values = point.v
            if (!Array.isArray(values) || values.length < 6) continue
            const [time, open, high, low, close, volume] = values.map(Number)
            if (![time, open, high, low, close, volume].every(Number.isFinite)) continue
            bars.set(time, { time, open, high, low, close, volume })
            oldestTime = Math.min(oldestTime, time)
          }
          if (bars.size > sizeBefore) moreRequestPending = false
        }
        if (message.m === 'series_error' || message.m === 'symbol_error') {
          finish(new Error(`${series.symbol} TradingView 返回 ${message.m}`))
          continue
        }
        if (message.m === 'series_completed') {
          if ((bars.size < TARGET_BARS || oldestTime > RANGE_START) && bars.size > lastRequestedSize) {
            lastRequestedSize = bars.size
            moreRequestPending = true
            send('request_more_data', [session, seriesId, REQUEST_BATCH])
            clearTimeout(moreRequestTimer)
            moreRequestTimer = setTimeout(() => {
              if (moreRequestPending) finish()
            }, 2_500)
          } else if (moreRequestPending) {
            // TradingView can emit series_completed before the response to
            // request_more_data arrives. Wait for that response instead of
            // treating the unchanged intermediate count as the final range.
          } else {
            finish()
          }
        }
      }
    })

    ws.addEventListener('error', () => finish(new Error(`${series.symbol} TradingView WebSocket 连接失败`)))
  })
}

const fetched = requestedSeries.size > 0 && existingSnapshot?.series && typeof existingSnapshot.series === 'object'
  ? { ...existingSnapshot.series }
  : {}
for (const series of selectedSeries) {
  const result = await fetchSeries(series)
  fetched[series.id] = {
    symbol: result.symbol,
    vendor: result.vendor,
    resolution: MARKET_RESOLUTION,
    bars: result.bars,
  }
  console.log(`${series.id}: ${result.bars.length} bars, ${new Date(result.bars[0]?.time * 1000).toISOString()} → ${new Date(result.bars.at(-1)?.time * 1000).toISOString()}`)
}

const output = {
  fetchedAt: new Date().toISOString(),
  timezone: 'UTC',
  range: {
    from: new Date(RANGE_START * 1000).toISOString(),
    to: new Date(RANGE_END * 1000).toISOString(),
  },
  series: fetched,
}
await writeFile(OUTPUT, `${JSON.stringify(output)}\n`, 'utf8')
console.log(`wrote ${OUTPUT.pathname}`)
