import type { IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, Logical, SeriesType } from 'lightweight-charts'
import { computeAutoTrendDetector, computeAutoTrendlines, computePivotPairLines, type AutoTrendline } from './autoTrendlines'
import type { Candle } from './market'

/** All auto trendlines are blue and the thinnest line; dashed means only two points so far (not yet a trendline). */
export const AUTO_TRENDLINE_COLOR = '#2962ff'
const MAX_CONFIRMED_LINES = 8
const MAX_PENDING_LINES = 2

/** near: only lines the latest candle is close to (default); recent: every unbroken line, best 8 + newest 2 two-point lines. */
export type AutoTrendlinesMode = 'near' | 'recent'
/** How close (in ATRs) the latest candle must be to a line for 'near' to show it. */
const NEAR_ATR = 1

export function attachAutoTrendlinesOverlay(chart: IChartApi, series: ISeriesApi<SeriesType>, mode: AutoTrendlinesMode = 'near') {
  let lines: AutoTrendline[] = []
  let lastData: readonly Candle[] | null = null
  let requestUpdate = () => {}
  const timeScale = chart.timeScale()

  const draw = (context: CanvasRenderingContext2D, width: number, height: number) => {
    const range = timeScale.getVisibleLogicalRange()
    if (!range || !lastData) return
    // Bar spacing is constant, so any logical index maps linearly to x — including bars beyond the data.
    const x0 = timeScale.logicalToCoordinate(0 as Logical), x1 = timeScale.logicalToCoordinate(1 as Logical)
    const origin = x0 ?? null, spacing = x0 !== null && x1 !== null ? x1 - x0 : timeScale.options().barSpacing
    const anchor = origin ?? (() => {
      const index = Math.max(0, Math.floor(range.from)), coordinate = timeScale.logicalToCoordinate(index as Logical)
      return coordinate === null ? null : coordinate - index * spacing
    })()
    if (anchor === null) return
    const x = (index: number) => anchor + index * spacing
    context.save()
    context.beginPath(); context.rect(0, 0, width, height); context.clip()
    for (const line of lines) {
      const slope = (line.y2 - line.y1) / (line.x2 - line.x1)
      // Only the part on screen is converted to pixels, so far-away anchors cannot distort the line.
      const from = Math.max(line.x1, range.from - 1)
      const to = line.extendRight ? Math.max(line.endX, range.to + 1) : Math.min(line.endX, range.to + 1)
      if (to <= from) continue
      const yFrom = series.priceToCoordinate(line.y1 + slope * (from - line.x1)), yTo = series.priceToCoordinate(line.y1 + slope * (to - line.x1))
      if (yFrom === null || yTo === null) continue
      context.strokeStyle = AUTO_TRENDLINE_COLOR
      context.lineWidth = 1
      context.setLineDash(line.confirmed ? [] : [3, 3])
      context.beginPath(); context.moveTo(x(from), yFrom); context.lineTo(x(to), yTo); context.stroke()
    }
    context.setLineDash([])
    context.restore()
  }
  const renderer: IPrimitivePaneRenderer = {
    draw(target) { target.useMediaCoordinateSpace(({ context, mediaSize }) => draw(context, mediaSize.width, mediaSize.height)) },
  }
  const views: readonly IPrimitivePaneView[] = [{ zOrder: () => 'top', renderer: () => renderer }]
  const primitive: ISeriesPrimitive = {
    attached(param) { requestUpdate = param.requestUpdate },
    detached() { requestUpdate = () => {} },
    paneViews: () => views,
  }
  series.attachPrimitive(primitive)
  return {
    setData(candles: readonly Candle[]) {
      if (candles === lastData) return
      lastData = candles
      // The two studies are shown as one set of trendlines; a line both find (same two anchors) is drawn once.
      const seen = new Set<string>()
      const candidates = [...computeAutoTrendlines(candles), ...computeAutoTrendDetector(candles).lines, ...computePivotPairLines(candles)].filter((line) => {
        const key = `${line.x1}:${line.x2}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      // Keep the chart readable: only lines still in play (broken ones are history), the best confirmed ones, and the newest two-point lines.
      // The first two touches (the anchors) may not overshoot: between them no wick may cross the line.
      // Only the third and later touches may poke through (see touchCount).
      const clean = (line: AutoTrendline) => {
        const slope = (line.y2 - line.y1) / (line.x2 - line.x1)
        const high = line.kind === 'resistance' || (line.kind === 'flat' && line.y1 >= candles[line.x1].high - 1e-9)
        for (let x = line.x1 + 1; x < line.x2 && x < candles.length; x += 1) {
          const value = line.y1 + slope * (x - line.x1), epsilon = 1e-9 * Math.abs(value)
          if (high ? candles[x].high > value + epsilon : candles[x].low < value - epsilon) return false
        }
        return true
      }
      // A third touch away from the anchors confirms the line. An overshoot that closes back counts too.
      const range = new Float64Array(candles.length)
      let avg = 0
      for (let i = 0; i < candles.length; i += 1) {
        const c = candles[i], prev = i > 0 ? candles[i - 1].close : c.close
        const tr = Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev))
        avg = i < 14 ? (avg * i + tr) / (i + 1) : (avg * 13 + tr) / 14
        range[i] = avg
      }
      const hasThirdTouch = (line: AutoTrendline) => {
        const slope = (line.y2 - line.y1) / (line.x2 - line.x1)
        const end = Math.min(candles.length - 1, Math.floor(line.endX))
        for (let x = line.x1 + 3; x <= end; x += 1) {
          if (Math.abs(x - line.x2) <= 2) continue
          const value = line.y1 + slope * (x - line.x1), tolerance = 0.3 * range[x], c = candles[x]
          const touched = line.kind === 'resistance' ? c.high >= value - tolerance && c.close <= value + tolerance
            : line.kind === 'support' ? c.low <= value + tolerance && c.close >= value - tolerance
            : c.high >= value - tolerance && c.low <= value + tolerance
          if (touched) return true
        }
        return false
      }
      const live = candidates.filter((line) => line.extendRight && clean(line))
      if (mode === 'near') {
        // Only lines that are within NEAR_ATR ATRs of the latest candle.
        const last = candles.length - 1, bar = candles[last], tolerance = NEAR_ATR * (range[last] || 0)
        lines = last < 0 ? [] : live.filter((line) => {
          const value = line.y1 + (line.y2 - line.y1) / (line.x2 - line.x1) * (last - line.x1)
          return value >= bar.low - tolerance && value <= bar.high + tolerance
        })
        for (const line of lines) line.confirmed = hasThirdTouch(line)
      } else {
        for (const line of live) line.confirmed = hasThirdTouch(line)
        const confirmed = live.filter((line) => line.confirmed).sort((p, q) => q.touches - p.touches || q.x2 - p.x2).slice(0, MAX_CONFIRMED_LINES)
        const pending = live.filter((line) => !line.confirmed).sort((p, q) => q.x2 - p.x2).slice(0, MAX_PENDING_LINES)
        lines = [...confirmed, ...pending]
      }
      requestUpdate()
    },
    destroy() {
      lines = []; lastData = null
      try { series.detachPrimitive(primitive) } catch { /* The chart may already have removed its series. */ }
    },
  }
}
