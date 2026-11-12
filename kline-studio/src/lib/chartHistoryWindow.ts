import { aggregateCandles, type Candle } from './market'

export const MAX_CHART_BARS = 16_000
export const CHART_WINDOW_MARGIN = 2_000

export interface ChartHistoryWindow {
  start: number
  end: number
  seconds: number
}

/** Fractional bar index, including the empty space beyond the loaded candles. */
export function historyIndexAtTime(data: readonly Candle[], time: number, seconds: number): number {
  if (!data.length) return 0
  const last = data.length - 1
  if (time <= data[0].time) return (time - data[0].time) / seconds
  if (time >= data[last].time) return last + (time - data[last].time) / seconds
  let low = 1
  let high = last
  while (low < high) {
    const middle = (low + high) >>> 1
    if (data[middle].time < time) low = middle + 1
    else high = middle
  }
  const before = data[low - 1].time
  return low - 1 + (time - before) / (data[low].time - before)
}

export function historyTimeAtIndex(data: readonly Candle[], index: number, seconds: number): number {
  if (!data.length) return 0
  const last = data.length - 1
  if (index <= 0) return data[0].time + index * seconds
  if (index >= last) return data[last].time + (index - last) * seconds
  const before = Math.floor(index)
  return data[before].time + (data[before + 1].time - data[before].time) * (index - before)
}

/** Keep a bounded set of real candles around the viewport, with indicator warmup. */
export function planChartHistoryWindow(data: readonly Candle[], from: number, to: number, seconds: number): ChartHistoryWindow {
  if (data.length <= MAX_CHART_BARS) return { start: 0, end: data.length, seconds }
  const first = Math.max(0, Math.min(data.length - 1, Math.floor(from)))
  const last = Math.max(first, Math.min(data.length - 1, Math.ceil(to)))
  const span = last - first + 1
  if (span <= MAX_CHART_BARS / 2) {
    const start = Math.max(0, Math.min(data.length - MAX_CHART_BARS, Math.floor((first + last - MAX_CHART_BARS) / 2)))
    return { start, end: start + MAX_CHART_BARS, seconds }
  }
  const margin = Math.ceil(span / 5)
  const start = Math.max(0, first - margin)
  const end = Math.min(data.length, last + margin + 1)
  const timeSpan = data[end - 1].time - data[start].time + seconds
  // Aligned time buckets preserve OHLCV and never allocate a minute-by-minute grid.
  const bucketSeconds = Math.max(seconds, Math.ceil(timeSpan / (MAX_CHART_BARS - 1) / seconds) * seconds)
  return { start, end, seconds: bucketSeconds }
}

export function candlesForHistoryWindow(data: Candle[], window: ChartHistoryWindow, sourceSeconds: number): Candle[] {
  if (window.start === 0 && window.end === data.length && window.seconds === sourceSeconds) return data
  const selected = data.slice(window.start, window.end)
  return window.seconds === sourceSeconds ? selected : aggregateCandles(selected, window.seconds)
}
