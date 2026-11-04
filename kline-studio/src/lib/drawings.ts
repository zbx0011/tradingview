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
  text?: string
  /** Per-level line thickness; falls back to the shared horizontal line width. */
  width?: number
}

export interface FibSettings {
  trendLineVisible: boolean
  trendLineColor: string
  trendLineStyle: DrawingLineStyle
  horizontalLineColor: string
  horizontalLineStyle: DrawingLineStyle
  horizontalLineWidth: number
  extend: 'none' | 'left' | 'right' | 'both'
  useOneColor: boolean
  backgroundVisible: boolean
  backgroundOpacity: number
  reverse: boolean
  pricesVisible: boolean
  levelsVisible: boolean
  levelsFormat: 'values' | 'percent'
  labelsPosition: 'left' | 'center' | 'right'
  fontSize: number
  levelsBasedOnLogScale: boolean
  levels: FibLevelSetting[]
  visibility: { minutes: boolean; hours: boolean; days: boolean; weeks: boolean }
}

const FIB_LEVEL_DEFAULTS: FibLevelSetting[] = [
  { id: '0', value: 0, visible: true, color: '#787b86' },
  { id: '0236', value: .236, visible: true, color: '#f23645' },
  { id: '0382', value: .382, visible: true, color: '#ff9800' },
  { id: '05', value: .5, visible: true, color: '#4caf50' },
  { id: '0618', value: .618, visible: true, color: '#089981' },
  { id: '0786', value: .786, visible: true, color: '#2962ff' },
  { id: '1', value: 1, visible: true, color: '#787b86' },
  { id: '1618', value: 1.618, visible: false, color: '#2962ff' },
  { id: '2618', value: 2.618, visible: false, color: '#f23645' },
  { id: '3618', value: 3.618, visible: false, color: '#9c27b0' },
  { id: '4236', value: 4.236, visible: false, color: '#e91e63' },
  { id: '1272', value: 1.272, visible: false, color: '#ff9800' },
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
    useOneColor: false,
    backgroundVisible: true,
    backgroundOpacity: 0.08,
    reverse: false,
    pricesVisible: true,
    levelsVisible: true,
    levelsFormat: 'values',
    labelsPosition: 'right',
    fontSize: 12,
    levelsBasedOnLogScale: false,
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

/** Statistics shown next to a line tool (TradingView "统计数据"). */
export type DrawingStat = 'price-range' | 'percent-change' | 'pips-change' | 'bars-range' | 'date-time-range' | 'distance' | 'angle' | 'volume'

export interface DrawingVisibilityRange { enabled: boolean; min: number; max: number }

/** TradingView "可见范围": which chart resolutions show the drawing. */
export interface DrawingVisibility {
  ticks: boolean
  seconds: DrawingVisibilityRange
  minutes: DrawingVisibilityRange
  hours: DrawingVisibilityRange
  days: DrawingVisibilityRange
  weeks: DrawingVisibilityRange
  months: DrawingVisibilityRange
  ranges: boolean
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
  /** Line opacity 0..1 (TradingView 不透明度). */
  opacity?: number
  extendLeft?: boolean
  extendRight?: boolean
  leftEnd?: 'normal' | 'arrow'
  rightEnd?: 'normal' | 'arrow'
  middlePoint?: boolean
  priceLabels?: boolean
  stats?: DrawingStat[]
  statsPosition?: 'left' | 'center' | 'right' | 'auto'
  alwaysShowStats?: boolean
  textColor?: string
  fontSize?: number
  bold?: boolean
  italic?: boolean
  textVAlign?: 'top' | 'middle' | 'bottom'
  textHAlign?: 'left' | 'center' | 'right'
  visibility?: DrawingVisibility
  /** Hidden from the chart via the drawing's "更多 → 隐藏" menu. */
  hiddenOnChart?: boolean
  /** 背景 checkbox + colour (shapes, channels, text boxes, patterns). */
  fillEnabled?: boolean
  fillColor?: string
  /** 边框 checkbox + colour (text boxes, patterns, ranges). */
  borderEnabled?: boolean
  borderColor?: string
  /** 中线 for rectangles. */
  middleLine?: boolean
  /** 时间标签 for vertical / cross lines. */
  timeLabel?: boolean
  /** 文字方向 for vertical lines. */
  textOrientation?: 'vertical' | 'horizontal'
  /** 文本换行 for text boxes. */
  wrapText?: boolean
  /** Parallel-channel levels (0 and 1 are the two channel lines). */
  channelLevels?: ChannelLevel[]
  /** Long / short position inputs and styling. */
  position?: PositionSettings
  /** Levels for fib time zones / channels / circles / fans and pitchforks. */
  fibLevels?: ChannelLevel[]
  /** 使用一种颜色: draw every level with the main colour. */
  useOneColor?: boolean
  /** 分叉线 样式. */
  pitchforkStyle?: 'original' | 'schiff' | 'modified-schiff' | 'inside'
  /** 仓位预测 colours (来源 / 目标 / 成功 / 失败). */
  forecastColors?: Partial<Record<ForecastColorKey, string>>
  /** 标签背景 for price / date ranges. */
  labelBackground?: boolean
  labelBackgroundColor?: string
  /** Extra level groups (江恩箱 价格位/时间水平, 江恩正方 水平位/扇形/弧形 …). */
  levelGroups?: Record<string, ChannelLevel[]>
  /** Tool specific switches / values (反手, 角度, 逆时针方向, 完整圆圈, 镜像, VWAP / VP inputs …). */
  options?: Record<string, boolean | number | string>
}

export type ForecastColorKey = 'sourceText' | 'sourceBackground' | 'sourceBorder' | 'targetText' | 'targetBackground' | 'targetBorder' | 'successText' | 'successBackground' | 'failureText' | 'failureBackground'

export interface ChannelLevel { value: number; enabled: boolean; color: string; lineStyle: DrawingLineStyle; label?: string }

export interface PositionSettings {
  accountSize: number
  lotSize: number
  risk: number
  riskUnit: 'percent' | 'currency'
  leverage: number
  qtyPrecision: 'default' | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
  stopColor: string
  targetColor: string
  stats: string[]
  compactStats: boolean
  alwaysShowStats: boolean
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
  | { type: 'reorder'; id: string; to: 'front' | 'back' | 'forward' | 'backward' }
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
    case 'reorder': {
      const index = state.present.findIndex((item) => item.id === action.id)
      if (index < 0) return state
      const next = [...state.present]
      const [item] = next.splice(index, 1)
      const target = action.to === 'front' ? next.length
        : action.to === 'back' ? 0
          : action.to === 'forward' ? Math.min(next.length, index + 1)
            : Math.max(0, index - 1)
      next.splice(target, 0, item)
      return commit(state, next)
    }
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
