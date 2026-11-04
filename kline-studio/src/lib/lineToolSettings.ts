import type { ChannelLevel, Drawing, DrawingStat, DrawingVisibility, ForecastColorKey, PositionSettings } from './drawings'
import type { IntervalId } from './market'

/** TradingView colour picker palette (10 columns × 8 rows). */
export const TV_COLOR_PALETTE: string[][] = [
  ['#ffffff', '#dbdbdb', '#b8b8b8', '#9c9c9c', '#808080', '#636363', '#464646', '#1a1a1a', '#000000', '#000000'],
  ['#f23645', '#ff9800', '#ffeb3b', '#4caf50', '#089981', '#00bcd4', '#2962ff', '#673ab7', '#9c27b0', '#e91e63'],
  ['#fccbcd', '#ffe0b2', '#fff9c4', '#c8e6c9', '#ace5dc', '#b2ebf2', '#bbd9fb', '#d1c4e9', '#e1bee7', '#f8bbd0'],
  ['#faa1a4', '#ffcc80', '#fff59d', '#a5d6a7', '#70ccbd', '#80deea', '#90bff9', '#b39ddb', '#ce93d8', '#f48fb1'],
  ['#f77c80', '#ffb74d', '#fff176', '#81c784', '#42bda8', '#4dd0e1', '#5b9cf6', '#9575cd', '#ba68c8', '#f06292'],
  ['#f7525f', '#ffa726', '#ffee58', '#66bb6a', '#22ab94', '#26c6da', '#3179f5', '#7e57c2', '#ab47bc', '#ec407a'],
  ['#b22833', '#f57c00', '#fbc02d', '#388e3c', '#056656', '#0097a7', '#1848cc', '#512da8', '#7b1fa2', '#c2185b'],
  ['#801922', '#e65100', '#f57f17', '#1b5e20', '#00332a', '#006064', '#0c3299', '#311b92', '#4a148c', '#880e4f'],
]

export const LINE_TOOL_BEHAVIORS = ['line', 'arrow', 'ray', 'extended-line', 'info-line', 'angle'] as const

export function isLineToolBehavior(behavior: string) {
  return (LINE_TOOL_BEHAVIORS as readonly string[]).includes(behavior)
}

export const DATE_RANGE_STAT_OPTIONS: { id: DrawingStat; label: string }[] = [
  { id: 'bars-range', label: 'K线范围' },
  { id: 'date-time-range', label: '日期/时间范围' },
  { id: 'volume', label: '成交量' },
]

export const STAT_OPTIONS: { id: DrawingStat; label: string }[] = [
  { id: 'price-range', label: '价格范围' },
  { id: 'percent-change', label: '百分比变化' },
  { id: 'pips-change', label: '点数变化' },
  { id: 'bars-range', label: 'K线范围' },
  { id: 'date-time-range', label: '日期/时间范围' },
  { id: 'distance', label: '距离' },
  { id: 'angle', label: '角度' },
]

export const STATS_POSITION_OPTIONS: { id: NonNullable<Drawing['statsPosition']>; label: string }[] = [
  { id: 'left', label: '左' },
  { id: 'center', label: '中心' },
  { id: 'right', label: '右' },
  { id: 'auto', label: '自动' },
]

export const FONT_SIZES = [10, 11, 12, 14, 16, 20, 24, 28, 32, 40]

export const VISIBILITY_ROWS: { key: Exclude<keyof DrawingVisibility, 'ticks' | 'ranges'>; label: string; max: number }[] = [
  { key: 'seconds', label: '秒', max: 59 },
  { key: 'minutes', label: '分钟', max: 59 },
  { key: 'hours', label: '小时', max: 24 },
  { key: 'days', label: '日', max: 366 },
  { key: 'weeks', label: '周', max: 52 },
  { key: 'months', label: '个月', max: 12 },
]

