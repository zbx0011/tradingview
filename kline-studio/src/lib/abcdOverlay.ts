import type { IChartApi, MouseEventParams, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, Logical, SeriesType } from 'lightweight-charts'
import type { Candle } from './market'
import type { AbcdPoint } from './abcd'
import { ABCD_TIMEFRAMES, computeChartAbcd, type AbcdTimeframe, type ChartAbcd } from './abcdChart'
import { threePushCoordinate, threePushMinuteWindow, type ThreePushMinuteSource } from './threePushProjection'

/**
 * At rest only the D line of each pattern is drawn, at 70% transparency (30% opacity); the whole
 * AB=CD (A-B-C zigzag, letters, projection, label) appears opaque while the pointer is on its D line.
 */
const IDLE_ALPHA = 0.3
const LIVE_ALPHA = 0.3
const HOVER_DISTANCE = 9
/** A finger is less precise than a mouse pointer. */
const TAP_DISTANCE = 22

export const ABCD_COLOR = '#e03131'

export interface AbcdChartOptions {
  /** Levels to draw (default: all). */
  levels?: readonly AbcdTimeframe[]
  /** Kinds to draw (default: both). */
  kinds?: readonly ('leg' | 'spike')[]
  /** Touch screens: a tap on a D line shows the whole pattern (and a tap elsewhere hides it) instead of mouse hover. */
  tapToSelect?: boolean
}

/**
 * Two kinds of AB=CD are drawn, all in red and labelled with their level:
 * - settled: the CD leg ended at or near D (a little short, a little past, or a pin through D) — A→B→C→(CD extreme) zigzag and a short line at D;
 * - live: the newest pattern still in play at the last candle — A→B→C, the CD leg so far, a dashed
 *   projection to D and a D line running to the right edge with its price, so D can be prepared for.
 */
