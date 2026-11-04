import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type SVGProps } from 'react'
import {
  constrainDrawingPoint, duplicateDrawing, normalizeFibSettings, partiallyEraseDrawing,
  type Drawing, type DrawingAction, type DrawingHistory, type DrawingLineStyle, type DrawingPoint, makeDrawing,
} from '../lib/drawings'
import {
  calculateChartMeasurement, formatMeasurementDuration, formatMeasurementTime, formatMeasurementVolume, formatSignedMeasurement,
} from '../lib/measurement'
import { calculateFibLevelGeometry, layoutFibLabels } from '../lib/fibLayout'
import { formatPrice, type Candle, type IntervalId, type SymbolId } from '../lib/market'
import {
  calculatePositionMetrics, calculatePositionMetricsFromLevels, createDefaultPositionPoints, formatPositionNumber,
  resolvePositionGeometry, updatePositionPoints,
  type PositionHandle,
} from '../lib/positionDrawing'
import { getTool, supportsDrawingProperties, type ToolBehavior } from '../lib/toolCatalog'
import { channelLevelsFor, drawingOption, fibLevelsFor, forecastColor, isLineToolBehavior, isVisibleOnInterval, levelColor, levelGroup, positionAmounts, positionSettingsFor } from '../lib/lineToolSettings'
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
  onPlotSize?: () => { width: number; height: number } | null
  onMeasurePoint: (point: DrawingPoint) => { time: number; price: number } | null
  onProjectPoint: (point: { time: number; price: number }) => { x: number; y: number } | null
  onQuickMeasurementChange: (drawing: Drawing | null) => void
  onToolComplete: (drawing?: Drawing) => void
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
  pointIndex?: number
  channelWidth?: boolean
  rectangleCorner?: RectangleCorner
  rectangleEdge?: RectangleEdge
}

type RectangleCorner = 'nw' | 'ne' | 'sw' | 'se'
type RectangleEdge = 'n' | 'e' | 's' | 'w'

