import { getTool, type ToolBehavior, type ToolDefinition } from './toolCatalog'

export type DrawingTool = string
export interface DrawingPoint {
  x: number
  y: number
  time?: number
  price?: number
}
export type DrawingLineStyle = 'solid' | 'dashed' | 'dotted'

export interface FibLevelSetting {
  id: string
  value: number
  visible: boolean
  color: string
}

export interface FibSettings {
  trendLineVisible: boolean
  trendLineColor: string
  trendLineStyle: DrawingLineStyle
  horizontalLineColor: string
  horizontalLineStyle: DrawingLineStyle
  horizontalLineWidth: number
  extend: 'none' | 'left' | 'right' | 'both'
  levels: FibLevelSetting[]
  visibility: { minutes: boolean; hours: boolean; days: boolean; weeks: boolean }
}

const FIB_LEVEL_DEFAULTS: FibLevelSetting[] = [
  { id: '0', value: 0, visible: true, color: '#f0f3fa' },
  { id: '0236', value: .236, visible: false, color: '#a3333f' },
  { id: '0382', value: .382, visible: false, color: '#a66c14' },
  { id: '05', value: .5, visible: true, color: '#f0f3fa' },
  { id: '0618', value: .618, visible: true, color: '#b42130' },
  { id: '0786', value: .786, visible: false, color: '#1f8794' },
  { id: '1', value: 1, visible: true, color: '#f0f3fa' },
  { id: '1618', value: 1.618, visible: false, color: '#3655a5' },
  { id: '2618', value: 2.618, visible: false, color: '#a43742' },
  { id: '3618', value: 3.618, visible: false, color: '#713086' },
  { id: '4236', value: 4.236, visible: false, color: '#9d1e56' },
  { id: '1272', value: 1.272, visible: false, color: '#a66c14' },
]

export function createDefaultFibSettings(): FibSettings {
  return {
    trendLineVisible: true,
    trendLineColor: '#7b808a',
    trendLineStyle: 'dashed',
    horizontalLineColor: '#d1d4dc',
    horizontalLineStyle: 'solid',
    horizontalLineWidth: 1.5,
    extend: 'none',
    levels: FIB_LEVEL_DEFAULTS.map((level) => ({ ...level })),
    visibility: { minutes: true, hours: true, days: true, weeks: true },
  }
}

export function normalizeFibSettings(value?: Partial<FibSettings>): FibSettings {
  const defaults = createDefaultFibSettings()
  if (!value) return defaults
  const savedLevels = Array.isArray(value.levels) ? value.levels : []
  return {
    ...defaults,
    ...value,
    levels: defaults.levels.map((level) => {
      const saved = savedLevels.find((item) => item.id === level.id)
      return saved && Number.isFinite(saved.value) ? { ...level, ...saved } : level
    }),
    visibility: { ...defaults.visibility, ...(value.visibility ?? {}) },
  }
}

export interface Drawing {
  id: string
  tool: string
  behavior: ToolBehavior
  label: string
  points: DrawingPoint[]
  color: string
  width: number
  lineStyle?: DrawingLineStyle
  fillOpacity?: number
  locked?: boolean
  text?: string
  fib?: FibSettings
}

export interface DrawingHistory {
  past: Drawing[][]
  present: Drawing[]
  future: Drawing[][]
  selectedId: string | null
  selectedIds: string[]
}

export type DrawingAction =
  | { type: 'add'; drawing: Drawing }
  | { type: 'update'; id: string; patch: Partial<Drawing> }
  | { type: 'checkpoint' }
  | { type: 'delete'; id: string }
  | { type: 'delete-many'; ids: string[] }
  | { type: 'select'; id: string | null; additive?: boolean }
  | { type: 'clear' }
  | { type: 'load'; drawings: Drawing[] }
  | { type: 'undo' }
  | { type: 'redo' }

export const initialDrawingHistory: DrawingHistory = { past: [], present: [], future: [], selectedId: null, selectedIds: [] }