export function attachAbcdOverlay(chart: IChartApi, series: ISeriesApi<SeriesType>, options: AbcdChartOptions = {}) {
  const levels = options.levels ?? ABCD_TIMEFRAMES.map((t) => t.label)
  const kinds = options.kinds ?? ['leg', 'spike']
  let patterns: ChartAbcd[] = []
  let lastData: readonly Candle[] | null = null
  let minuteSource: ThreePushMinuteSource | undefined
  let windowKey = ''
  let requestUpdate = () => {}
  let hoveredKey: string | null = null
  const timeScale = chart.timeScale()
  const x = (index: number) => threePushCoordinate(index, (i) => timeScale.logicalToCoordinate(i as Logical))
  const xy = (p: AbcdPoint) => {
    const px = x(p.index), py = series.priceToCoordinate(p.price)
    return px === null || py === null ? null : { x: px, y: py }
  }
  const dPoint = (p: ChartAbcd): AbcdPoint => ({ index: p.dIndex, time: 0, price: p.d })
  /**
   * The last vertex of a settled pattern is D itself: the CD leg ended at D (within the near-D tolerance), so it sits on
   * the D line rather than at the leg's raw extreme a few points short of / past it. A running one keeps its real extreme.
   */
  const endVertex = (p: ChartAbcd) => {
    const raw = p.e && xy(p.e)
    if (p.live || !raw) return raw
    const y = series.priceToCoordinate(p.d)
    return y === null ? raw : { x: raw.x, y }
  }
  const keyOf = (p: ChartAbcd) => `${p.kind ?? 'leg'}|${p.timeframe}|${p.direction}|${p.a.time}|${p.b.time}`
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
    patterns = computeChartAbcd({ candles: lastData, minutes }, {}, levels, kinds)
  }
  const distanceToSegment = (px: number, py: number, a: { x: number, y: number }, b: { x: number, y: number }) => {
    const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len))
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy))
  }
  const hitTest = (px: number, py: number) => {
    let best: string | null = null, bestDistance = options.tapToSelect ? TAP_DISTANCE : HOVER_DISTANCE
    for (const pattern of patterns) {
      const points = [xy(pattern.a), xy(pattern.b), xy(pattern.c), pattern.live ? xy(dPoint(pattern)) : endVertex(pattern)]
      // The zigzag is only visible (and so only hoverable) once its pattern is the hovered one; at rest only the D line reacts.
      if (keyOf(pattern) === hoveredKey) {
        for (let k = 0; k < 3; k += 1) {
          const a = points[k], b = points[k + 1]
          if (!a || !b) continue
          const distance = distanceToSegment(px, py, a, b)
          if (distance < bestDistance) { bestDistance = distance; best = keyOf(pattern) }
        }
      }
      // The horizontal D line: from C to the right edge for a live projection, a short line around the CD extreme otherwise.
      const dy = series.priceToCoordinate(pattern.d), c = points[2]
      if (dy === null || !c) continue
      let line: [number, number] | null = null
      if (pattern.live) line = [c.x, Number.MAX_SAFE_INTEGER]
      else {
        const centre = pattern.e?.index ?? pattern.c.index, half = Math.max(3, (centre - pattern.c.index) / 2)
        const x0 = x(centre - half), x1 = x(centre + half)
        if (x0 !== null && x1 !== null) line = [x0, x1]
      }
      if (!line) continue
      const distance = distanceToSegment(px, py, { x: line[0], y: dy }, { x: line[1], y: dy })
      if (distance < bestDistance) { bestDistance = distance; best = keyOf(pattern) }
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
  const onVisibleRangeChange = () => { if (minuteSource) recompute(); requestUpdate() }
  timeScale.subscribeVisibleLogicalRangeChange(onVisibleRangeChange)

  const draw = (context: CanvasRenderingContext2D, width: number, height: number) => {
    const range = timeScale.getVisibleLogicalRange()
    if (!range || !lastData) return
    const format = (price: number) => series.priceFormatter().format(price)
    context.save()
    context.beginPath(); context.rect(0, 0, width, height); context.clip()
    context.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    context.textAlign = 'center'
    context.strokeStyle = ABCD_COLOR; context.fillStyle = ABCD_COLOR
    const labels: { x: number, y: number, w: number }[] = []
    const label = (text: string, cx: number, cy: number, step: number) => {
      const w = context.measureText(text).width + 10
      const lx = Math.min(width - w / 2, Math.max(w / 2, cx))
      let ly = Math.min(height - 8, Math.max(14, cy))
      while (labels.some((r) => Math.abs(r.x - lx) < (r.w + w) / 2 && Math.abs(r.y - ly) < 17) && ly > 14 && ly < height - 8) ly += step
      labels.push({ x: lx, y: ly, w })
      const alpha = context.globalAlpha
      context.globalAlpha = alpha
      context.fillStyle = 'rgba(255,255,255,0.9)'
      context.fillRect(lx - w / 2, ly - 12, w, 17)
      context.fillStyle = ABCD_COLOR; context.fillText(text, lx, ly)
      context.globalAlpha = alpha
    }
    // Live projections last, so they are on top of settled ones.
    const ordered = [...patterns.filter((p) => !p.live), ...patterns.filter((p) => p.live)]
    let nearestAbove: ChartAbcd | null = null, nearestBelow: ChartAbcd | null = null
    let aboveY = -Infinity, belowY = Infinity
    for (const pattern of ordered) {
      const y = pattern.live ? series.priceToCoordinate(pattern.d) : null
      if (y === null) continue
      if (y < 0 && y > aboveY) { aboveY = y; nearestAbove = pattern }
      if (y > height && y < belowY) { belowY = y; nearestBelow = pattern }
    }
    for (const pattern of ordered) {
      const right = pattern.live ? Infinity : pattern.e?.index ?? pattern.c.index
      if (right < range.from - 3 || pattern.a.index > range.to + 3) continue
      const hovered = hoveredKey === keyOf(pattern)
      context.globalAlpha = hovered ? 1 : pattern.live ? LIVE_ALPHA : IDLE_ALPHA
      context.lineWidth = pattern.live || hovered ? 1.6 : 1.3
      context.setLineDash([])
      if (!hovered) {
        // At rest: just the D line, no letters, labels or zigzag.
        const dLine = series.priceToCoordinate(pattern.d)
        if (dLine === null) continue
        let from: number | null, to: number | null
        if (pattern.live) { from = xy(pattern.c)?.x ?? null; to = width }
        else {
          const centre = pattern.e?.index ?? pattern.c.index, half = Math.max(3, (centre - pattern.c.index) / 2)
          from = x(centre - half); to = x(centre + half)
        }
        if (from === null || to === null) continue
        context.beginPath(); context.moveTo(from, dLine); context.lineTo(to, dLine); context.stroke()
        continue
      }
      const a = xy(pattern.a), b = xy(pattern.b), c = xy(pattern.c), e = endVertex(pattern), d = xy(dPoint(pattern))
      context.beginPath()
      let moved = false
      for (const p of [a, b, c, e]) {
        if (!p) { moved = false; continue }
        if (moved) context.lineTo(p.x, p.y); else { context.moveTo(p.x, p.y); moved = true }
      }
      context.stroke()
      const up = pattern.direction === 'up'
      const outward = (isLegExtreme: boolean) => up === isLegExtreme ? -7 : 14
      if (a) context.fillText('A', a.x, a.y + outward(false))
      if (b) context.fillText('B', b.x, b.y + outward(true))
      if (c) context.fillText('C', c.x, c.y + outward(false))
      if (!pattern.live && e) context.fillText('D', e.x, e.y + outward(true))
      const dy = series.priceToCoordinate(pattern.d)
      if (pattern.live) {
        // Projection C→D, then D across to the right edge with its price.
        if (c && d) { context.setLineDash([5, 4]); context.beginPath(); context.moveTo(c.x, c.y); context.lineTo(d.x, d.y); context.stroke() }
        if (dy !== null && c) {
          context.setLineDash([]); context.beginPath(); context.moveTo(c.x, dy); context.lineTo(width, dy); context.stroke()
          if (d) context.fillText('D', d.x, dy + (up ? -7 : 14))
          const status = pattern.confirmedIndex < 0 ? '（C 未定）' : ''
          // D outside the visible prices: only the nearest one above and below keeps a label, at the edge, with an arrow towards D.
          const beyond = dy < 0 ? '↑ ' : dy > height ? '↓ ' : ''
          if (beyond && pattern !== nearestAbove && pattern !== nearestBelow) continue
          label(`${beyond}${pattern.kind === 'spike' ? '急速转通道 ' : ''}AB=CD ${pattern.timeframe} · D ${format(pattern.d)}${status}`, width - 90, dy + (up ? -8 : 16), up ? -18 : 18)
        }
      } else {
        // Settled at D: a short line at D across the end of the CD leg.
        const half = Math.max(3, ((pattern.e?.index ?? pattern.c.index) - pattern.c.index) / 2)
        const centre = pattern.e?.index ?? pattern.c.index
        const x0 = x(centre - half), x1 = x(centre + half)
        if (dy !== null && x0 !== null && x1 !== null) { context.beginPath(); context.moveTo(x0, dy); context.lineTo(x1, dy); context.stroke() }
        if (e) {
          const name = pattern.kind === 'spike' ? '急速转通道 AB=CD' : 'AB=CD'
          const text = hovered ? `${name} ${pattern.timeframe} · D ${format(pattern.d)} · 实体 ${format(pattern.bodyD)}` : `${name} ${pattern.timeframe}`
          label(text, e.x, e.y + (up ? -20 : 22), up ? -18 : 18)
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
    setData(candles: readonly Candle[], source?: ThreePushMinuteSource) {
      if (candles === lastData && source === minuteSource) return
      lastData = candles; minuteSource = source; windowKey = ''
      recompute(); requestUpdate()
    },
    destroy() {
      timeScale.unsubscribeVisibleLogicalRangeChange(onVisibleRangeChange)
      chart.unsubscribeCrosshairMove(onCrosshairMove)
      chart.unsubscribeClick(onCrosshairMove)
      hoveredKey = null; patterns = []; lastData = null; minuteSource = undefined
      try { series.detachPrimitive(primitive) } catch { /* The chart may already have removed its series. */ }
    },
  }
}
