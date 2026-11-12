export interface SavedChartView {
  anchorTime: number
  anchorOffset: number
  span: number
  priceRange: { from: number; to: number } | null
  fromTime?: number
  toTime?: number
}
const key = (symbol: string, interval: string) => `kline-studio-chart-view-v1:${symbol}:${interval}`

export function loadChartView(symbol: string, interval: string): SavedChartView | null {
  try {
    const value = JSON.parse(localStorage.getItem(key(symbol, interval)) ?? 'null') as SavedChartView | null
    if (!value || !Number.isFinite(value.anchorTime) || !Number.isFinite(value.anchorOffset) || !Number.isFinite(value.span) || value.span <= 0) return null
    if (value.priceRange && (!Number.isFinite(value.priceRange.from) || !Number.isFinite(value.priceRange.to) || value.priceRange.from >= value.priceRange.to)) value.priceRange = null
    return value
  } catch { return null }
}

export const hasSavedChartViewport = (symbol: string, interval: string) => loadChartView(symbol, interval) !== null

export function captureChartView(times: readonly number[], range: { from: number; to: number }, priceRange: SavedChartView['priceRange']): SavedChartView | null {
  if (!times.length || !Number.isFinite(range.from) || !Number.isFinite(range.to) || range.to <= range.from) return null
  const anchorIndex = Math.min(times.length - 1, Math.max(0, Math.round((range.from + range.to) / 2)))
  const last = times.length - 1
  const step = last > 0 ? Math.min(times[1] - times[0], times[last] - times[last - 1]) : 60
  const timeAt = (index: number) => {
    if (index <= 0) return times[0] + index * step
    if (index >= last) return times[last] + (index - last) * step
    const before = Math.floor(index)
    return times[before] + (times[before + 1] - times[before]) * (index - before)
  }
  return { anchorTime: times[anchorIndex], anchorOffset: range.from - anchorIndex, span: range.to - range.from, priceRange, fromTime: timeAt(range.from), toTime: timeAt(range.to) }
}

export function restoredChartRange(times: readonly number[], saved: SavedChartView): { from: number; to: number } | null {
  let lo = 0, hi = times.length
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (times[mid] < saved.anchorTime) lo = mid + 1; else hi = mid }
  if (times[lo] !== saved.anchorTime) return null
  const from = lo + saved.anchorOffset
  return { from, to: from + saved.span }
}

export function saveChartView(symbol: string, interval: string, view: SavedChartView) {
  try { localStorage.setItem(key(symbol, interval), JSON.stringify(view)) } catch { /* Keep chart usable if storage is unavailable. */ }
}
