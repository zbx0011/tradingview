import { useCallback, useEffect, useRef, useState } from 'react'
import { getTool } from '../lib/toolCatalog'
import {
  clampQuickDrawingToolbarPosition,
  loadQuickDrawingToolbarPosition,
  saveQuickDrawingToolbarPosition,
  type QuickDrawingToolbarPosition,
} from '../lib/quickDrawingToolbar'

interface QuickDrawingToolbarProps {
  favoriteTools: readonly string[]
  onSelectTool: (toolId: string) => void
  onOpenSettings: () => void
}

interface DragState {
  pointerId: number
  startX: number
  startY: number
  startPosition: QuickDrawingToolbarPosition
}

export function QuickDrawingToolbar({ favoriteTools, onSelectTool, onOpenSettings }: QuickDrawingToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const [position, setPositionState] = useState(loadQuickDrawingToolbarPosition)
  const positionRef = useRef<QuickDrawingToolbarPosition | null>(position)
  const cleanupRef = useRef<(() => void) | null>(null)
  const [dragging, setDragging] = useState(false)

  const setPosition = useCallback((next: QuickDrawingToolbarPosition) => {
    positionRef.current = next
    setPositionState(next)
  }, [])

  const clampPosition = useCallback((candidate: QuickDrawingToolbarPosition) => {
    const toolbar = toolbarRef.current
    const parent = toolbar?.parentElement
    if (!toolbar || !parent) return candidate
    const parentRect = parent.getBoundingClientRect()
    const toolbarRect = toolbar.getBoundingClientRect()
    return clampQuickDrawingToolbarPosition(candidate, parentRect, toolbarRect)
  }, [])

  useEffect(() => {
    const toolbar = toolbarRef.current
    const parent = toolbar?.parentElement
    if (!toolbar || !parent || !positionRef.current) return
    const keepInsideChart = () => {
      const next = clampPosition(positionRef.current!)
      setPosition(next)
      saveQuickDrawingToolbarPosition(next)
    }
    keepInsideChart()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(keepInsideChart)
    observer?.observe(parent)
    observer?.observe(toolbar)
    window.addEventListener('resize', keepInsideChart)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', keepInsideChart)
    }
  }, [clampPosition, favoriteTools, setPosition])

  useEffect(() => () => cleanupRef.current?.(), [])

  const handleDragStart = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return
    const toolbar = toolbarRef.current
    const parent = toolbar?.parentElement
    if (!toolbar || !parent) return
    event.preventDefault()
    event.stopPropagation()
    const parentRect = parent.getBoundingClientRect()
    const toolbarRect = toolbar.getBoundingClientRect()
    const startPosition = clampPosition({
      left: toolbarRect.left - parentRect.left,
      top: toolbarRect.top - parentRect.top,
    })
    setPosition(startPosition)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPosition,
    }
    setDragging(true)

    const handleMove = (pointerEvent: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || pointerEvent.pointerId !== drag.pointerId) return
      pointerEvent.preventDefault()
      setPosition(clampPosition({
        left: drag.startPosition.left + pointerEvent.clientX - drag.startX,
        top: drag.startPosition.top + pointerEvent.clientY - drag.startY,
      }))
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleEnd)
      window.removeEventListener('pointercancel', handleEnd)
      if (cleanupRef.current === cleanup) cleanupRef.current = null
    }
    const handleEnd = (pointerEvent: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || pointerEvent.pointerId !== drag.pointerId) return
      dragRef.current = null
      setDragging(false)
      if (positionRef.current) saveQuickDrawingToolbarPosition(positionRef.current)
      cleanup()
    }
    cleanupRef.current?.()
    cleanupRef.current = cleanup
    window.addEventListener('pointermove', handleMove, { passive: false })
    window.addEventListener('pointerup', handleEnd)
    window.addEventListener('pointercancel', handleEnd)
  }

  return <div
    ref={toolbarRef}
    className={`reference-quick-tools${dragging ? ' is-dragging' : ''}`}
    aria-label="快捷绘图工具"
    style={position ? { left: position.left, top: position.top, transform: 'none' } : undefined}
  >
    <span
      className="quick-tool-grip"
      role="button"
      tabIndex={0}
      aria-label="拖动移动快捷绘图工具条"
      title="拖动移动工具条"
      onPointerDown={handleDragStart}
    >⠿</span>
    {favoriteTools.map((toolId) => {
      const tool = getTool(toolId)
      return <button key={toolId} type="button" data-testid={`quick-tool-${toolId}`} aria-label={tool.label} title={tool.label} onClick={() => onSelectTool(toolId)}>{tool.glyph}</button>
    })}
    <button type="button" aria-label="绘图设置" title="绘图设置" onClick={onOpenSettings}>—</button>
  </div>
}