export function defaultVisibility(): DrawingVisibility {
  return {
    ticks: true,
    seconds: { enabled: true, min: 1, max: 59 },
    minutes: { enabled: true, min: 1, max: 59 },
    hours: { enabled: true, min: 1, max: 24 },
    days: { enabled: true, min: 1, max: 366 },
    weeks: { enabled: true, min: 1, max: 52 },
    months: { enabled: true, min: 1, max: 12 },
    ranges: true,
  }
}

export function normalizeVisibility(value?: Partial<DrawingVisibility>): DrawingVisibility {
  const defaults = defaultVisibility()
  if (!value) return defaults
  const merged = { ...defaults, ...value }
  for (const row of VISIBILITY_ROWS) merged[row.key] = { ...defaults[row.key], ...(value[row.key] ?? {}) }
  return merged
}

/** Whether a drawing should be shown on the given chart interval. */
export function isVisibleOnInterval(visibility: DrawingVisibility | undefined, interval: IntervalId) {
  if (!visibility) return true
  const match = /^(\d+)([mhdw])$/.exec(interval)
  if (!match) return true
  const amount = Number(match[1])
  const key = match[2] === 'm' ? 'minutes' : match[2] === 'h' ? 'hours' : match[2] === 'd' ? 'days' : 'weeks'
  const range = normalizeVisibility(visibility)[key]
  return range.enabled && amount >= range.min && amount <= range.max
}

/** Style fields that make up a line-tool "template" (模板). */
const TEMPLATE_FIELDS = [
  'color', 'width', 'lineStyle', 'opacity', 'extendLeft', 'extendRight', 'leftEnd', 'rightEnd', 'middlePoint', 'priceLabels',
  'stats', 'statsPosition', 'alwaysShowStats', 'textColor', 'fontSize', 'bold', 'italic', 'textVAlign', 'textHAlign',
] as const satisfies readonly (keyof Drawing)[]

const templateKey = (tool: string) => `kline-studio-drawing-template-v1:${tool}`

export function pickTemplate(drawing: Drawing): Partial<Drawing> {
  const template: Partial<Drawing> = {}
  for (const field of TEMPLATE_FIELDS) {
    if (drawing[field] !== undefined) (template as Record<string, unknown>)[field] = drawing[field]
  }
  return template
}

export function saveDrawingTemplate(drawing: Drawing) {
  try { localStorage.setItem(templateKey(drawing.tool), JSON.stringify(pickTemplate(drawing))) } catch { /* storage unavailable */ }
}

export function loadDrawingTemplate(tool: string): Partial<Drawing> | null {
  try {
    const raw = localStorage.getItem(templateKey(tool))
    return raw ? JSON.parse(raw) as Partial<Drawing> : null
  } catch {
    return null
  }
}

const lastStyleKey = (tool: string) => `kline-studio-drawing-last-style-v1:${tool}`

/** Style fields of a drawing, restricted to what a template carries. */
export function templateFieldsOf(drawing: Drawing): Partial<Drawing> {
  return pickTemplate(drawing)
}

/** Remember the style the user last gave a tool, so the next drawing of that tool starts the same (per tool, never shared). */
export function rememberDrawingStyle(tool: string, changed: Partial<Drawing>) {
  const next: Partial<Drawing> = { ...(loadLastDrawingStyle(tool) ?? {}) }
  for (const field of TEMPLATE_FIELDS) {
    if (changed[field] !== undefined) (next as Record<string, unknown>)[field] = changed[field]
  }
  try { localStorage.setItem(lastStyleKey(tool), JSON.stringify(next)) } catch { /* storage unavailable */ }
}

export function loadLastDrawingStyle(tool: string): Partial<Drawing> | null {
  try {
    const raw = localStorage.getItem(lastStyleKey(tool))
    return raw ? JSON.parse(raw) as Partial<Drawing> : null
  } catch {
    return null
  }
}

