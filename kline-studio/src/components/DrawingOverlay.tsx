import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  constrainDrawingPoint, duplicateDrawing, normalizeFibSettings, partiallyEraseDrawing,
  type Drawing, type DrawingAction, type DrawingHistory, type DrawingLineStyle, type DrawingPoint, makeDrawing,
} from '../lib/drawings'
import {
  calculateChartMeasurement, formatMeasurementDuration, formatMeasurementTime, formatMeasurementVolume, formatSignedMeasurement,
} from '../lib/measurement'
import { formatPrice, type Candle, type IntervalId, type SymbolId } from '../lib/market'
import {
  calculatePositionMetrics, calculatePositionMetricsFromLevels, createDefaultPositionPoints, formatPositionNumber,
  resolvePositionGeometry, updatePositionPoints,
  type PositionHandle,
} from '../lib/positionDrawing'
import { getTool, type ToolBehavior } from '../lib/toolCatalog'
import type { MagnetMode } from './DrawingToolbar'

interface Props {
  activeTool: string
  history: DrawingHistory
  dispatch: Dispatch<DrawingAction>
  color: string
  magnetMode: MagnetMode
  drawingsLocked: boolean
  hidden: boolean
  candles: Candle[]
  symbol: SymbolId
  interval: IntervalId
  quickMeasurement: Drawing | null
  onMeasurePoint: (point: DrawingPoint) => { time: number; price: number } | null
  onProjectPoint: (point: { time: number; price: number }) => { x: number; y: number } | null
  onQuickMeasurementChange: (drawing: Drawing | null) => void
  onToolComplete: () => void
  onZoomSelection: (from: number, to: number) => void
  onOpenProperties: (drawing: Drawing) => void
}

const distance = (a: DrawingPoint, b: DrawingPoint) => Math.hypot(a.x - b.x, a.y - b.y)
const textBehaviors: ToolBehavior[] = ['text', 'note', 'callout', 'comment', 'price-label', 'signpost', 'flag', 'table', 'media', 'icon', 'arrow-mark']
const freehandBehaviors: ToolBehavior[] = ['brush', 'highlighter', 'polyline']
const oneClickBehaviors: ToolBehavior[] = [...textBehaviors, 'horizontal', 'horizontal-ray', 'vertical', 'cross']
const positionBehaviors: ToolBehavior[] = ['long-position', 'short-position']
const dashForLineStyle = (style: DrawingLineStyle) => style === 'dashed' ? '8 6' : style === 'dotted' ? '2 5' : undefined
const formatFibValue = (value: number) => String(Number(value.toFixed(3)))
const visibilityGroupForInterval = (interval: IntervalId): 'minutes' | 'hours' | 'days' | 'weeks' => {
  if (interval.endsWith('m')) return 'minutes'
  if (interval.endsWith('h')) return 'hours'
  if (interval.endsWith('d')) return 'days'
  return 'weeks'
}

interface DrawingDrag {
  start: DrawingPoint
  pointerId: number
  originals: { id: string; points: DrawingPoint[] }[]
  source: Drawing
  control: boolean
  moved: boolean
  cloneId?: string
  positionHandle?: PositionHandle
}

