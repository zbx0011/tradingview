import type { IChartApi, MouseEventParams, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, Logical, SeriesType } from 'lightweight-charts'
import type { Candle } from './market'
import { computeChartThreePushes, type ChartThreePush, type ThreePushChartOptions, type ThreePushPoint, type ThreePushTimeframe } from './threePush'
import { mergeProjectedThreePushes, projectThreePushesToChart, threePushCoordinate, threePushMinuteWindow, type ThreePushMinuteSource } from './threePushProjection'

/** Patterns stay faint until the pointer is on one; the hovered pattern is drawn fully opaque. */
const IDLE_ALPHA = 0.22
const HOVER_DISTANCE = 9
/** A finger is less precise than a mouse pointer. */
const TAP_DISTANCE = 22

export const THREE_PUSH_COLORS: Record<ThreePushTimeframe, string> = { '1m': '#2962ff', '5m': '#ef8b22', '15m': '#a45cdb' }

/** A chart primitive moves/clips with the candle series and does not change its price scale. */
export function attachThreePushOverlay(chart: IChartApi, series: ISeriesApi<SeriesType>, options: ThreePushChartOptions = {}) {
  let patterns: ChartThreePush[] = []
  let chartPatterns: ChartThreePush[] = []
  let lastData: readonly Candle[] | null = null
  let minuteSource: ThreePushMinuteSource | undefined
  let minuteTape: readonly Candle[] | null = null
  let minuteFrom = -1, minuteTo = -1
  let minutePatterns: ChartThreePush[] = []
  let requestUpdate = () => {}
  let hoveredKey: string | null = null
  /** Push numbers and the pattern label as drawn last frame: pointing at them also selects the pattern. */
  let hitBoxes: { key: string, x0: number, y0: number, x1: number, y1: number }[] = []
  const timeScale = chart.timeScale()
  const coordinateAt = (index: number) => timeScale.logicalToCoordinate(index as Logical)
  const updateMinutePatterns = () => {
    if (!lastData) return
    if (!minuteSource || (options.timeframes && !options.timeframes.includes('1m'))) { patterns = chartPatterns; return }
    const window = threePushMinuteWindow(minuteSource, lastData, timeScale.getVisibleLogicalRange()?.to)
    if (minuteTape !== minuteSource.candles || minuteFrom !== window.from || minuteTo !== window.to) {
      minuteTape = minuteSource.candles; minuteFrom = window.from; minuteTo = window.to
      minutePatterns = computeChartThreePushes(minuteTape.slice(minuteFrom, minuteTo), { ...options, timeframes: ['1m'] })
    }
    const combined = [...projectThreePushesToChart(minutePatterns, lastData), ...chartPatterns]
    patterns = options.mergeOverlaps === false ? combined : mergeProjectedThreePushes(combined)
  }
  const onVisibleRangeChange = () => { updateMinutePatterns(); requestUpdate() }
  timeScale.subscribeVisibleLogicalRangeChange(onVisibleRangeChange)
  const xy = (p: ThreePushPoint) => {
    const x = threePushCoordinate(p.index, coordinateAt), y = series.priceToCoordinate(p.price)
    return x === null || y === null ? null : { x, y }
  }
  const patternKey = (pattern: ChartThreePush) => `${pattern.label}|${pattern.direction}|${pattern.start.index}|${pattern.pushes.at(-1)!.peak.index}`
  const distanceToSegment = (px: number, py: number, a: { x: number, y: number }, b: { x: number, y: number }) => {
    const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len))
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy))
  }
  /** Nearest pattern whose zigzag passes within a few pixels of the pointer. */
  const hitTest = (px: number, py: number) => {
    for (let i = hitBoxes.length - 1; i >= 0; i -= 1) {
      const box = hitBoxes[i]
      if (px >= box.x0 && px <= box.x1 && py >= box.y0 && py <= box.y1) return box.key
    }
    let best: string | null = null, bestDistance = options.tapToSelect ? TAP_DISTANCE : HOVER_DISTANCE
    for (const pattern of patterns) {
      let previous = xy(pattern.start)
      for (const push of pattern.pushes) {
        const start = xy(push.start), peak = xy(push.peak)
        const segments = [[previous, start], [start, peak]] as const
        for (const [a, b] of segments) {
          if (!a || !b) continue
          const distance = distanceToSegment(px, py, a, b)
          if (distance < bestDistance) { bestDistance = distance; best = patternKey(pattern) }
        }
        previous = peak ?? previous
      }
    }
    return best
  }
  const onCrosshairMove = (param: MouseEventParams) => {
    const next = param.point ? hitTest(param.point.x, param.point.y) : null
    if (next === hoveredKey) return
    hoveredKey = next; requestUpdate()
  }
  if (options.tapToSelect) chart.subscribeClick(onCrosshairMove)
  else chart.subscribeCrosshairMove(onCrosshairMove)
  const draw = (context: CanvasRenderingContext2D, width: number, height: number) => {
    const range = timeScale.getVisibleLogicalRange()
    if (!range) return
    // Numbers and the label sit outside the candle that holds the extreme: a one-minute push inside a five-minute
    // candle is drawn at its own price (inside the candle), but its mark goes beyond the candle's high / low.
    const markPoint = (p: ThreePushPoint, direction: 'up' | 'down') => {
      const x = threePushCoordinate(p.index, coordinateAt)
      const host = lastData?.[Math.round(p.index)]
      const price = !host ? p.price : direction === 'up' ? Math.max(p.price, host.high) : Math.min(p.price, host.low)
      const y = series.priceToCoordinate(price)
      return x === null || y === null ? null : { x, y }
    }
    context.save()
    context.beginPath(); context.rect(0, 0, width, height); context.clip()
    context.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    context.textAlign = 'center'
    const boxes: typeof hitBoxes = []
    for (const pattern of patterns) {
      const last = pattern.pushes.at(-1)!.peak
      if (last.index < range.from - 3 || pattern.start.index > range.to + 3) continue
      const color = THREE_PUSH_COLORS[pattern.timeframes[0]]
      context.strokeStyle = color; context.fillStyle = color; context.lineWidth = 1.4
      context.globalAlpha = hoveredKey === patternKey(pattern) ? 1 : IDLE_ALPHA
      // The zigzag shows the qualifying pullbacks instead of implying three adjacent candles are three pushes.
      // Direction is read off the line itself: each push leg ends in an arrowhead at its extreme,
      // the pullbacks between the legs have none. All segments share one line width.
      let previous = xy(pattern.start)
      for (const push of pattern.pushes) {
        const start = xy(push.start), peak = xy(push.peak)
        if (previous && start) {
          context.beginPath(); context.moveTo(previous.x, previous.y); context.lineTo(start.x, start.y); context.stroke()
        }
        if (start && peak) {
          context.beginPath(); context.moveTo(start.x, start.y); context.lineTo(peak.x, peak.y); context.stroke()
          const angle = Math.atan2(peak.y - start.y, peak.x - start.x), size = 8
          context.beginPath()
          context.moveTo(peak.x, peak.y)
          context.lineTo(peak.x - size * Math.cos(angle - 0.45), peak.y - size * Math.sin(angle - 0.45))
          context.lineTo(peak.x - size * Math.cos(angle + 0.45), peak.y - size * Math.sin(angle + 0.45))
          context.closePath(); context.fill()
        }
        previous = peak ?? previous
      }
      const dy = pattern.direction === 'up' ? -10 : 15
      pattern.pushes.forEach((push, index) => {
        if (push.peak.index < range.from - 2 || push.peak.index > range.to + 2) return
        const p = markPoint(push.peak, pattern.direction)
        if (p) {
          context.fillText(String(index + 1), p.x, p.y + dy)
          boxes.push({ key: patternKey(pattern), x0: p.x - 8, x1: p.x + 8, y0: p.y + dy - 12, y1: p.y + dy + 5 })
        }
      })
      const anchor = markPoint(last, pattern.direction)
      if (anchor && last.index >= range.from - 2 && last.index <= range.to + 2) {
        const text = pattern.label
        const labelWidth = context.measureText(text).width + 10
        const x = Math.min(width - labelWidth / 2, Math.max(labelWidth / 2, anchor.x))
        // Unmerged levels share the same geometry; keep their labels readable
        // rather than painting the last level over all the previous labels.
        const levelOffset = options.mergeOverlaps === false ? ({ '1m': 0, '5m': 18, '15m': 36 })[pattern.timeframes[0]] : 0
        const stackHeight = options.mergeOverlaps === false ? 36 : 0
        const base = pattern.direction === 'up'
          ? Math.min(height - 8, Math.max(14 + stackHeight, anchor.y + dy * 2.4))
          : Math.min(height - 8 - stackHeight, Math.max(14, anchor.y + dy * 2.4))
        const y = base + (pattern.direction === 'up' ? -levelOffset : levelOffset)
        context.fillStyle = 'rgba(255,255,255,0.88)'
        context.fillRect(x - labelWidth / 2, y - 12, labelWidth, 17)
        context.fillStyle = color; context.fillText(text, x, y)
        boxes.push({ key: patternKey(pattern), x0: x - labelWidth / 2, x1: x + labelWidth / 2, y0: y - 12, y1: y + 5 })
      }
    }
    context.restore()
    hitBoxes = boxes
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
    setData(candles: readonly Candle[], source?: ThreePushMinuteSource) {
      if (candles === lastData && minuteSource === source) return
      if (candles !== lastData) chartPatterns = computeChartThreePushes(candles, options)
      lastData = candles; minuteSource = source
      updateMinutePatterns(); requestUpdate()
    },
    destroy() {
      timeScale.unsubscribeVisibleLogicalRangeChange(onVisibleRangeChange)
      chart.unsubscribeCrosshairMove(onCrosshairMove)
      chart.unsubscribeClick(onCrosshairMove)
      hoveredKey = null; hitBoxes = []; patterns = []; chartPatterns = []; minutePatterns = []; lastData = null; minuteSource = undefined; minuteTape = null
      try { series.detachPrimitive(primitive) } catch { /* The chart may already have removed its series. */ }
    },
  }
}