/** Factory defaults used by "应用默认". */
export function defaultLineToolStyle(behavior: string): Partial<Drawing> {
  return {
    color: '#2962ff', width: 1, lineStyle: 'solid', opacity: 1,
    extendLeft: behavior === 'extended-line', extendRight: behavior === 'ray' || behavior === 'extended-line',
    leftEnd: 'normal', rightEnd: behavior === 'arrow' ? 'arrow' : 'normal',
    middlePoint: false, priceLabels: false, stats: [], statsPosition: 'right', alwaysShowStats: false,
    textColor: '#2962ff', fontSize: 14, bold: false, italic: false, textVAlign: 'top', textHAlign: 'center',
  }
}

export function hexToRgba(hex: string, alpha: number) {
  const value = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : '2962ff'
  return `rgba(${parseInt(value.slice(0, 2), 16)}, ${parseInt(value.slice(2, 4), 16)}, ${parseInt(value.slice(4, 6), 16)}, ${alpha})`
}

/** Which TradingView settings layout a drawing uses. */
export type SettingsKind = 'line' | 'hline' | 'vline' | 'cross' | 'channel' | 'shape' | 'pattern' | 'textbox' | 'label' | 'range'
  | 'position' | 'fiblevels' | 'pitchfork' | 'cycle' | 'forecast' | 'gannbox' | 'gannsquare' | 'gannfan' | 'pitchfan' | 'spiral'
  | 'arcs' | 'wedge' | 'barspattern' | 'sector' | 'vwap' | 'volumeprofile' | 'arrowmark' | 'path' | 'brush' | 'arc' | 'curve'
  | 'circle' | 'note' | 'generic'

export function settingsKindFor(behavior: string, tool = ''): SettingsKind {
  if (tool === 'gann-box') return 'gannbox'
  if (tool === 'gann-square' || tool === 'gann-square-fixed') return 'gannsquare'
  if (tool === 'gann-fan') return 'gannfan'
  if (tool === 'pitchfan') return 'pitchfan'
  if (tool === 'time-cycles') return 'cycle'
  if (tool === 'circle' || tool === 'ellipse') return 'circle'
  if (tool === 'note' || tool === 'anchored-note' || tool === 'price-note') return 'note'
  if (isLineToolBehavior(behavior)) return 'line'
  if (behavior === 'horizontal' || behavior === 'horizontal-ray') return 'hline'
  if (behavior === 'vertical') return 'vline'
  if (behavior === 'cross') return 'cross'
  if (behavior === 'channel' || behavior === 'regression') return 'channel'
  if (behavior === 'arc') return 'arc'
  if (behavior === 'curve' || behavior === 'double-curve') return 'curve'
  if (['rectangle', 'rotated-rectangle', 'triangle'].includes(behavior)) return 'shape'
  if (behavior === 'pattern' || behavior === 'wave') return 'pattern'
  if (['price-label', 'signpost', 'flag'].includes(behavior)) return 'label'
  if (['text', 'callout', 'comment', 'table', 'media', 'note'].includes(behavior)) return 'textbox'
  if (behavior === 'range') return 'range'
  if (behavior === 'long-position' || behavior === 'short-position') return 'position'
  if (behavior === 'spiral') return 'spiral'
  if (behavior === 'arcs') return 'arcs'
  if (behavior === 'wedge') return 'wedge'
  if (['fib-time', 'fib-channel', 'circles', 'fan'].includes(behavior)) return 'fiblevels'
  if (behavior === 'pitchfork') return 'pitchfork'
  if (behavior === 'cycles' || behavior === 'sine') return 'cycle'
  if (behavior === 'forecast') return 'forecast'
  if (behavior === 'bars-pattern' || behavior === 'ghost-feed') return 'barspattern'
  if (behavior === 'sector') return 'sector'
  if (behavior === 'vwap') return 'vwap'
  if (behavior === 'volume-profile') return 'volumeprofile'
  if (behavior === 'arrow-mark') return 'arrowmark'
  if (behavior === 'polyline') return 'path'
  if (behavior === 'brush' || behavior === 'highlighter') return 'brush'
  return 'generic'
}

const FIB_COLORS = ['#787b86', '#f23645', '#ff9800', '#4caf50', '#089981', '#00bcd4', '#2962ff', '#9c27b0', '#e91e63', '#673ab7', '#2962ff']