export function isTransientMeasurement(drawing: Drawing): boolean {
  return drawing.tool === 'measure' && drawing.behavior === 'measure'
}

export function withoutTransientMeasurements(drawings: Drawing[]): Drawing[] {
  return drawings.filter((drawing) => !isTransientMeasurement(drawing))
}

function distanceToSegment(point: DrawingPoint, start: DrawingPoint, end: DrawingPoint) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y)
  const progress = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(point.x - (start.x + dx * progress), point.y - (start.y + dy * progress))
}

export function hitTestDrawing(drawing: Drawing, point: DrawingPoint, width: number, height: number, tolerance = 10) {
  if (drawing.points.length < 2 || width <= 0 || height <= 0) return false
  const first = { x: drawing.points[0].x * width, y: drawing.points[0].y * height }
  const lastPoint = drawing.points.at(-1)!
  const last = { x: lastPoint.x * width, y: lastPoint.y * height }
  const testPoint = { x: point.x * width, y: point.y * height }
  const dx = last.x - first.x
  const dy = last.y - first.y
  const slope = dx === 0 ? 0 : dy / dx
  const segments: [DrawingPoint, DrawingPoint][] = drawing.behavior === 'ray'
    ? [[first, { x: width, y: first.y + (width - first.x) * slope }]]
    : drawing.behavior === 'extended-line'
      ? [[{ x: 0, y: first.y - first.x * slope }, { x: width, y: first.y + (width - first.x) * slope }]]
      : drawing.behavior === 'horizontal'
        ? [[{ x: 0, y: first.y }, { x: width, y: first.y }]]
        : drawing.behavior === 'horizontal-ray'
          ? [[first, { x: width, y: first.y }]]
          : drawing.behavior === 'vertical'
            ? [[{ x: first.x, y: 0 }, { x: first.x, y: height }]]
            : drawing.behavior === 'cross'
              ? [[{ x: 0, y: first.y }, { x: width, y: first.y }], [{ x: first.x, y: 0 }, { x: first.x, y: height }]]
              : ['line', 'arrow', 'info-line', 'angle', 'vwap'].includes(drawing.behavior)
                ? [[first, last]]
                : []
  return segments.some(([start, end]) => distanceToSegment(testPoint, start, end) <= Math.max(tolerance, drawing.width / 2 + 6))
}

function commit(state: DrawingHistory, next: Drawing[]): DrawingHistory {
  return { past: [...state.past.slice(-49), state.present], present: next, future: [], selectedId: state.selectedId, selectedIds: state.selectedIds ?? (state.selectedId ? [state.selectedId] : []) }
}

export function drawingReducer(state: DrawingHistory, action: DrawingAction): DrawingHistory {
  switch (action.type) {
    case 'add':
      return { ...commit(state, [...state.present, action.drawing]), selectedId: action.drawing.id, selectedIds: [action.drawing.id] }
    case 'checkpoint':
      return { ...state, past: [...state.past.slice(-49), state.present], future: [] }
    case 'update':
      return { ...state, present: state.present.map((item) => item.id === action.id ? { ...item, ...action.patch } : item) }
    case 'delete':
      return { ...commit(state, state.present.filter((item) => item.id !== action.id)), selectedId: null, selectedIds: (state.selectedIds ?? []).filter((id) => id !== action.id) }
    case 'delete-many':
      return { ...commit(state, state.present.filter((item) => !action.ids.includes(item.id))), selectedId: null, selectedIds: [] }
    case 'select': {
      if (!action.id) return { ...state, selectedId: null, selectedIds: [] }
      if (!action.additive) return { ...state, selectedId: action.id, selectedIds: [action.id] }
      const currentSelection = state.selectedIds ?? (state.selectedId ? [state.selectedId] : [])
      const selectedIds = currentSelection.includes(action.id)
        ? currentSelection.filter((id) => id !== action.id)
        : [...currentSelection, action.id]
      return { ...state, selectedId: selectedIds.includes(action.id) ? action.id : (selectedIds.at(-1) ?? null), selectedIds }
    }
    case 'clear':
      return { ...commit(state, []), selectedId: null }
    case 'load':
      return { ...initialDrawingHistory, present: action.drawings }
    case 'undo': {
      const previous = state.past.at(-1)
      if (!previous) return state
      return { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future], selectedId: null, selectedIds: [] }
    }
    case 'redo': {
      const next = state.future[0]
      if (!next) return state
      return { past: [...state.past, state.present], present: next, future: state.future.slice(1), selectedId: null, selectedIds: [] }
    }
  }
}

