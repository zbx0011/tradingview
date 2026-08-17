import type { SymbolId } from './market'

export interface ChartAlert {
  id: string
  symbol: SymbolId
  price: number
  name: string
  condition: 'crossing' | 'greater' | 'less'
  frequency: 'once' | 'once-per-bar' | 'every-time'
  createdAt: number
}

export interface PaperOrder {
  id: string
  symbol: SymbolId
  side: 'buy' | 'sell'
  type: 'limit' | 'stop'
  quantity: number
  price: number
  createdAt: number
}

export interface ContextMenuPosition {
  left: number
  top: number
}

export const CHART_ALERTS_STORAGE_KEY = 'kline-studio-chart-alerts-v1'
export const PAPER_ORDERS_STORAGE_KEY = 'kline-studio-paper-orders-v1'

export function clampContextMenuPosition(
  clientX: number,
  clientY: number,
  viewportWidth: number,
  viewportHeight: number,
  menuWidth = 420,
  menuHeight = 720,
  gutter = 8,
): ContextMenuPosition {
  return {
    left: Math.max(gutter, Math.min(clientX, viewportWidth - menuWidth - gutter)),
    top: Math.max(gutter, Math.min(clientY, viewportHeight - Math.min(menuHeight, viewportHeight - gutter * 2) - gutter)),
  }
}

export function countActiveIndicators(indicators: { ma: boolean; ema: boolean; boll: boolean; volume: boolean }) {
  return [indicators.ma, indicators.ema, indicators.boll, indicators.volume].filter(Boolean).length
}

function parseStoredArray<T>(raw: string | null, predicate: (value: unknown) => value is T): T[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? value.filter(predicate) : []
  } catch {
    return []
  }
}

const isAlert = (value: unknown): value is ChartAlert => {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ChartAlert>
  return typeof item.id === 'string' && typeof item.price === 'number' && Number.isFinite(item.price)
    && ['XAUUSD', 'XAGUSD', 'BTCUSDT.P', 'US500', 'ETHUSD'].includes(item.symbol ?? '')
    && ['crossing', 'greater', 'less'].includes(item.condition ?? '')
    && ['once', 'once-per-bar', 'every-time'].includes(item.frequency ?? '')
}

const isOrder = (value: unknown): value is PaperOrder => {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<PaperOrder>
  return typeof item.id === 'string' && typeof item.price === 'number' && Number.isFinite(item.price)
    && typeof item.quantity === 'number' && item.quantity > 0
    && ['XAUUSD', 'XAGUSD', 'BTCUSDT.P', 'US500', 'ETHUSD'].includes(item.symbol ?? '')
    && ['buy', 'sell'].includes(item.side ?? '') && ['limit', 'stop'].includes(item.type ?? '')
}

export function loadChartAlerts(): ChartAlert[] {
  if (typeof localStorage === 'undefined') return []
  return parseStoredArray(localStorage.getItem(CHART_ALERTS_STORAGE_KEY), isAlert)
}

export function saveChartAlerts(alerts: ChartAlert[]) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(CHART_ALERTS_STORAGE_KEY, JSON.stringify(alerts))
}

export function loadPaperOrders(): PaperOrder[] {
  if (typeof localStorage === 'undefined') return []
  return parseStoredArray(localStorage.getItem(PAPER_ORDERS_STORAGE_KEY), isOrder)
}

export function savePaperOrders(orders: PaperOrder[]) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(PAPER_ORDERS_STORAGE_KEY, JSON.stringify(orders))
}
