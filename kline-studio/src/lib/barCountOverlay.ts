import type { IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, Logical, MouseEventParams, SeriesType } from 'lightweight-charts'
import type { Candle } from './market'
import { detectBarCounts, type BarCountMark } from './barCount'

export const BAR_COUNT_HIGH_COLOR = '#2b8a3e'
export const BAR_COUNT_LOW_COLOR = '#e8590c'

export interface BarCountChartOptions {
  /** Draw 高1/2/3 (pullback buys). */
  high?: boolean
  /** Draw 低1/2/3 (rally sells). */
  low?: boolean
}

/** Labels on the same side closer than this (pixels) are stacked one line further from the bars instead of overlapping. */
const LABEL_WIDTH = 18
const LINE_HEIGHT = 11

/**
 * 高n under the bar that traded above the prior bar's high, 低n above the bar that traded below the prior
 * bar's low. Hovering a bar with a count shows the stop-entry price (the prior bar's high / low).
 */
export function attachBarCountOverlay(chart: IChartApi, series: ISeriesApi<SeriesType>, options: BarCountChartOptions = {}) {
  const showHigh = options.high !== false, showLow = options.low !== false
  let candles: readonly Candle[] = []
  let marks: BarCountMark[] = []
  let hoveredIndex: number | null = null
  let requestUpdate = () => {}
  const timeScale = chart.timeScale()

  const onCrosshairMove = (param: MouseEventParams) => {
    const logical = param.point ? timeScale.coordinateToLogical(param.point.x) : null
    const next = logical === null ? null : Math.round(logical)
    if (next === hoveredIndex) return
    hoveredIndex = next; requestUpdate()
  }
  chart.subscribeCrosshairMove(onCrosshairMove)

  const draw = (context: CanvasRenderingContext2D, width: number, height: number) => {
    const range = timeScale.getVisibleLogicalRange()
    if (!range || !marks.length) return
    const placed: { kind: 'H' | 'L', x: number, y: number }[] = []
    const format = (price: number) => series.priceFormatter().format(price)
    context.save()
    context.beginPath(); context.rect(0, 0, width, height); context.clip()
    context.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    context.textAlign = 'center'
    for (const mark of marks) {
      if (mark.index < range.from - 1 || mark.index > range.to + 1) continue
      const candle = candles[mark.index]
      const x = timeScale.logicalToCoordinate(mark.index as Logical)
      if (!candle || x === null) continue
      const isHigh = mark.kind === 'H'
      const color = isHigh ? BAR_COUNT_HIGH_COLOR : BAR_COUNT_LOW_COLOR
      const anchor = series.priceToCoordinate(isHigh ? candle.low : candle.high)
      if (anchor === null) continue
      context.fillStyle = color
      let y = isHigh ? anchor + 13 : anchor - 5
      while (placed.some((p) => p.kind === mark.kind && Math.abs(p.x - x) < LABEL_WIDTH && Math.abs(p.y - y) < LINE_HEIGHT)) y += isHigh ? LINE_HEIGHT : -LINE_HEIGHT
      placed.push({ kind: mark.kind, x, y })
      context.fillText(`${isHigh ? '高' : '低'}${mark.count}`, x, y)
      if (hoveredIndex === mark.index) {
        // Stop-entry price: one tick beyond the signal bar (the prior bar).
        const y = series.priceToCoordinate(mark.entry)
        const xs = timeScale.logicalToCoordinate((mark.index - 1) as Logical)
        if (y !== null && xs !== null) {
          context.strokeStyle = color; context.lineWidth = 1; context.setLineDash([3, 3])
          context.beginPath(); context.moveTo(xs - 6, y); context.lineTo(x + 6, y); context.stroke()
          context.setLineDash([])
          context.textAlign = 'left'
          const text = `${isHigh ? '高' : '低'}${mark.count} 触发 ${format(mark.entry)}`
          const w = context.measureText(text).width + 8
          context.fillStyle = 'rgba(255,255,255,0.9)'; context.fillRect(x + 8, y - 8, w, 15)
          context.fillStyle = color; context.fillText(text, x + 12, y + 3)
          context.textAlign = 'center'
        }
      }
    }
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
    setData(data: readonly Candle[]) {
      if (data === candles) return
      candles = data
      marks = detectBarCounts(data).filter((m) => (m.kind === 'H' ? showHigh : showLow))
      requestUpdate()
    },
    destroy() {
      chart.unsubscribeCrosshairMove(onCrosshairMove)
      marks = []; candles = []
      try { series.detachPrimitive(primitive) } catch { /* The chart may already have removed its series. */ }
    },
  }
}
