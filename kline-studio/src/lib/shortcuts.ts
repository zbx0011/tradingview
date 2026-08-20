import type { IntervalId } from './market'

export interface ShortcutDefinition {
  id: string
  section: '图表' | '绘图' | '回放' | '交易平台'
  label: string
  keys: string
}

export const TRADINGVIEW_SHORTCUTS: ShortcutDefinition[] = [
  { id: 'quick-search', section: '图表', label: '快速搜索', keys: 'Ctrl+K' },
  { id: 'indicators', section: '图表', label: '打开指标', keys: '/' },
  { id: 'load-layout', section: '图表', label: '加载图表布局', keys: '.' },
  { id: 'save-layout', section: '图表', label: '保存图表布局', keys: 'Ctrl+S' },
  { id: 'undo', section: '图表', label: '撤销', keys: 'Ctrl+Z' },
  { id: 'redo', section: '图表', label: '重做', keys: 'Ctrl+Y / Ctrl+Shift+Z' },
  { id: 'symbol', section: '图表', label: '更改商品', keys: '直接输入代码' },
  { id: 'interval', section: '图表', label: '更改周期', keys: '数字 或 ,' },
  { id: 'move-bar', section: '图表', label: '左右移动一根 K 线', keys: '← / →' },
  { id: 'zoom', section: '图表', label: '放大 / 缩小', keys: 'Ctrl+↑ / Ctrl+↓' },
  { id: 'move-far', section: '图表', label: '大幅左右移动', keys: 'Ctrl+← / Ctrl+→' },
  { id: 'go-date', section: '图表', label: '转到日期', keys: 'Alt+G' },
  { id: 'snapshot', section: '图表', label: '图表快照', keys: 'Alt+S' },
  { id: 'reset', section: '图表', label: '重置图表', keys: 'Alt+R' },
  { id: 'invert', section: '图表', label: '反转价格坐标', keys: 'Alt+I' },
  { id: 'log', section: '图表', label: '对数坐标', keys: 'Alt+L' },
  { id: 'percent', section: '图表', label: '百分比坐标', keys: 'Alt+P' },
  { id: 'keyboard-nav', section: '图表', label: '键盘导航', keys: 'Alt+Z' },
  { id: 'toggle-chart-annotations', section: '图表', label: '隐藏 / 显示全部标注', keys: '·' },
  { id: 'copy-paste', section: '绘图', label: '复制 / 粘贴对象', keys: 'Ctrl+C / Ctrl+V' },
  { id: 'hide-drawings', section: '绘图', label: '隐藏全部绘图', keys: 'Ctrl+Alt+H' },
  { id: 'measure-temporary', section: '绘图', label: '临时测量工具', keys: '按住 Shift + 点击' },
  { id: 'clone-drawing', section: '绘图', label: '克隆绘图', keys: 'Ctrl + 拖动' },
  { id: 'multi-select', section: '绘图', label: '多选绘图', keys: 'Ctrl + 点击' },
  { id: 'axis-drag', section: '绘图', label: '水平或垂直移动', keys: 'Shift + 拖动' },
  { id: 'temporary-magnet', section: '绘图', label: '临时切换磁吸', keys: 'Ctrl + 移动绘图点' },
  { id: 'partial-erase', section: '绘图', label: '局部擦除自由绘图', keys: '橡皮擦 + Ctrl' },
  { id: 'move-drawing', section: '绘图', label: '移动选中绘图', keys: '方向键' },
  { id: 'trend', section: '绘图', label: '趋势线', keys: 'Alt+T' },
  { id: 'horizontal', section: '绘图', label: '水平线', keys: 'Alt+H' },
  { id: 'vertical', section: '绘图', label: '垂直线', keys: 'Alt+V' },
  { id: 'cross', section: '绘图', label: '交叉线', keys: 'Alt+C' },
  { id: 'fib', section: '绘图', label: '斐波那契回撤', keys: 'Alt+F' },
  { id: 'rectangle', section: '绘图', label: '矩形', keys: 'Alt+Shift+R' },
  { id: 'square', section: '绘图', label: '绘制正方形', keys: '矩形 + Shift' },
  { id: 'circle', section: '绘图', label: '绘制正圆', keys: '椭圆 + Shift' },
  { id: 'angle-constraint', section: '绘图', label: '水平 / 45° 约束', keys: '趋势线或通道 + Shift' },
  { id: 'replay-toggle', section: '回放', label: '播放 / 暂停', keys: 'Shift+↓' },
  { id: 'replay-step', section: '回放', label: '前进一格', keys: 'Shift+→' },
  { id: 'maximize', section: '交易平台', label: '最大化图表', keys: 'Alt+Enter' },
  { id: 'watchlist', section: '交易平台', label: '加入自选', keys: 'Alt+W' },
  { id: 'alert', section: '交易平台', label: '在当前价格创建警报', keys: 'Alt+A' },
  { id: 'buy-limit', section: '交易平台', label: '创建买入限价单', keys: 'Alt+Shift+B' },
  { id: 'add-order', section: '交易平台', label: '添加模拟订单', keys: 'Shift+T' },
]

const intervalAliases: Record<string, IntervalId> = {
  '1': '1m', '1m': '1m',
  '5': '5m', '5m': '5m',
  '15': '15m', '15m': '15m',
  '30': '30m', '30m': '30m',
  '60': '1h', '1h': '1h', '1小时': '1h',
  '120': '2h', '2h': '2h', '2小时': '2h',
  '240': '4h', '4h': '4h', '4小时': '4h',
  d: '1d', '1d': '1d', '日': '1d',
  w: '1w', '1w': '1w', '周': '1w',
}

export function parseIntervalShortcut(value: string): IntervalId | null {
  return intervalAliases[value.trim().toLowerCase()] ?? null
}

export type HistoryShortcutAction = 'undo' | 'redo'

export function resolveHistoryShortcut(
  event: Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
): HistoryShortcutAction | null {
  if ((!event.ctrlKey && !event.metaKey) || event.altKey) return null

  const key = event.key.toLowerCase()
  const isZ = key === 'z' || event.code === 'KeyZ'
  const isY = key === 'y' || event.code === 'KeyY'

  if (isZ) return event.shiftKey ? 'redo' : 'undo'
  if (isY && !event.shiftKey) return 'redo'
  return null
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export function isChartAnnotationVisibilityShortcut(
  event: Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'repeat' | 'shiftKey'>,
): boolean {
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
  return event.key === '·' || event.key === '`' || event.code === 'Backquote'
}
