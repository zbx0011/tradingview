import type { Drawing } from './drawings'
import type { IntervalId, SymbolId } from './market'
import {
  DECISION_REPLAY_INTERVALS,
  type DecisionPositionSizingMode, type DecisionPracticeMode, type DecisionReplayInterval,
} from './decisionReplay'

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
  indicatorLegendExpanded?: boolean
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

export interface DecisionChartStatusPreferences {
  position: TradeMarkerPanelPosition | null
}

export interface DecisionReplayCenterPreferences {
  count: number
  selectedSymbols: SymbolId[]
  selectedIntervals: DecisionReplayInterval[]
  selectedModes: DecisionPositionSizingMode[]
  practiceMode: DecisionPracticeMode
  daySequenceScope: 'all-days' | 'loss-day'
  lossDaySizingMode: DecisionPositionSizingMode
}

export const STORAGE_KEY = 'kline-studio-workspace-v1'
export const INDICATOR_PROFILE_VERSION = 1 as const
export const TRADE_MARKER_PANEL_STORAGE_KEY = 'kline-studio-trade-marker-panel-v1'
export const DECISION_REPLAY_PANEL_STORAGE_KEY = 'kline-studio-decision-replay-panel-v1'
export const DECISION_REPLAY_MENU_STORAGE_KEY = 'kline-studio-decision-replay-menu-v1'
export const DECISION_CHART_STATUS_STORAGE_KEY = 'kline-studio-decision-chart-status-v1'
export const DECISION_REPLAY_CENTER_STORAGE_KEY = 'kline-studio-decision-replay-center-v1'
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
export const DEFAULT_DECISION_CHART_STATUS_PREFERENCES: DecisionChartStatusPreferences = {
  position: null,
}

const DECISION_REPLAY_SYMBOLS: readonly SymbolId[] = ['XAUUSD', 'XAGUSD', 'BTCUSDT.P', 'US500', 'ETHUSD']
const DECISION_REPLAY_POSITION_MODES: readonly DecisionPositionSizingMode[] = ['fixed-risk', 'fixed-notional']

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
      indicatorLegendExpanded: value.indicatorLegendExpanded !== false,
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

export function parseDecisionChartStatusPreferences(raw: string | null): DecisionChartStatusPreferences {
  if (!raw) return { ...DEFAULT_DECISION_CHART_STATUS_PREFERENCES }
  try {
    const value = JSON.parse(raw) as Partial<DecisionChartStatusPreferences>
    const position = value.position
      && Number.isFinite(value.position.left)
      && Number.isFinite(value.position.top)
      ? { left: value.position.left, top: value.position.top }
      : null
    return { position }
  } catch {
    return { ...DEFAULT_DECISION_CHART_STATUS_PREFERENCES }
  }
}

export function loadDecisionChartStatusPreferences(): DecisionChartStatusPreferences {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_DECISION_CHART_STATUS_PREFERENCES }
  return parseDecisionChartStatusPreferences(localStorage.getItem(DECISION_CHART_STATUS_STORAGE_KEY))
}

export function saveDecisionChartStatusPreferences(value: DecisionChartStatusPreferences) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(DECISION_CHART_STATUS_STORAGE_KEY, JSON.stringify(value))
}

export function parseDecisionReplayCenterPreferences(raw: string | null): DecisionReplayCenterPreferences | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Omit<Partial<DecisionReplayCenterPreferences>, 'daySequenceScope'> & {
      daySequenceScope?: DecisionReplayCenterPreferences['daySequenceScope'] | 'loss-week'
      lossWeekSizingMode?: DecisionPositionSizingMode
    }
    if (!Number.isFinite(value.count) || value.count! < 1 || !Array.isArray(value.selectedSymbols) || !Array.isArray(value.selectedModes)) return null
    if (value.selectedIntervals !== undefined && !Array.isArray(value.selectedIntervals)) return null
    const selectedSymbols = value.selectedSymbols.filter((symbol): symbol is SymbolId => DECISION_REPLAY_SYMBOLS.includes(symbol as SymbolId))
    const selectedIntervals = (value.selectedIntervals ?? ['5m']).filter((interval): interval is DecisionReplayInterval => DECISION_REPLAY_INTERVALS.includes(interval as DecisionReplayInterval))
    const selectedModes = value.selectedModes.filter((mode): mode is DecisionPositionSizingMode => DECISION_REPLAY_POSITION_MODES.includes(mode as DecisionPositionSizingMode))
    const practiceMode: DecisionPracticeMode = value.practiceMode === 'day-sequence' ? 'day-sequence' : 'random-count'
    const daySequenceScope = value.daySequenceScope === 'loss-day' || value.daySequenceScope === 'loss-week' ? 'loss-day' : 'all-days'
    const lossDaySizingMode: DecisionPositionSizingMode = value.lossDaySizingMode === 'fixed-notional' || value.lossWeekSizingMode === 'fixed-notional' ? 'fixed-notional' : 'fixed-risk'
    return {
      count: Math.floor(value.count!),
      selectedSymbols: [...new Set(selectedSymbols)],
      selectedIntervals: [...new Set(selectedIntervals)],
      selectedModes: [...new Set(selectedModes)],
      practiceMode,
      daySequenceScope,
      lossDaySizingMode,
    }
  } catch {
    return null
  }
}

export function loadDecisionReplayCenterPreferences(): DecisionReplayCenterPreferences | null {
  if (typeof localStorage === 'undefined') return null
  return parseDecisionReplayCenterPreferences(localStorage.getItem(DECISION_REPLAY_CENTER_STORAGE_KEY))
}

export function saveDecisionReplayCenterPreferences(value: DecisionReplayCenterPreferences) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(DECISION_REPLAY_CENTER_STORAGE_KEY, JSON.stringify(value))
}