export function DrawingOverlay({
  activeTool, history, dispatch, color, magnetMode, drawingsLocked, hidden, candles, symbol, interval, quickMeasurement, onMeasurePoint, onProjectPoint, onQuickMeasurementChange, onToolComplete, onZoomSelection, onOpenProperties,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [viewportSize, setViewportSize] = useState({ width: 1000, height: 1000 })
  const [draft, setDraft] = useState<Drawing | null>(null)
  const [placementPhase, setPlacementPhase] = useState<'idle' | 'placing' | 'awaiting-second'>('idle')
  const draftRef = useRef<Drawing | null>(null)
  const placementRef = useRef<{ start: DrawingPoint; pointerId: number; moved: boolean } | null>(null)
  const awaitingSecondPointRef = useRef(false)
  const suppressNextClickRef = useRef(false)
  const dragRef = useRef<DrawingDrag | null>(null)
  const activeDefinition = getTool(activeTool)
  const selectedDrawingIds = history.selectedIds ?? (history.selectedId ? [history.selectedId] : [])
  const handleRadius = {
    x: 5 * 1000 / Math.max(1, viewportSize.width),
    y: 5 * 1000 / Math.max(1, viewportSize.height),
  }

  const anchorPoint = useCallback((point: DrawingPoint): DrawingPoint => {
    const anchor = onMeasurePoint(point)
    return anchor ? { ...point, time: anchor.time, price: anchor.price } : point
  }, [onMeasurePoint])

  const projectNormalizedPoint = useCallback((point: DrawingPoint): DrawingPoint => {
    if (!Number.isFinite(point.time) || !Number.isFinite(point.price)) return point
    const projected = onProjectPoint({ time: point.time!, price: point.price! })
    if (!projected) return point
    return {
      ...point,
      x: projected.x / Math.max(1, viewportSize.width),
      y: projected.y / Math.max(1, viewportSize.height),
    }
  }, [onProjectPoint, viewportSize.height, viewportSize.width])

  useLayoutEffect(() => {
    const element = svgRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) setViewportSize({ width, height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!svgRef.current) return
    history.present.forEach((drawing) => {
      if (drawing.points.every((point) => Number.isFinite(point.time) && Number.isFinite(point.price))) return
      const points = drawing.points.map((point) => (
        Number.isFinite(point.time) && Number.isFinite(point.price) ? point : anchorPoint(point)
      ))
      if (points.some((point, index) => point.time !== drawing.points[index].time || point.price !== drawing.points[index].price)) {
        dispatch({ type: 'update', id: drawing.id, patch: { points } })
      }
    })
  }, [anchorPoint, dispatch, history.present, viewportSize.height, viewportSize.width])

  const updateDraft = (next: Drawing | null) => {
    draftRef.current = next
    setDraft(next)
  }

  const cancelDraft = () => {
    updateDraft(null)
    placementRef.current = null
    awaitingSecondPointRef.current = false
    setPlacementPhase('idle')
  }

  const snap = (point: DrawingPoint, mode: MagnetMode = magnetMode): DrawingPoint => {
    if (mode === 'off') return point
    const step = mode === 'strong' ? 0.025 : 0.0125
    const snapped = { x: Math.round(point.x / step) * step, y: Math.round(point.y / step) * step }
    if (mode === 'strong') return snapped
    return {
      x: Math.abs(point.x - snapped.x) < 0.004 ? snapped.x : point.x,
      y: Math.abs(point.y - snapped.y) < 0.004 ? snapped.y : point.y,
    }
  }

  const normalizedPoint = (event: { clientX: number; clientY: number; ctrlKey?: boolean; metaKey?: boolean }): DrawingPoint => {
    const rect = svgRef.current!.getBoundingClientRect()
    const temporaryToggle = event.ctrlKey || event.metaKey
    const effectiveMagnet = temporaryToggle ? (magnetMode === 'off' ? 'strong' : 'off') : magnetMode
    return snap({ x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }, effectiveMagnet)
  }

  const constrainedPoint = (point: DrawingPoint, start: DrawingPoint, behavior: ToolBehavior, shiftKey: boolean): DrawingPoint => {
    if (!shiftKey) return point
    const rect = svgRef.current!.getBoundingClientRect()
    return constrainDrawingPoint(start, point, behavior, rect.width, rect.height)
  }

  const px = (point: DrawingPoint) => {
    const projected = projectNormalizedPoint(point)
    return { x: projected.x * 1000, y: projected.y * 1000 }
  }

  const commitDraft = (drawing: Drawing) => {
    const first = drawing.points[0]
    const last = drawing.points.at(-1) ?? first
    if (drawing.behavior === 'zoom') {
      if (Math.abs(last.x - first.x) > 0.02) onZoomSelection(Math.min(first.x, last.x), Math.max(first.x, last.x))
    } else if (drawing.tool === 'measure' && drawing.points.length > 1) {
      if (distance(first, last) > 0.003) onQuickMeasurementChange(drawing)
    } else if (drawing.points.length > 1 && distance(first, last) > 0.003) {
      dispatch({ type: 'add', drawing })
    }
    cancelDraft()
    onToolComplete()
  }

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    const behavior = activeDefinition.behavior
    if (event.button !== 0 || behavior === 'cursor' || behavior === 'eraser' || oneClickBehaviors.includes(behavior) || positionBehaviors.includes(behavior) || awaitingSecondPointRef.current) return
    const point = anchorPoint(normalizedPoint(event))
    if (activeDefinition.id === 'measure') onQuickMeasurementChange(null)
    placementRef.current = { start: point, pointerId: event.pointerId, moved: false }
    setPlacementPhase('placing')
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  /**
   * TradingView's long/short position tool is a one-click tool.  The click
   * becomes the entry point and the tool creates a compact 1:1 rectangle so
   * the three price controls are immediately available for dragging.
   */
  const createDefaultPositionDrawing = (point: DrawingPoint) => {
    const side = activeDefinition.behavior === 'short-position' ? 'short' : 'long'
    const points = createDefaultPositionPoints(point, side).map(anchorPoint)
    const first = points[0]
    const drawing = makeDrawing(activeDefinition, first, color)
    drawing.points = points
    return drawing
  }

  const startPositionHandleDrag = (drawing: Drawing, handle: PositionHandle) => (event: ReactPointerEvent<SVGElement>) => {
    if (activeDefinition.behavior !== 'cursor' || drawingsLocked || drawing.locked) return
    event.preventDefault()
    event.stopPropagation()
    const selectedIds = selectedDrawingIds.includes(drawing.id) ? selectedDrawingIds : [drawing.id]
    if (!selectedDrawingIds.includes(drawing.id)) dispatch({ type: 'select', id: drawing.id })
    dispatch({ type: 'checkpoint' })
    dragRef.current = {
      start: normalizedPoint(event), pointerId: event.pointerId,
      originals: history.present.filter((item) => selectedIds.includes(item.id)).map((item) => ({ id: item.id, points: item.points.map(projectNormalizedPoint) })),
      source: drawing, control: false, moved: false, positionHandle: handle,
    }
    svgRef.current?.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    let point = normalizedPoint(event)
    const drag = dragRef.current
    if (drag) {
      event.preventDefault()
      if (drag.positionHandle) {
        const original = drag.originals.find((item) => item.id === drag.source.id)
        if (!original) return
        const base = original.points
        const side = drag.source.behavior === 'short-position' ? 'short' : 'long'
        const nextPoints = updatePositionPoints(base, drag.positionHandle, point, side).map((item) => anchorPoint(item))
        if (distance(point, drag.start) <= 0.003) return
        drag.moved = true
        dispatch({ type: 'update', id: original.id, patch: { points: nextPoints } })
        return
      }
      let delta = { x: point.x - drag.start.x, y: point.y - drag.start.y }
      const rect = svgRef.current!.getBoundingClientRect()
      if (event.shiftKey) {
        if (Math.abs(delta.x * rect.width) >= Math.abs(delta.y * rect.height)) delta = { x: delta.x, y: 0 }
        else delta = { x: 0, y: delta.y }
      }
      if (Math.hypot(delta.x * rect.width, delta.y * rect.height) < 3) return
      drag.moved = true
      if (drag.control && !drag.cloneId) {
        const clone = duplicateDrawing(drag.source, 0)
        drag.cloneId = clone.id
        drag.originals = [{ id: clone.id, points: clone.points }]
        dispatch({ type: 'add', drawing: clone })
      }
      drag.originals.forEach((original) => dispatch({
        type: 'update', id: original.id,
        patch: { points: original.points.map((item) => anchorPoint({ x: item.x + delta.x, y: item.y + delta.y })) },
      }))
      return
    }
    const placement = placementRef.current
    if (!placement) {
      const pending = draftRef.current
      if (pending && awaitingSecondPointRef.current && !freehandBehaviors.includes(pending.behavior)) {
        point = anchorPoint(constrainedPoint(point, projectNormalizedPoint(pending.points[0]), pending.behavior, event.shiftKey))
        updateDraft({ ...pending, points: [pending.points[0], point] })
      }
      return
    }
    if (distance(placement.start, point) <= 0.003) return
    placement.moved = true
    let current = draftRef.current
    if (!current) {
      current = makeDrawing(activeDefinition, placement.start, color)
      updateDraft(current)
    }
    point = anchorPoint(constrainedPoint(point, projectNormalizedPoint(placement.start), current.behavior, event.shiftKey))
    if (freehandBehaviors.includes(current.behavior)) {
      const last = current.points.at(-1) ?? current.points[0]
      if (distance(last, point) > 0.001) updateDraft({ ...current, points: [...current.points, point] })
    } else {
      updateDraft({ ...current, points: [current.points[0], point] })
    }
  }

  const handlePointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current
    if (drag) {
      if (drag.control && !drag.moved) dispatch({ type: 'select', id: drag.source.id, additive: true })
      if (drag.moved) suppressNextClickRef.current = true
      dragRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      return
    }
    const placement = placementRef.current
    if (!placement) return
    const rawEnd = normalizedPoint(event)
    const current = draftRef.current
    const end = anchorPoint(current ? constrainedPoint(rawEnd, projectNormalizedPoint(placement.start), current.behavior, event.shiftKey) : rawEnd)
    const moved = placement.moved || distance(placement.start, end) > 0.003
    placementRef.current = null
    setPlacementPhase(awaitingSecondPointRef.current ? 'awaiting-second' : 'idle')
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (moved && current) {
      const completed = freehandBehaviors.includes(current.behavior)
        ? current
        : { ...current, points: [current.points[0], end] }
      suppressNextClickRef.current = true
      commitDraft(completed)
    }
  }

  const handleCanvasClick = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false
      return
    }
    const behavior = activeDefinition.behavior
    if (behavior === 'cursor') {
      if (event.target === event.currentTarget) dispatch({ type: 'select', id: null })
      return
    }
    if (behavior === 'eraser' || freehandBehaviors.includes(behavior)) return
    let point = normalizedPoint(event)
    if (positionBehaviors.includes(behavior)) {
      dispatch({ type: 'add', drawing: createDefaultPositionDrawing(point) })
      onToolComplete()
      return
    }
    if (oneClickBehaviors.includes(behavior)) {
      point = anchorPoint(point)
      const drawing = makeDrawing(activeDefinition, point, color)
      if (behavior === 'horizontal') drawing.points = [anchorPoint({ x: 0, y: point.y }), anchorPoint({ x: 1, y: point.y })]
      if (behavior === 'horizontal-ray') drawing.points = [point, anchorPoint({ x: 1, y: point.y })]
      if (behavior === 'vertical') drawing.points = [anchorPoint({ x: point.x, y: 0 }), anchorPoint({ x: point.x, y: 1 })]
      if (behavior === 'cross') drawing.points = [point, point]
      dispatch({ type: 'add', drawing })
      onToolComplete()
      return
    }
    const current = draftRef.current
    if (awaitingSecondPointRef.current && current) {
      point = anchorPoint(constrainedPoint(point, projectNormalizedPoint(current.points[0]), current.behavior, event.shiftKey))
      commitDraft({ ...current, points: [current.points[0], point] })
      return
    }
    const drawing = makeDrawing(activeDefinition, anchorPoint(point), color)
    updateDraft(drawing)
    awaitingSecondPointRef.current = true
    setPlacementPhase('awaiting-second')
  }

  const selectOrErase = (drawing: Drawing) => (event: ReactPointerEvent<SVGGElement>) => {
    if (activeDefinition.behavior === 'eraser') {
      event.stopPropagation()
      if ((event.ctrlKey || event.metaKey) && freehandBehaviors.includes(drawing.behavior) && drawing.points.length > 3) {
        const point = normalizedPoint(event)
        const points = partiallyEraseDrawing(drawing, point)
        if (points) dispatch({ type: 'update', id: drawing.id, patch: { points } })
        else dispatch({ type: 'delete', id: drawing.id })
        return
      }
      dispatch({ type: 'delete', id: drawing.id })
      return
    }
    if (activeDefinition.behavior !== 'cursor') return
    event.stopPropagation()
    if (drawingsLocked || drawing.locked) return
    const control = event.ctrlKey || event.metaKey
    const selectedIds = selectedDrawingIds.includes(drawing.id) ? selectedDrawingIds : [drawing.id]
    if (!control) {
      if (!selectedDrawingIds.includes(drawing.id)) dispatch({ type: 'select', id: drawing.id })
      dispatch({ type: 'checkpoint' })
    }
    dragRef.current = {
      start: normalizedPoint(event), pointerId: event.pointerId,
      originals: history.present.filter((item) => selectedIds.includes(item.id)).map((item) => ({ id: item.id, points: item.points.map(projectNormalizedPoint) })),
      source: drawing, control, moved: false,
    }
    svgRef.current?.setPointerCapture(event.pointerId)
  }

  const measurementForDrawing = (drawing: Drawing) => {
    if (drawing.behavior !== 'measure' || drawing.points.length < 2) return null
    const first = drawing.points[0]
    const last = drawing.points.at(-1) ?? first
    const start = Number.isFinite(first.time) && Number.isFinite(first.price) ? { time: first.time!, price: first.price! } : onMeasurePoint(first)
    const end = Number.isFinite(last.time) && Number.isFinite(last.price) ? { time: last.time!, price: last.price! } : onMeasurePoint(last)
    if (!start || !end) return null
    return calculateChartMeasurement(start, end, candles, symbol)
  }

  const renderDrawing = (drawing: Drawing, isDraft = false, forceSelected = false) => {
    const behavior = drawing.behavior ?? getTool(drawing.tool).behavior
    if ((behavior === 'fib' || behavior === 'fib-extension') && !normalizeFibSettings(drawing.fib).visibility[visibilityGroupForInterval(interval)]) return null
    const points = drawing.points.map(px)
    const first = points[0]
    const last = points.at(-1) ?? first
    const selected = forceSelected || (!isDraft && selectedDrawingIds.includes(drawing.id))
    const dash = drawing.lineStyle === 'dashed' ? '8 6' : drawing.lineStyle === 'dotted' ? '2 5' : undefined
    const common = {
      stroke: drawing.color, strokeWidth: drawing.width, vectorEffect: 'non-scaling-stroke' as const,
      fill: 'none', strokeDasharray: dash,
    }
    const fill = colorWithAlpha(drawing.color, drawing.fillOpacity ?? 0.1)
    const mid = { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 }
    const dx = last.x - first.x
    const dy = last.y - first.y
    let content: ReactNode

    if (behavior === 'rectangle' || behavior === 'zoom') {
      content = <rect x={Math.min(first.x, last.x)} y={Math.min(first.y, last.y)} width={Math.abs(dx)} height={Math.abs(dy)} {...common} fill={behavior === 'zoom' ? 'rgba(41,108,255,.14)' : fill} strokeDasharray={behavior === 'zoom' ? '7 5' : dash} />
    } else if (behavior === 'rotated-rectangle') {
      const length = Math.hypot(dx, dy) || 1
      const ox = (-dy / length) * 55; const oy = (dx / length) * 55
      content = <polygon points={`${first.x + ox},${first.y + oy} ${last.x + ox},${last.y + oy} ${last.x - ox},${last.y - oy} ${first.x - ox},${first.y - oy}`} {...common} fill={fill} />
    } else if (freehandBehaviors.includes(behavior)) {
      content = <polyline points={points.map((point) => `${point.x},${point.y}`).join(' ')} {...common} opacity={behavior === 'highlighter' ? 0.38 : 1} strokeLinejoin="round" strokeLinecap="round" />
    } else if (behavior === 'text') {
      content = <text x={first.x} y={first.y} fill={drawing.color} fontSize="20" fontWeight="600">{drawing.text}</text>
    } else if (behavior === 'note' || behavior === 'comment') {
      content = <g><rect x={first.x} y={first.y - 32} width="150" height="48" rx="6" fill={fill} stroke={drawing.color} vectorEffect="non-scaling-stroke" /><text x={first.x + 10} y={first.y - 3} fill={drawing.color} fontSize="15">{drawing.text}</text></g>
    } else if (behavior === 'callout') {
      content = <g><path d={`M${first.x},${first.y} l18,-18 h135 v-45 h-160 v45 h15 z`} fill={fill} stroke={drawing.color} vectorEffect="non-scaling-stroke" /><text x={first.x + 22} y={first.y - 35} fill={drawing.color} fontSize="14">{drawing.text}</text></g>
    } else if (behavior === 'price-label') {
      content = <g><line x1="0" x2={first.x} y1={first.y} y2={first.y} {...common} strokeDasharray="5 5" /><path d={`M${first.x},${first.y} l18,-14 h112 v28 h-112 z`} fill={drawing.color} /><text x={first.x + 25} y={first.y + 5} fill="white" fontSize="13">{drawing.text}</text></g>
    } else if (behavior === 'signpost' || behavior === 'flag') {
      content = <g><line x1={first.x} x2={first.x} y1={first.y} y2={first.y - 70} {...common} /><path d={`M${first.x},${first.y - 70} h105 l-14,19 h-91 z`} fill={drawing.color} /><text x={first.x + 10} y={first.y - 56} fill="white" fontSize="12">{drawing.text}</text></g>
    } else if (behavior === 'table') {
      content = <g><rect x={first.x} y={first.y} width="180" height="82" rx="4" fill={fill} stroke={drawing.color} vectorEffect="non-scaling-stroke" /><line x1={first.x} x2={first.x + 180} y1={first.y + 28} y2={first.y + 28} {...common} /><line x1={first.x + 90} x2={first.x + 90} y1={first.y} y2={first.y + 82} {...common} /><text x={first.x + 8} y={first.y + 19} fill={drawing.color} fontSize="12">分析表</text><text x={first.x + 99} y={first.y + 19} fill={drawing.color} fontSize="12">数值</text></g>
    } else if (behavior === 'media') {
      content = <g><rect x={first.x} y={first.y} width="180" height="100" rx="6" fill={fill} stroke={drawing.color} strokeDasharray="7 5" vectorEffect="non-scaling-stroke" /><text x={first.x + 90} y={first.y + 48} textAnchor="middle" fill={drawing.color} fontSize="24">{drawing.tool === 'x-post' ? '𝕏' : '▧'}</text><text x={first.x + 90} y={first.y + 74} textAnchor="middle" fill={drawing.color} fontSize="12">{drawing.text}</text></g>
    } else if (behavior === 'icon' || behavior === 'arrow-mark') {
      content = <text x={first.x} y={first.y} textAnchor="middle" dominantBaseline="middle" fill={drawing.color} fontSize={behavior === 'icon' ? '34' : '30'}>{drawing.text ?? getTool(drawing.tool).glyph}</text>
    } else if (behavior === 'fib' || behavior === 'fib-extension') {
      const fib = normalizeFibSettings(drawing.fib)
      const left = Math.min(first.x, last.x)
      const right = Math.max(first.x, last.x)
      const x1 = fib.extend === 'left' || fib.extend === 'both' ? 0 : left
      const x2 = fib.extend === 'right' || fib.extend === 'both' ? 1000 : right
      const labelX = x2 === 1000 ? 988 : x2 + 9
      const textAnchor = x2 === 1000 ? 'end' : 'start'
      const startPoint = drawing.points[0]
      const endPoint = drawing.points.at(-1) ?? startPoint
      const startAnchor = Number.isFinite(startPoint.time) && Number.isFinite(startPoint.price)
        ? { time: startPoint.time!, price: startPoint.price! }
        : onMeasurePoint(startPoint)
      const endAnchor = Number.isFinite(endPoint.time) && Number.isFinite(endPoint.price)
        ? { time: endPoint.time!, price: endPoint.price! }
        : onMeasurePoint(endPoint)
      content = <g className="fib-drawing">
        {fib.trendLineVisible && <line
          x1={first.x} y1={first.y} x2={last.x} y2={last.y}
          stroke={fib.trendLineColor} strokeWidth={drawing.width}
          strokeDasharray={dashForLineStyle(fib.trendLineStyle)} vectorEffect="non-scaling-stroke"
        />}
        {fib.levels.filter((level) => level.visible).map((level) => {
          const y = first.y + dy * level.value
          const levelPrice = startAnchor && endAnchor
            ? startAnchor.price + (endAnchor.price - startAnchor.price) * level.value
            : null
          const label = levelPrice === null
            ? formatFibValue(level.value)
            : `${formatFibValue(level.value)} (${formatPrice(levelPrice, symbol)})`
          return <g key={level.id} data-fib-level={level.id}>
            <line
              x1={x1} x2={x2} y1={y} y2={y}
              stroke={level.color || fib.horizontalLineColor}
              strokeWidth={fib.horizontalLineWidth}
              strokeDasharray={dashForLineStyle(fib.horizontalLineStyle)}
              vectorEffect="non-scaling-stroke"
            />
            <text x={labelX} y={y - 7} textAnchor={textAnchor} fill={level.color || fib.horizontalLineColor} fontSize="15" fontWeight="600">{label}</text>
          </g>
        })}
      </g>
    } else if (behavior === 'fib-channel') {
      const levels = [0, .236, .382, .5, .618, .786, 1]
      content = <g>{levels.map((level) => <line key={level} x1={first.x} y1={first.y + level * 180} x2={last.x} y2={last.y + level * 180} {...common} opacity={level === 0 || level === 1 ? 1 : .65} />)}</g>
    } else if (behavior === 'fib-time' || behavior === 'cycles') {
      const multipliers = [0, 1, 2, 3, 5, 8]
      content = <g>{multipliers.map((value) => { const x = first.x + dx * value; return <g key={value}><line x1={x} x2={x} y1="0" y2="1000" {...common} opacity={value === 0 ? 1 : .55} /><text x={x + 4} y="24" fill={drawing.color} fontSize="11">{value}</text></g> })}</g>
    } else if (behavior === 'fan') {
      content = <g>{[-.5, -.25, 0, .25, .5].map((offset) => <line key={offset} x1={first.x} y1={first.y} x2={last.x} y2={last.y + offset * Math.abs(dx)} {...common} opacity={offset === 0 ? 1 : .55} />)}</g>
    } else if (behavior === 'pitchfork') {
      content = <g><line x1={first.x} y1={first.y} x2={last.x} y2={last.y} {...common} /><line x1={first.x} y1={first.y - 95} x2={last.x} y2={last.y - 95} {...common} opacity=".7" /><line x1={first.x} y1={first.y + 95} x2={last.x} y2={last.y + 95} {...common} opacity=".7" /><line x1={first.x} y1={first.y - 95} x2={first.x} y2={first.y + 95} {...common} opacity=".5" /></g>
    } else if (behavior === 'gann-box') {
      const x = Math.min(first.x, last.x); const y = Math.min(first.y, last.y); const w = Math.abs(dx); const h = Math.abs(dy)
      content = <g><rect x={x} y={y} width={w} height={h} {...common} fill={fill} />{[.25,.5,.75].map((v) => <g key={v}><line x1={x+w*v} x2={x+w*v} y1={y} y2={y+h} {...common} opacity=".45" /><line x1={x} x2={x+w} y1={y+h*v} y2={y+h*v} {...common} opacity=".45" /></g>)}<line x1={x} y1={y} x2={x+w} y2={y+h} {...common} opacity=".7" /><line x1={x+w} y1={y} x2={x} y2={y+h} {...common} opacity=".7" /></g>
    } else if (behavior === 'circles') {
      content = <g>{[1,.786,.618,.382,.236].map((ratio) => <ellipse key={ratio} cx={mid.x} cy={mid.y} rx={Math.abs(dx)*ratio/2} ry={Math.abs(dy)*ratio/2} {...common} opacity={ratio === 1 ? 1 : .55} />)}</g>
    } else if (behavior === 'spiral') {
      const spiral = Array.from({ length: 64 }, (_, index) => { const t=index/63*Math.PI*4; const radius=index/63; return `${mid.x+Math.cos(t)*Math.abs(dx)*radius/2},${mid.y+Math.sin(t)*Math.abs(dy)*radius/2}` }).join(' ')
      content = <polyline points={spiral} {...common} />
    } else if (behavior === 'arcs') {
      content = <g>{[1,.786,.618,.382].map((ratio) => <path key={ratio} d={`M${first.x},${first.y} A${Math.abs(dx)*ratio},${Math.abs(dy)*ratio} 0 0 1 ${last.x},${last.y}`} {...common} opacity={ratio === 1 ? 1 : .55} />)}</g>
    } else if (behavior === 'wedge' || behavior === 'sector') {
      content = <g><path d={`M${first.x},${first.y} L${last.x},${last.y} A${Math.abs(dx)},${Math.abs(dy)} 0 0 0 ${last.x},${first.y} Z`} {...common} fill={fill} /><line x1={first.x} y1={first.y} x2={last.x} y2={first.y} {...common} /></g>
    } else if (behavior === 'pattern' || behavior === 'wave') {
      const count = behavior === 'wave' ? 6 : 5
      const zig = Array.from({ length: count }, (_, index) => ({ x: first.x + dx * index / (count - 1), y: index % 2 ? last.y : first.y + dy * .28 }))
      const labels = behavior === 'wave' ? ['0','1','2','3','4','5'] : ['X','A','B','C','D']
      content = <g><polyline points={zig.map((p) => `${p.x},${p.y}`).join(' ')} {...common} />{zig.map((p,index) => <g key={index}><circle cx={p.x} cy={p.y} r="4" fill={drawing.color} /><text x={p.x} y={p.y-9} textAnchor="middle" fill={drawing.color} fontSize="12">{labels[index]}</text></g>)}</g>
    } else if (behavior === 'sine') {
      const sine = Array.from({ length: 50 }, (_, index) => { const t=index/49; return `${first.x+dx*t},${mid.y+Math.sin(t*Math.PI*4)*Math.abs(dy)/2}` }).join(' ')
      content = <polyline points={sine} {...common} />
    } else if (behavior === 'long-position' || behavior === 'short-position') {
      const long = behavior === 'long-position'
      const side = long ? 'long' : 'short'
      const geometry = resolvePositionGeometry(points, side)!
      const x = geometry.left
      const w = Math.max(24, geometry.right - geometry.left)
      const entry = geometry.entryY
      const targetEdge = geometry.targetY
      const stopEdge = geometry.stopY
      const top = Math.min(targetEdge, stopEdge)
      const bottom = Math.max(targetEdge, stopEdge)
      const upperIsTarget = targetEdge < entry
      const red = '#f23645'
      const green = '#089981'
      const tickSize = symbol === 'BTCUSDT.P' ? .1 : .01
      const rawGeometry = resolvePositionGeometry(drawing.points, side)
      const entryPrice = rawGeometry?.entryLeft.price
      const targetPrice = rawGeometry?.target.price
      const stopPrice = rawGeometry?.stop.price
      const canonicalPricesAvailable = drawing.points.length >= 4
        && Number.isFinite(entryPrice) && Number.isFinite(targetPrice) && Number.isFinite(stopPrice)
      const firstPrice = drawing.points[0]?.price
      const lastPrice = drawing.points.at(-1)?.price
      const legacyPricesAvailable = Number.isFinite(firstPrice) && Number.isFinite(lastPrice)
      const currentPrice = candles.at(-1)?.close
      const metrics = canonicalPricesAvailable ? calculatePositionMetricsFromLevels({
        side,
        entryPrice: entryPrice!,
        targetPrice: targetPrice!,
        stopPrice: stopPrice!,
        currentPrice: currentPrice ?? entryPrice!,
        tickSize,
      }) : legacyPricesAvailable ? calculatePositionMetrics({
        side,
        topPrice: Math.max(firstPrice!, lastPrice!),
        bottomPrice: Math.min(firstPrice!, lastPrice!),
        currentPrice: currentPrice ?? (firstPrice! + lastPrice!) / 2,
        tickSize,
      }) : null
      const priceDigits = symbol === 'XAUUSD' ? 3 : symbol === 'BTCUSDT.P' ? 1 : 2
      const stopDistance = metrics?.distance ?? null
      const targetDistance = metrics ? Math.abs(metrics.targetPrice - metrics.entryPrice) : null
      const stopPercent = metrics && metrics.entryPrice !== 0 ? stopDistance! / Math.abs(metrics.entryPrice) * 100 : null
      const targetPercent = metrics && metrics.entryPrice !== 0 ? targetDistance! / Math.abs(metrics.entryPrice) * 100 : null
      const stopTicks = metrics ? stopDistance! / (symbol === 'BTCUSDT.P' ? .1 : .01) : null
      const targetTicks = metrics ? targetDistance! / (symbol === 'BTCUSDT.P' ? .1 : .01) : null
      const riskReward = metrics ? formatPositionNumber(metrics.riskReward, 2) : '—'
      const pnl = metrics ? formatPositionNumber(metrics.pnl, 3) : '—'
      const pnlColor = !metrics || metrics.pnl < 0 ? red : green
      const stopText = `停止：${metrics ? formatPositionNumber(stopDistance!, priceDigits) : '—'} (${stopPercent === null ? '—' : formatPositionNumber(stopPercent, 3)}%) ${stopTicks === null ? '—' : formatPositionNumber(stopTicks, 1)}, 金额：${metrics?.stopAmount ?? 750}`
      const targetText = `目标：${metrics ? formatPositionNumber(targetDistance!, priceDigits) : '—'} (${targetPercent === null ? '—' : formatPositionNumber(targetPercent, 3)}%) ${targetTicks === null ? '—' : formatPositionNumber(targetTicks, 1)}, 金额：${metrics?.targetAmount ?? 1250}`
      const unitX = 1000 / Math.max(1, viewportSize.width)
      const unitY = 1000 / Math.max(1, viewportSize.height)
      const screenWidth = (characters: number, min: number, max: number) => Math.min(max, Math.max(min, characters * 6.2 + 18))
      const outsideWidth = Math.min(Math.max(120, viewportSize.width - 16), screenWidth(Math.max(stopText.length, targetText.length), 170, 390)) * unitX
      const centralLineOne = `开仓 PnL: ${pnl}, 数量: ${metrics?.quantity ?? 5}`
      const centralLineTwo = `风险/回报比: ${riskReward}`
      const centralWidth = Math.min(Math.max(120, viewportSize.width - 16), screenWidth(Math.max(centralLineOne.length, centralLineTwo.length), 150, 280)) * unitX
      const centerX = x + w / 2
      const centralX = Math.min(1000 - centralWidth - 8 * unitX, Math.max(8 * unitX, centerX - centralWidth / 2))
      const outsideX = Math.min(1000 - outsideWidth - 8 * unitX, Math.max(8 * unitX, centerX - outsideWidth / 2))
      const labelHeight = 24 * unitY
      const centralHeight = 40 * unitY
      const labelGap = 5 * unitY
      const labelAbove = (edge: number) => Math.max(5 * unitY, edge - labelHeight - labelGap)
      const labelBelow = (edge: number) => edge + labelHeight + labelGap * 2 <= 1000 ? edge + labelGap : Math.max(5 * unitY, edge - labelHeight - labelGap)
      const stopY = long ? labelBelow(stopEdge) : labelAbove(stopEdge)
      const targetY = long ? labelAbove(targetEdge) : labelBelow(targetEdge)
      const textScaleX = Math.max(.45, Math.min(1.5, viewportSize.height / Math.max(1, viewportSize.width)))
      const positionFont = '-apple-system, BlinkMacSystemFont, Segoe UI, Microsoft YaHei, sans-serif'
      const fontSize = 12 * unitY
      const secondaryFontSize = 11 * unitY
      const handleWidth = 10 * unitX
      const handleHeight = 10 * unitY
      const handle = (cx: number, cy: number, key: string, handleType: PositionHandle, shape: 'square' | 'circle' = 'square') => {
        const props = {
          key,
          'data-position-handle': handleType,
          'aria-label': `拖动${handleType === 'target' ? '目标' : handleType === 'stop' ? '止损' : handleType === 'entry' ? '入场' : '宽度'}控制点`,
          onPointerDown: startPositionHandleDrag(drawing, handleType),
          pointerEvents: 'all' as const,
          fill: '#131722',
          stroke: '#2962ff',
          strokeWidth: 2,
          vectorEffect: 'non-scaling-stroke' as const,
        }
        return shape === 'circle'
          ? <ellipse {...props} cx={cx} cy={cy} rx={handleWidth / 2} ry={handleHeight / 2} />
          : <rect {...props} x={cx - handleWidth / 2} y={cy - handleHeight / 2} width={handleWidth} height={handleHeight} rx={2 * unitX} />
      }
      content = <g className="position-drawing" data-position-side={long ? 'long' : 'short'}>
        <rect data-testid="position-upper-zone" x={x} y={top} width={w} height={Math.max(0, entry - top)} fill={upperIsTarget ? 'rgba(8,153,129,.2)' : 'rgba(242,54,69,.2)'} stroke={upperIsTarget ? green : red} strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <rect data-testid="position-lower-zone" x={x} y={entry} width={w} height={Math.max(0, bottom - entry)} fill={upperIsTarget ? 'rgba(242,54,69,.2)' : 'rgba(8,153,129,.2)'} stroke={upperIsTarget ? red : green} strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <line data-testid="position-entry-line" x1={x} x2={x + w} y1={entry} y2={entry} stroke="#787b86" strokeWidth="1" vectorEffect="non-scaling-stroke" />

        <g data-testid="position-stop-label" transform={`translate(${outsideX} ${stopY})`}>
          <rect width={outsideWidth} height={labelHeight} rx={4 * unitX} fill={red} />
          <text x="0" y={16 * unitY} transform={`translate(${outsideWidth / 2} 0) scale(${textScaleX} 1)`} textAnchor="middle" fill="white" fontFamily={positionFont} fontSize={fontSize} fontWeight="500">{stopText}</text>
        </g>
        <g data-testid="position-target-label" transform={`translate(${outsideX} ${targetY})`}>
          <rect width={outsideWidth} height={labelHeight} rx={4 * unitX} fill={green} />
          <text x="0" y={16 * unitY} transform={`translate(${outsideWidth / 2} 0) scale(${textScaleX} 1)`} textAnchor="middle" fill="white" fontFamily={positionFont} fontSize={fontSize} fontWeight="500">{targetText}</text>
        </g>
        <g data-testid="position-entry-label" transform={`translate(${centralX} ${entry - centralHeight / 2})`}>
          <rect width={centralWidth} height={centralHeight} rx={5 * unitX} fill={pnlColor} stroke="#f0f3fa" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <text x="0" y={16 * unitY} transform={`translate(${centralWidth / 2} 0) scale(${textScaleX} 1)`} textAnchor="middle" fill="white" fontFamily={positionFont} fontSize={fontSize} fontWeight="500">{centralLineOne}</text>
          <text x="0" y={32 * unitY} transform={`translate(${centralWidth / 2} 0) scale(${textScaleX} 1)`} textAnchor="middle" fill="white" fontFamily={positionFont} fontSize={secondaryFontSize} fontWeight="500">{centralLineTwo}</text>
        </g>
        {selected && <g className="position-control-points" data-testid="position-control-points" pointerEvents="all">
          {handle(x, targetEdge, 'target', 'target')}
          {handle(x, entry, 'entry', 'entry', 'circle')}
          {handle(x + w, entry, 'width', 'width')}
          {handle(x, stopEdge, 'stop', 'stop')}
        </g>}
      </g>
    } else if (behavior === 'forecast') {
      content = <g><path d={`M${first.x},${first.y} C${mid.x},${first.y} ${mid.x},${last.y} ${last.x},${last.y}`} {...common} strokeDasharray="8 5" markerEnd="url(#arrow-head)" /><ellipse cx={last.x} cy={last.y} rx="64" ry="38" fill={fill} stroke={drawing.color} vectorEffect="non-scaling-stroke" /></g>
    } else if (behavior === 'measure') {
      const measurement = measurementForDrawing(drawing)
      const rising = measurement ? measurement.direction === 'up' : last.y <= first.y
      const accent = rising ? '#22ab94' : '#ff525f'
      const areaFill = rising ? 'rgba(34,171,148,.25)' : 'rgba(255,82,95,.25)'
      const arrowId = rising ? 'measure-arrow-up' : 'measure-arrow-down'
      const x = Math.min(first.x, last.x)
      const y = Math.min(first.y, last.y)
      content = measurement
        ? <g>
          <rect x={x} y={y} width={Math.abs(dx)} height={Math.abs(dy)} fill={areaFill} stroke={accent} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          <line x1={first.x} x2={first.x} y1={first.y} y2={last.y} stroke={accent} strokeWidth="2" vectorEffect="non-scaling-stroke" />
          <line x1={last.x} x2={last.x} y1={first.y} y2={last.y} stroke={accent} strokeWidth="1.5" strokeDasharray="7 6" vectorEffect="non-scaling-stroke" />
          <line x1={first.x} x2={last.x} y1={last.y} y2={last.y} stroke={accent} strokeWidth="2" markerEnd={`url(#${arrowId})`} vectorEffect="non-scaling-stroke" />
          {selected && <>
            <line x1="0" x2="1000" y1={last.y} y2={last.y} stroke="#b2b5be" strokeWidth="1" strokeDasharray="7 7" opacity=".8" vectorEffect="non-scaling-stroke" />
            <line x1={last.x} x2={last.x} y1="0" y2="1000" stroke="#b2b5be" strokeWidth="1" strokeDasharray="7 7" opacity=".8" vectorEffect="non-scaling-stroke" />
            <ellipse cx={first.x} cy={first.y} rx={handleRadius.x} ry={handleRadius.y} fill="white" stroke={accent} strokeWidth="2" vectorEffect="non-scaling-stroke" />
            <ellipse cx={last.x} cy={last.y} rx={handleRadius.x} ry={handleRadius.y} fill="white" stroke={accent} strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </>}
        </g>
        : <rect
          data-testid="empty-measurement-box"
          x={x} y={y} width={Math.abs(dx)} height={Math.abs(dy)}
          fill="rgba(178,181,190,.06)" stroke="#b2b5be" strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
    } else if (behavior === 'range') {
      const percent = ((drawing.points[0].y - drawing.points.at(-1)!.y) * 100).toFixed(2)
      content = <g><rect x={Math.min(first.x,last.x)} y={Math.min(first.y,last.y)} width={Math.abs(dx)} height={Math.abs(dy)} fill={fill} stroke={drawing.color} strokeDasharray="6 5" vectorEffect="non-scaling-stroke" /><rect x={mid.x-68} y={mid.y-15} width="136" height="26" rx="5" fill="#296cff" /><text x={mid.x} y={mid.y+3} textAnchor="middle" fill="white" fontSize="12">{percent}% · {Math.abs(dx).toFixed(0)} px</text></g>
    } else if (behavior === 'bars-pattern' || behavior === 'ghost-feed') {
      const zig = Array.from({length:12},(_,index)=>({x:first.x+dx*index/11,y:mid.y+Math.sin(index*1.7)*Math.abs(dy)*.38}))
      content = <polyline points={zig.map((p)=>`${p.x},${p.y}`).join(' ')} {...common} opacity={behavior==='ghost-feed'?'.55':'1'} strokeDasharray={behavior==='ghost-feed'?'7 5':dash} />
    } else if (behavior === 'volume-profile') {
      const x=Math.min(first.x,last.x); const y=Math.min(first.y,last.y); const w=Math.abs(dx); const h=Math.abs(dy)
      content = <g>{Array.from({length:12},(_,index)=>{const bar=.3+Math.abs(Math.sin(index*.73))*.7; return <rect key={index} x={x} y={y+h*index/12} width={w*bar} height={h/12-2} fill={colorWithAlpha(drawing.color,.35)} />})}<rect x={x} y={y} width={w} height={h} {...common} /></g>
    } else if (behavior === 'ellipse') {
      content = <ellipse cx={mid.x} cy={mid.y} rx={Math.abs(dx)/2} ry={Math.abs(dy)/2} {...common} fill={fill} />
    } else if (behavior === 'triangle') {
      content = <polygon points={`${mid.x},${first.y} ${last.x},${last.y} ${first.x},${last.y}`} {...common} fill={fill} />
    } else if (behavior === 'arc') {
      content = <path d={`M${first.x},${first.y} Q${mid.x},${Math.min(first.y,last.y)-Math.abs(dy)*.7-40} ${last.x},${last.y}`} {...common} />
    } else if (behavior === 'curve' || behavior === 'double-curve') {
      content = <g><path d={`M${first.x},${first.y} C${mid.x},${first.y-120} ${mid.x},${last.y+120} ${last.x},${last.y}`} {...common} />{behavior==='double-curve'&&<path d={`M${first.x},${first.y+55} C${mid.x},${first.y-65} ${mid.x},${last.y+175} ${last.x},${last.y+55}`} {...common} opacity=".65" />}</g>
    } else if (behavior === 'channel' || behavior === 'regression') {
      const offset=behavior==='regression'?70:95
      content = <g><polygon points={`${first.x},${first.y-offset} ${last.x},${last.y-offset} ${last.x},${last.y+offset} ${first.x},${first.y+offset}`} fill={fill} /><line x1={first.x} y1={first.y-offset} x2={last.x} y2={last.y-offset} {...common} /><line x1={first.x} y1={first.y} x2={last.x} y2={last.y} {...common} opacity=".65" /><line x1={first.x} y1={first.y+offset} x2={last.x} y2={last.y+offset} {...common} /></g>
    } else if (behavior === 'horizontal' || behavior === 'horizontal-ray' || behavior === 'vertical' || behavior === 'cross') {
      content = <g>{behavior !== 'vertical' && <line x1={behavior==='horizontal-ray'?first.x:0} x2="1000" y1={first.y} y2={first.y} {...common} />}{(behavior==='vertical'||behavior==='cross')&&<line x1={first.x} x2={first.x} y1="0" y2="1000" {...common} />}</g>
    } else if (behavior === 'ray' || behavior === 'extended-line') {
      const slope = dx === 0 ? 0 : dy / dx
      const x1 = behavior === 'extended-line' ? 0 : first.x; const x2 = 1000
      content = <line x1={x1} y1={first.y + (x1-first.x)*slope} x2={x2} y2={first.y + (x2-first.x)*slope} {...common} />
    } else if (behavior === 'info-line' || behavior === 'angle') {
      const angle = Math.atan2(-dy, dx) * 180 / Math.PI
      content = <g><line x1={first.x} y1={first.y} x2={last.x} y2={last.y} {...common} />{behavior==='angle'&&<line x1={first.x} y1={first.y} x2={last.x} y2={first.y} {...common} opacity=".5" strokeDasharray="5 5" />}<rect x={mid.x-54} y={mid.y-28} width="108" height="22" rx="4" fill="#202736" /><text x={mid.x} y={mid.y-13} textAnchor="middle" fill="white" fontSize="11">{angle.toFixed(1)}° · {Math.hypot(dx,dy).toFixed(0)} px</text></g>
    } else if (behavior === 'arrow') {
      content = <line x1={first.x} y1={first.y} x2={last.x} y2={last.y} {...common} markerEnd="url(#arrow-head)" />
    } else if (behavior === 'vwap') {
      content = <g><path d={`M${first.x},${first.y} Q${mid.x},${mid.y-35} ${last.x},${last.y}`} {...common} /><text x={mid.x} y={mid.y-15} textAnchor="middle" fill={drawing.color} fontSize="11">VWAP</text></g>
    } else {
      content = <line x1={first.x} y1={first.y} x2={last.x} y2={last.y} {...common} />
    }

    return (
      <g
        key={drawing.id}
        className={selected ? 'drawing selected' : 'drawing'}
        data-tool={drawing.tool}
        data-behavior={behavior}
        data-testid="drawing-object"
        data-anchor-start-time={drawing.points[0]?.time}
        data-anchor-start-price={drawing.points[0]?.price}
        data-anchor-end-time={drawing.points.at(-1)?.time}
        data-anchor-end-price={drawing.points.at(-1)?.price}
        role="img"
        aria-label={`绘图对象：${getTool(drawing.tool).label}`}
        onPointerDown={selectOrErase(drawing)}
        onDoubleClick={(event) => {
          if (behavior === 'fib' || behavior === 'fib-extension') {
            event.stopPropagation()
            onOpenProperties(drawing)
            return
          }
          if (!textBehaviors.includes(behavior)) return
          const text = window.prompt('编辑内容', drawing.text)
          if (text) dispatch({ type: 'update', id: drawing.id, patch: { text } })
        }}
        style={{ pointerEvents: isDraft || forceSelected ? 'none' : 'all', cursor: activeDefinition.behavior === 'eraser' ? 'not-allowed' : activeDefinition.behavior === 'cursor' && !drawingsLocked ? 'move' : 'crosshair' }}
      >
        <g opacity={isDraft && !forceSelected ? .78 : 1}>{content}</g>
        {selected && !['measure', 'long-position', 'short-position'].includes(behavior) && <g className="drawing-anchor-points"><ellipse cx={first.x} cy={first.y} rx={handleRadius.x} ry={handleRadius.y} fill="#fff" stroke="#2962ff" strokeWidth="2" vectorEffect="non-scaling-stroke" /><ellipse cx={last.x} cy={last.y} rx={handleRadius.x} ry={handleRadius.y} fill="#fff" stroke="#2962ff" strokeWidth="2" vectorEffect="non-scaling-stroke" /></g>}
      </g>
    )
  }

  const renderMeasurementPanel = (drawing: Drawing, isDraft = false, forceSelected = false) => {
    const measurement = measurementForDrawing(drawing)
    if (!measurement) return null
    const first = drawing.points[0]
    const last = drawing.points.at(-1) ?? first
    const centerX = Math.min(.84, Math.max(.16, (first.x + last.x) / 2))
    const lowerY = Math.max(first.y, last.y)
    const panelY = lowerY > .7 ? Math.max(.12, lowerY - .2) : Math.min(.8, lowerY + .025)
    const priceDigits = symbol === 'XAUUSD' ? 3 : symbol === 'BTCUSDT.P' ? 1 : 2
    const selected = forceSelected || (!isDraft && selectedDrawingIds.includes(drawing.id))
    return <div key={`${drawing.id}-measurement`} className={`measurement-result ${measurement.direction === 'up' ? 'is-up' : 'is-down'}${selected ? ' is-selected' : ''}${isDraft ? ' is-draft' : ''}`}>
      <div className="measurement-result-card" role="status" aria-label="测量结果" style={{ left: `${centerX * 100}%`, top: `${panelY * 100}%` }}>
        <strong>{formatSignedMeasurement(measurement.priceChange, priceDigits)} ({formatSignedMeasurement(measurement.percentChange, 2)}%) {formatSignedMeasurement(measurement.ticks, 1)}</strong>
        <span>{measurement.bars}根K线, {formatMeasurementDuration(measurement.durationSeconds)}</span>
        <span>成交量 {formatMeasurementVolume(measurement.volume)}</span>
      </div>
      <div className="measurement-time-card" style={{ left: `${centerX * 100}%` }}>
        <span>{formatMeasurementTime(measurement.startTime)}</span>
        <span>{formatMeasurementTime(measurement.endTime)}</span>
      </div>
    </div>
  }

  if (hidden) return null
  const drawingMode = !['cursor', 'eraser'].includes(activeDefinition.behavior)
  const selectedMeasurement = history.present.find((drawing) => drawing.behavior === 'measure' && selectedDrawingIds.includes(drawing.id)) ?? null
  const displayedMeasurement = draft?.behavior === 'measure'
    ? { drawing: draft, draft: true, forceSelected: false }
    : quickMeasurement
      ? { drawing: quickMeasurement, draft: false, forceSelected: true }
      : selectedMeasurement
        ? { drawing: selectedMeasurement, draft: false, forceSelected: false }
        : null
  return (
    <>
      <svg
      ref={svgRef}
      className={`drawing-overlay tool-${activeDefinition.behavior}`}
      data-placement-phase={placementPhase}
      viewBox="0 0 1000 1000" preserveAspectRatio="none"
      onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}
      onPointerCancel={() => { cancelDraft(); dragRef.current = null; onToolComplete() }}
      onClick={handleCanvasClick}
      style={{ pointerEvents: drawingMode || activeDefinition.behavior === 'eraser' ? 'auto' : 'none' }}
      aria-label="绘图覆盖层"
    >
      <defs>
        <marker id="arrow-head" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill={color} /></marker>
        <marker id="measure-arrow-up" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 L3,5 Z" fill="#22ab94" /></marker>
        <marker id="measure-arrow-down" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 L3,5 Z" fill="#ff525f" /></marker>
      </defs>
      {history.present.filter((drawing) => drawing.tool !== 'measure').map((drawing) => renderDrawing(drawing))}
      {quickMeasurement && renderDrawing(quickMeasurement, false, true)}
      {draft && renderDrawing(draft, true)}
      </svg>
      <div className="measurement-result-layer" aria-live="polite">
        {displayedMeasurement && renderMeasurementPanel(displayedMeasurement.drawing, displayedMeasurement.draft, displayedMeasurement.forceSelected)}
      </div>
    </>
  )
}

function colorWithAlpha(hex: string, opacity: number) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex
  const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, '0')
  return `${hex}${alpha}`
}