export function makeDrawing(toolOrId: ToolDefinition | string, point: DrawingPoint, color = '#a7c7ff'): Drawing {
  const definition = typeof toolOrId === 'string' ? getTool(toolOrId) : toolOrId
  const textBehaviors: ToolBehavior[] = ['text', 'note', 'callout', 'comment', 'price-label', 'signpost', 'flag', 'table', 'media']
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    tool: definition.id,
    behavior: definition.behavior,
    label: definition.label,
    points: [point],
    color,
    width: definition.behavior === 'highlighter' ? 12 : 1.5,
    lineStyle: definition.behavior === 'ghost-feed' ? 'dashed' : 'solid',
    fillOpacity: definition.behavior === 'highlighter' ? 0.2 : 0.1,
    text: textBehaviors.includes(definition.behavior) ? definition.label : definition.behavior === 'icon' ? definition.glyph : undefined,
    fib: definition.behavior === 'fib' || definition.behavior === 'fib-extension' ? createDefaultFibSettings() : undefined,
  }
}

export function duplicateDrawing(drawing: Drawing, offset = 0.02): Drawing {
  return {
    ...drawing,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    points: drawing.points.map((point) => ({ x: point.x + offset, y: point.y + offset })),
    locked: false,
  }
}

export function moveDrawing(drawing: Drawing, dx: number, dy: number): DrawingPoint[] {
  return drawing.points.map((point) => ({
    x: Math.max(0, Math.min(1, point.x + dx)),
    y: Math.max(0, Math.min(1, point.y + dy)),
  }))
}

const constrainedLineBehaviors: ToolBehavior[] = ['line', 'ray', 'extended-line', 'info-line', 'angle', 'channel', 'regression', 'arrow']
const constrainedShapeBehaviors: ToolBehavior[] = ['rectangle', 'ellipse', 'gann-box', 'circles']

export function constrainDrawingPoint(start: DrawingPoint, point: DrawingPoint, behavior: ToolBehavior, width: number, height: number): DrawingPoint {
  const dx = (point.x - start.x) * width
  const dy = (point.y - start.y) * height
  if (constrainedShapeBehaviors.includes(behavior)) {
    const size = Math.max(Math.abs(dx), Math.abs(dy))
    return {
      x: start.x + Math.sign(dx || 1) * size / width,
      y: start.y + Math.sign(dy || 1) * size / height,
    }
  }
  if (constrainedLineBehaviors.includes(behavior)) {
    const length = Math.hypot(dx, dy)
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
    return {
      x: start.x + Math.cos(angle) * length / width,
      y: start.y + Math.sin(angle) * length / height,
    }
  }
  return point
}

export function partiallyEraseDrawing(drawing: Drawing, point: DrawingPoint): DrawingPoint[] | null {
  if (!['brush', 'highlighter', 'polyline'].includes(drawing.behavior) || drawing.points.length <= 3) return null
  let nearest = 0
  drawing.points.forEach((candidate, index) => {
    if (Math.hypot(candidate.x - point.x, candidate.y - point.y) < Math.hypot(drawing.points[nearest].x - point.x, drawing.points[nearest].y - point.y)) nearest = index
  })
  const radius = Math.max(1, Math.ceil(drawing.points.length * 0.08))
  const points = drawing.points.filter((_, index) => Math.abs(index - nearest) > radius)
  return points.length > 2 ? points : null
}
