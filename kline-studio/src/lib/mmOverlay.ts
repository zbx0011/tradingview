import type { IChartApi, MouseEventParams, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, Logical, SeriesType } from 'lightweight-charts'
import type { Candle } from './market'
import type { MmPoint } from './mm'
import { MM_TIMEFRAMES, computeChartMm, type ChartMm, type MmTimeframe } from './mmChart'
import { threePushCoordinate, threePushMinuteWindow, type ThreePushMinuteSource } from './threePushProjection'

/** At rest only the target lines are drawn, faint; the whole measurement appears opaque while the pointer is on one. */
const IDLE_ALPHA = 0.35
/** A smaller swing broken by the same bar as a bigger one: fainter still. */
const MINOR_ALPHA = 0.15
const HOVER_DISTANCE = 9

export const MM_COLOR = '#1098ad'

export interface MmChartOptions {
  /** Levels to draw (default: all). */
  levels?: readonly MmTimeframe[]
  /** Kinds to draw (default: both). */
  kinds?: readonly ChartMm['kind'][]
}

/**
 * Z-style MM (被突破的波段点翻一倍), in teal:
 * - live (gap still open, target not reached): the wick target (solid) and the body target (dashed) from the breakout
 *   bar to the right edge;
 * - reached: a short line at the target where price got there.
 * Hovering a target line shows the measurement: L → H (the broken swing point), the broken level up to the breakout
 * bar, the equal distance H → target, and the prices.
 */
