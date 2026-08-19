import type { Drawing } from './drawings'
import type { IntervalId, SymbolId } from './market'

export interface SavedWorkspace {
  symbol: SymbolId
  interval: IntervalId
  chartType: 'candles' | 'hollow' | 'line' | 'area'
  theme: 'dark' | 'light'
  priceScaleAuto?: boolean
  priceScaleLog?: boolean
  priceScalePercent?: boolean
  priceScaleInverted?: boolean
  indicatorProfileVersion?: 1
  indicators: { ma: boolean; ema: boolean; boll: boolean; volume: boolean; maPeriod: number; emaPeriod: number; bollPeriod: number; bollDeviation: number }
  drawings: Drawing[]
  /** Replay-range groups that were collapsed in the Object Tree. */
  collapsedReplayRangeLayerIds?: string[]
}

export type TradeMarkerFontSize = 'small' | 'medium' | 'large'

export interface TradeMarkerPanelPosition {
  left: number
  top: number
}

export interface TradeMarkerPanelSize {
  width: number
  height: number
}

export interface TradeMarkerPanelPreferences {
  position: TradeMarkerPanelPosition | null
  size: TradeMarkerPanelSize | null
  fontSize: TradeMarkerFontSize
}

export interface DecisionReplayPanelPreferences {
  position: TradeMarkerPanelPosition | null
  size: TradeMarkerPanelSize | null
}

export interface DecisionReplayMenuPreferences {
  position: TradeMarkerPanelPosition | null
}

export const STORAGE_KEY = 'kline-studio-workspace-v1'
export const INDICATOR_PROFILE_VERSION = 1 as const
export const TRADE_MARKER_PANEL_STORAGE_KEY = 'kline-studio-trade-marker-panel-v1'
export const DECISION_REPLAY_PANEL_STORAGE_KEY = 'kline-studio-decision-replay-panel-v1'
export const DECISION_REPLAY_MENU_STORAGE_KEY = 'kline-studio-decision-replay-menu-v1'
export const DEFAULT_TRADE_MARKER_PANEL_PREFERENCES: TradeMarkerPanelPreferences = {
  position: null,
  size: null,
  fontSize: 'medium',
}
export const DEFAULT_DECISION_REPLAY_PANEL_PREFERENCES: DecisionReplayPanelPreferences = {
  position: null,
  size: null,
}
export const DEFAULT_DECISION_REPLAY_MENU_PREFERENCES: DecisionReplayMenuPreferences = {
  position: null,
}

export function parseWorkspace(raw: string | null): SavedWorkspace | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<SavedWorkspace>
    if (!['XAUUSD', 'XAGUSD', 'BTCUSDT.P', 'US500', 'ETHUSD'].includes(value.symbol ?? '')) return null
    if (!['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w'].includes(value.interval ?? '')) return null
    if (!value.indicators || !Array.isArray(value.drawings)) return null
    const indicators = value.indicatorProfileVersion === INDICATOR_PROFILE_VERSION
      ? value.indicators
      : { ...value.indicators, ma: false, ema: true, emaPeriod: 20 }
    const collapsedReplayRangeLayerIds = Array.isArray(value.collapsedReplayRangeLayerIds)
      ? value.collapsedReplayRangeLayerIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : []
    return {
      ...value,
      indicatorProfileVersion: INDICATOR_PROFILE_VERSION,
      indicators,
      collapsedReplayRangeLayerIds,
      priceScaleAuto: value.priceScaleAuto !== false,
      priceScaleLog: value.priceScaleLog === true,
      priceScalePercent: value.priceScalePercent === true,
      priceScaleInverted: value.priceScaleInverted === true,
    } as SavedWorkspace
  } catch {
    return null
  }
}

export function loadWorkspace(): SavedWorkspace | null {
  if (typeof localStorage === 'undefined') return null
  return parseWorkspace(localStorage.getItem(STORAGE_KEY))
}

export function saveWorkspace(value: SavedWorkspace) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify({
    ...value,
    indicatorProfileVersion: INDICATOR_PROFILE_VERSION,
  }))
}