const levelList = (values: number[], enabled: (value: number) => boolean = () => true): ChannelLevel[] =>
  values.map((value, index) => ({ value, enabled: enabled(value), color: FIB_COLORS[index % FIB_COLORS.length], lineStyle: 'solid' }))

/** Default levels per tool (TradingView defaults). */
export function defaultFibLevels(behavior: string): ChannelLevel[] {
  if (behavior === 'fib-time') return levelList([0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89])
  if (behavior === 'fan') return levelList([0, 0.25, 0.382, 0.5, 0.618, 0.75, 1])
  if (behavior === 'pitchfork') return levelList([0.25, 0.382, 0.5, 0.618, 0.75, 1, 1.5, 1.75, 2], (value) => value === 0.5 || value === 1)
  return levelList([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1])
}

export function fibLevelsFor(drawing: Drawing): ChannelLevel[] {
  if (drawing.fibLevels) return drawing.fibLevels
  if (drawing.tool === 'pitchfan') return levelList([0.25, 0.382, 0.5, 0.618, 0.75, 1])
  if (drawing.behavior === 'arcs' || drawing.behavior === 'wedge') return levelList([0.236, 0.382, 0.5, 0.618, 0.786, 1])
  return defaultFibLevels(drawing.behavior)
}

const ratioLevels = (items: [string, number][]) => items.map(([label, value], index) => ({ label, value, enabled: true, color: FIB_COLORS[index % FIB_COLORS.length], lineStyle: 'solid' as const }))

/** Default level groups for the Gann tools. */
export const LEVEL_GROUP_DEFAULTS: Record<string, () => ChannelLevel[]> = {
  'gann-price': () => levelList([0, 0.25, 0.382, 0.5, 0.618, 0.75, 1]),
  'gann-time': () => levelList([0, 0.25, 0.382, 0.5, 0.618, 0.75, 1]),
  'square-levels': () => levelList([0, 1, 2, 3, 4, 5]),
  'square-fans': () => ratioLevels([['8x1', 8], ['5x1', 5], ['4x1', 4], ['3x1', 3], ['2x1', 2], ['1x1', 1], ['1x2', 1 / 2], ['1x3', 1 / 3], ['1x4', 1 / 4], ['1x5', 1 / 5], ['1x8', 1 / 8]]),
  'square-arcs': () => ratioLevels([['1x0', 1], ['1x1', Math.SQRT2], ['1.5x0', 1.5], ['2x0', 2], ['2x1', Math.hypot(2, 1)], ['3x0', 3], ['3x1', Math.hypot(3, 1)], ['4x0', 4], ['4x1', Math.hypot(4, 1)], ['5x0', 5], ['5x1', Math.hypot(5, 1)]]),
  'gann-fan': () => ratioLevels([['1/8', 1 / 8], ['1/4', 1 / 4], ['1/3', 1 / 3], ['1/2', 1 / 2], ['1/1', 1], ['2/1', 2], ['3/1', 3], ['4/1', 4], ['8/1', 8]]),
}

export function levelGroup(drawing: Drawing, key: string): ChannelLevel[] {
  return drawing.levelGroups?.[key] ?? LEVEL_GROUP_DEFAULTS[key]?.() ?? []
}

export function drawingOption<T extends boolean | number | string>(drawing: Drawing, key: string, fallback: T): T {
  const value = drawing.options?.[key]
  return (value === undefined ? fallback : value) as T
}

/** Colour of a level, honouring 使用一种颜色. */
export function levelColor(drawing: Drawing, level: ChannelLevel) {
  return drawing.useOneColor ? drawing.color : level.color
}

