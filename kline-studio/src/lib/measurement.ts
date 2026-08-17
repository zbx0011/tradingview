import type { Candle, SymbolId } from './market'

export interface MeasurementAnchor {
  time: number
  price: number
}

export interface ChartMeasurement {
  startTime: number
  endTime: number
  startPrice: number
  endPrice: number
  priceChange: number
  percentChange: number
  ticks: number
  bars: number
  durationSeconds: number
  volume: number
  direction: 'up' | 'down'
}

const tickSize: Record<SymbolId, number> = {
  XAUUSD: 0.01,
  XAGUSD: 0.001,
  'BTCUSDT.P': 0.1,
  US500: 0.1,
  ETHUSD: 0.01,
}

function nearestCandleIndex(candles: Candle[], requestedTime: number) {
  if (candles.length === 0) return -1
  let low = 0
  let high = candles.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (candles[middle].time < requestedTime) low = middle + 1
    else high = middle - 1
  }
  if (low <= 0) return 0
  if (low >= candles.length) return candles.length - 1
  return Math.abs(candles[low].time - requestedTime) < Math.abs(candles[low - 1].time - requestedTime) ? low : low - 1
}

function estimatedCandleInterval(candles: Candle[]) {
  const gaps: number[] = []
  const firstIndex = Math.max(1, candles.length - 201)
  for (let index = firstIndex; index < candles.length; index += 1) {
    const gap = candles[index].time - candles[index - 1].time
    if (gap > 0 && Number.isFinite(gap)) gaps.push(gap)
  }
  if (gaps.length === 0) return 60
  gaps.sort((left, right) => left - right)
  return gaps[Math.floor(gaps.length / 2)]
}

export function calculateChartMeasurement(
  start: MeasurementAnchor,
  end: MeasurementAnchor,
  candles: Candle[],
  symbol: SymbolId,
): ChartMeasurement | null {
  if (
    candles.length === 0
    || !Number.isFinite(start.time)
    || !Number.isFinite(end.time)
    || !Number.isFinite(start.price)
    || !Number.isFinite(end.price)
  ) return null

  const requestedFrom = Math.min(start.time, end.time)
  const requestedTo = Math.max(start.time, end.time)
  const candleFrom = candles[0].time
  const candleTo = candles.at(-1)!.time
  const startIndex = nearestCandleIndex(candles, start.time)
  const endIndex = nearestCandleIndex(candles, end.time)
  if (startIndex < 0 || endIndex < 0) return null

  const fromIndex = Math.min(startIndex, endIndex)
  const toIndex = Math.max(startIndex, endIndex)
  const priceChange = end.price - start.price
  const durationSeconds = Math.abs(end.time - start.time)
  const bothAnchorsOnCandleTimeline = start.time >= candleFrom && start.time <= candleTo && end.time >= candleFrom && end.time <= candleTo
  const candlesInRange = requestedTo < candleFrom || requestedFrom > candleTo
    ? []
    : candles.filter((candle) => candle.time >= requestedFrom && candle.time <= requestedTo)
  return {
    startTime: start.time,
    endTime: end.time,
    startPrice: start.price,
    endPrice: end.price,
    priceChange,
    percentChange: start.price === 0 ? 0 : priceChange / start.price * 100,
    ticks: priceChange / tickSize[symbol],
    bars: bothAnchorsOnCandleTimeline
      ? toIndex - fromIndex + 1
      : Math.max(1, Math.round(durationSeconds / estimatedCandleInterval(candles)) + 1),
    durationSeconds,
    volume: bothAnchorsOnCandleTimeline
      ? candles.slice(fromIndex, toIndex + 1).reduce((sum, candle) => sum + candle.volume, 0)
      : candlesInRange.reduce((sum, candle) => sum + candle.volume, 0),
    direction: priceChange >= 0 ? 'up' : 'down',
  }
}

export function formatSignedMeasurement(value: number, fractionDigits: number) {
  const prefix = value > 0 ? '+' : ''
  return `${prefix}${value.toLocaleString('en-US', { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })}`
}

export function formatMeasurementDuration(seconds: number) {
  const totalMinutes = Math.round(Math.abs(seconds) / 60)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor(totalMinutes % 1440 / 60)
  const minutes = totalMinutes % 60
  const parts: string[] = []
  if (days) parts.push(`${days}天`)
  if (hours) parts.push(`${hours}小时`)
  if (minutes || parts.length === 0) parts.push(`${minutes}分钟`)
  return parts.join(' ')
}

export function formatMeasurementVolume(volume: number) {
  const absolute = Math.abs(volume)
  if (absolute >= 1_000_000_000) return `${(volume / 1_000_000_000).toFixed(2)}B`
  if (absolute >= 1_000_000) return `${(volume / 1_000_000).toFixed(2)}M`
  if (absolute >= 1_000) return `${(volume / 1_000).toFixed(2)}K`
  return volume.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

export function formatMeasurementTime(time: number) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(time * 1000))
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('weekday')} ${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`
}