export function attachMmOverlay(chart: IChartApi, series: ISeriesApi<SeriesType>, options: MmChartOptions = {}) {
  const levels = options.levels ?? MM_TIMEFRAMES.map((t) => t.label)
  const kinds = options.kinds ?? ['swing', 'spike']
  let patterns: ChartMm[] = []
  let lastData: readonly Candle[] | null = null
  let minuteSource: ThreePushMinuteSource | undefined
  let windowKey = ''
  let requestUpdate = () => {}
  let hoveredKey: string | null = null
  const timeScale = chart.timeScale()
  const x = (index: number) => threePushCoordinate(index, (i) => timeScale.logicalToCoordinate(i as Logical))
  const xy = (p: MmPoint) => {
    const px = x(p.index), py = series.priceToCoordinate(p.price)
    return px === null || py === null ? null : { x: px, y: py }
  }
  const keyOf = (p: ChartMm) => `${p.kind}|${p.timeframe}|${p.direction}|${p.h.time}|${p.l.time}`
  /** Horizontal extent of the target line: breakout → right edge while live, a short line where it was reached. */
  const targetSpan = (p: ChartMm, width: number): [number, number] | null => {
    if (p.live) { const from = x(p.breakoutIndex); return from === null ? null : [from, width] }
    const half = Math.max(3, (p.endIndex - p.breakoutIndex) / 2)
    const x0 = x(p.endIndex - half), x1 = x(p.endIndex + half)
    return x0 === null || x1 === null ? null : [x0, x1]
  }
  const recompute = () => {
    if (!lastData || !levels.length) { patterns = []; return }
    let minutes: { candles: readonly Candle[], endTime: number } | undefined
    if (minuteSource) {
      // Same bounded window as the three-push 1m level, so a long minute tape is not rescanned on every pan.
      const window = threePushMinuteWindow(minuteSource, lastData, timeScale.getVisibleLogicalRange()?.to)
      const key = `${window.from}:${window.to}`
      if (key === windowKey) return
      windowKey = key
      minutes = { candles: minuteSource.candles.slice(window.from, window.to), endTime: minuteSource.endTime }
    }
    patterns = computeChartMm({ candles: lastData, minutes }, {}, levels, kinds)
  }
  const distanceToSegment = (px: number, py: number, a: { x: number, y: number }, b: { x: number, y: number }) => {
    const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len))
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy))
  }
  let paneWidth = 0
  const hitTest = (px: number, py: number) => {
    let best: string | null = null, bestDistance = HOVER_DISTANCE
    const consider = (pattern: ChartMm, a: { x: number, y: number } | null, b: { x: number, y: number } | null) => {
      if (!a || !b) return
      const distance = distanceToSegment(px, py, a, b)
      if (distance < bestDistance) { bestDistance = distance; best = keyOf(pattern) }
    }
    for (const pattern of patterns) {
      const span = targetSpan(pattern, paneWidth || Number.MAX_SAFE_INTEGER)
      for (const price of pattern.live ? [pattern.target, pattern.bodyTarget] : [pattern.target]) {
        const y = series.priceToCoordinate(price)
        if (span && y !== null) consider(pattern, { x: span[0], y }, { x: span[1], y })
      }
      // The measurement itself is only visible (and so only hoverable) once its pattern is the hovered one.
      if (keyOf(pattern) === hoveredKey) {
        const l = xy(pattern.l), h = xy(pattern.h), bx = x(pattern.breakoutIndex), ty = series.priceToCoordinate(pattern.target)
        consider(pattern, l, h)
        if (h && bx !== null) consider(pattern, h, { x: bx, y: h.y })
        if (h && bx !== null && ty !== null) consider(pattern, { x: bx, y: h.y }, { x: bx, y: ty })
      }
    }
    return best
  }
  const onCrosshairMove = (param: MouseEventParams) => {
    const next = param.point ? hitTest(param.point.x, param.point.y) : null
    if (next === hoveredKey) return
    hoveredKey = next; requestUpdate()
  }
  chart.subscribeCrosshairMove(onCrosshairMove)
  const onVisibleRangeChange = () => { if (minuteSource) recompute(); requestUpdate() }
  timeScale.subscribeVisibleLogicalRangeChange(onVisibleRangeChange)

  const draw = (context: CanvasRenderingContext2D, width: number, height: number) => {
    paneWidth = width
    const range = timeScale.getVisibleLogicalRange()
    if (!range || !lastData) return
    const format = (price: number) => series.priceFormatter().format(price)
    context.save()
    context.beginPath(); context.rect(0, 0, width, height); context.clip()
    context.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    context.textAlign = 'center'
    context.strokeStyle = MM_COLOR; context.fillStyle = MM_COLOR
    const line = (x0: number, y0: number, x1: number, y1: number, dash: number[] = []) => {
      context.setLineDash(dash); context.beginPath(); context.moveTo(x0, y0); context.lineTo(x1, y1); context.stroke()
    }
    // One bar can break several tops at once: the most prominent one (the biggest swing or range) stands out.
    const major = new Map<string, ChartMm>()
    for (const p of patterns) {
      const group = `${p.kind}|${p.timeframe}|${p.direction}|${p.breakoutIndex}`
      const best = major.get(group)
      if (!best || p.prominence > best.prominence) major.set(group, p)
    }
    const majors = new Set(major.values())
    // The hovered measurement last, so it is on top.
    const ordered = [...patterns.filter((p) => keyOf(p) !== hoveredKey), ...patterns.filter((p) => keyOf(p) === hoveredKey)]
    for (const pattern of ordered) {
      const right = pattern.live ? Infinity : pattern.endIndex + 3
      if (right < range.from - 3 || pattern.l.index > range.to + 3) continue
      const hovered = keyOf(pattern) === hoveredKey
      context.globalAlpha = hovered ? 1 : majors.has(pattern) ? IDLE_ALPHA : MINOR_ALPHA
      context.lineWidth = hovered ? 1.6 : 1.3
      const span = targetSpan(pattern, width)
      const ty = series.priceToCoordinate(pattern.target), by = series.priceToCoordinate(pattern.bodyTarget)
      if (span && ty !== null) line(span[0], ty, span[1], ty)
      if (span && by !== null && pattern.live) line(span[0], by, span[1], by, [4, 3])
      if (!hovered) continue
      const up = pattern.direction === 'up'
      const l = xy(pattern.l), h = xy(pattern.h), bx = x(pattern.breakoutIndex)
      // L → H, the broken level from H to the breakout bar, and the equal distance on the breakout bar: L–H solid, H–T dashed.
      if (l && h) line(l.x, l.y, h.x, h.y)
      if (h && bx !== null) {
        line(h.x, h.y, bx, h.y, [2, 3])
        if (l) line(bx, l.y, bx, h.y)
        if (ty !== null) line(bx, h.y, bx, ty, [5, 4])
      }
      context.setLineDash([])
      if (l) context.fillText('L', l.x, l.y + (up ? 14 : -7))
      if (h) context.fillText('H', h.x, h.y + (up ? -7 : 14))
      if (ty === null) continue
      const pending = pattern.status !== 'pending' ? '' : pattern.kind === 'spike' ? '（大K还在连续）' : '（待跟随K）'
      const reached = pattern.status === 'reached' ? ' · 已到' : ''
      const size = `${pattern.kind === 'spike' ? '长' : '波段'} ${pattern.prominence.toFixed(1)} ATR`
      const name = pattern.kind === 'spike' ? '连续大K MM' : '突破点 MM'
      const text = `${name} ${pattern.timeframe} · 影线 ${format(pattern.target)} · 实体 ${format(pattern.bodyTarget)} · ${size}${reached}${pending}`
      const w = context.measureText(text).width + 10
      const cx = pattern.live ? width - w / 2 - 4 : Math.min(width - w / 2, Math.max(w / 2, x(pattern.endIndex) ?? width - w / 2))
      const cy = Math.min(height - 8, Math.max(14, ty + (up ? -8 : 16)))
      context.fillStyle = 'rgba(255,255,255,0.9)'
      context.fillRect(cx - w / 2, cy - 12, w, 17)
      context.fillStyle = MM_COLOR; context.fillText(text, cx, cy)
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
    setData(candles: readonly Candle[], source?: ThreePushMinuteSource) {
      if (candles === lastData && source === minuteSource) return
      lastData = candles; minuteSource = source; windowKey = ''
      recompute(); requestUpdate()
    },
    destroy() {
      timeScale.unsubscribeVisibleLogicalRangeChange(onVisibleRangeChange)
      chart.unsubscribeCrosshairMove(onCrosshairMove)
      hoveredKey = null; patterns = []; lastData = null; minuteSource = undefined
      try { series.detachPrimitive(primitive) } catch { /* The chart may already have removed its series. */ }
    },
  }
}