export const FORECAST_COLOR_ROWS: { key: ForecastColorKey; label: string; fallback: string }[] = [
  { key: 'sourceText', label: '来源文字', fallback: '#ffffff' },
  { key: 'sourceBackground', label: '来源背景', fallback: '#2962ff' },
  { key: 'sourceBorder', label: '来源边界', fallback: '#2962ff' },
  { key: 'targetText', label: '目标文本', fallback: '#ffffff' },
  { key: 'targetBackground', label: '目标背景', fallback: '#2962ff' },
  { key: 'targetBorder', label: '目标边界', fallback: '#2962ff' },
  { key: 'successText', label: '成功文本', fallback: '#ffffff' },
  { key: 'successBackground', label: '成功的背景色', fallback: '#089981' },
  { key: 'failureText', label: '失败文字', fallback: '#ffffff' },
  { key: 'failureBackground', label: '失败背景', fallback: '#f23645' },
]

export function forecastColor(drawing: Drawing, key: ForecastColorKey) {
  return drawing.forecastColors?.[key] ?? FORECAST_COLOR_ROWS.find((row) => row.key === key)!.fallback
}

export const CHANNEL_LEVEL_DEFAULTS: ChannelLevel[] = [
  { value: -0.25, enabled: false, color: '#2962ff', lineStyle: 'solid' },
  { value: 0, enabled: true, color: '#2962ff', lineStyle: 'solid' },
  { value: 0.25, enabled: false, color: '#2962ff', lineStyle: 'solid' },
  { value: 0.5, enabled: true, color: '#2962ff', lineStyle: 'dashed' },
  { value: 0.75, enabled: false, color: '#2962ff', lineStyle: 'solid' },
  { value: 1, enabled: true, color: '#2962ff', lineStyle: 'solid' },
  { value: 1.25, enabled: false, color: '#2962ff', lineStyle: 'solid' },
]

export function channelLevelsFor(drawing: Drawing): ChannelLevel[] {
  return drawing.channelLevels ?? CHANNEL_LEVEL_DEFAULTS.map((level) => ({ ...level, color: drawing.color }))
}

export const POSITION_STAT_OPTIONS: { id: string; label: string }[] = [
  { id: 'tp-price', label: 'TP价格偏移' },
  { id: 'tp-percent', label: 'TP百分比偏移' },
  { id: 'tp-ticks', label: 'TP tick偏移' },
  { id: 'tp-amount', label: 'TP金额' },
  { id: 'pnl', label: '开盘/收盘损益' },
  { id: 'qty', label: '数量' },
  { id: 'rr', label: '风险/回报比' },
  { id: 'sl-price', label: 'SL价格偏移' },
  { id: 'sl-percent', label: 'SL百分比偏移' },
  { id: 'sl-ticks', label: 'SL tick偏移' },
  { id: 'sl-amount', label: 'SL金额' },
]

export function defaultPositionSettings(): PositionSettings {
  return {
    accountSize: 1000, lotSize: 1, risk: 25, riskUnit: 'percent', leverage: 1, qtyPrecision: 'default',
    stopColor: '#f23645', targetColor: '#089981', stats: POSITION_STAT_OPTIONS.map((item) => item.id), compactStats: false, alwaysShowStats: false,
  }
}

export function positionSettingsFor(drawing: Drawing): PositionSettings {
  return { ...defaultPositionSettings(), ...(drawing.position ?? {}) }
}

/** TradingView sizing: quantity = risk amount / stop distance, amounts = quantity × distance. */
export function positionAmounts(settings: PositionSettings, entry: number, stop: number, target: number) {
  const riskAmount = settings.riskUnit === 'percent' ? settings.accountSize * settings.risk / 100 : settings.risk
  const stopDistance = Math.abs(entry - stop)
  const rawQuantity = stopDistance > 0 ? riskAmount / stopDistance / Math.max(settings.lotSize, 1e-9) : 0
  const quantity = settings.qtyPrecision === 'default' ? Math.round(rawQuantity * 1000) / 1000 : Number(rawQuantity.toFixed(settings.qtyPrecision))
  const units = quantity * settings.lotSize
  return { quantity, stopAmount: Math.round(units * stopDistance * 100) / 100, targetAmount: Math.round(units * Math.abs(target - entry) * 100) / 100 }
}