export function DrawingOverlay({
  activeTool, history, dispatch, color, magnetMode, drawingsLocked, hidden, candles, symbol, interval, quickMeasurement, onPlotSize, onMeasurePoint, onProjectPoint, onQuickMeasurementChange, onToolComplete, onZoomSelection, onOpenProperties,
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
  const viewportWidth = Math.max(1, viewportSize.width)
  const viewportHeight = Math.max(1, viewportSize.height)
  const plotSize = onPlotSize?.()
  // Clip painting and hit testing, without resizing the coordinate system.
  // Anchors remain in the same chart pixel coordinates used by time/price projection.
  const plotClip = plotSize ? `inset(0px ${Math.max(0, viewportWidth - plotSize.width)}px ${Math.max(0, viewportHeight - plotSize.height)}px 0px)` : undefined
  const handleRadius = {
    x: 5,
    y: 5,
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
    const initialBounds = element.getBoundingClientRect()
    if (initialBounds.width > 0 && initialBounds.height > 0) setViewportSize({ width: initialBounds.width, height: initialBounds.height })
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
    return { x: projected.x * viewportWidth, y: projected.y * viewportHeight }
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
    onToolComplete(drawing.behavior !== 'zoom' && drawing.tool !== 'measure' && drawing.points.length > 1 && distance(first, last) > 0.003 ? drawing : undefined)
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

  const startDrawingPointDrag = (drawing: Drawing, pointIndex: number) => (event: ReactPointerEvent<SVGElement>) => {
    if (event.button !== 0) return
    if (activeDefinition.behavior !== 'cursor' || drawingsLocked || drawing.locked) return
    event.preventDefault()
    event.stopPropagation()
    if (!selectedDrawingIds.includes(drawing.id)) dispatch({ type: 'select', id: drawing.id })
    dispatch({ type: 'checkpoint' })
    dragRef.current = {
      start: normalizedPoint(event),
      pointerId: event.pointerId,
      originals: [{ id: drawing.id, points: drawing.points.map(projectNormalizedPoint) }],
      source: drawing,
      control: false,
      moved: false,
      pointIndex,
    }
    svgRef.current?.setPointerCapture(event.pointerId)
  }

  const startRectangleCornerDrag = (drawing: Drawing, corner: RectangleCorner) => (event: ReactPointerEvent<SVGElement>) => {
    startDrawingPointDrag(drawing, 0)(event)
    if (dragRef.current) {
      dragRef.current.pointIndex = undefined
      dragRef.current.rectangleCorner = corner
    }
  }

  const startRectangleEdgeDrag = (drawing: Drawing, edge: RectangleEdge) => (event: ReactPointerEvent<SVGElement>) => {
    startDrawingPointDrag(drawing, 0)(event)
    if (dragRef.current) {
      dragRef.current.pointIndex = undefined
      dragRef.current.rectangleEdge = edge
    }
  }

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    let point = normalizedPoint(event)
    const drag = dragRef.current
    if (drag) {
      event.preventDefault()
      if (drag.channelWidth) {
        const base = drag.originals[0].points
        const center = { x: (base[0].x + base[base.length - 1].x) / 2, y: (base[0].y + base[base.length - 1].y) / 2 }
        const normalized = Math.max(2 / viewportHeight, Math.abs(point.y - center.y))
        const centerAnchor = onMeasurePoint(center)
        const edgeAnchor = onMeasurePoint({ x: center.x, y: center.y + normalized })
        drag.moved = true
        dispatch({ type: 'update', id: drag.source.id, patch: { channelWidth: {
          normalized,
          price: centerAnchor && edgeAnchor ? Math.abs(edgeAnchor.price - centerAnchor.price) : undefined,
        } } })
        return
      }
      if (drag.rectangleCorner) {
        const original = drag.originals.find((item) => item.id === drag.source.id)
        if (!original || distance(point, drag.start) <= 0.003) return
        const first = original.points[0]
        const last = original.points.at(-1) ?? first
        const firstCorner: RectangleCorner = `${first.y <= last.y ? 'n' : 's'}${first.x <= last.x ? 'w' : 'e'}` as RectangleCorner
        const draggedPoint = anchorPoint(point)
        const fixedPoint = drag.rectangleCorner === firstCorner ? last : first
        const points = drag.rectangleCorner === firstCorner
          ? [draggedPoint, fixedPoint]
          : [fixedPoint, draggedPoint]
        drag.moved = true
        dispatch({ type: 'update', id: original.id, patch: { points } })
        return
      }
      if (drag.rectangleEdge) {
        const original = drag.originals.find((item) => item.id === drag.source.id)
        if (!original || distance(point, drag.start) <= 0.003) return
        const first = original.points[0]
        const last = original.points.at(-1) ?? first
        const firstCorner: RectangleCorner = `${first.y <= last.y ? 'n' : 's'}${first.x <= last.x ? 'w' : 'e'}` as RectangleCorner
        let left = Math.min(first.x, last.x)
        let right = Math.max(first.x, last.x)
        let top = Math.min(first.y, last.y)
        let bottom = Math.max(first.y, last.y)
        if (drag.rectangleEdge === 'n') top = point.y
        if (drag.rectangleEdge === 's') bottom = point.y
        if (drag.rectangleEdge === 'w') left = point.x
        if (drag.rectangleEdge === 'e') right = point.x
        const oppositeCorner: Record<RectangleCorner, RectangleCorner> = { nw: 'se', ne: 'sw', sw: 'ne', se: 'nw' }
        const cornerPoint = (corner: RectangleCorner) => anchorPoint({
          x: corner.endsWith('w') ? left : right,
          y: corner.startsWith('n') ? top : bottom,
        })
        const points = [cornerPoint(firstCorner), cornerPoint(oppositeCorner[firstCorner])]
        drag.moved = true
        dispatch({ type: 'update', id: original.id, patch: { points } })
        return
      }
      if (drag.pointIndex !== undefined) {
        const original = drag.originals.find((item) => item.id === drag.source.id)
        if (!original || distance(point, drag.start) <= 0.003) return
        const points = original.points.map((item, index) => index === drag.pointIndex ? anchorPoint(point) : item)
        drag.moved = true
        dispatch({ type: 'update', id: original.id, patch: { points } })
        return
      }
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
      // Pointer capture retargets the release click to the SVG canvas.
      // Consume it even for a stationary click so selection is retained.
      suppressNextClickRef.current = true
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
    if (event.button !== 0) return
    if (activeDefinition.behavior === 'eraser') {
      event.stopPropagation()
      if ((event.ctrlKey || event.metaKey) && freehandBehaviors.includes(drawing.behavior) && drawing.points.length > 3) {
        const point = normalizedPoint(event)
        const points = partiallyEraseDrawing(drawing, point)
        if (points) {
          dispatch({ type: 'checkpoint' })
          dispatch({ type: 'update', id: drawing.id, patch: { points } })
        }
        else dispatch({ type: 'delete', id: drawing.id })
        return
      }
      dispatch({ type: 'delete', id: drawing.id })
      return
    }
    if (activeDefinition.behavior !== 'cursor') return
    event.preventDefault()
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

  const measurementForDrawing = (drawing: Drawing, anyBehavior = false) => {
    if ((!anyBehavior && drawing.behavior !== 'measure') || drawing.points.length < 2) return null
    const first = drawing.points[0]
    const last = drawing.points.at(-1) ?? first
    const start = Number.isFinite(first.time) && Number.isFinite(first.price) ? { time: first.time!, price: first.price! } : onMeasurePoint(first)
    const end = Number.isFinite(last.time) && Number.isFinite(last.price) ? { time: last.time!, price: last.price! } : onMeasurePoint(last)
    if (!start || !end) return null
    return calculateChartMeasurement(start, end, candles, symbol)
  }

  // TradingView-style line tools: extension, arrow ends, middle point, price labels, statistics and text.
  const renderLineTool = (
    drawing: Drawing, behavior: ToolBehavior, first: { x: number; y: number }, last: { x: number; y: number },
    common: SVGProps<SVGLineElement>, selected: boolean,
  ): ReactNode => {
    const dx = last.x - first.x
    const dy = last.y - first.y
    const length = Math.hypot(dx, dy) || 1
    const extendLeft = drawing.extendLeft ?? behavior === 'extended-line'
    const extendRight = drawing.extendRight ?? (behavior === 'ray' || behavior === 'extended-line')
    const reach = (viewportWidth + viewportHeight) * 4 / length
    const start = extendLeft ? { x: first.x - dx * reach, y: first.y - dy * reach } : first
    const end = extendRight ? { x: last.x + dx * reach, y: last.y + dy * reach } : last
    const leftArrow = !extendLeft && drawing.leftEnd === 'arrow'
    const rightArrow = !extendRight && (drawing.rightEnd ?? (behavior === 'arrow' ? 'arrow' : 'normal')) === 'arrow'
    const markerId = `line-arrow-${drawing.id}`
    const mid = { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 }
    const angleDeg = Math.atan2(dy, dx) * 180 / Math.PI
    const textColor = drawing.textColor ?? drawing.color
    const fontSize = drawing.fontSize ?? 14
    const measurement = (drawing.stats?.length || drawing.priceLabels) ? measurementForDrawing(drawing, true) : null
    const priceDigits = symbol === 'XAUUSD' ? 3 : symbol === 'BTCUSDT.P' ? 1 : 2

    // Text runs along the line and stays upright.
    let textNode: ReactNode = null
    if (drawing.text && !['info-line', 'angle'].includes(behavior)) {
      const flip = angleDeg > 90 || angleDeg < -90
      const rotation = flip ? angleDeg + 180 : angleDeg
      const hAlign = drawing.textHAlign ?? 'center'
      const left = flip ? last : first
      const right = flip ? first : last
      const anchorPoint = hAlign === 'left' ? left : hAlign === 'right' ? right : mid
      const vAlign = drawing.textVAlign ?? 'top'
      const offset = vAlign === 'top' ? -(4 + drawing.width / 2) : vAlign === 'bottom' ? 4 + drawing.width / 2 + fontSize * .8 : fontSize * .35
      textNode = <text
        x={anchorPoint.x} y={anchorPoint.y} dy={offset}
        textAnchor={hAlign === 'left' ? 'start' : hAlign === 'right' ? 'end' : 'middle'}
        transform={`rotate(${rotation} ${anchorPoint.x} ${anchorPoint.y})`}
        fill={textColor} fontSize={fontSize} fontWeight={drawing.bold ? 700 : 400} fontStyle={drawing.italic ? 'italic' : 'normal'}
        style={{ pointerEvents: 'none' }}
      >{drawing.text}</text>
    }

    const priceLabel = (point: { x: number; y: number }, price: number | undefined, key: string) => {
      if (price === undefined || !Number.isFinite(price)) return null
      const label = formatPrice(price, symbol)
      const width = label.length * 7 + 12
      return <g key={key} style={{ pointerEvents: 'none' }}>
        <rect x={point.x - width / 2} y={point.y - 26} width={width} height={18} rx={3} fill={drawing.color} />
        <text x={point.x} y={point.y - 13} textAnchor="middle" fill="#ffffff" fontSize="11">{label}</text>
      </g>
    }

    let statsNode: ReactNode = null
    if (measurement && drawing.stats?.length && (drawing.alwaysShowStats || selected)) {
      const lines: string[] = []
      const priceParts: string[] = []
      if (drawing.stats.includes('price-range')) priceParts.push(formatSignedMeasurement(measurement.priceChange, priceDigits))
      if (drawing.stats.includes('percent-change')) priceParts.push(`(${formatSignedMeasurement(measurement.percentChange, 2)}%)`)
      if (drawing.stats.includes('pips-change')) priceParts.push(formatSignedMeasurement(measurement.ticks, 1))
      if (priceParts.length) lines.push(priceParts.join(' '))
      const timeParts: string[] = []
      if (drawing.stats.includes('bars-range')) timeParts.push(`${measurement.bars}根K线`)
      if (drawing.stats.includes('date-time-range')) timeParts.push(formatMeasurementDuration(measurement.durationSeconds))
      if (timeParts.length) lines.push(timeParts.join(', '))
      const geometryParts: string[] = []
      if (drawing.stats.includes('distance')) geometryParts.push(`距离: ${Math.round(length)}`)
      if (drawing.stats.includes('angle')) geometryParts.push(`${(-angleDeg).toFixed(2)}°`)
      if (geometryParts.length) lines.push(geometryParts.join(', '))
      const position = drawing.statsPosition ?? 'right'
      const anchor = position === 'left' ? (first.x <= last.x ? first : last) : position === 'center' ? mid : (first.x <= last.x ? last : first)
      const boxWidth = Math.max(...lines.map((line) => line.length)) * 7 + 16
      const boxHeight = lines.length * 17 + 8
      const boxX = position === 'left' ? anchor.x - boxWidth - 10 : position === 'center' ? anchor.x - boxWidth / 2 : anchor.x + 10
      const boxY = anchor.y + 10
      statsNode = <g style={{ pointerEvents: 'none' }}>
        <rect x={boxX} y={boxY} width={boxWidth} height={boxHeight} rx={4} fill="rgba(30,34,45,.92)" />
        {lines.map((line, index) => <text key={line} x={boxX + 8} y={boxY + 17 + index * 17} fill="#ffffff" fontSize="12">{line}</text>)}
      </g>
    }

    return <g>
      {(leftArrow || rightArrow) && <defs>
        <marker id={`${markerId}-end`} markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L10,5 L0,10" fill="none" stroke={drawing.color} strokeWidth="1.5" /></marker>
        <marker id={`${markerId}-start`} markerWidth="10" markerHeight="10" refX="1" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M10,0 L0,5 L10,10" fill="none" stroke={drawing.color} strokeWidth="1.5" /></marker>
      </defs>}
      {(extendLeft || extendRight) && <line data-testid="ray-hit-target" x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke="transparent" strokeWidth="16" pointerEvents="stroke" vectorEffect="non-scaling-stroke" />}
      <line
        x1={start.x} y1={start.y} x2={end.x} y2={end.y} {...common}
        markerStart={leftArrow ? `url(#${markerId}-start)` : undefined}
        markerEnd={rightArrow ? `url(#${markerId}-end)` : undefined}
      />
      {behavior === 'angle' && <line x1={first.x} y1={first.y} x2={last.x} y2={first.y} {...common} opacity=".5" strokeDasharray="5 5" />}
      {(behavior === 'info-line' || behavior === 'angle') && <g style={{ pointerEvents: 'none' }}>
        <rect x={mid.x - 54} y={mid.y - 28} width="108" height="22" rx="4" fill="#202736" />
        <text x={mid.x} y={mid.y - 13} textAnchor="middle" fill="white" fontSize="11">{(-angleDeg).toFixed(1)}° · {Math.round(length)} px</text>
      </g>}
      {drawing.middlePoint && <circle cx={mid.x} cy={mid.y} r={3.5} fill={drawing.color} style={{ pointerEvents: 'none' }} />}
      {drawing.priceLabels && <>{priceLabel(first, drawing.points[0]?.price, 'p1')}{priceLabel(last, drawing.points.at(-1)?.price, 'p2')}</>}
      {textNode}
      {statsNode}
    </g>
  }

  const renderDrawing = (drawing: Drawing, isDraft = false, forceSelected = false) => {
    const behavior = drawing.behavior ?? getTool(drawing.tool).behavior
    if ((behavior === 'fib' || behavior === 'fib-extension') && !normalizeFibSettings(drawing.fib).visibility[visibilityGroupForInterval(interval)]) return null
    if (!isDraft && (drawing.hiddenOnChart || !isVisibleOnInterval(drawing.visibility, interval))) return null
    const points = drawing.points.map(px)
    const first = points[0]
    const last = points.at(-1) ?? first
    const selected = forceSelected || (!isDraft && selectedDrawingIds.includes(drawing.id))
    const dash = drawing.lineStyle === 'dashed' ? '8 6' : drawing.lineStyle === 'dotted' ? '2 5' : undefined
    const common = {
      stroke: drawing.color, strokeWidth: drawing.width, vectorEffect: 'non-scaling-stroke' as const,
      fill: 'none', strokeDasharray: dash, strokeOpacity: drawing.opacity ?? 1,
    }
    const fill = colorWithAlpha(drawing.color, drawing.fillOpacity ?? 0.1)
    const shapeFill = (defaultOn: boolean, defaultOpacity = 0.2) => (drawing.fillEnabled ?? defaultOn)
      ? colorWithAlpha(drawing.fillColor ?? drawing.color, drawing.fillOpacity ?? defaultOpacity)
      : 'none'
    const textStyle = (defaultSize: number) => ({
      fill: drawing.textColor ?? drawing.color, fontSize: drawing.fontSize ?? defaultSize,
      fontWeight: drawing.bold ? 700 : 400, fontStyle: drawing.italic ? 'italic' : 'normal',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif",
    })
    /** Text placed inside / around a box using the drawing's alignment settings. */
    const boxText = (left: number, top: number, right: number, bottom: number, defaultSize: number, defaultV: 'top' | 'middle' | 'bottom', defaultH: 'left' | 'center' | 'right', inside = true) => {
      if (!drawing.text) return null
      const style = textStyle(defaultSize)
      const h = drawing.textHAlign ?? defaultH
      const v = drawing.textVAlign ?? defaultV
      const x = h === 'left' ? left + 4 : h === 'right' ? right - 4 : (left + right) / 2
      const y = v === 'top' ? (inside ? top + style.fontSize + 2 : top - 6) : v === 'bottom' ? (inside ? bottom - 6 : bottom + style.fontSize + 2) : (top + bottom) / 2 + style.fontSize * .35
      return <text x={x} y={y} textAnchor={h === 'left' ? 'start' : h === 'right' ? 'end' : 'middle'} {...style} style={{ pointerEvents: 'none' }}>{drawing.text}</text>
    }
    const mid = { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 }
    const dx = last.x - first.x
    const dy = last.y - first.y
    const rectangleCorners: { corner: RectangleCorner; x: number; y: number }[] = [
      { corner: 'nw', x: Math.min(first.x, last.x), y: Math.min(first.y, last.y) },
      { corner: 'ne', x: Math.max(first.x, last.x), y: Math.min(first.y, last.y) },
      { corner: 'sw', x: Math.min(first.x, last.x), y: Math.max(first.y, last.y) },
      { corner: 'se', x: Math.max(first.x, last.x), y: Math.max(first.y, last.y) },
    ]
    const rectangleEdges: { edge: RectangleEdge; x: number; y: number }[] = [
      { edge: 'n', x: mid.x, y: Math.min(first.y, last.y) },
      { edge: 'e', x: Math.max(first.x, last.x), y: mid.y },
      { edge: 's', x: mid.x, y: Math.max(first.y, last.y) },
      { edge: 'w', x: Math.min(first.x, last.x), y: mid.y },
    ]
    let content: ReactNode

    if (isLineToolBehavior(behavior)) {
      content = renderLineTool(drawing, behavior, first, last, common, selected)
    } else if (behavior === 'rectangle' || behavior === 'zoom') {
      if (behavior === 'zoom') {
        content = <rect x={Math.min(first.x, last.x)} y={Math.min(first.y, last.y)} width={Math.abs(dx)} height={Math.abs(dy)} {...common} fill="rgba(41,108,255,.14)" strokeDasharray="7 5" />
      } else {
        const top = Math.min(first.y, last.y)
        const bottom = Math.max(first.y, last.y)
        const left = drawing.extendLeft ? -viewportWidth : Math.min(first.x, last.x)
        const right = drawing.extendRight ? viewportWidth * 2 : Math.max(first.x, last.x)
        content = <g>
          {/* Only the border (and anchors) select the box; clicking inside it falls through to the chart. */}
          <rect x={left} y={top} width={right - left} height={bottom - top} {...common} stroke={drawing.color} fill={shapeFill(true)} pointerEvents="none" />
          <rect data-testid="rectangle-border-hit-target" x={left} y={top} width={right - left} height={bottom - top} fill="none" stroke="transparent" strokeWidth="14" pointerEvents="stroke" vectorEffect="non-scaling-stroke" />
          {drawing.middleLine && <line x1={left} x2={right} y1={(top + bottom) / 2} y2={(top + bottom) / 2} {...common} strokeDasharray="6 4" />}
          {boxText(Math.min(first.x, last.x), top, Math.max(first.x, last.x), bottom, 14, 'middle', 'center')}
        </g>
      }
    } else if (behavior === 'rotated-rectangle') {
      const length = Math.hypot(dx, dy) || 1
      const ox = (-dy / length) * 55; const oy = (dx / length) * 55
      content = <g><polygon points={`${first.x + ox},${first.y + oy} ${last.x + ox},${last.y + oy} ${last.x - ox},${last.y - oy} ${first.x - ox},${first.y - oy}`} {...common} fill={shapeFill(true)} />{boxText(Math.min(first.x, last.x), Math.min(first.y, last.y) - 55, Math.max(first.x, last.x), Math.max(first.y, last.y) + 55, 14, 'middle', 'center')}</g>
    } else if (freehandBehaviors.includes(behavior)) {
      content = <polyline points={points.map((point) => `${point.x},${point.y}`).join(' ')} {...common} fill={behavior === 'brush' && drawing.fillEnabled ? colorWithAlpha(drawing.fillColor ?? drawing.color, drawing.fillOpacity ?? .2) : 'none'} opacity={behavior === 'highlighter' ? 0.38 : 1} strokeLinejoin="round" strokeLinecap="round" />
    } else if (behavior === 'text') {
      const style = textStyle(14)
      const rawLines = (drawing.text ?? '').split('\n')
      const maxChars = 32
      const lines = drawing.wrapText ? rawLines.flatMap((line) => line.length <= maxChars ? [line] : (line.match(new RegExp(`.{1,${maxChars}}`, 'g')) ?? [line])) : rawLines
      const lineHeight = style.fontSize * 1.3
      const width = Math.max(...lines.map((line) => line.length), 1) * style.fontSize * .62 + 12
      const height = lines.length * lineHeight + 8
      const boxed = (drawing.fillEnabled ?? false) || (drawing.borderEnabled ?? false)
      content = <g>
        {boxed && <rect x={first.x - 6} y={first.y - style.fontSize - 4} width={width} height={height} rx={3}
          fill={(drawing.fillEnabled ?? false) ? colorWithAlpha(drawing.fillColor ?? '#2962ff', drawing.fillOpacity ?? .2) : 'none'}
          stroke={(drawing.borderEnabled ?? false) ? (drawing.borderColor ?? '#787b86') : 'none'} vectorEffect="non-scaling-stroke" />}
        <text x={first.x} y={first.y} {...style} fill={drawing.textColor ?? drawing.color}>{lines.map((line, index) => <tspan key={index} x={first.x} dy={index === 0 ? 0 : lineHeight}>{line}</tspan>)}</text>
      </g>
    } else if (behavior === 'note' || behavior === 'comment') {
      const noteStyle = textStyle(14)
      content = <g><rect x={first.x} y={first.y - 32} width="150" height="48" rx="6" fill={drawing.fillColor ? colorWithAlpha(drawing.fillColor, drawing.fillOpacity ?? 1) : fill} stroke={drawing.borderColor ?? drawing.color} vectorEffect="non-scaling-stroke" /><text x={first.x + 10} y={first.y - 3} {...noteStyle}>{drawing.text}</text></g>
    } else if (behavior === 'callout') {
      content = <g><path d={`M${first.x},${first.y} l18,-18 h135 v-45 h-160 v45 h15 z`} fill={fill} stroke={drawing.color} vectorEffect="non-scaling-stroke" /><text x={first.x + 22} y={first.y - 35} fill={drawing.color} fontSize="14">{drawing.text}</text></g>
    } else if (behavior === 'price-label' || behavior === 'signpost' || behavior === 'flag') {
      const style = textStyle(14)
      const labelFill = (drawing.fillEnabled ?? true) ? (drawing.fillColor ?? drawing.color) : 'none'
      const labelStroke = (drawing.borderEnabled ?? false) ? (drawing.borderColor ?? drawing.color) : 'none'
      const textColor = drawing.textColor ?? '#ffffff'
      const label = drawing.text ?? ''
      const width = Math.max(40, label.length * style.fontSize * .62 + 24)
      content = behavior === 'price-label'
        ? <g><line x1="0" x2={first.x} y1={first.y} y2={first.y} {...common} strokeDasharray="5 5" /><path d={`M${first.x},${first.y} l18,-14 h${width} v28 h-${width} z`} fill={labelFill} stroke={labelStroke} vectorEffect="non-scaling-stroke" /><text x={first.x + 25} y={first.y + style.fontSize * .35} {...style} fill={textColor}>{label}</text></g>
        : <g><line x1={first.x} x2={first.x} y1={first.y} y2={first.y - 70} {...common} /><path d={`M${first.x},${first.y - 70} h${width} l-14,19 h-${width - 14} z`} fill={labelFill} stroke={labelStroke} vectorEffect="non-scaling-stroke" /><text x={first.x + 10} y={first.y - 56} {...style} fill={textColor}>{label}</text></g>
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
      const x2 = fib.extend === 'right' || fib.extend === 'both' ? viewportWidth : right
      const startPoint = drawing.points[0]
      const endPoint = drawing.points.at(-1) ?? startPoint
      const startAnchor = Number.isFinite(startPoint.time) && Number.isFinite(startPoint.price)
        ? { time: startPoint.time!, price: startPoint.price! }
        : onMeasurePoint(startPoint)
      const endAnchor = Number.isFinite(endPoint.time) && Number.isFinite(endPoint.price)
        ? { time: endPoint.time!, price: endPoint.price! }
        : onMeasurePoint(endPoint)
      const visibleLevels = fib.levels.filter((level) => level.visible)
      const calculatedLevels = calculateFibLevelGeometry(
        visibleLevels,
        first.y,
        last.y,
        startAnchor?.price ?? null,
        endAnchor?.price ?? null,
        fib.reverse,
        fib.levelsBasedOnLogScale,
      )
      const levelGeometry = calculatedLevels.map((level) => {
        if (level.price === null || !startAnchor) return level
        const projected = onProjectPoint({ time: startAnchor.time, price: level.price })
        return projected && Number.isFinite(projected.y) ? { ...level, y: projected.y } : level
      })
      const labels = layoutFibLabels(levelGeometry, viewportHeight, fib.fontSize)
      const labelYById = new Map(labels.map((level) => [level.id, level.labelY]))
      const labelX = fib.labelsPosition === 'left'
        ? Math.min(viewportWidth - 8, Math.max(8, x1 + 6))
        : fib.labelsPosition === 'center'
          ? (x1 + x2) / 2
          : Math.min(viewportWidth - 8, Math.max(8, x2 - 6))
      const textAnchor = fib.labelsPosition === 'left' ? 'start' : fib.labelsPosition === 'center' ? 'middle' : 'end'
      const bandLevels = [...levelGeometry].sort((a, b) => a.y - b.y)
      content = <g className="fib-drawing">
        {fib.backgroundVisible && bandLevels.slice(0, -1).map((level, index) => {
          const next = bandLevels[index + 1]
          const levelSetting = visibleLevels.find((item) => item.id === level.id)
          const bandColor = fib.useOneColor ? fib.horizontalLineColor : (levelSetting?.color || fib.horizontalLineColor)
          return <rect
            key={`band-${level.id}-${next.id}`}
            data-fib-band={`${level.id}-${next.id}`}
            x={x1} y={level.y} width={Math.max(0, x2 - x1)} height={Math.max(0, next.y - level.y)}
            fill={colorWithAlpha(bandColor, fib.backgroundOpacity)}
            pointerEvents="none"
          />
        })}
        {fib.trendLineVisible && <line
          x1={first.x} y1={first.y} x2={last.x} y2={last.y}
          stroke={fib.trendLineColor} strokeWidth={drawing.width}
          strokeDasharray={dashForLineStyle(fib.trendLineStyle)} vectorEffect="non-scaling-stroke"
        />}
        {levelGeometry.map((geometry) => {
          const level = visibleLevels.find((item) => item.id === geometry.id)!
          const levelColor = fib.useOneColor ? fib.horizontalLineColor : (level.color || fib.horizontalLineColor)
          const levelText = fib.levelsFormat === 'percent'
            ? `${Number((level.value * 100).toFixed(1))}%`
            : formatFibValue(level.value)
          const labelParts = [
            fib.levelsVisible ? levelText : '',
            fib.pricesVisible && geometry.price !== null ? `(${formatPrice(geometry.price, symbol)})` : '',
            level.text?.trim() ?? '',
          ].filter(Boolean)
          const levelLabelY = labelYById.get(level.id) ?? geometry.y
          const labelDisplaced = Math.abs(levelLabelY - geometry.y) > 1.5
          return <g key={level.id} data-fib-level={level.id}>
            <line x1={x1} x2={x2} y1={geometry.y} y2={geometry.y} stroke="transparent" strokeWidth="10" pointerEvents="stroke" vectorEffect="non-scaling-stroke" />
            <line
              x1={x1} x2={x2} y1={geometry.y} y2={geometry.y}
              stroke={levelColor}
              strokeWidth={level.width ?? fib.horizontalLineWidth}
              strokeDasharray={dashForLineStyle(fib.horizontalLineStyle)}
              vectorEffect="non-scaling-stroke"
            />
            {labelParts.length > 0 && <>
              {labelDisplaced && <line
                data-fib-label-connector={level.id}
                x1={labelX} x2={labelX} y1={geometry.y} y2={levelLabelY}
                stroke={levelColor} strokeWidth="1" strokeDasharray="2 2" opacity=".72" vectorEffect="non-scaling-stroke"
              />}
              <text
                data-fib-label={level.id}
                data-fib-label-y={levelLabelY}
                x={labelX} y={levelLabelY}
                textAnchor={textAnchor} dominantBaseline="middle"
                fill={levelColor}
                fontFamily="-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif"
                fontSize={fib.fontSize} fontWeight="400"
              >{[labelParts.filter((part) => part !== level.text?.trim()).join(''), level.text?.trim()].filter(Boolean).join(' ')}</text>
            </>}
          </g>
        })}
      </g>
    } else if (behavior === 'fib-channel') {
      const levels = fibLevelsFor(drawing).filter((level) => level.enabled)
      const fillOn = drawing.fillEnabled ?? true
      content = <g>
        {fillOn && levels.slice(0, -1).map((level, index) => { const next = levels[index + 1]; return <polygon key={`f${level.value}`} points={`${first.x},${first.y + level.value * 180} ${last.x},${last.y + level.value * 180} ${last.x},${last.y + next.value * 180} ${first.x},${first.y + next.value * 180}`} fill={colorWithAlpha(levelColor(drawing, level), drawing.fillOpacity ?? .12)} /> })}
        {levels.map((level) => <g key={level.value}><line x1={first.x} y1={first.y + level.value * 180} x2={last.x} y2={last.y + level.value * 180} {...common} stroke={levelColor(drawing, level)} /><text x={first.x - 4} y={first.y + level.value * 180 + 4} textAnchor="end" fill={levelColor(drawing, level)} fontSize="11">{level.value}</text></g>)}
      </g>
    } else if (behavior === 'fib-time') {
      const levels = fibLevelsFor(drawing).filter((level) => level.enabled)
      const fillOn = drawing.fillEnabled ?? false
      content = <g>
        {fillOn && levels.slice(0, -1).map((level, index) => { const x1 = first.x + dx * level.value; const x2 = first.x + dx * levels[index + 1].value; return <rect key={`f${level.value}`} x={Math.min(x1, x2)} y={0} width={Math.abs(x2 - x1)} height={viewportHeight} fill={colorWithAlpha(levelColor(drawing, level), drawing.fillOpacity ?? .08)} /> })}
        {levels.map((level) => { const x = first.x + dx * level.value; return <g key={level.value}><line x1={x} x2={x} y1="0" y2={viewportHeight} {...common} stroke={levelColor(drawing, level)} /><text x={x + 4} y={viewportHeight - 30} fill={levelColor(drawing, level)} fontSize="11">{level.value}</text></g> })}
      </g>
    } else if (behavior === 'cycles') {
      const multipliers = [0, 1, 2, 3, 4, 5, 6, 7, 8]
      if (drawing.tool === 'time-cycles') {
        const radius = Math.abs(dx) / 2
        const cycleFill = (drawing.fillEnabled ?? true) ? colorWithAlpha(drawing.fillColor ?? drawing.color, drawing.fillOpacity ?? .15) : 'none'
        content = <g>{multipliers.map((value) => { const cx = first.x + dx * value + dx / 2; return <path key={value} d={`M${cx - radius},${first.y} A${radius},${radius * .8} 0 0 1 ${cx + radius},${first.y}`} {...common} fill={cycleFill} /> })}</g>
      } else {
        content = <g>{multipliers.map((value) => { const x = first.x + dx * value; return <line key={value} x1={x} x2={x} y1="0" y2={viewportHeight} {...common} /> })}</g>
      }
    } else if (behavior === 'fan' && drawing.tool === 'gann-fan') {
      const ratios = levelGroup(drawing, 'gann-fan').filter((level) => level.enabled)
      const reach = 4
      const showLabels = drawingOption(drawing, 'labels', true)
      // Ratio r means r units of price per unit of time, measured against the first→second point box.
      const rayEnd = (ratio: number) => ({ x: first.x + dx * reach, y: first.y + dy * ratio * reach })
      content = <g>
        {(drawing.fillEnabled ?? true) && ratios.slice(0, -1).map((level, index) => { const a = rayEnd(level.value); const b = rayEnd(ratios[index + 1].value); return <polygon key={`f${level.label}`} points={`${first.x},${first.y} ${a.x},${a.y} ${b.x},${b.y}`} fill={colorWithAlpha(levelColor(drawing, level), drawing.fillOpacity ?? .06)} /> })}
        {ratios.map((level) => { const end = rayEnd(level.value); const labelPoint = { x: first.x + dx, y: first.y + dy * level.value }; return <g key={level.label}><line x1={first.x} y1={first.y} x2={end.x} y2={end.y} {...common} stroke={levelColor(drawing, level)} />{showLabels && <text x={labelPoint.x + 4} y={labelPoint.y} fill={levelColor(drawing, level)} fontSize="11">{level.label}</text>}</g> })}
      </g>
    } else if (behavior === 'fan' && drawing.tool === 'pitchfan') {
      const levels = fibLevelsFor(drawing).filter((level) => level.enabled)
      const base = 95
      content = <g>
        {(drawing.fillEnabled ?? true) && levels.length > 0 && <polygon points={`${first.x},${first.y} ${last.x},${last.y - base * levels.at(-1)!.value} ${last.x},${last.y + base * levels.at(-1)!.value}`} fill={colorWithAlpha(drawing.useOneColor ? drawing.color : levels.at(-1)!.color, drawing.fillOpacity ?? .08)} />}
        <line x1={first.x} y1={first.y} x2={last.x} y2={last.y} {...common} />
        {levels.flatMap((level) => [-1, 1].map((sign) => <line key={`${level.value}${sign}`} x1={first.x} y1={first.y} x2={last.x} y2={last.y + sign * base * level.value} {...common} stroke={levelColor(drawing, level)} />))}
      </g>
    } else if (behavior === 'fan') {
      // Speed resistance fan: rays from the first point through each level of the price range.
      const levels = fibLevelsFor(drawing).filter((level) => level.enabled)
      const reach = drawing.extendRight === false ? 1 : 4
      content = <g>
        {(drawing.fillEnabled ?? true) && levels.slice(0, -1).map((level, index) => { const next = levels[index + 1]; return <polygon key={`f${level.value}`} points={`${first.x},${first.y} ${first.x + dx * reach},${first.y + dy * level.value * reach} ${first.x + dx * reach},${first.y + dy * next.value * reach}`} fill={colorWithAlpha(levelColor(drawing, level), drawing.fillOpacity ?? .08)} /> })}
        {levels.map((level) => <line key={level.value} x1={first.x} y1={first.y} x2={first.x + dx * reach} y2={first.y + dy * level.value * reach} {...common} stroke={levelColor(drawing, level)} />)}
      </g>
    } else if (behavior === 'pitchfork') {
      const levels = fibLevelsFor(drawing).filter((level) => level.enabled)
      const base = 95
      const style = drawing.pitchforkStyle ?? 'original'
      const start = style === 'schiff' ? { x: first.x, y: (first.y + last.y) / 2 } : style === 'modified-schiff' ? { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 } : first
      const scale = style === 'inside' ? .5 : 1
      const reach = drawing.extendRight ? 4 : 1
      const end = { x: start.x + (last.x - start.x) * reach, y: start.y + (last.y - start.y) * reach }
      const outer = levels.at(-1)?.value ?? 1
      content = <g>
        {(drawing.fillEnabled ?? true) && <polygon points={`${start.x},${start.y - base * outer * scale} ${end.x},${end.y - base * outer * scale} ${end.x},${end.y + base * outer * scale} ${start.x},${start.y + base * outer * scale}`} fill={colorWithAlpha(drawing.useOneColor ? drawing.color : (levels.at(-1)?.color ?? drawing.color), drawing.fillOpacity ?? .08)} />}
        <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} {...common} />
        {levels.flatMap((level) => [-1, 1].map((sign) => <line key={`${level.value}${sign}`} x1={start.x} y1={start.y + sign * base * level.value * scale} x2={end.x} y2={end.y + sign * base * level.value * scale} {...common} stroke={levelColor(drawing, level)} />))}
        <line x1={start.x} y1={start.y - base * outer * scale} x2={start.x} y2={start.y + base * outer * scale} {...common} opacity=".5" />
      </g>
    } else if (behavior === 'gann-box') {
      const x = Math.min(first.x, last.x); const y = Math.min(first.y, last.y); const w = Math.abs(dx); const h = Math.abs(dy)
      const reverse = drawingOption(drawing, 'reverse', false)
      const px = (v: number) => reverse ? x + w * (1 - v) : x + w * v
      const py = (v: number) => reverse ? y + h * v : y + h * (1 - v)
      if (drawing.tool === 'gann-box') {
        const priceLevels = levelGroup(drawing, 'gann-price').filter((level) => level.enabled)
        const timeLevels = levelGroup(drawing, 'gann-time').filter((level) => level.enabled)
        content = <g>
          {drawingOption(drawing, 'priceBackground', true) && priceLevels.slice(0, -1).map((level, index) => <rect key={`pb${level.value}`} x={x} width={w} y={Math.min(py(level.value), py(priceLevels[index + 1].value))} height={Math.abs(py(priceLevels[index + 1].value) - py(level.value))} fill={colorWithAlpha(levelColor(drawing, level), .06)} />)}
          {drawingOption(drawing, 'timeBackground', true) && timeLevels.slice(0, -1).map((level, index) => <rect key={`tb${level.value}`} y={y} height={h} x={Math.min(px(level.value), px(timeLevels[index + 1].value))} width={Math.abs(px(timeLevels[index + 1].value) - px(level.value))} fill={colorWithAlpha(levelColor(drawing, level), .06)} />)}
          {priceLevels.map((level) => <g key={`p${level.value}`}><line x1={x} x2={x + w} y1={py(level.value)} y2={py(level.value)} {...common} stroke={levelColor(drawing, level)} />
            {drawingOption(drawing, 'labelsLeft', true) && <text x={x - 4} y={py(level.value) + 4} textAnchor="end" fill={levelColor(drawing, level)} fontSize="11">{level.value}</text>}
            {drawingOption(drawing, 'labelsRight', true) && <text x={x + w + 4} y={py(level.value) + 4} fill={levelColor(drawing, level)} fontSize="11">{level.value}</text>}</g>)}
          {timeLevels.map((level) => <g key={`t${level.value}`}><line x1={px(level.value)} x2={px(level.value)} y1={y} y2={y + h} {...common} stroke={levelColor(drawing, level)} />
            {drawingOption(drawing, 'labelsTop', true) && <text x={px(level.value)} y={y - 5} textAnchor="middle" fill={levelColor(drawing, level)} fontSize="11">{level.value}</text>}
            {drawingOption(drawing, 'labelsBottom', true) && <text x={px(level.value)} y={y + h + 14} textAnchor="middle" fill={levelColor(drawing, level)} fontSize="11">{level.value}</text>}</g>)}
          {drawingOption(drawing, 'angles', false) && <><line x1={px(0)} y1={py(0)} x2={px(1)} y2={py(1)} {...common} opacity=".7" /><line x1={px(0)} y1={py(1)} x2={px(1)} y2={py(0)} {...common} opacity=".7" /></>}
        </g>
      } else {
        // Gann square: 0..5 grid levels, fans from the origin corner and arcs.
        const gridLevels = levelGroup(drawing, 'square-levels').filter((level) => level.enabled)
        const fans = levelGroup(drawing, 'square-fans').filter((level) => level.enabled)
        const arcs = levelGroup(drawing, 'square-arcs').filter((level) => level.enabled)
        const maxLevel = Math.max(5, ...gridLevels.map((level) => level.value))
        const unitX = w / maxLevel
        const unitY = h / maxLevel
        const ox = px(0); const oy = py(0)
        const sx = reverse ? -1 : 1; const sy = reverse ? 1 : -1
        content = <g>
          {(drawing.fillEnabled ?? true) && <rect x={x} y={y} width={w} height={h} fill={colorWithAlpha(drawing.fillColor ?? drawing.color, drawing.fillOpacity ?? .06)} />}
          {gridLevels.map((level) => <g key={`g${level.value}`}><line x1={x} x2={x + w} y1={oy + sy * unitY * level.value} y2={oy + sy * unitY * level.value} {...common} stroke={levelColor(drawing, level)} opacity=".6" /><line y1={y} y2={y + h} x1={ox + sx * unitX * level.value} x2={ox + sx * unitX * level.value} {...common} stroke={levelColor(drawing, level)} opacity=".6" /></g>)}
          {fans.map((level) => { const ratio = level.value; const ex = ratio >= 1 ? maxLevel / ratio : maxLevel; const ey = ratio >= 1 ? maxLevel : maxLevel * ratio; return <line key={`f${level.label}`} x1={ox} y1={oy} x2={ox + sx * unitX * ex} y2={oy + sy * unitY * ey} {...common} stroke={levelColor(drawing, level)} /> })}
          {arcs.map((level) => <path key={`a${level.label}`} d={`M${ox + sx * unitX * level.value},${oy} A${unitX * level.value},${unitY * level.value} 0 0 ${reverse ? 1 : 0} ${ox},${oy + sy * unitY * level.value}`} {...common} stroke={levelColor(drawing, level)} opacity=".8" />)}
        </g>
      }
    } else if (behavior === 'circles') {
      const levels = fibLevelsFor(drawing).filter((level) => level.enabled && level.value > 0)
      content = <g>{levels.map((level) => <ellipse key={level.value} cx={mid.x} cy={mid.y} rx={Math.abs(dx) * level.value / 2} ry={Math.abs(dy) * level.value / 2} {...common} stroke={levelColor(drawing, level)} fill={(drawing.fillEnabled ?? false) ? colorWithAlpha(levelColor(drawing, level), drawing.fillOpacity ?? .06) : 'none'} />)}</g>
    } else if (behavior === 'spiral') {
      const direction = drawingOption(drawing, 'counterclockwise', false) ? -1 : 1
      const spiral = Array.from({ length: 64 }, (_, index) => { const t = direction * index / 63 * Math.PI * 4; const radius = index / 63; return `${mid.x + Math.cos(t) * Math.abs(dx) * radius / 2},${mid.y + Math.sin(t) * Math.abs(dy) * radius / 2}` }).join(' ')
      content = <polyline points={spiral} {...common} />
    } else if (behavior === 'arcs') {
      const levels = fibLevelsFor(drawing).filter((level) => level.enabled)
      const radius = Math.hypot(dx, dy)
      const full = drawingOption(drawing, 'fullCircles', false)
      const up = dy < 0 ? 1 : 0
      content = <g>
        {drawingOption(drawing, 'trendLine', true) && <line x1={first.x} y1={first.y} x2={last.x} y2={last.y} {...common} strokeDasharray="6 4" />}
        {levels.map((level) => { const r = radius * level.value; return full
          ? <circle key={level.value} cx={last.x} cy={last.y} r={r} {...common} stroke={levelColor(drawing, level)} fill={(drawing.fillEnabled ?? true) ? colorWithAlpha(levelColor(drawing, level), .04) : 'none'} />
          : <g key={level.value}><path d={`M${last.x - r},${last.y} A${r},${r} 0 0 ${up} ${last.x + r},${last.y}`} {...common} stroke={levelColor(drawing, level)} fill={(drawing.fillEnabled ?? true) ? colorWithAlpha(levelColor(drawing, level), .04) : 'none'} />
            {drawingOption(drawing, 'levelLabels', true) && <text x={last.x} y={last.y + (up ? -r : r) + (up ? -4 : 12)} textAnchor="middle" fill={levelColor(drawing, level)} fontSize="11">{level.value}</text>}</g> })}
      </g>
    } else if (behavior === 'wedge') {
      const levels = fibLevelsFor(drawing).filter((level) => level.enabled)
      const radius = Math.hypot(dx, dy)
      const angleA = Math.atan2(dy, dx)
      const angleB = Math.atan2(0, dx === 0 ? 1 : dx)
      content = <g>
        {drawingOption(drawing, 'trendLine', true) && <><line x1={first.x} y1={first.y} x2={last.x} y2={last.y} {...common} /><line x1={first.x} y1={first.y} x2={first.x + Math.cos(angleB) * radius} y2={first.y + Math.sin(angleB) * radius} {...common} /></>}
        {levels.map((level) => { const r = radius * level.value; const ax = first.x + Math.cos(angleA) * r; const ay = first.y + Math.sin(angleA) * r; const bx = first.x + Math.cos(angleB) * r; const by = first.y + Math.sin(angleB) * r; return <g key={level.value}>
          <path d={`M${first.x},${first.y} L${ax},${ay} A${r},${r} 0 0 ${dy < 0 ? 1 : 0} ${bx},${by} Z`} stroke="none" fill={(drawing.fillEnabled ?? true) ? colorWithAlpha(levelColor(drawing, level), .04) : 'none'} />
          <path d={`M${ax},${ay} A${r},${r} 0 0 ${dy < 0 ? 1 : 0} ${bx},${by}`} {...common} stroke={levelColor(drawing, level)} />
          {drawingOption(drawing, 'levelLabels', true) && <text x={bx + 4} y={by + 12} fill={levelColor(drawing, level)} fontSize="11">{level.value}</text>}</g> })}
      </g>
    } else if (behavior === 'sector') {
      const sectorFill = (drawing.fillEnabled ?? true) ? colorWithAlpha(drawing.fillColor ?? drawing.color, drawing.fillOpacity ?? .2) : 'none'
      const sectorStroke = (drawing.borderEnabled ?? true) ? (drawing.borderColor ?? drawing.color) : 'none'
      content = <g><path d={`M${first.x},${first.y} L${last.x},${last.y} A${Math.abs(dx)},${Math.abs(dy)} 0 0 0 ${last.x},${first.y} Z`} {...common} stroke={sectorStroke} fill={sectorFill} /></g>
    } else if (behavior === 'pattern' || behavior === 'wave') {
      const count = behavior === 'wave' ? 6 : 5
      const zig = Array.from({ length: count }, (_, index) => ({ x: first.x + dx * index / (count - 1), y: index % 2 ? last.y : first.y + dy * .28 }))
      const labels = behavior === 'wave' ? ['0','1','2','3','4','5'] : ['X','A','B','C','D']
      const labelStyle = textStyle(12)
      const patternFill = shapeFill(true)
      content = <g>
        {patternFill !== 'none' && behavior === 'pattern' && <><polygon points={zig.slice(0, 3).map((p) => `${p.x},${p.y}`).join(' ')} fill={patternFill} stroke="none" /><polygon points={zig.slice(2, 5).map((p) => `${p.x},${p.y}`).join(' ')} fill={patternFill} stroke="none" /></>}
        <polyline points={zig.map((p) => `${p.x},${p.y}`).join(' ')} {...common} />
        {zig.map((p,index) => <g key={index}><circle cx={p.x} cy={p.y} r="4" fill={drawing.color} /><text x={p.x} y={p.y-9} textAnchor="middle" {...labelStyle}>{labels[index]}</text></g>)}
      </g>
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
      const positionSettings = positionSettingsFor(drawing)
      const red = positionSettings.stopColor
      const green = positionSettings.targetColor
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
        ...positionAmounts(positionSettings, entryPrice!, stopPrice!, targetPrice!),
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
      const unitX = 1
      const unitY = 1
      const screenWidth = (characters: number, min: number, max: number) => Math.min(max, Math.max(min, characters * 6.2 + 18))
      const outsideWidth = Math.min(Math.max(120, viewportSize.width - 16), screenWidth(Math.max(stopText.length, targetText.length), 170, 390)) * unitX
      const centralLineOne = `开仓 PnL: ${pnl}, 数量: ${metrics?.quantity ?? 5}`
      const centralLineTwo = `风险/回报比: ${riskReward}`
      const centralWidth = Math.min(Math.max(120, viewportSize.width - 16), screenWidth(Math.max(centralLineOne.length, centralLineTwo.length), 150, 280)) * unitX
      const centerX = x + w / 2
      const centralX = Math.min(viewportWidth - centralWidth - 8 * unitX, Math.max(8 * unitX, centerX - centralWidth / 2))
      const outsideX = Math.min(viewportWidth - outsideWidth - 8 * unitX, Math.max(8 * unitX, centerX - outsideWidth / 2))
      const labelHeight = 24 * unitY
      const centralHeight = 40 * unitY
      const labelGap = 5 * unitY
      const labelAbove = (edge: number) => Math.max(5 * unitY, edge - labelHeight - labelGap)
      const labelBelow = (edge: number) => edge + labelHeight + labelGap * 2 <= viewportHeight ? edge + labelGap : Math.max(5 * unitY, edge - labelHeight - labelGap)
      const stopY = long ? labelBelow(stopEdge) : labelAbove(stopEdge)
      const targetY = long ? labelAbove(targetEdge) : labelBelow(targetEdge)
      const textScaleX = 1
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
        <rect data-testid="position-upper-zone" x={x} y={top} width={w} height={Math.max(0, entry - top)} fill={colorWithAlpha(upperIsTarget ? green : red, drawing.fillOpacity ?? .2)} stroke={upperIsTarget ? green : red} strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <rect data-testid="position-lower-zone" x={x} y={entry} width={w} height={Math.max(0, bottom - entry)} fill={colorWithAlpha(upperIsTarget ? red : green, drawing.fillOpacity ?? .2)} stroke={upperIsTarget ? red : green} strokeWidth="1" vectorEffect="non-scaling-stroke" />
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
      content = <g><path d={`M${first.x},${first.y} C${mid.x},${first.y} ${mid.x},${last.y} ${last.x},${last.y}`} {...common} strokeDasharray="8 5" markerEnd="url(#arrow-head)" /><circle cx={first.x} cy={first.y} r="6" fill={forecastColor(drawing, 'sourceBackground')} stroke={forecastColor(drawing, 'sourceBorder')} vectorEffect="non-scaling-stroke" /><ellipse cx={last.x} cy={last.y} rx="64" ry="38" fill={colorWithAlpha(forecastColor(drawing, 'targetBackground'), .2)} stroke={forecastColor(drawing, 'targetBorder')} vectorEffect="non-scaling-stroke" /></g>
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
            <line x1="0" x2={viewportWidth} y1={last.y} y2={last.y} stroke="#b2b5be" strokeWidth="1" strokeDasharray="7 7" opacity=".8" vectorEffect="non-scaling-stroke" />
            <line x1={last.x} x2={last.x} y1="0" y2={viewportHeight} stroke="#b2b5be" strokeWidth="1" strokeDasharray="7 7" opacity=".8" vectorEffect="non-scaling-stroke" />
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
      const rangeFill = (drawing.fillEnabled ?? true) ? colorWithAlpha(drawing.fillColor ?? drawing.color, drawing.fillOpacity ?? .2) : 'none'
      const rangeLabelSize = drawing.fontSize ?? 12
      content = <g><rect x={drawing.extendLeft ? -viewportWidth : Math.min(first.x,last.x)} y={Math.min(first.y,last.y)} width={drawing.extendLeft || drawing.extendRight ? viewportWidth * 3 : Math.abs(dx)} height={Math.abs(dy)} fill={rangeFill} stroke={drawing.color} strokeDasharray={dash} strokeOpacity={drawing.opacity ?? 1} vectorEffect="non-scaling-stroke" />{(drawing.labelBackground ?? true) && <rect x={mid.x-68} y={mid.y-15} width="136" height="26" rx="5" fill={drawing.labelBackgroundColor ?? '#296cff'} />}<text x={mid.x} y={mid.y+3} textAnchor="middle" fill={drawing.textColor ?? 'white'} fontSize={rangeLabelSize}>{percent}% · {Math.abs(dx).toFixed(0)} px</text></g>
    } else if (behavior === 'bars-pattern' || behavior === 'ghost-feed') {
      const zig = Array.from({length:12},(_,index)=>({x:first.x+dx*index/11,y:mid.y+Math.sin(index*1.7)*Math.abs(dy)*.38}))
      content = <polyline points={zig.map((p)=>`${p.x},${p.y}`).join(' ')} {...common} opacity={behavior==='ghost-feed'?'.55':'1'} strokeDasharray={behavior==='ghost-feed'?'7 5':dash} />
    } else if (behavior === 'volume-profile') {
      const x=Math.min(first.x,last.x); const y=Math.min(first.y,last.y); const w=Math.abs(dx); const h=Math.abs(dy)
      content = <g>{Array.from({length:12},(_,index)=>{const bar=.3+Math.abs(Math.sin(index*.73))*.7; return <rect key={index} x={x} y={y+h*index/12} width={w*bar} height={h/12-2} fill={colorWithAlpha(drawing.color,.35)} />})}<rect x={x} y={y} width={w} height={h} {...common} /></g>
    } else if (behavior === 'ellipse') {
      content = <g><ellipse cx={mid.x} cy={mid.y} rx={Math.abs(dx)/2} ry={Math.abs(dy)/2} {...common} fill={shapeFill(true)} />{boxText(Math.min(first.x, last.x), Math.min(first.y, last.y), Math.max(first.x, last.x), Math.max(first.y, last.y), 14, 'middle', 'center')}</g>
    } else if (behavior === 'triangle') {
      content = <g><polygon points={`${mid.x},${first.y} ${last.x},${last.y} ${first.x},${last.y}`} {...common} fill={shapeFill(true)} />{boxText(Math.min(first.x, last.x), Math.min(first.y, last.y), Math.max(first.x, last.x), Math.max(first.y, last.y), 14, 'middle', 'center')}</g>
    } else if (behavior === 'arc') {
      content = <path d={`M${first.x},${first.y} Q${mid.x},${Math.min(first.y,last.y)-Math.abs(dy)*.7-40} ${last.x},${last.y}`} {...common} stroke={(drawing.borderEnabled ?? true) ? (drawing.borderColor ?? drawing.color) : 'none'} fill={(drawing.fillEnabled ?? true) ? colorWithAlpha(drawing.fillColor ?? drawing.color, drawing.fillOpacity ?? .2) : 'none'} />
    } else if (behavior === 'curve' || behavior === 'double-curve') {
      content = <g><path d={`M${first.x},${first.y} C${mid.x},${first.y-120} ${mid.x},${last.y+120} ${last.x},${last.y}`} {...common} fill={drawing.fillEnabled ? colorWithAlpha(drawing.fillColor ?? drawing.color, drawing.fillOpacity ?? .2) : 'none'} />{behavior==='double-curve'&&<path d={`M${first.x},${first.y+55} C${mid.x},${first.y-65} ${mid.x},${last.y+175} ${last.x},${last.y+55}`} {...common} opacity=".65" />}</g>
    } else if (behavior === 'channel' || behavior === 'regression') {
      let offset = drawing.channelWidth ? drawing.channelWidth.normalized * viewportHeight : behavior === 'regression' ? 70 : 95
      const anchor = drawing.points[0]
      if (drawing.channelWidth?.price !== undefined && anchor.time !== undefined && anchor.price !== undefined) {
        const edge = onProjectPoint({ time: anchor.time, price: anchor.price + drawing.channelWidth.price })
        if (edge) offset = Math.abs(edge.y - first.y)
      }
      // Level 0 is the upper channel line, level 1 the lower one (TradingView parallel channel).
      const levelY = (level: number) => -offset + level * offset * 2
      const levels = channelLevelsFor(drawing)
      const slope = dx === 0 ? 0 : dy / dx
      const x1 = drawing.extendLeft ? -viewportWidth : first.x
      const x2 = drawing.extendRight ? viewportWidth * 2 : last.x
      const yAt = (x: number, level: number) => first.y + (x - first.x) * slope + levelY(level)
      const channelFill = shapeFill(true)
      content = <g>
        {channelFill !== 'none' && <polygon points={`${x1},${yAt(x1, 0)} ${x2},${yAt(x2, 0)} ${x2},${yAt(x2, 1)} ${x1},${yAt(x1, 1)}`} fill={channelFill} />}
        {levels.filter((level) => level.enabled || level.value === 0 || level.value === 1).map((level) => <line key={level.value}
          x1={x1} y1={yAt(x1, level.value)} x2={x2} y2={yAt(x2, level.value)} {...common}
          stroke={level.color} strokeDasharray={dashForLineStyle(level.lineStyle)} />)}
        {boxText(first.x, yAt(first.x, 0) , last.x, yAt(first.x, 0), 14, 'top', 'left', false)}
      </g>
      // Wide invisible stroke targets make the thin channel lines easy to grab.
      // Keep these behind the width handles so resizing remains independent.
      content = <>{content}{[-1, 0, 1].map(side => <line key={`hit-${side}`}
        data-channel-move="line" x1={first.x} y1={first.y + side * offset}
        x2={last.x} y2={last.y + side * offset}
        stroke="transparent" strokeWidth={14} pointerEvents="stroke" style={{ cursor: 'move' }}
      />)}</>
      if (selected) content = <>{content}
        <g data-channel-move="center" style={{ cursor: 'move' }}>
          <title>拖动整体移动通道（左右 / 上下）</title>
          <rect x={mid.x - 11} y={mid.y - 11} width={22} height={22} rx={4} fill="#131722" stroke="#90bfff" />
          <path d={`M${mid.x - 7},${mid.y}h14 M${mid.x},${mid.y - 7}v14 M${mid.x - 7},${mid.y}l3,-3 M${mid.x - 7},${mid.y}l3,3 M${mid.x + 7},${mid.y}l-3,-3 M${mid.x + 7},${mid.y}l-3,3`} stroke="#90bfff" fill="none" pointerEvents="none" />
        </g>
        {[-1, 1].map(side => <ellipse
        key={side} data-channel-width={side < 0 ? 'upper' : 'lower'}
        cx={mid.x} cy={mid.y + side * offset} rx={7} ry={7}
        fill="#131722" stroke="#2962ff" strokeWidth="2" vectorEffect="non-scaling-stroke"
        style={{ cursor: 'ns-resize' }}
        onPointerDown={event => {
          if (event.button !== 0) return
          startDrawingPointDrag(drawing, 0)(event)
          if (dragRef.current) { dragRef.current.pointIndex = undefined; dragRef.current.channelWidth = true }
        }}
      />)}</>
    } else if (behavior === 'horizontal' || behavior === 'horizontal-ray' || behavior === 'vertical' || behavior === 'cross') {
      const hx1 = behavior === 'horizontal-ray' ? first.x : 0
      const plotRight = plotSize ? Math.min(viewportWidth, plotSize.width) : viewportWidth
      const plotBottom = plotSize ? Math.min(viewportHeight, plotSize.height) : viewportHeight
      const priceLabelOn = behavior !== 'vertical' && (drawing.priceLabels ?? true)
      const timeLabelOn = (behavior === 'vertical' || behavior === 'cross') && (drawing.timeLabel ?? true)
      const priceValue = drawing.points[0]?.price
      const timeValue = drawing.points[0]?.time
      const style = textStyle(behavior === 'vertical' ? 14 : 12)
      let lineText: ReactNode = null
      if (drawing.text && behavior !== 'cross') {
        const h = drawing.textHAlign ?? 'center'
        const v = drawing.textVAlign ?? (behavior === 'horizontal-ray' ? 'bottom' : 'middle')
        if (behavior === 'vertical') {
          const vertical = (drawing.textOrientation ?? 'vertical') === 'vertical'
          const ty = v === 'top' ? 20 : v === 'bottom' ? viewportHeight - 20 : viewportHeight / 2
          const tx = h === 'left' ? first.x - 6 : h === 'right' ? first.x + 6 : first.x
          lineText = <text x={tx} y={ty} textAnchor={vertical ? 'middle' : h === 'left' ? 'end' : h === 'right' ? 'start' : 'middle'}
            transform={vertical ? `rotate(-90 ${tx} ${ty})` : undefined} dy={vertical ? (h === 'left' ? -4 : h === 'right' ? style.fontSize : style.fontSize * .35) : 0}
            {...style} style={{ pointerEvents: 'none' }}>{drawing.text}</text>
        } else {
          const tx = h === 'left' ? hx1 + 6 : h === 'right' ? viewportWidth - 6 : (hx1 + viewportWidth) / 2
          const ty = v === 'top' ? first.y - 5 : v === 'bottom' ? first.y + style.fontSize + 3 : first.y - 5
          lineText = <text x={tx} y={ty} textAnchor={h === 'left' ? 'start' : h === 'right' ? 'end' : 'middle'} {...style} style={{ pointerEvents: 'none' }}>{drawing.text}</text>
        }
      }
      const priceText = priceValue !== undefined && Number.isFinite(priceValue) ? formatPrice(priceValue, symbol) : null
      const timeText = timeValue !== undefined && Number.isFinite(timeValue) ? new Date(timeValue * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : null
      content = <g>
        {behavior !== 'vertical' && <line data-testid="horizontal-ray-hit-target" x1={hx1} x2={viewportWidth} y1={first.y} y2={first.y} stroke="transparent" strokeWidth="16" pointerEvents="stroke" vectorEffect="non-scaling-stroke" />}
        {behavior !== 'vertical' && <line x1={hx1} x2={viewportWidth} y1={first.y} y2={first.y} {...common} />}
        {(behavior === 'vertical' || behavior === 'cross') && <line x1={first.x} x2={first.x} y1="0" y2={viewportHeight} {...common} />}
        {lineText}
        {priceLabelOn && priceText && <g style={{ pointerEvents: 'none' }}>
          <rect x={plotRight - priceText.length * 7 - 12} y={first.y - 9} width={priceText.length * 7 + 12} height={18} rx={2} fill={drawing.color} />
          <text x={plotRight - 6} y={first.y + 4} textAnchor="end" fill="#ffffff" fontSize="11">{priceText}</text>
        </g>}
        {timeLabelOn && timeText && <g style={{ pointerEvents: 'none' }}>
          <rect x={first.x - timeText.length * 3.6 - 6} y={plotBottom - 20} width={timeText.length * 7.2 + 12} height={18} rx={2} fill={drawing.color} />
          <text x={first.x} y={plotBottom - 7} textAnchor="middle" fill="#ffffff" fontSize="11">{timeText}</text>
        </g>}
      </g>
    } else if (behavior === 'ray' || behavior === 'extended-line') {
      const slope = dx === 0 ? 0 : dy / dx
      const x1 = behavior === 'extended-line' ? 0 : first.x; const x2 = viewportWidth
      content = <g>
        <line data-testid="ray-hit-target" x1={x1} y1={first.y + (x1-first.x)*slope} x2={x2} y2={first.y + (x2-first.x)*slope} stroke="transparent" strokeWidth="16" pointerEvents="stroke" vectorEffect="non-scaling-stroke" />
        <line x1={x1} y1={first.y + (x1-first.x)*slope} x2={x2} y2={first.y + (x2-first.x)*slope} {...common} />
      </g>
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
          if (supportsDrawingProperties(behavior)) {
            event.stopPropagation()
            onOpenProperties(drawing)
            return
          }
          if (!textBehaviors.includes(behavior)) return
          const text = window.prompt('编辑内容', drawing.text)
          if (text && text !== drawing.text) {
            dispatch({ type: 'checkpoint' })
            dispatch({ type: 'update', id: drawing.id, patch: { text } })
          }
        }}
        onContextMenu={(event) => {
          if (!supportsDrawingProperties(behavior)) return
          event.preventDefault()
          event.stopPropagation()
          if (!selectedDrawingIds.includes(drawing.id)) dispatch({ type: 'select', id: drawing.id })
          onOpenProperties(drawing)
        }}
        style={{ pointerEvents: isDraft || forceSelected ? 'none' : 'all', cursor: activeDefinition.behavior === 'eraser' ? 'not-allowed' : activeDefinition.behavior === 'cursor' && !drawingsLocked ? 'move' : 'crosshair' }}
      >
        {['line', 'trend', 'arrow', 'info-line', 'angle'].includes(behavior) && <line
          data-testid="drawing-line-hit-target"
          x1={first.x} y1={first.y} x2={last.x} y2={last.y}
          stroke="transparent" strokeWidth="14" pointerEvents="stroke" vectorEffect="non-scaling-stroke"
        />}
        <g opacity={isDraft && !forceSelected ? .78 : 1}>{content}</g>
        {selected && !['measure', 'long-position', 'short-position'].includes(behavior) && <g className="drawing-anchor-points" pointerEvents="all">
          {['rectangle', 'zoom'].includes(behavior)
            ? <>
              {rectangleCorners.map(({ corner, x, y }) => <ellipse
                key={corner} data-drawing-anchor={corner} cx={x} cy={y} rx={handleRadius.x} ry={handleRadius.y}
                fill="#131722" stroke="#2962ff" strokeWidth="2" vectorEffect="non-scaling-stroke"
                onPointerDown={startRectangleCornerDrag(drawing, corner)}
                style={{ cursor: corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize' }}
              />)}
              {rectangleEdges.map(({ edge, x, y }) => <ellipse
                key={edge} data-drawing-anchor={edge} cx={x} cy={y} rx={handleRadius.x} ry={handleRadius.y}
                fill="#131722" stroke="#2962ff" strokeWidth="2" vectorEffect="non-scaling-stroke"
                onPointerDown={startRectangleEdgeDrag(drawing, edge)}
                style={{ cursor: edge === 'n' || edge === 's' ? 'ns-resize' : 'ew-resize' }}
              />)}
            </>
            : <>
              <ellipse
                data-drawing-anchor="start" cx={first.x} cy={first.y} rx={handleRadius.x} ry={handleRadius.y}
                fill="#131722" stroke="#2962ff" strokeWidth="2" vectorEffect="non-scaling-stroke"
                onPointerDown={startDrawingPointDrag(drawing, 0)}
                style={{ cursor: 'crosshair' }}
              />
              <ellipse
                data-drawing-anchor="end" cx={last.x} cy={last.y} rx={handleRadius.x} ry={handleRadius.y}
                fill="#131722" stroke="#2962ff" strokeWidth="2" vectorEffect="non-scaling-stroke"
                onPointerDown={startDrawingPointDrag(drawing, drawing.points.length - 1)}
                style={{ cursor: 'crosshair' }}
              />
            </>}
        </g>}
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
      viewBox={`0 0 ${viewportWidth} ${viewportHeight}`} preserveAspectRatio="none"
      onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp}
      onPointerCancel={() => { cancelDraft(); dragRef.current = null; onToolComplete() }}
      onClick={handleCanvasClick}
      style={{ pointerEvents: drawingMode || activeDefinition.behavior === 'eraser' ? 'auto' : 'none', clipPath: plotClip }}
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