export function clearWorkspace() {
  if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY)
}

export function parseTradeMarkerPanelPreferences(raw: string | null): TradeMarkerPanelPreferences {
  if (!raw) return { ...DEFAULT_TRADE_MARKER_PANEL_PREFERENCES }
  try {
    const value = JSON.parse(raw) as Partial<TradeMarkerPanelPreferences>
    const fontSize = value.fontSize && ['small', 'medium', 'large'].includes(value.fontSize)
      ? value.fontSize
      : DEFAULT_TRADE_MARKER_PANEL_PREFERENCES.fontSize
    const position = value.position
      && Number.isFinite(value.position.left)
      && Number.isFinite(value.position.top)
      ? { left: value.position.left, top: value.position.top }
      : null
    const size = value.size
      && Number.isFinite(value.size.width)
      && Number.isFinite(value.size.height)
      && value.size.width > 0
      && value.size.height > 0
      ? { width: value.size.width, height: value.size.height }
      : null
    return { position, size, fontSize }
  } catch {
    return { ...DEFAULT_TRADE_MARKER_PANEL_PREFERENCES }
  }
}

export function loadTradeMarkerPanelPreferences(): TradeMarkerPanelPreferences {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_TRADE_MARKER_PANEL_PREFERENCES }
  return parseTradeMarkerPanelPreferences(localStorage.getItem(TRADE_MARKER_PANEL_STORAGE_KEY))
}

export function saveTradeMarkerPanelPreferences(value: TradeMarkerPanelPreferences) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(TRADE_MARKER_PANEL_STORAGE_KEY, JSON.stringify(value))
}

export function parseDecisionReplayPanelPreferences(raw: string | null): DecisionReplayPanelPreferences {
  if (!raw) return { ...DEFAULT_DECISION_REPLAY_PANEL_PREFERENCES }
  try {
    const value = JSON.parse(raw) as Partial<DecisionReplayPanelPreferences>
    const position = value.position
      && Number.isFinite(value.position.left)
      && Number.isFinite(value.position.top)
      ? { left: value.position.left, top: value.position.top }
      : null
    const size = value.size
      && Number.isFinite(value.size.width)
      && Number.isFinite(value.size.height)
      && value.size.width > 0
      && value.size.height > 0
      ? { width: value.size.width, height: value.size.height }
      : null
    return { position, size }
  } catch {
    return { ...DEFAULT_DECISION_REPLAY_PANEL_PREFERENCES }
  }
}

export function loadDecisionReplayPanelPreferences(): DecisionReplayPanelPreferences {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_DECISION_REPLAY_PANEL_PREFERENCES }
  return parseDecisionReplayPanelPreferences(localStorage.getItem(DECISION_REPLAY_PANEL_STORAGE_KEY))
}

export function saveDecisionReplayPanelPreferences(value: DecisionReplayPanelPreferences) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(DECISION_REPLAY_PANEL_STORAGE_KEY, JSON.stringify(value))
}

export function parseDecisionReplayMenuPreferences(raw: string | null): DecisionReplayMenuPreferences {
  if (!raw) return { ...DEFAULT_DECISION_REPLAY_MENU_PREFERENCES }
  try {
    const value = JSON.parse(raw) as Partial<DecisionReplayMenuPreferences>
    const position = value.position
      && Number.isFinite(value.position.left)
      && Number.isFinite(value.position.top)
      ? { left: value.position.left, top: value.position.top }
      : null
    return { position }
  } catch {
    return { ...DEFAULT_DECISION_REPLAY_MENU_PREFERENCES }
  }
}

export function loadDecisionReplayMenuPreferences(): DecisionReplayMenuPreferences {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_DECISION_REPLAY_MENU_PREFERENCES }
  return parseDecisionReplayMenuPreferences(localStorage.getItem(DECISION_REPLAY_MENU_STORAGE_KEY))
}

export function saveDecisionReplayMenuPreferences(value: DecisionReplayMenuPreferences) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(DECISION_REPLAY_MENU_STORAGE_KEY, JSON.stringify(value))
}
