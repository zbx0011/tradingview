import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  Activity, AlarmClock, AlarmClockPlus, AreaChart, BarChart3, Bell, CalendarDays, Camera, ChartCandlestick, ChevronsLeft,
  ChevronDown, CircleHelp, Database, Download, Grid2X2, History, Layers3, List, Lock, Maximize2, Moon,
  BrainCircuit, MessageSquare, PanelRightClose, Plus, Radio, Redo2, RefreshCcw, Rewind, Scissors, Search, Settings2, Square, Sun, Trash2, TrendingUp, Undo2, Upload, X,
} from 'lucide-react'
import { ChartSurface, type ChartSurfaceHandle, type IndicatorSettings } from './components/ChartSurface'
import { AlertDialog, DataTableDialog, ObjectTreeDialog, OrderDialog } from './components/ChartActionDialogs'
import { IndicatorLegend } from './components/IndicatorLegend'
import { ChartContextMenu, type ChartContextData } from './components/TradingViewContextMenu'
import { DrawingOverlay } from './components/DrawingOverlay'
import { DrawingToolbar, type MagnetMode } from './components/DrawingToolbar'
import { QuickDrawingToolbar } from './components/QuickDrawingToolbar'
import { FibSettingsDialog } from './components/FibSettingsDialog'
import { ReplayToolbar, type ReplayStartMode } from './components/ReplayToolbar'
import {
  DecisionChartAnnotations, DecisionChartStatus, DecisionHistoryDialog, DecisionPricePicker, DecisionReplayCenter, DecisionReplayPanel, DecisionResultsDialog,
  DecisionRiskOverlay,
} from './components/DecisionReplay'
import type { DecisionSymbolStats } from './components/DecisionReplay'
import { drawingReducer, duplicateDrawing, hitTestDrawing, initialDrawingHistory, moveDrawing, withoutTransientMeasurements, type Drawing } from './lib/drawings'
import {
  clampContextMenuPosition, countActiveIndicators, loadChartAlerts, loadPaperOrders, saveChartAlerts, savePaperOrders,
  type ChartAlert, type PaperOrder,
} from './lib/chartContext'
import { ALL_DRAWING_TOOLS, getTool, shouldExitDrawingMode } from './lib/toolCatalog'
import { clearWorkspace, loadWorkspace, saveWorkspace } from './lib/persistence'
import { decisionExerciseNavigationDirection, isChartAnnotationVisibilityShortcut, isEditableShortcutTarget, parseIntervalShortcut, resolveHistoryShortcut, TRADINGVIEW_SHORTCUTS } from './lib/shortcuts'
import { aggregateCandles, formatPrice, generateCandles, INTERVALS, SYMBOLS, type Candle, type IntervalId, type SymbolId } from './lib/market'
import {
  getDecisionReplayCandles, getSnapshotStatus, loadSnapshotCandles, mergeCandleHistory,
  type MarketDataStatus,
} from './lib/liveMarket'
import {
  advanceReplayTime, nearestReplayTime, replayCandles, replayResolutions,
  replaySpeed, saveReplaySession,
} from './lib/replay'
import {
  loadWeeklyMergedReplayTradeLayers, saveWeeklyMergedReplayTradeLayers, WEEKLY_MERGED_REPLAY_SUFFIX,
  type ReplayTradeLayer,
} from './lib/replayTradeLayers'
import { deleteReplayRangeObjectFromLayers, loadReplayRangeLayers, saveReplayRangeLayers, toggleReplayRangeObjectInLayers, type ReplayRangeLayer } from './lib/replayRangeLayers'
import { loadFavoriteTools, saveFavoriteTools, toggleFavoriteTool } from './lib/favoriteTools'
import {
  DECISION_REPLAY_FAVORITES_STORAGE_KEY, decisionReplayFavoriteKey, loadDecisionReplayFavorites,
  parseDecisionReplayFavoritesChecked, saveDecisionReplayFavorites, toggleDecisionReplayFavorite,
} from './lib/decisionReplayFavorites'
import { collectPortableWorkspace, downloadPortableWorkspace, loadPortableWorkspaceRecovery, parsePortableWorkspace, restorePortableWorkspaceRecovery, restorePortableWorkspaceSafely } from './lib/portableWorkspace'
import { decisionHistoryWorkspace, mergePortableWorkspaceProgress, receivePortableWorkspaceSnapshotsSafely } from './lib/workspaceProgressSync'
import {
  LocalSyncConflictError, localPrivateSyncAvailable,
  prepareLocalPrivateSync, publishLocalPrivateSync, receiveLocalPrivateSync, runWithLocalPrivateSyncLock,
  sha256PortableWorkspace, type LocalSyncScope,
} from './lib/localPrivateSync'
import {
  LocalCodeDeployUnavailableError, loadLocalCodeDeployActivity, loadLocalCodeStatus, publishLocalCode,
  saveLocalCodeDeployActivity, updateLocalCode, type LocalCodeDeployActivity, type LocalCodeStatus,
} from './lib/localCodeDeploy'
import { latestReplayDecisionSignal, replayDecisionCandidates, replayDecisionContextSourceIds, replayTradeDatasetInfos, type ReplayDecisionCandidate } from './lib/replayTradeRegistry'
import { createDecisionAnomalyReviewSession, findDecisionReplayAnomalies } from './lib/decisionReplayAnomalies'
import {
  DECISION_REPLAY_INTERVALS, DECISION_REPLAY_STORAGE_KEY, adjacentDecisionExerciseTarget, adjustDecisionPendingEntry, advanceDecisionAttempt, buildDecisionResult, cancelPendingOrderAndAdvance, candleAtOrBefore, candlesKnownAt, createDecisionAttempt,
  createDecisionReviewSession, createDecisionSession, currentDecisionAttempt, currentDecisionCandidate, decisionExtremeEntryPrice, decisionShortcutAction, defaultDecisionLevels,
  decisionAiDaySummaries, decisionAttemptInitialStopLoss, decisionAttemptSide, decisionDayHistoryIsComplete, decisionSessionPracticeMode, decisionStopLossMode, decisionSessionPositionSizingModes, decisionSystemCandidatesForDay, emptyDecisionReplayStore, filterDecisionCandidatesByScope, filterDecisionCandidatesByTradingDay, formatDecisionDay, historyCoversDecisionCandidate, intervalCutoffTime, intervalSeconds,
  canFinishDecisionSessionAtMarketEnd, finishDecisionSessionAtMarketEnd, latestResumableDecisionDaySession, loadDecisionReplayStore, mergeDecisionReplayStores, nextCandleAfter, normalizeDecisionPositionMultiplier, normalizeDecisionReplayStore, parseDecisionReplayStoreChecked, pnlForDecisionMode, recentDecisionStructureStop, restartPostExitDecisionAttempt, revealedDecisionSystemTrades, sampleDecisionCandidates, sampleDecisionDayCandidates, startNextDaySequenceTrade,
  saveDecisionReplayStoreSnapshot, sessionResults, updateDecisionSessionDrawings, validDecisionLevels, validOpenPositionLevels,
  type DecisionAttempt, type DecisionExit, type DecisionPositionMultiplier, type DecisionPositionSizingMode, type DecisionPracticeMode, type DecisionReplayInterval, type DecisionReplaySession, type DecisionStopLossMode, type DecisionTradeResult,
} from './lib/decisionReplay'

type ChartType = 'candles' | 'hollow' | 'line' | 'area'
type Theme = 'dark' | 'light'
type PrivateSyncStatus = 'checking' | 'ready' | 'syncing' | 'synced' | 'received' | 'unavailable' | 'error'
type PrivateSyncOperation = 'sync' | 'receive' | 'history-sync' | 'history-receive' | null
type CodeDeployPhase = 'checking' | 'ready' | 'publishing' | 'published' | 'updating' | 'unavailable' | 'status-error' | 'error'

const DEFAULT_INDICATORS: IndicatorSettings = {
  ma: false, ema: true, boll: false, volume: true,
  maPeriod: 20, emaPeriod: 20, bollPeriod: 20, bollDeviation: 2,
}
const DEFAULT_INTERVAL: IntervalId = '5m'

function workspaceBackupFileName(kind: 'sync' | 'before-merge' | 'before-import' | 'before-undo') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')
  return `kline-studio-${kind}-${timestamp}.json`
}

function formatCodeDeployTime(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return '暂无记录'
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
}

const CHART_TYPES: { id: ChartType; label: string; icon: typeof ChartCandlestick }[] = [
  { id: 'candles', label: 'K 线', icon: ChartCandlestick },
  { id: 'hollow', label: '空心 K', icon: ChartCandlestick },
  { id: 'line', label: '折线', icon: TrendingUp },
  { id: 'area', label: '面积', icon: AreaChart },
]

interface QuickSearchItem {
  id: string
  label: string
  detail: string
  shortcut?: string
  toolId?: string
}

function IconButton({ label, active, disabled, onClick, children, className = '' }: {
  label: string; active?: boolean; disabled?: boolean; onClick?: () => void; children: React.ReactNode; className?: string
}) {
  return <button type="button" className={`icon-button ${active ? 'active' : ''} ${className}`} title={label} aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}>{children}</button>
}

async function copyTextToClipboard(text: string) {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the legacy copy path used by embedded desktop browsers.
  }
  const input = document.createElement('textarea')
  input.value = text
  input.setAttribute('readonly', '')
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.appendChild(input)
  input.select()
  const copied = document.execCommand('copy')
  input.remove()
  return copied
}

function App() {
  const saved = useMemo(() => loadWorkspace(), [])
  const initialSymbol = saved?.symbol ?? 'XAUUSD'
  // 1 分钟是旧版本的默认值；迁移到 5 分钟，同时继续保留用户明确保存的其它周期。
  const initialInterval: IntervalId = saved?.interval && saved.interval !== '1m' ? saved.interval : DEFAULT_INTERVAL
  const [symbol, setSymbol] = useState<SymbolId>(initialSymbol)
  const [interval, setIntervalId] = useState<IntervalId>(initialInterval)
  const [chartType, setChartType] = useState<ChartType>(saved?.chartType ?? 'candles')
  const [theme, setTheme] = useState<Theme>(saved?.theme ?? 'dark')
  const [priceScaleAuto, setPriceScaleAuto] = useState(saved?.priceScaleAuto ?? true)
  const [priceScaleLog, setPriceScaleLog] = useState(saved?.priceScaleLog ?? false)
  const [priceScalePercent, setPriceScalePercent] = useState(saved?.priceScalePercent ?? false)
  const [priceScaleInverted, setPriceScaleInverted] = useState(saved?.priceScaleInverted ?? false)
  const [indicators, setIndicators] = useState<IndicatorSettings>(saved?.indicators ?? DEFAULT_INDICATORS)
  const [indicatorLegendExpanded, setIndicatorLegendExpanded] = useState(saved?.indicatorLegendExpanded ?? true)
  const [drawings, dispatchDrawing] = useReducer(drawingReducer, { ...initialDrawingHistory, present: withoutTransientMeasurements(saved?.drawings ?? []) })
  const [decisionDrawings, dispatchDecisionDrawing] = useReducer(drawingReducer, initialDrawingHistory)
  const [activeTool, setActiveTool] = useState('cursor')
  const [drawingColor, setDrawingColor] = useState('#9abfff')
  const [magnetMode, setMagnetMode] = useState<MagnetMode>('off')
  const [keepDrawing, setKeepDrawing] = useState(false)
  const [shiftMeasureActive, setShiftMeasureActive] = useState(false)
  const [quickMeasurement, setQuickMeasurement] = useState<Drawing | null>(null)
  const shiftMeasureActiveRef = useRef(false)
  const [drawingProjectionTick, refreshDrawingProjection] = useReducer((value: number) => value + 1, 0)
  const [drawingsLocked, setDrawingsLocked] = useState(false)
  const [drawingsHidden, setDrawingsHidden] = useState(false)
  const [indicatorsHidden, setIndicatorsHidden] = useState(false)
  const [syncDrawings, setSyncDrawings] = useState(false)
  const [hoverCandle, setHoverCandle] = useState<Candle | null>(null)
  const [chartAnnotationsHidden, setChartAnnotationsHidden] = useState(false)
  const [symbolPickerOpen, setSymbolPickerOpen] = useState(false)
  const [symbolQuery, setSymbolQuery] = useState('')
  const [indicatorPanelOpen, setIndicatorPanelOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [watchlistOpen, setWatchlistOpen] = useState(false)
  const [chartMenuOpen, setChartMenuOpen] = useState(false)
  const [quickSearchOpen, setQuickSearchOpen] = useState(false)
  const [quickSearchQuery, setQuickSearchQuery] = useState('')
  const [intervalDialogOpen, setIntervalDialogOpen] = useState(false)
  const [intervalDraft, setIntervalDraft] = useState('')
  const [goToDateOpen, setGoToDateOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [drawingSettingsId, setDrawingSettingsId] = useState<string | null>(null)
  const [chartContext, setChartContext] = useState<ChartContextData | null>(null)
  const [alertDraft, setAlertDraft] = useState<{ price: number } | null>(null)
  const [orderDraft, setOrderDraft] = useState<{ price: number; side: PaperOrder['side']; type: PaperOrder['type'] } | null>(null)
  const [dataTableOpen, setDataTableOpen] = useState(false)
  const [objectTreeOpen, setObjectTreeOpen] = useState(false)
  const [collapsedReplayRangeLayerIds, setCollapsedReplayRangeLayerIds] = useState<string[]>(saved?.collapsedReplayRangeLayerIds ?? [])
  const [lockedCursorTime, setLockedCursorTime] = useState<number | null>(null)
  const [chartAlerts, setChartAlerts] = useState<ChartAlert[]>(loadChartAlerts)
  const [paperOrders, setPaperOrders] = useState<PaperOrder[]>(loadPaperOrders)
  const [replayTradeLayers, setReplayTradeLayers] = useState<ReplayTradeLayer[]>(loadWeeklyMergedReplayTradeLayers)
  const [replayRangeLayers, setReplayRangeLayers] = useState<ReplayRangeLayer[]>(loadReplayRangeLayers)
  const [selectedReplayRangeId, setSelectedReplayRangeId] = useState<string | null>(null)
  const [drawingClipboardAvailable, setDrawingClipboardAvailable] = useState(false)
  const [favoriteTools, setFavoriteTools] = useState<string[]>(loadFavoriteTools)
  const [contextOverlayPositions, setContextOverlayPositions] = useState<{
    lockedCursorX: number | null
    alertY: Record<string, number | null>
    orderY: Record<string, number | null>
  }>({ lockedCursorX: null, alertY: {}, orderY: {} })
  const [live, setLive] = useState(false)
  const [liveTick, setLiveTick] = useState(0)
  const [replayPanelOpen, setReplayPanelOpen] = useState(false)
  const [replaySelecting, setReplaySelecting] = useState(false)
  const [replayCursor, setReplayCursor] = useState<number | null>(null)
  const [replayPlaying, setReplayPlaying] = useState(false)
  const [replaySpeedValue, setReplaySpeedValue] = useState(10)
  const [replayResolutionSeconds, setReplayResolutionSeconds] = useState(INTERVALS[initialInterval].seconds)
  const [replayAutoResolution, setReplayAutoResolution] = useState(true)
  const [replayStartMode, setReplayStartMode] = useState<ReplayStartMode>('bar')
  const [replayPointer, setReplayPointer] = useState<{ x: number; time: number } | null>(null)
  const [clock, setClock] = useState(() => new Date())
  const [toast, setToast] = useState('')
  const [privateSyncBusy, setPrivateSyncBusy] = useState(false)
  const [privateSyncStatus, setPrivateSyncStatus] = useState<PrivateSyncStatus>('checking')
  const [privateSyncOperation, setPrivateSyncOperation] = useState<PrivateSyncOperation>(null)
  const [codeDeployPhase, setCodeDeployPhase] = useState<CodeDeployPhase>('checking')
  const [codeDeployStatus, setCodeDeployStatus] = useState<LocalCodeStatus | null>(null)
  const [codeDeployError, setCodeDeployError] = useState('')
  const [codeDeployActivity, setCodeDeployActivity] = useState<LocalCodeDeployActivity>(loadLocalCodeDeployActivity)
  const codeDeployStatusInFlightRef = useRef(false)
  const [remoteMarket, setRemoteMarket] = useState<{ symbol: SymbolId; bars: Candle[]; status: MarketDataStatus } | null>(null)
  const [decisionHistoryBySymbol, setDecisionHistoryBySymbol] = useState<Partial<Record<SymbolId, Candle[]>>>({})
  const [marketLoading, setMarketLoading] = useState<{ symbol: SymbolId; label: string } | null>(null)
  const [marketRefreshTick, setMarketRefreshTick] = useState(0)
  const [marketHydrationKey, setMarketHydrationKey] = useState(0)
  const [decisionStore, setDecisionStore] = useState(loadDecisionReplayStore)
  const [decisionFavoriteKeys, setDecisionFavoriteKeys] = useState(loadDecisionReplayFavorites)
  const [decisionCenterOpen, setDecisionCenterOpen] = useState(false)
  const [decisionHistoryOpen, setDecisionHistoryOpen] = useState(false)
  const [decisionResultsSessionId, setDecisionResultsSessionId] = useState<string | null>(null)
  // When an old result is redone, keep the official active exercise resumable
  // underneath the independent review session.
  const [decisionReviewReturnSessionId, setDecisionReviewReturnSessionId] = useState<string | null>(null)
  const [decisionFocusTick, setDecisionFocusTick] = useState(0)
  const [decisionPriceDraft, setDecisionPriceDraft] = useState<number | null>(null)
  const [decisionRiskDraft, setDecisionRiskDraft] = useState<{ stopLoss: number; takeProfit: number } | null>(null)
  const [decisionCurrentCandleX, setDecisionCurrentCandleX] = useState<number | null>(null)
  const decisionDrawingContextRef = useRef<string | null>(null)
  const decisionDrawingLoadingRef = useRef(false)
  const decisionStoreRef = useRef(decisionStore)
  const decisionPersistTimerRef = useRef<number | null>(null)
  const decisionSessionStartLockRef = useRef(false)
  const decisionFavoriteKeysRef = useRef(decisionFavoriteKeys)
  const privateSyncInFlightRef = useRef(false)
  const chartRef = useRef<ChartSurfaceHandle>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const drawingClipboardRef = useRef<Drawing | null>(null)

  // Loading/import/sync already canonicalize the store. Re-normalizing all
  // historical sessions on every candle advance blocked Edge's main thread.
  const normalizedDecisionStore = decisionStore

  const activeDecisionSession = useMemo(() => normalizedDecisionStore.activeSessionId
    ? normalizedDecisionStore.sessions.find((session) => session.id === normalizedDecisionStore.activeSessionId && session.status === 'active') ?? null
    : null, [normalizedDecisionStore])
  const activeDecisionCandidate = currentDecisionCandidate(activeDecisionSession)
  const activeDecisionAttempt = currentDecisionAttempt(activeDecisionSession)
  const activeDecisionDaySequence = decisionSessionPracticeMode(activeDecisionSession) === 'day-sequence'
    ? activeDecisionSession?.daySequence ?? null
    : null
  const decisionDayMode = activeDecisionDaySequence !== null
  const activeDecisionHistoricalResults = useMemo(() => {
    if (!activeDecisionSession || !decisionDayMode) return []
    // Use the same settled-result source as the PnL summary. Candidate arrays
    // can be reordered or repaired after persistence, so slicing candidates
    // could report nine settled trades below while drawing none of them here.
    // Do not filter by candidate key: legacy/sync-repaired attempts can retain a
    // duplicate key even though their immutable result contains a different
    // execution. Drawing the current result twice is visually harmless, while
    // filtering it can erase every historical user path.
    return sessionResults(activeDecisionSession)
  }, [activeDecisionSession, decisionDayMode])
  const decisionSignalReached = Boolean(activeDecisionCandidate && activeDecisionAttempt && (
    !decisionDayMode || activeDecisionAttempt.cursorTime >= activeDecisionCandidate.trade.entry.signalTime
  ))
  const decisionDayModeRef = useRef(decisionDayMode)
  useEffect(() => {
    decisionDayModeRef.current = decisionDayMode
  }, [decisionDayMode])
  const activeDecisionPositionSizingModes = decisionSessionPositionSizingModes(activeDecisionSession)
  const decisionResultsSession = useMemo(() => decisionResultsSessionId
    ? normalizedDecisionStore.sessions.find((session) => session.id === decisionResultsSessionId) ?? null
    : null, [decisionResultsSessionId, normalizedDecisionStore])
  const decisionResultsSystemCandidates = useMemo(() => {
    if (!decisionResultsSession?.daySequence || decisionSessionPracticeMode(decisionResultsSession) !== 'day-sequence') return null
    const sourceIds = [...new Set(decisionResultsSession.candidates
      .filter((candidate) => candidate.manualContinuation !== true)
      .map((candidate) => candidate.sourceId))]
    const completeSourcePool = replayDecisionCandidates(sourceIds)
    return decisionSystemCandidatesForDay(
      completeSourcePool.length > 0 ? completeSourcePool : decisionResultsSession.candidates,
      decisionResultsSession.daySequence,
    )
  }, [decisionResultsSession])
  const decisionMode = Boolean(activeDecisionCandidate)
  const uiDrawings = decisionMode ? decisionDrawings : drawings
  const dispatchUiDrawing = decisionMode ? dispatchDecisionDrawing : dispatchDrawing
  const symbolInfo = SYMBOLS.find((item) => item.id === symbol) ?? SYMBOLS[0]
  const effectiveDrawingTool = activeTool === 'cursor' && shiftMeasureActive ? 'measure' : activeTool
  const activeDefinition = getTool(effectiveDrawingTool)
  const selectedDrawing = uiDrawings.present.find((item) => item.id === uiDrawings.selectedId)
  const drawingSettingsTarget = uiDrawings.present.find((item) => item.id === drawingSettingsId) ?? null
  const selectedDrawingIds = useMemo(
    () => uiDrawings.selectedIds ?? (uiDrawings.selectedId ? [uiDrawings.selectedId] : []),
    [uiDrawings.selectedId, uiDrawings.selectedIds],
  )
  const quickSearchItems = useMemo<QuickSearchItem[]>(() => [
    { id: 'symbol', label: '更改商品', detail: '搜索 XAUUSD、BTCUSDT.P 或 ETHUSD', shortcut: '直接输入' },
    { id: 'interval', label: '更改周期', detail: '输入分钟、小时、日或周周期', shortcut: '数字 / ,' },
    { id: 'indicators', label: '技术指标', detail: '打开指标面板', shortcut: '/' },
    { id: 'settings', label: '图表设置', detail: '外观、坐标与工作区设置' },
    { id: 'go-date', label: '转到日期', detail: '将当前视图居中到指定时间', shortcut: 'Alt+G' },
    { id: 'replay', label: 'K 线回放', detail: '选择一根 K 线作为回放起点' },
    { id: 'snapshot', label: '图表快照', detail: '下载快照并复制当前地址', shortcut: 'Alt+S' },
    { id: 'reset-chart', label: '重置图表', detail: '适应全部可用数据', shortcut: 'Alt+R' },
    { id: 'toggle-drawings', label: '隐藏/显示全部绘图', detail: '切换绘图对象可见性', shortcut: 'Ctrl+Alt+H' },
    { id: 'shortcut-help', label: '键盘快捷键', detail: '查看 TradingView 快捷键清单', shortcut: 'Ctrl+/' },
    ...ALL_DRAWING_TOOLS.map((tool) => ({ id: `tool-${tool.id}`, label: tool.label, detail: `${tool.section} · ${tool.description}`, shortcut: tool.shortcut, toolId: tool.id })),
  ], [])
  const visibleIndicators = useMemo(() => indicatorsHidden ? { ...indicators, ma: false, ema: false, boll: false, volume: false } : indicators, [indicators, indicatorsHidden])
  const minuteHistory = useMemo(() => remoteMarket?.symbol === symbol ? remoteMarket.bars : decisionHistoryBySymbol[symbol] ?? null, [decisionHistoryBySymbol, remoteMarket, symbol])
  const availableDecisionHistoryBySymbol = useMemo(() => {
    const histories = { ...decisionHistoryBySymbol }
    if (remoteMarket?.bars.length && decisionHistoryBySymbol[remoteMarket.symbol] !== remoteMarket.bars) {
      histories[remoteMarket.symbol] = mergeCandleHistory([decisionHistoryBySymbol[remoteMarket.symbol] ?? [], remoteMarket.bars])
    }
    const oandaXagusdBars = getDecisionReplayCandles('XAGUSD')
    if (oandaXagusdBars?.length) histories.XAGUSD = oandaXagusdBars
    return histories
  }, [decisionHistoryBySymbol, remoteMarket])
  const marketStatus = decisionMode && symbol === 'XAGUSD'
    ? { kind: 'snapshot', label: 'OANDA 最新', vendor: 'OANDA', fetchedAt: null, detail: 'OANDA:XAGUSD · 决策回放冻结 5 分钟数据' } satisfies MarketDataStatus
    : remoteMarket?.symbol === symbol ? remoteMarket.status : getSnapshotStatus(symbol)
  const marketStatusLabel = marketLoading?.symbol === symbol ? marketLoading.label : marketStatus.label
  const baseData = useMemo(() => {
    if (minuteHistory?.length) return interval === '1m' ? minuteHistory : aggregateCandles(minuteHistory, INTERVALS[interval].seconds)
    return generateCandles(symbol, interval, 1800)
  }, [interval, minuteHistory, symbol])
  const decisionSubject = activeDecisionCandidate
  const decisionMinuteHistory = useMemo(() => {
    if (!decisionSubject) return null
    return availableDecisionHistoryBySymbol[decisionSubject.symbol] ?? null
  }, [availableDecisionHistoryBySymbol, decisionSubject])
  const decisionSourceData = useMemo(() => {
    if (!decisionSubject || !decisionMinuteHistory?.length) return []
    const seconds = intervalSeconds(decisionSubject.interval)
    const sourceData = seconds === 60 ? decisionMinuteHistory : aggregateCandles(decisionMinuteHistory, seconds)
    if (!activeDecisionDaySequence) return sourceData
    return sourceData.filter((candle) => (
      candle.time >= activeDecisionDaySequence.startTime
      && candle.time < activeDecisionDaySequence.endTime
    ))
  }, [activeDecisionDaySequence, decisionMinuteHistory, decisionSubject])
  const decisionRiskFallback = useMemo(() => {
    const pendingEntryPrice = activeDecisionAttempt?.stage === 'risk-setup' ? activeDecisionAttempt.pendingEntryPrice : null
    if (!activeDecisionCandidate || pendingEntryPrice === null) return null
    const side = activeDecisionAttempt ? decisionAttemptSide(activeDecisionCandidate, activeDecisionAttempt) : activeDecisionCandidate.trade.side
    const suggestedStop = activeDecisionAttempt?.userSide
      ? recentDecisionStructureStop(side, pendingEntryPrice, decisionSourceData, activeDecisionAttempt.cursorTime)
      : activeDecisionCandidate.trade.entry.stopLoss
    return defaultDecisionLevels(side, pendingEntryPrice, suggestedStop)
  }, [activeDecisionAttempt, activeDecisionCandidate, decisionSourceData])
  // The draft is transient, so fall back to the active attempt's causal setup
  // after a refresh or hot update while keeping any edits in local state.
  const effectiveDecisionRiskDraft = decisionRiskDraft ?? decisionRiskFallback
  const isMarketHistory = marketStatus.kind !== 'simulated'
  const liveData = useMemo(() => {
    if (isMarketHistory) return baseData
    if (!live || liveTick === 0) return baseData
    const next = baseData.map((item) => ({ ...item }))
    const last = next.at(-1)!
    const change = Math.sin(liveTick * 0.83) * symbolInfo.volatility * last.open * 0.75
    last.close = Math.max(0.01, last.open + change)
    last.high = Math.max(last.high, last.close)
    last.low = Math.min(last.low, last.close)
    last.volume += liveTick * 7
    return next
  }, [baseData, isMarketHistory, live, liveTick, symbolInfo.volatility])
  const chartSeconds = INTERVALS[interval].seconds
  const availableReplayResolutions = useMemo(() => replayResolutions(interval), [interval])
  const effectiveReplayResolution = replayAutoResolution || !availableReplayResolutions.some((item) => item.seconds === replayResolutionSeconds)
    ? chartSeconds
    : replayResolutionSeconds
  const normalizedReplayCursor = replayCursor === null ? null : Math.min(baseData.at(-1)!.time + chartSeconds, Math.max(baseData[0].time, replayCursor))
  const decisionCutoff = useMemo(() => {
    return activeDecisionAttempt && activeDecisionCandidate
      ? intervalCutoffTime(activeDecisionAttempt.cursorTime, intervalSeconds(activeDecisionCandidate.interval))
      : null
  }, [activeDecisionAttempt, activeDecisionCandidate])
  const decisionData = useMemo(() => {
    if (!decisionSubject || !decisionMinuteHistory?.length || decisionCutoff === null) return []
    // Day-sequence playback starts its cursor at the session open, but the
    // chart keeps the same pre-signal history context as ordinary decision
    // replay. Session bounds still govern advancing via decisionSourceData.
    const knownMinutes = candlesKnownAt(decisionMinuteHistory, decisionCutoff)
    return interval === '1m' ? knownMinutes : aggregateCandles(knownMinutes, INTERVALS[interval].seconds)
  }, [decisionCutoff, decisionMinuteHistory, decisionSubject, interval])
  const data = useMemo(() => decisionMode
    ? decisionData
    : replaySelecting ? baseData : (normalizedReplayCursor === null ? liveData : replayCandles(baseData, normalizedReplayCursor, chartSeconds)),
  [baseData, chartSeconds, decisionData, decisionMode, liveData, normalizedReplayCursor, replaySelecting])
  const replayAtEnd = normalizedReplayCursor !== null && normalizedReplayCursor >= baseData.at(-1)!.time + chartSeconds
  const candle = hoverCandle ?? data.at(-1) ?? baseData.at(-1)!
  const decisionCurrentCandle = decisionMode ? data.at(-1) ?? null : null
  const decisionPositionCandle = activeDecisionAttempt?.stage === 'position-open' ? data.at(-1) ?? null : null
  const activeDecisionUserSide = activeDecisionCandidate && activeDecisionAttempt
    ? decisionAttemptSide(activeDecisionCandidate, activeDecisionAttempt)
    : null
  const activeDecisionPositionMultiplier = normalizeDecisionPositionMultiplier(activeDecisionAttempt?.positionMultiplier)
  const decisionPositionPnlByMode = activeDecisionUserSide && activeDecisionCandidate && activeDecisionAttempt?.stage === 'position-open' && activeDecisionAttempt.fill && activeDecisionAttempt.stopLoss !== null && decisionPositionCandle
    ? {
        'fixed-risk': pnlForDecisionMode('fixed-risk', activeDecisionUserSide, activeDecisionAttempt.fill.price, decisionPositionCandle.close, decisionAttemptInitialStopLoss(activeDecisionCandidate, activeDecisionAttempt) ?? activeDecisionAttempt.stopLoss, activeDecisionPositionMultiplier),
        'fixed-notional': pnlForDecisionMode('fixed-notional', activeDecisionUserSide, activeDecisionAttempt.fill.price, decisionPositionCandle.close, activeDecisionAttempt.stopLoss, activeDecisionPositionMultiplier),
      }
    : null
  // The system trade is also causal: once its entry candle is visible, show
  // its mark-to-market PnL from the currently revealed close. Once the candle
  // containing the system exit is visible, lock to the immutable exit result
  // instead of continuing to mark the already-closed trade to later candles.
  const decisionSystemCurrentCandle = activeDecisionAttempt?.stage !== 'complete' ? data.at(-1) ?? null : null
  const decisionSystemRevealedThrough = decisionSystemCurrentCandle
    ? decisionSystemCurrentCandle.time + intervalSeconds(activeDecisionCandidate?.interval ?? interval) - 1
    : Number.NEGATIVE_INFINITY
  const decisionSystemEntryVisible = Boolean(
    activeDecisionCandidate
    && decisionSystemCurrentCandle
    && activeDecisionCandidate.trade.entry.time <= decisionSystemRevealedThrough,
  )
  const decisionSystemPnlLocked = Boolean(
    activeDecisionCandidate
    && decisionSystemEntryVisible
    && activeDecisionCandidate.trade.exit.time <= decisionSystemRevealedThrough,
  )
  const decisionSystemPnlByMode = activeDecisionCandidate && decisionSystemCurrentCandle && decisionSystemEntryVisible
    ? {
        'fixed-risk': decisionSystemPnlLocked
          ? activeDecisionCandidate.trade.result.pnlUsd
          : pnlForDecisionMode('fixed-risk', activeDecisionCandidate.trade.side, activeDecisionCandidate.trade.entry.price, decisionSystemCurrentCandle.close, activeDecisionCandidate.trade.entry.stopLoss),
        'fixed-notional': pnlForDecisionMode(
          'fixed-notional',
          activeDecisionCandidate.trade.side,
          activeDecisionCandidate.trade.entry.price,
          decisionSystemPnlLocked ? activeDecisionCandidate.trade.exit.price : decisionSystemCurrentCandle.close,
          activeDecisionCandidate.trade.entry.stopLoss,
        ),
      }
    : null
  const decisionDayTradeSourceIds = useMemo(() => decisionDayMode && activeDecisionSession
    ? [...new Set(activeDecisionSession.candidates
        .filter((candidate) => candidate.manualContinuation !== true)
        .map((candidate) => candidate.sourceId))]
    : [], [activeDecisionSession, decisionDayMode])
  const decisionDaySystemCandidates = useMemo(() => {
    if (!activeDecisionDaySequence) return []
    const completeSourcePool = replayDecisionCandidates(decisionDayTradeSourceIds)
    return decisionSystemCandidatesForDay(
      completeSourcePool.length > 0 ? completeSourcePool : activeDecisionSession?.candidates ?? [],
      activeDecisionDaySequence,
    )
  }, [activeDecisionDaySequence, activeDecisionSession, decisionDayTradeSourceIds])
  const decisionSystemTrades = useMemo(() => {
    if (!decisionDayMode || !activeDecisionSession || !decisionSystemCurrentCandle) return null
    return revealedDecisionSystemTrades(
      decisionDaySystemCandidates,
      decisionSystemRevealedThrough,
      decisionSystemCurrentCandle.close,
    )
  }, [activeDecisionSession, decisionDayMode, decisionDaySystemCandidates, decisionSystemCurrentCandle, decisionSystemRevealedThrough])
  const change = candle.close - candle.open
  const changePercent = (change / candle.open) * 100
  const activeIndicatorCount = countActiveIndicators(indicators)
  const visibleTradeLayerSourceIds = useMemo(
    () => replayTradeLayers.filter((layer) => layer.symbol === symbol && layer.interval === interval && layer.visible).map((layer) => layer.sourceId),
    [interval, replayTradeLayers, symbol],
  )
  const weeklyDecisionSourceIds = useMemo(
    () => replayTradeDatasetInfos()
      .filter((source) => source.name.endsWith(WEEKLY_MERGED_REPLAY_SUFFIX))
      .map((source) => source.sourceId),
    [],
  )
  const registeredDecisionCandidates = useMemo(() => replayDecisionCandidates(weeklyDecisionSourceIds), [weeklyDecisionSourceIds])
  const allDecisionCandidates = useMemo(() => registeredDecisionCandidates.filter((candidate) => (
    historyCoversDecisionCandidate(candidate, availableDecisionHistoryBySymbol[candidate.symbol])
  )), [availableDecisionHistoryBySymbol, registeredDecisionCandidates])
  const decisionAiDaySummariesByMode = useMemo(() => ({
    'fixed-risk': decisionAiDaySummaries(registeredDecisionCandidates, 'fixed-risk'),
    'fixed-notional': decisionAiDaySummaries(registeredDecisionCandidates, 'fixed-notional'),
  }), [registeredDecisionCandidates])
  const decisionContextSourceIds = useMemo(() => {
    if (!decisionMode || !activeDecisionCandidate) return []
    if (!decisionDayMode) return [activeDecisionCandidate.sourceId]
    // Day playback can show candles from before the selected market session.
    // Keep their already-known annotations too, even when those candles belong
    // to an adjacent replay file. Marker generation still clips at the cursor.
    return replayDecisionContextSourceIds(
      allDecisionCandidates,
      activeDecisionCandidate.symbol,
      activeDecisionCandidate.interval,
    )
  }, [activeDecisionCandidate, allDecisionCandidates, decisionDayMode, decisionMode])
  const decisionSignalSourceIds = useMemo(() => {
    if (!decisionMode || !activeDecisionCandidate || !activeDecisionAttempt) return []
    // Keep the context sources' signal-only stream active for the whole causal
    // exercise. ChartSurface clips every marker at the revealed candle, so
    // preceding context remains visible without leaking future signals.
    return decisionContextSourceIds
  }, [activeDecisionAttempt, activeDecisionCandidate, decisionContextSourceIds, decisionMode])
  const latestRevealedDecisionSignal = useMemo(() => {
    if (!decisionDayMode || !activeDecisionCandidate || !activeDecisionAttempt) return null
    return latestReplayDecisionSignal(
      activeDecisionCandidate.symbol,
      activeDecisionCandidate.interval,
      decisionSignalSourceIds,
      activeDecisionAttempt.cursorTime,
    )
  }, [activeDecisionAttempt, activeDecisionCandidate, decisionDayMode, decisionSignalSourceIds])
  const decisionAnomalies = useMemo(() => decisionCenterOpen
    ? findDecisionReplayAnomalies(normalizedDecisionStore.sessions, aggregateCandles(availableDecisionHistoryBySymbol.XAUUSD ?? [], 300))
    : [], [availableDecisionHistoryBySymbol.XAUUSD, decisionCenterOpen, normalizedDecisionStore.sessions])
  const replayableDecisionAnomalies = useMemo(() => decisionAnomalies.filter(({ result }) => (
    historyCoversDecisionCandidate(result.candidate, availableDecisionHistoryBySymbol.XAUUSD)
  )), [availableDecisionHistoryBySymbol.XAUUSD, decisionAnomalies])
  const decisionAnomalyCount = new Set(replayableDecisionAnomalies.map(({ result }) => result.candidate.key)).size
  const availableDecisionCount = useMemo(() => {
    const seen = new Set(normalizedDecisionStore.seenTradeKeys)
    return allDecisionCandidates.filter((candidate) => (
      DECISION_REPLAY_INTERVALS.some((interval) => interval === candidate.interval) && !seen.has(candidate.key)
    )).length
  }, [allDecisionCandidates, normalizedDecisionStore.seenTradeKeys])
  const decisionSymbolStats = useMemo<DecisionSymbolStats[]>(() => {
    const seen = new Set(normalizedDecisionStore.seenTradeKeys)
    const grouped = new Map<string, { total: number; remaining: number }>()
    for (const candidate of allDecisionCandidates) {
      const replayInterval = DECISION_REPLAY_INTERVALS.find((interval) => interval === candidate.interval)
      if (!replayInterval) continue
      const key = `${candidate.symbol}:${replayInterval}`
      const current = grouped.get(key) ?? { total: 0, remaining: 0 }
      current.total += 1
      if (!seen.has(candidate.key)) current.remaining += 1
      grouped.set(key, current)
    }
    return SYMBOLS
      .map(({ id }) => {
        const intervals = DECISION_REPLAY_INTERVALS.map((interval) => ({
          interval,
          ...(grouped.get(`${id}:${interval}`) ?? { total: 0, remaining: 0 }),
        }))
        return {
          symbol: id,
          total: intervals.reduce((sum, stat) => sum + stat.total, 0),
          remaining: intervals.reduce((sum, stat) => sum + stat.remaining, 0),
          intervals,
        }
      })
      .filter((item) => item.total > 0)
  }, [allDecisionCandidates, normalizedDecisionStore.seenTradeKeys])
  const visibleRangeLayerSourceIds = useMemo(
    () => replayRangeLayers.filter((layer) => layer.symbol === symbol && layer.interval === interval && layer.visible).map((layer) => layer.sourceId),
    [interval, replayRangeLayers, symbol],
  )
  const suppressedRangeObjectIds = useMemo(
    () => replayRangeLayers.flatMap((layer) => [...layer.hiddenRangeIds, ...layer.deletedRangeIds]),
    [replayRangeLayers],
  )
  const activeSelectedReplayRangeId = useMemo(() => selectedReplayRangeId && replayRangeLayers.some((layer) => (
    layer.symbol === symbol && layer.interval === interval && layer.visible
    && selectedReplayRangeId.startsWith(`replay-range-${layer.sourceId}-`)
    && !layer.hiddenRangeIds.includes(selectedReplayRangeId)
    && !layer.deletedRangeIds.includes(selectedReplayRangeId)
  )) ? selectedReplayRangeId : null, [interval, replayRangeLayers, selectedReplayRangeId, symbol])

  useEffect(() => {
    // A refreshed or newly opened chart always starts at the latest candle.
    // Replay remains an in-page mode and is intentionally not restored across reloads.
    saveReplaySession(null)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    const loadingTimer = window.setTimeout(() => {
      if (!active) return
      setRemoteMarket((current) => current?.symbol === symbol ? current : null)
      setMarketLoading({ symbol, label: '行情加载中…' })
    }, 0)
    void loadSnapshotCandles(symbol, '1m', controller.signal).then((bars) => {
      if (!active) return
      if (!bars?.length) {
        setRemoteMarket(null)
        return
      }
      setDecisionHistoryBySymbol((current) => current[symbol] === bars ? current : { ...current, [symbol]: bars })
      setRemoteMarket({ symbol, bars, status: getSnapshotStatus(symbol) })
      setMarketHydrationKey((value) => value + 1)
    }).catch((error) => {
      if (!active || (error instanceof DOMException && error.name === 'AbortError')) return
      setToast(error instanceof Error ? error.message : `${symbol} 历史数据加载失败`)
    }).finally(() => {
      window.clearTimeout(loadingTimer)
      if (active) setMarketLoading(null)
    })
    return () => { active = false; window.clearTimeout(loadingTimer); controller.abort() }
  }, [marketRefreshTick, symbol])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    const hydrateDecisionHistory = async () => {
      // Do not parse every market before the first paint. Loading the remaining
      // snapshots in short, separated tasks keeps the chart responsive while
      // preserving cross-symbol decision replay once hydration completes.
      await new Promise((resolve) => window.setTimeout(resolve, 1200))
      for (const { id } of SYMBOLS) {
        if (!active) return
        const bars = await loadSnapshotCandles(id, '1m', controller.signal)
        if (active && bars?.length) {
          setDecisionHistoryBySymbol((current) => current[id] === bars ? current : { ...current, [id]: bars })
        }
        await new Promise((resolve) => window.setTimeout(resolve, 150))
      }
    }
    void hydrateDecisionHistory().catch((error) => {
      if (!active || (error instanceof DOMException && error.name === 'AbortError')) return
      console.warn('决策回放行情后台加载失败', error)
    })
    return () => { active = false; controller.abort() }
  }, [marketRefreshTick])

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => saveChartAlerts(chartAlerts), [chartAlerts])
  useEffect(() => savePaperOrders(paperOrders), [paperOrders])
  useEffect(() => saveWeeklyMergedReplayTradeLayers(replayTradeLayers), [replayTradeLayers])
  useEffect(() => saveReplayRangeLayers(replayRangeLayers), [replayRangeLayers])
  useEffect(() => saveFavoriteTools(favoriteTools), [favoriteTools])
  useEffect(() => saveLocalCodeDeployActivity(codeDeployActivity), [codeDeployActivity])
  useEffect(() => {
    decisionStoreRef.current = decisionStore
    if (decisionPersistTimerRef.current !== null) window.clearTimeout(decisionPersistTimerRef.current)
    decisionPersistTimerRef.current = window.setTimeout(() => {
      decisionPersistTimerRef.current = null
      saveDecisionReplayStoreSnapshot(decisionStoreRef.current)
    }, 400)
  }, [decisionStore])
  useEffect(() => {
    decisionFavoriteKeysRef.current = decisionFavoriteKeys
    saveDecisionReplayFavorites(decisionFavoriteKeys)
  }, [decisionFavoriteKeys])
  useEffect(() => {
    const syncDecisionProgressFromAnotherTab = (event: StorageEvent) => {
      if (event.storageArea && event.storageArea !== localStorage) return
      if (event.key === DECISION_REPLAY_STORAGE_KEY) {
        const incoming = event.newValue === null
          ? emptyDecisionReplayStore()
          : parseDecisionReplayStoreChecked(event.newValue)
        if (!incoming) return
        const current = decisionStoreRef.current
        // Imported progress is additive. Keep any in-flight work from this tab while
        // adopting sessions that were merged by another same-origin Edge tab.
        const next = event.newValue === null ? incoming : mergeDecisionReplayStores(current, incoming)
        if (JSON.stringify(next) === JSON.stringify(current)) return
        decisionStoreRef.current = next
        setDecisionStore(next)
        return
      }
      if (event.key === DECISION_REPLAY_FAVORITES_STORAGE_KEY) {
        const incoming = event.newValue === null ? [] : parseDecisionReplayFavoritesChecked(event.newValue)
        if (!incoming || JSON.stringify(incoming) === JSON.stringify(decisionFavoriteKeysRef.current)) return
        decisionFavoriteKeysRef.current = incoming
        setDecisionFavoriteKeys(incoming)
      }
    }
    window.addEventListener('storage', syncDecisionProgressFromAnotherTab)
    return () => window.removeEventListener('storage', syncDecisionProgressFromAnotherTab)
  }, [])
  useEffect(() => {
    const reloadDecisionProgress = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      const current = decisionStoreRef.current
      const next = mergeDecisionReplayStores(current, loadDecisionReplayStore())
      if (JSON.stringify(next) === JSON.stringify(current)) return
      decisionStoreRef.current = next
      setDecisionStore(next)
    }
    window.addEventListener('pageshow', reloadDecisionProgress)
    return () => {
      window.removeEventListener('pageshow', reloadDecisionProgress)
    }
  }, [])
  useEffect(() => {
    const flushDecisionProgress = () => {
      if (decisionPersistTimerRef.current !== null) {
        window.clearTimeout(decisionPersistTimerRef.current)
        decisionPersistTimerRef.current = null
      }
      saveDecisionReplayStoreSnapshot(decisionStoreRef.current)
      saveDecisionReplayFavorites(decisionFavoriteKeysRef.current)
    }
    const flushWhenHidden = () => { if (document.visibilityState === 'hidden') flushDecisionProgress() }
    window.addEventListener('pagehide', flushDecisionProgress)
    document.addEventListener('visibilitychange', flushWhenHidden)
    return () => {
      flushDecisionProgress()
      window.removeEventListener('pagehide', flushDecisionProgress)
      document.removeEventListener('visibilitychange', flushWhenHidden)
    }
  }, [])
  // Candidate changes replace the causal data set. Wait until that data has
  // committed to ChartSurface before focusing, otherwise its data-sync effect
  // can restore the previous trade's viewport immediately afterwards.
  const focusDecisionChartLatest = useCallback(() => {
    const focus = () => {
      // Delayed retries from ordinary random practice must never pull a newly
      // opened day-sequence chart back to only the latest candles.
      if (decisionDayModeRef.current) return
      // Keep automatic transitions identical to pressing the bottom-right A
      // button: reset the price scale to automatic before centering the latest
      // visible candles. This runs after the data commit, not synchronously in
      // the effect that schedules the focus.
      setPriceScaleAuto(true)
      chartRef.current?.focusLatest()
    }
    if (typeof window === 'undefined') return
    if (typeof window.requestAnimationFrame !== 'function') {
      window.setTimeout(focus, 0)
      window.setTimeout(focus, 120)
      window.setTimeout(focus, 300)
      window.setTimeout(focus, 600)
      window.setTimeout(focus, 1000)
      return
    }
    // The candidate data can arrive after the decision panel changes. Retry
    // after the next paint and after the asynchronous data/effect commits so
    // a slow transition cannot leave the chart parked on an empty range.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        focus()
        window.setTimeout(focus, 120)
        window.setTimeout(focus, 300)
        window.setTimeout(focus, 600)
        window.setTimeout(focus, 1000)
      })
    })
  }, [])

  const focusDecisionDayChart = useCallback(() => {
    const focus = () => {
      if (!decisionDayModeRef.current) return
      setPriceScaleAuto(true)
      // The current day candle stays at the right edge while earlier candles
      // remain visible as context, matching ordinary decision replay.
      chartRef.current?.focusLatest()
    }
    if (typeof window === 'undefined') return
    window.setTimeout(focus, 0)
    window.setTimeout(focus, 120)
    window.setTimeout(focus, 300)
    window.setTimeout(focus, 600)
    window.setTimeout(focus, 1000)
  }, [])

  const focusCurrentDecisionChart = useCallback(() => {
    if (decisionDayMode) focusDecisionDayChart()
    else focusDecisionChartLatest()
  }, [decisionDayMode, focusDecisionChartLatest, focusDecisionDayChart])

  // Include the session id so switching between the source attempt and an
  // independent review reloads the correct drawing snapshot even when both
  // attempts use the same candidate.
  const decisionContextKey = activeDecisionSession && activeDecisionCandidate
    ? `active:${activeDecisionSession.id}|${activeDecisionCandidate.key}`
    : null
  const decisionContextSymbol = decisionSubject?.symbol ?? null
  const decisionContextInterval = decisionSubject?.interval ?? null

  useEffect(() => {
    if (!decisionContextKey || !decisionContextSymbol || !decisionContextInterval) return
    const timer = window.setTimeout(() => {
      setSymbol(decisionContextSymbol)
      setIntervalId(decisionContextInterval)
      setReplayPanelOpen(false)
      setReplaySelecting(false)
      setReplayCursor(null)
      setReplayPlaying(false)
      setReplayPointer(null)
      setLive(false)
      setHoverCandle(null)
      setQuickMeasurement(null)
      setSelectedReplayRangeId(null)
      setObjectTreeOpen(false)
      const store = decisionStoreRef.current
      const activeSession = store.activeSessionId ? store.sessions.find((session) => session.id === store.activeSessionId) : null
      const currentAttempt = currentDecisionAttempt(activeSession)
      const currentIndex = activeSession?.currentIndex ?? 0
      const previousAttempt = activeSession && currentIndex > 0
        ? activeSession.attempts.find((attempt) => attempt.candidateKey === activeSession.candidates[currentIndex - 1]?.key)
        : null
      // Recover day-chart drawings saved by the previous question before this
      // fix. New day attempts inherit the snapshot directly, but existing
      // active sessions may already have an empty current attempt.
      const drawingsForContext = decisionDayMode && currentAttempt?.drawings.length === 0
        ? previousAttempt?.drawings ?? []
        : currentAttempt?.drawings ?? []
      decisionDrawingLoadingRef.current = true
      const separator = decisionContextKey.indexOf('|')
      decisionDrawingContextRef.current = separator >= 0
        ? decisionContextKey.slice(separator + 1)
        : decisionContextKey.slice('active:'.length)
      dispatchDecisionDrawing({ type: 'load', drawings: withoutTransientMeasurements(drawingsForContext) })
      window.setTimeout(() => {
        decisionDrawingLoadingRef.current = false
        // A day-sequence session is one continuous chart. Candidate changes
        // only swap the answer/drawing context and must not recenter the
        // viewport. The initial day focus is handled by the mode effect below.
        if (!decisionDayMode) focusDecisionChartLatest()
      }, 0)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [decisionContextInterval, decisionContextKey, decisionContextSymbol, decisionDayMode, focusDecisionChartLatest])

  useEffect(() => {
    const candidateKey = decisionDrawingContextRef.current
    if (!candidateKey || decisionDrawingLoadingRef.current) return
    const timer = window.setTimeout(() => {
      const snapshot = withoutTransientMeasurements(decisionDrawings.present)
      setDecisionStore((current) => {
        let changed = false
        const sessions = current.sessions.map((session) => {
          if (session.id !== current.activeSessionId) return session
          const next = updateDecisionSessionDrawings(session, candidateKey, snapshot)
          if (next !== session) changed = true
          return next
        })
        return changed ? { ...current, sessions } : current
      })
    }, 140)
    return () => window.clearTimeout(timer)
  }, [decisionDrawings.present])

  useEffect(() => {
    if (!decisionMode) return
    if (decisionDayMode) focusDecisionDayChart()
    else focusDecisionChartLatest()
  }, [decisionDayMode, decisionMode, focusDecisionChartLatest, focusDecisionDayChart, interval])

  // Do not focus the day chart when decisionData grows. ChartSurface preserves
  // its visible logical range as key 1 reveals each candle, matching ordinary
  // custom practice and preventing horizontal/vertical layout jumps.

  useEffect(() => {
    const chart = chartRef.current
    const nextDecisionCurrentCandleX = chart && decisionCurrentCandle !== null
      ? chart.timeToCoordinate(decisionCurrentCandle.time)
      : null
    setDecisionCurrentCandleX((current) => current === nextDecisionCurrentCandleX ? current : nextDecisionCurrentCandleX)
    if (!chart) return
    const alertY = Object.fromEntries(chartAlerts.filter((alert) => alert.symbol === symbol).map((alert) => [alert.id, chart.priceToCoordinate(alert.price)]))
    const orderY = Object.fromEntries(paperOrders.filter((order) => order.symbol === symbol).map((order) => [order.id, chart.priceToCoordinate(order.price)]))
    setContextOverlayPositions({
      lockedCursorX: lockedCursorTime === null ? null : chart.timeToCoordinate(lockedCursorTime),
      alertY,
      orderY,
    })
  }, [chartAlerts, clock, data, decisionCurrentCandle, decisionMode, drawingProjectionTick, lockedCursorTime, paperOrders, symbol])

  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => setLiveTick((value) => value + 1), 1200)
    return () => window.clearInterval(timer)
  }, [live])

  useEffect(() => {
    if (!replayPlaying || normalizedReplayCursor === null) return
    const timer = window.setTimeout(() => {
      const next = advanceReplayTime(normalizedReplayCursor, effectiveReplayResolution, baseData, chartSeconds)
      setReplayCursor(next.time)
      if (next.ended) setReplayPlaying(false)
    }, replaySpeed(replaySpeedValue).delay)
    return () => window.clearTimeout(timer)
  }, [baseData, chartSeconds, effectiveReplayResolution, normalizedReplayCursor, replayPlaying, replaySpeedValue])

  useEffect(() => {
    const timer = window.setTimeout(() => saveWorkspace({
      symbol, interval, chartType, theme, priceScaleAuto, priceScaleLog, priceScalePercent, priceScaleInverted,
      indicators, indicatorLegendExpanded, drawings: withoutTransientMeasurements(drawings.present), collapsedReplayRangeLayerIds,
    }), 120)
    return () => window.clearTimeout(timer)
  }, [chartType, collapsedReplayRangeLayerIds, drawings.present, indicatorLegendExpanded, indicators, interval, priceScaleAuto, priceScaleInverted, priceScaleLog, priceScalePercent, symbol, theme])

  const notify = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 1800)
  }, [])

  const updateActiveDecisionAttempt = useCallback((updater: (attempt: DecisionAttempt, candidate: ReplayDecisionCandidate) => DecisionAttempt) => {
    setDecisionStore((current) => {
      const sessionId = current.activeSessionId
      if (!sessionId) return current
      return {
        ...current,
        sessions: current.sessions.map((session) => {
          if (session.id !== sessionId || session.status !== 'active') return session
          const candidate = currentDecisionCandidate(session)
          const attempt = currentDecisionAttempt(session)
          if (!candidate || !attempt) return session
          const nextAttempt = updater(attempt, candidate)
          return {
            ...session,
            updatedAt: Date.now(),
            attempts: session.attempts.map((item) => item.candidateKey === attempt.candidateKey ? nextAttempt : item),
          }
        }),
      }
    })
  }, [])

  const beginDecisionSession = useCallback((requestedCount: number, selectedSymbols: SymbolId[], selectedIntervals: DecisionReplayInterval[], positionSizingModes: DecisionPositionSizingMode[], practiceMode: DecisionPracticeMode, lossDayOnly = false, lossDaySizingMode: DecisionPositionSizingMode = 'fixed-risk') => {
    if (decisionSessionStartLockRef.current) return
    decisionSessionStartLockRef.current = true
    window.setTimeout(() => { decisionSessionStartLockRef.current = false }, 0)
    const scopedCandidates = filterDecisionCandidatesByScope(allDecisionCandidates, selectedSymbols, selectedIntervals)
    const lossDays = decisionAiDaySummariesByMode[lossDaySizingMode].filter((day) => (
      day.pnlUsd < 0
      && selectedSymbols.includes(day.symbol)
      && selectedIntervals.includes(day.interval)
    ))
    const candidates = lossDayOnly
      ? lossDays.flatMap((day) => filterDecisionCandidatesByTradingDay(scopedCandidates, day.key))
      : scopedCandidates
    const resumableDaySession = practiceMode === 'day-sequence'
      ? latestResumableDecisionDaySession(
          normalizedDecisionStore.sessions,
          selectedSymbols,
          selectedIntervals,
          lossDayOnly ? lossDays.map((day) => day.key) : undefined,
        )
      : null
    if (resumableDaySession) {
      const now = Date.now()
      setDecisionStore((current) => ({
        ...current,
        activeSessionId: resumableDaySession.id,
        sessions: current.sessions.map((session) => session.id === resumableDaySession.id
          ? { ...session, status: 'active', updatedAt: now, finishedAt: null }
          : session),
      }))
      setDecisionCenterOpen(false)
      setDecisionResultsSessionId(null)
      setDecisionReviewReturnSessionId(null)
      setDecisionPriceDraft(null)
      setDecisionRiskDraft(null)
      setHoverCandle(null)
      decisionDayModeRef.current = true
      notify(`已自动接上 ${resumableDaySession.daySequence ? formatDecisionDay(resumableDaySession.daySequence.startTime) : '上次'} 未完成的逐K练习`)
      return
    }
    const sampledDay = practiceMode === 'day-sequence'
      ? sampleDecisionDayCandidates(
        candidates,
        normalizedDecisionStore.seenTradeKeys,
        ({ daySequence }) => decisionDayHistoryIsComplete(
          daySequence,
          availableDecisionHistoryBySymbol[daySequence.symbol],
        ),
      )
      : null
    const selected = practiceMode === 'day-sequence'
      ? sampledDay?.candidates ?? []
      : sampleDecisionCandidates(candidates, normalizedDecisionStore.seenTradeKeys, requestedCount)
    if (selected.length === 0) {
      notify(practiceMode === 'day-sequence' ? `${lossDayOnly ? '当前筛选范围的AI亏损日' : '当前筛选范围'}没有可组成完整交易日的未练习交易` : '没有尚未练习的模拟交易')
      return
    }
    const session = createDecisionSession(selected, practiceMode === 'day-sequence' ? selected.length : requestedCount, Date.now(), positionSizingModes, {
      practiceMode,
      ...(sampledDay ? { daySequence: sampledDay.daySequence } : {}),
    })
    setDecisionStore((current) => normalizeDecisionReplayStore({
      ...current,
      activeSessionId: session.id,
      // Custom-count batches keep their historical immediate reservation.
      // Whole-day practice is atomic: it becomes seen only after the entire
      // round completes, so an unfinished day can be randomly sampled again.
      seenTradeKeys: practiceMode === 'day-sequence'
        ? current.seenTradeKeys
        : [...new Set([...current.seenTradeKeys, ...selected.map((candidate) => candidate.key)])],
      sessions: [session, ...current.sessions],
    }))
    setDecisionCenterOpen(false)
    setDecisionResultsSessionId(null)
    setDecisionReviewReturnSessionId(null)
    setDecisionPriceDraft(null)
    setDecisionRiskDraft(null)
    decisionDayModeRef.current = practiceMode === 'day-sequence'
    if (practiceMode !== 'day-sequence') setDecisionFocusTick((value) => value + 1)
    const selectedLossDay = lossDayOnly && sampledDay ? lossDays.find((day) => day.key === sampledDay.daySequence.key) : null
    notify(sampledDay
      ? `${selectedLossDay ? `已随机抽取AI亏损日 ${selectedLossDay.symbol} ${INTERVALS[selectedLossDay.interval].label} ${formatDecisionDay(selectedLossDay.startTime)} · ` : ''}按时间顺序练习 ${selected.length} 笔`
      : `已随机抽取 ${selected.length} 笔，开始严格因果决策回放`)
  }, [allDecisionCandidates, availableDecisionHistoryBySymbol, decisionAiDaySummariesByMode, normalizedDecisionStore.seenTradeKeys, normalizedDecisionStore.sessions, notify])

  const beginAnomalyReview = useCallback((positionSizingModes: DecisionPositionSizingMode[]) => {
    if (decisionSessionStartLockRef.current || replayableDecisionAnomalies.length === 0) return
    decisionSessionStartLockRef.current = true
    window.setTimeout(() => { decisionSessionStartLockRef.current = false }, 0)
    const currentActive = normalizedDecisionStore.sessions.find((session) => session.id === normalizedDecisionStore.activeSessionId && session.status === 'active')
    // Repeated clicks resume an unfinished anomaly batch instead of making empty duplicates.
    const unfinished = normalizedDecisionStore.sessions.find((session) => session.reviewKind === 'stop-anomalies' && session.status === 'active')
    const session = unfinished ?? createDecisionAnomalyReviewSession(replayableDecisionAnomalies, positionSizingModes)
    setDecisionStore((current) => ({
      ...current,
      activeSessionId: session.id,
      sessions: unfinished ? current.sessions : [session, ...current.sessions],
    }))
    setDecisionReviewReturnSessionId(currentActive?.id === session.id ? decisionReviewReturnSessionId : currentActive?.origin === 'review' ? decisionReviewReturnSessionId : currentActive?.id ?? null)
    setDecisionCenterOpen(false)
    setDecisionHistoryOpen(false)
    setDecisionResultsSessionId(null)
    setDecisionPriceDraft(null)
    setDecisionRiskDraft(null)
    setHoverCandle(null)
    decisionDrawingLoadingRef.current = true
    decisionDrawingContextRef.current = null
    dispatchDecisionDrawing({ type: 'load', drawings: currentDecisionAttempt(session)?.drawings ?? [] })
    window.setTimeout(() => { decisionDrawingLoadingRef.current = false }, 0)
    setDecisionFocusTick((value) => value + 1)
    focusDecisionChartLatest()
    notify(`${unfinished ? '继续' : '已创建'}异常订单独立重做卷，共 ${session.candidates.length} 题；原记录保留`)
  }, [decisionReviewReturnSessionId, focusDecisionChartLatest, normalizedDecisionStore, notify, replayableDecisionAnomalies])

  const completeDecisionTrade = useCallback((resolvedAttempt: DecisionAttempt, exit: DecisionExit, advanceImmediately = false) => {
    if (!activeDecisionSession || !activeDecisionCandidate) return
    const expectedCandidateKey = activeDecisionCandidate.key
    const drawingSnapshot = withoutTransientMeasurements(decisionDrawings.present)
    const result = buildDecisionResult(activeDecisionCandidate, resolvedAttempt, exit, drawingSnapshot)
    const isLast = activeDecisionSession.currentIndex >= activeDecisionSession.candidates.length - 1
    const sessionId = activeDecisionSession.id
    setDecisionStore((current) => {
      const session = current.sessions.find((item) => item.id === sessionId)
      if (!session || session.status !== 'active') return current
      const sessionCandidate = currentDecisionCandidate(session)
      if (!sessionCandidate || sessionCandidate.key !== expectedCandidateKey || resolvedAttempt.candidateKey !== expectedCandidateKey) return current
      const resolved = { ...resolvedAttempt, stage: advanceImmediately ? 'complete' as const : 'post-exit' as const, result, drawings: result.drawings }
      let attempts = session.attempts.map((attempt) => attempt.candidateKey === resolved.candidateKey ? resolved : attempt)
      let nextIndex = session.currentIndex
      let status: DecisionReplaySession['status'] = session.status
      let activeSessionId: string | null = current.activeSessionId
      let seenTradeKeys = current.seenTradeKeys
      if (!advanceImmediately) {
        const now = Date.now()
        return {
          ...current,
          sessions: current.sessions.map((item) => item.id === sessionId ? { ...session, attempts, updatedAt: now } : item),
        }
      }
      const nextCandidate = session.candidates[session.currentIndex + 1]
      if (nextCandidate) {
        nextIndex = session.currentIndex + 1
        if (!attempts.some((attempt) => attempt.candidateKey === nextCandidate.key)) {
          const daySequenceMode = decisionSessionPracticeMode(session) === 'day-sequence'
          const nextAttempt = createDecisionAttempt(nextCandidate, daySequenceMode ? resolved.cursorTime : undefined)
          attempts = [...attempts, daySequenceMode ? { ...nextAttempt, drawings: drawingSnapshot } : nextAttempt]
        }
        if (decisionSessionPracticeMode(session) !== 'day-sequence') {
          seenTradeKeys = [...new Set([...seenTradeKeys, nextCandidate.key])]
        }
      } else {
        status = 'completed'
        activeSessionId = session.origin === 'review' ? decisionReviewReturnSessionId : null
        if (decisionSessionPracticeMode(session) === 'day-sequence') {
          seenTradeKeys = [...new Set([...seenTradeKeys, ...session.candidates.map((candidate) => candidate.key)])]
        }
      }
      const now = Date.now()
      return {
        ...current,
        activeSessionId,
        seenTradeKeys,
        sessions: current.sessions.map((item) => item.id === sessionId ? {
          ...session, attempts, currentIndex: nextIndex, status,
          updatedAt: now, finishedAt: status === 'completed' ? now : session.finishedAt,
        } : item),
      }
    })
    setDecisionPriceDraft(null)
    setDecisionRiskDraft(null)
    setHoverCandle(null)
    const returnFromReview = isLast && activeDecisionSession.origin === 'review' && decisionReviewReturnSessionId !== null
    if (!advanceImmediately) {
      notify(decisionDayMode
        ? isLast
          ? '当天最后一笔已经结算：按 1 继续逐根观看到收盘'
          : '本笔已经平仓：按 1 继续观看，按 2 开多，按 3 开空'
        : '本笔已经平仓：按 1 继续观看，按 4 进入下一笔')
    } else if (returnFromReview) {
      setDecisionResultsSessionId(null)
      setDecisionReviewReturnSessionId(null)
      setDecisionFocusTick((value) => value + 1)
      focusDecisionChartLatest()
      notify('本题独立复盘已保存，已返回原练习')
    } else if (isLast) {
      setDecisionResultsSessionId(sessionId)
      notify('本场决策已完成，系统结果现已揭晓')
    } else {
      if (!decisionDayMode) {
        setDecisionFocusTick((value) => value + 1)
        focusDecisionChartLatest()
      }
    }
  }, [activeDecisionCandidate, activeDecisionSession, decisionDayMode, decisionDrawings.present, decisionReviewReturnSessionId, focusDecisionChartLatest, notify])

  const goToNextDecisionTrade = useCallback(() => {
    if (!activeDecisionSession || !activeDecisionCandidate || !activeDecisionAttempt?.result || activeDecisionAttempt.stage !== 'post-exit') return
    const isLast = activeDecisionSession.currentIndex >= activeDecisionSession.candidates.length - 1
    const dayLastBarTime = activeDecisionDaySequence
      ? activeDecisionDaySequence.endTime - intervalSeconds(activeDecisionCandidate.interval)
      : null
    if (isLast && dayLastBarTime !== null && activeDecisionAttempt.cursorTime < dayLastBarTime) {
      notify('这是当天最后一笔交易；请按 1 继续逐根观看到收盘')
      return
    }
    const sessionId = activeDecisionSession.id
    const expectedCandidateKey = activeDecisionCandidate.key
    const drawingSnapshot = withoutTransientMeasurements(decisionDrawings.present)
    setDecisionStore((current) => {
      const session = current.sessions.find((item) => item.id === sessionId)
      if (!session || session.status !== 'active') return current
      const sessionCandidate = currentDecisionCandidate(session)
      if (!sessionCandidate || sessionCandidate.key !== expectedCandidateKey) return current
      const currentAttempt = currentDecisionAttempt(session)
      if (!currentAttempt?.result || currentAttempt.stage !== 'post-exit' || currentAttempt.candidateKey !== expectedCandidateKey) return current
      const completedAttempt: DecisionAttempt = {
        ...currentAttempt,
        stage: 'complete',
        drawings: drawingSnapshot,
        result: { ...currentAttempt.result, drawings: drawingSnapshot },
      }
      let attempts = session.attempts.map((attempt) => attempt.candidateKey === completedAttempt.candidateKey ? completedAttempt : attempt)
      let nextIndex = session.currentIndex
      let status: DecisionReplaySession['status'] = session.status
      let activeSessionId: string | null = current.activeSessionId
      let seenTradeKeys = current.seenTradeKeys
      const nextCandidate = session.candidates[session.currentIndex + 1]
      if (nextCandidate) {
        nextIndex = session.currentIndex + 1
        if (!attempts.some((attempt) => attempt.candidateKey === nextCandidate.key)) {
          const daySequenceMode = decisionSessionPracticeMode(session) === 'day-sequence'
          const nextAttempt = createDecisionAttempt(nextCandidate, daySequenceMode ? currentAttempt.cursorTime : undefined)
          attempts = [...attempts, daySequenceMode ? { ...nextAttempt, drawings: drawingSnapshot } : nextAttempt]
        }
        if (decisionSessionPracticeMode(session) !== 'day-sequence') {
          seenTradeKeys = [...new Set([...seenTradeKeys, nextCandidate.key])]
        }
      } else {
        status = 'completed'
        activeSessionId = session.origin === 'review' ? decisionReviewReturnSessionId : null
        if (decisionSessionPracticeMode(session) === 'day-sequence') {
          seenTradeKeys = [...new Set([...seenTradeKeys, ...session.candidates.map((candidate) => candidate.key)])]
        }
      }
      const now = Date.now()
      return {
        ...current,
        activeSessionId,
        seenTradeKeys,
        sessions: current.sessions.map((item) => item.id === sessionId ? {
          ...session, attempts, currentIndex: nextIndex, status,
          updatedAt: now, finishedAt: status === 'completed' ? now : session.finishedAt,
        } : item),
      }
    })
    setHoverCandle(null)
    const returnFromReview = isLast && activeDecisionSession.origin === 'review' && decisionReviewReturnSessionId !== null
    if (returnFromReview) {
      setDecisionResultsSessionId(null)
      setDecisionReviewReturnSessionId(null)
      setDecisionFocusTick((value) => value + 1)
      focusDecisionChartLatest()
      notify('本题独立复盘已保存，已返回原练习')
    } else if (isLast) {
      setDecisionResultsSessionId(sessionId)
      notify('本场决策已完成，系统结果现已揭晓')
    } else {
      if (!decisionDayMode) {
        setDecisionFocusTick((value) => value + 1)
        focusDecisionChartLatest()
      }
      notify('已进入下一笔交易')
    }
  }, [activeDecisionAttempt, activeDecisionCandidate, activeDecisionDaySequence, activeDecisionSession, decisionDayMode, decisionDrawings.present, decisionReviewReturnSessionId, focusDecisionChartLatest, notify])

  const restartActiveDecisionTrade = useCallback(() => {
    if (!activeDecisionSession || !activeDecisionCandidate || activeDecisionAttempt?.stage !== 'post-exit') return
    const sessionId = activeDecisionSession.id
    const candidateKey = activeDecisionCandidate.key
    const now = Date.now()
    setDecisionStore((current) => {
      const session = current.sessions.find((item) => item.id === sessionId)
      if (!session) return current
      const restarted = restartPostExitDecisionAttempt(session, candidateKey, now)
      if (restarted === session) return current
      return {
        ...current,
        sessions: current.sessions.map((item) => item.id === sessionId ? restarted : item),
      }
    })
    setDecisionResultsSessionId(null)
    setDecisionPriceDraft(null)
    setDecisionRiskDraft(null)
    setHoverCandle(null)
    decisionDrawingLoadingRef.current = true
    decisionDrawingContextRef.current = null
    dispatchDecisionDrawing({ type: 'load', drawings: [] })
    window.setTimeout(() => { decisionDrawingLoadingRef.current = false }, 0)
    if (!decisionDayMode) setDecisionFocusTick((value) => value + 1)
    focusCurrentDecisionChart()
    notify('已回到信号 K，重新开始本笔交易')
  }, [activeDecisionAttempt, activeDecisionCandidate, activeDecisionSession, decisionDayMode, focusCurrentDecisionChart, notify])

  const stopDecisionSession = useCallback(() => {
    if (!activeDecisionSession) return
    const sessionId = activeDecisionSession.id
    const now = Date.now()
    const restoreSessionId = activeDecisionSession.origin === 'review' ? decisionReviewReturnSessionId : null
    setDecisionStore((current) => normalizeDecisionReplayStore({
      ...current,
      activeSessionId: current.activeSessionId === sessionId ? restoreSessionId : current.activeSessionId,
      sessions: current.sessions.map((session) => session.id === sessionId ? { ...session, status: 'stopped', updatedAt: now, finishedAt: now } : session),
    }))
    setDecisionResultsSessionId(sessionId)
    setDecisionPriceDraft(null)
    setDecisionRiskDraft(null)
    notify(decisionSessionPracticeMode(activeDecisionSession) === 'day-sequence'
      ? '已提前退出：本交易日不计为已练习，之后仍可随机抽到'
      : `已提前退出，保留 ${sessionResults(activeDecisionSession).length} 笔已完成结果`)
  }, [activeDecisionSession, decisionReviewReturnSessionId, notify])

  const finishDecisionRoundAtMarketEnd = useCallback((marketEndCandle: Candle) => {
    if (!decisionDayMode || !activeDecisionSession || !activeDecisionCandidate || !activeDecisionAttempt) return
    if (!canFinishDecisionSessionAtMarketEnd(activeDecisionAttempt)) return
    const sessionId = activeDecisionSession.id
    const candidateKey = activeDecisionCandidate.key
    const drawingSnapshot = withoutTransientMeasurements(decisionDrawings.present)
    const restoreSessionId = activeDecisionSession.origin === 'review' ? decisionReviewReturnSessionId : null
    setDecisionStore((current) => {
      const session = current.sessions.find((item) => item.id === sessionId)
      if (!session || session.status !== 'active') return current
      const sessionCandidate = currentDecisionCandidate(session)
      if (!sessionCandidate || sessionCandidate.key !== candidateKey) return current
      const finished = finishDecisionSessionAtMarketEnd(session, marketEndCandle, drawingSnapshot)
      if (finished === session) return current
      return {
        ...current,
        activeSessionId: current.activeSessionId === sessionId ? restoreSessionId : current.activeSessionId,
        seenTradeKeys: finished.status === 'completed'
          ? [...new Set([...current.seenTradeKeys, ...finished.candidates.map((candidate) => candidate.key)])]
          : current.seenTradeKeys,
        sessions: current.sessions.map((item) => item.id === sessionId ? finished : item),
      }
    })
    setDecisionResultsSessionId(sessionId)
    setDecisionPriceDraft(null)
    setDecisionRiskDraft(null)
    setHoverCandle(null)
    notify(activeDecisionAttempt.stage === 'position-open'
      ? '已到达本交易日最后一根 K 线：持仓已按该 K 线收盘价强制平仓，本轮结算完成'
      : activeDecisionAttempt.stage === 'order-pending'
        ? '已到达本交易日最后一根 K 线：未成交挂单已结束，本轮结算完成'
        : '已到达本交易日最后一根 K 线，本轮结算完成')
  }, [activeDecisionAttempt, activeDecisionCandidate, activeDecisionSession, decisionDayMode, decisionDrawings.present, decisionReviewReturnSessionId, notify])

  useEffect(() => {
    if (!decisionDayMode || !activeDecisionAttempt || decisionSourceData.length === 0) return
    const marketEndCandle = decisionSourceData.at(-1)
    if (!marketEndCandle || activeDecisionAttempt.cursorTime < marketEndCandle.time) return
    const finishTimer = window.setTimeout(() => finishDecisionRoundAtMarketEnd(marketEndCandle), 0)
    return () => window.clearTimeout(finishTimer)
  }, [activeDecisionAttempt, decisionDayMode, decisionSourceData, finishDecisionRoundAtMarketEnd])

  const advanceActiveDecision = useCallback(() => {
    if (!activeDecisionAttempt || !activeDecisionCandidate) return
    const next = nextCandleAfter(decisionSourceData, activeDecisionAttempt.cursorTime)
    if (activeDecisionAttempt.stage === 'post-exit') {
      if (!next) {
        const isLastDayTrade = decisionDayMode && activeDecisionSession
          && activeDecisionSession.currentIndex >= activeDecisionSession.candidates.length - 1
        if (isLastDayTrade) {
          goToNextDecisionTrade()
          return
        }
        notify(decisionDayMode
          ? '已经到达当天行情末尾；按 2 开多或按 3 开空进入下一笔交易'
          : '已经到达可用行情末尾；按 4 进入下一笔交易')
        return
      }
      updateActiveDecisionAttempt((attempt) => ({ ...attempt, cursorTime: next.time, drawings: withoutTransientMeasurements(decisionDrawings.present) }))
      return
    }
    if (!next) {
      const current = candleAtOrBefore(decisionSourceData, activeDecisionAttempt.cursorTime)
      const exit: DecisionExit = { time: activeDecisionAttempt.cursorTime, price: current?.close ?? activeDecisionCandidate.trade.entry.price, reason: 'end-of-data' }
      completeDecisionTrade(activeDecisionAttempt, exit)
      return
    }
    if (activeDecisionAttempt.stage === 'entry-decision') {
      updateActiveDecisionAttempt((attempt) => ({ ...attempt, cursorTime: next.time, drawings: withoutTransientMeasurements(decisionDrawings.present) }))
      return
    }
    if (activeDecisionAttempt.stage !== 'order-pending' && activeDecisionAttempt.stage !== 'position-open') return
    const evaluation = advanceDecisionAttempt(activeDecisionCandidate, activeDecisionAttempt, next)
    if (evaluation.exit) completeDecisionTrade(evaluation.attempt, evaluation.exit)
    else {
      updateActiveDecisionAttempt(() => ({ ...evaluation.attempt, drawings: withoutTransientMeasurements(decisionDrawings.present) }))
    }
  }, [activeDecisionAttempt, activeDecisionCandidate, activeDecisionSession, completeDecisionTrade, decisionDayMode, decisionDrawings.present, decisionSourceData, goToNextDecisionTrade, notify, updateActiveDecisionAttempt])

  const chooseSignalExtremeOrder = useCallback(() => {
    if (!activeDecisionAttempt || !activeDecisionCandidate || !decisionSignalReached) return
    const current = candleAtOrBefore(decisionSourceData, activeDecisionAttempt.cursorTime)
    if (!current) return
    const price = decisionExtremeEntryPrice(activeDecisionCandidate.trade.side, current)
    const levels = defaultDecisionLevels(activeDecisionCandidate.trade.side, price, activeDecisionCandidate.trade.entry.stopLoss)
    setDecisionPriceDraft(price)
    setDecisionRiskDraft(levels)
    updateActiveDecisionAttempt((attempt) => ({ ...attempt, stopLossMode: 'close', entryMode: 'signal-extreme', orderKind: 'stop', pendingEntryPrice: price, stage: 'risk-setup' }))
  }, [activeDecisionAttempt, activeDecisionCandidate, decisionSignalReached, decisionSourceData, updateActiveDecisionAttempt])

  const chooseFreePriceOrder = useCallback(() => {
    if (!activeDecisionAttempt || !decisionSignalReached) return
    const current = candleAtOrBefore(decisionSourceData, activeDecisionAttempt.cursorTime)
    if (!current) return
    setDecisionPriceDraft(current.close)
    setDecisionRiskDraft(null)
    updateActiveDecisionAttempt((attempt) => ({ ...attempt, stopLossMode: 'close', entryMode: 'free-price', orderKind: null, pendingEntryPrice: null, stage: 'entry-price' }))
  }, [activeDecisionAttempt, decisionSignalReached, decisionSourceData, updateActiveDecisionAttempt])

  const chooseDayExtremeOrder = useCallback((side: 'long' | 'short') => {
    if (!decisionDayMode || !activeDecisionAttempt || !activeDecisionCandidate || !['entry-decision', 'post-exit'].includes(activeDecisionAttempt.stage)) return
    const current = candleAtOrBefore(decisionSourceData, activeDecisionAttempt.cursorTime)
    if (!current) return
    const price = decisionExtremeEntryPrice(side, current)
    const structureStop = recentDecisionStructureStop(side, price, decisionSourceData, activeDecisionAttempt.cursorTime)
    const levels = defaultDecisionLevels(side, price, structureStop)
    setDecisionPriceDraft(price)
    setDecisionRiskDraft(levels)
    if (activeDecisionAttempt.stage === 'post-exit') {
      if (!activeDecisionSession) {
        setDecisionPriceDraft(null)
        setDecisionRiskDraft(null)
        return
      }
      const sessionId = activeDecisionSession.id
      const candidateKey = activeDecisionCandidate.key
      const drawings = withoutTransientMeasurements(decisionDrawings.present)
      setDecisionStore((store) => ({
        ...store,
        sessions: store.sessions.map((session) => (
          session.id === sessionId && currentDecisionCandidate(session)?.key === candidateKey
            ? startNextDaySequenceTrade(session, side, price, drawings)
            : session
        )),
      }))
      setHoverCandle(null)
      notify(`本笔结果已保存，已在当前 K 线${side === 'long' ? '最高价设置做多追单' : '最低价设置做空追单'}`)
      return
    }
    updateActiveDecisionAttempt((attempt) => ({
      ...attempt,
      userSide: side,
      stopLossMode: 'close',
      entryMode: 'signal-extreme',
      orderKind: 'stop',
      pendingEntryPrice: price,
      fill: null,
      stage: 'risk-setup',
    }))
  }, [activeDecisionAttempt, activeDecisionCandidate, activeDecisionSession, decisionDayMode, decisionDrawings.present, decisionSourceData, notify, updateActiveDecisionAttempt])

  useEffect(() => {
    if (!decisionDayMode || !activeDecisionAttempt || !activeDecisionCandidate || activeDecisionAttempt.stage !== 'risk-setup' || activeDecisionAttempt.entryMode !== 'market-close') return
    const current = candleAtOrBefore(decisionSourceData, activeDecisionAttempt.cursorTime)
    if (!current) return
    const side = decisionAttemptSide(activeDecisionCandidate, activeDecisionAttempt)
    const price = decisionExtremeEntryPrice(side, current)
    const structureStop = recentDecisionStructureStop(side, price, decisionSourceData, activeDecisionAttempt.cursorTime)
    const migrationTimer = window.setTimeout(() => {
      setDecisionPriceDraft(price)
      setDecisionRiskDraft(defaultDecisionLevels(side, price, structureStop))
      updateActiveDecisionAttempt((attempt) => ({
        ...attempt,
        entryMode: 'signal-extreme',
        orderKind: 'stop',
        pendingEntryPrice: price,
        fill: null,
      }))
    }, 0)
    return () => window.clearTimeout(migrationTimer)
  }, [activeDecisionAttempt, activeDecisionCandidate, decisionDayMode, decisionSourceData, updateActiveDecisionAttempt])

  const cancelDecisionSetup = useCallback(() => {
    setDecisionPriceDraft(null)
    setDecisionRiskDraft(null)
    updateActiveDecisionAttempt((attempt) => ({ ...attempt, stage: 'entry-decision', userSide: undefined, stopLossMode: 'close', entryMode: null, orderKind: null, pendingEntryPrice: null, initialStopLoss: null, stopLoss: null, takeProfit: null, positionMultiplier: 1, fill: null }))
  }, [updateActiveDecisionAttempt])

  const confirmDecisionPrice = useCallback(() => {
    if (!activeDecisionAttempt || !activeDecisionCandidate || decisionPriceDraft === null) return
    const current = candleAtOrBefore(decisionSourceData, activeDecisionAttempt.cursorTime)
    if (!current) return
    const side = decisionAttemptSide(activeDecisionCandidate, activeDecisionAttempt)
    const orderKind = side === 'long'
      ? decisionPriceDraft >= current.close ? 'stop' : 'limit'
      : decisionPriceDraft <= current.close ? 'stop' : 'limit'
    const suggestedStop = activeDecisionAttempt.userSide
      ? recentDecisionStructureStop(side, decisionPriceDraft, decisionSourceData, activeDecisionAttempt.cursorTime)
      : activeDecisionCandidate.trade.entry.stopLoss
    const levels = defaultDecisionLevels(side, decisionPriceDraft, suggestedStop)
    setDecisionRiskDraft(levels)
    updateActiveDecisionAttempt((attempt) => ({ ...attempt, orderKind, pendingEntryPrice: decisionPriceDraft, stage: 'risk-setup' }))
  }, [activeDecisionAttempt, activeDecisionCandidate, decisionPriceDraft, decisionSourceData, updateActiveDecisionAttempt])

  const confirmDecisionRisk = useCallback(() => {
    if (!activeDecisionAttempt || !activeDecisionCandidate || activeDecisionAttempt.pendingEntryPrice === null || !effectiveDecisionRiskDraft) return
    const riskDraft = effectiveDecisionRiskDraft
    const pendingEntryPrice = activeDecisionAttempt.pendingEntryPrice
    const side = decisionAttemptSide(activeDecisionCandidate, activeDecisionAttempt)
    if (!validDecisionLevels(side, pendingEntryPrice, riskDraft.stopLoss, riskDraft.takeProfit)) {
      notify(side === 'long' ? '做多时止损必须低于开仓价，止盈必须高于开仓价' : '做空时止损必须高于开仓价，止盈必须低于开仓价')
      return
    }
    const configured: DecisionAttempt = {
      ...activeDecisionAttempt, stage: activeDecisionAttempt.fill ? 'position-open' : 'order-pending', initialStopLoss: riskDraft.stopLoss, stopLoss: riskDraft.stopLoss,
      takeProfit: riskDraft.takeProfit, drawings: withoutTransientMeasurements(decisionDrawings.present),
    }
    setDecisionRiskDraft(null)
    if (configured.stage === 'position-open') {
      updateActiveDecisionAttempt(() => configured)
      return
    }
    const next = nextCandleAfter(decisionSourceData, configured.cursorTime)
    if (!next) {
      completeDecisionTrade(configured, { time: configured.cursorTime, price: pendingEntryPrice, reason: 'end-of-data' })
      return
    }
    const evaluation = advanceDecisionAttempt(activeDecisionCandidate, configured, next)
    if (evaluation.exit) completeDecisionTrade(evaluation.attempt, evaluation.exit)
    else updateActiveDecisionAttempt(() => evaluation.attempt)
  }, [activeDecisionAttempt, activeDecisionCandidate, completeDecisionTrade, decisionDrawings.present, effectiveDecisionRiskDraft, decisionSourceData, notify, updateActiveDecisionAttempt])

  const moveDecisionPendingEntry = useCallback((nextEntryPrice: number) => {
    if (!Number.isFinite(nextEntryPrice) || nextEntryPrice <= 0 || !activeDecisionAttempt || !activeDecisionCandidate || activeDecisionAttempt.stage !== 'risk-setup' || activeDecisionAttempt.pendingEntryPrice === null || !effectiveDecisionRiskDraft) return
    const current = candleAtOrBefore(decisionSourceData, activeDecisionAttempt.cursorTime)
    if (!current) return
    const side = decisionAttemptSide(activeDecisionCandidate, activeDecisionAttempt)
    const adjusted = adjustDecisionPendingEntry(side, nextEntryPrice, current.close, effectiveDecisionRiskDraft)
    setDecisionPriceDraft(nextEntryPrice)
    setDecisionRiskDraft({ stopLoss: adjusted.stopLoss, takeProfit: adjusted.takeProfit })
    updateActiveDecisionAttempt((attempt) => ({
      ...attempt,
      entryMode: 'free-price',
      orderKind: adjusted.orderKind,
      pendingEntryPrice: nextEntryPrice,
      fill: null,
    }))
  }, [activeDecisionAttempt, activeDecisionCandidate, decisionSourceData, effectiveDecisionRiskDraft, updateActiveDecisionAttempt])

  const updateActiveDecisionRisk = useCallback((field: 'stopLoss' | 'takeProfit', value: number) => {
    if (!Number.isFinite(value)) return
    updateActiveDecisionAttempt((attempt, candidate) => {
      if ((attempt.stage !== 'order-pending' && attempt.stage !== 'position-open') || attempt.pendingEntryPrice === null || attempt.stopLoss === null || attempt.takeProfit === null) return attempt
      const stopLoss = field === 'stopLoss' ? value : attempt.stopLoss
      const takeProfit = field === 'takeProfit' ? value : attempt.takeProfit
      const entryPrice = attempt.fill?.price ?? attempt.pendingEntryPrice
      const side = decisionAttemptSide(candidate, attempt)
      const valid = attempt.stage === 'position-open'
        ? validOpenPositionLevels(side, entryPrice, stopLoss, takeProfit)
        : validDecisionLevels(side, entryPrice, stopLoss, takeProfit)
      if (!valid) return attempt
      return { ...attempt, stopLoss, takeProfit }
    })
  }, [updateActiveDecisionAttempt])

  const updateDecisionStopLossMode = useCallback((mode: DecisionStopLossMode) => {
    updateActiveDecisionAttempt((attempt) => ['risk-setup', 'order-pending', 'position-open'].includes(attempt.stage)
      ? { ...attempt, stopLossMode: mode }
      : attempt)
  }, [updateActiveDecisionAttempt])

  const updateDecisionPositionMultiplier = useCallback((positionMultiplier: DecisionPositionMultiplier) => {
    updateActiveDecisionAttempt((attempt) => attempt.stage === 'risk-setup'
      ? { ...attempt, positionMultiplier: normalizeDecisionPositionMultiplier(positionMultiplier) }
      : attempt)
  }, [updateActiveDecisionAttempt])

  const skipActiveDecision = useCallback((reason: DecisionExit['reason'] = 'skipped') => {
    if (!activeDecisionAttempt || !activeDecisionCandidate || !decisionSignalReached) return
    const current = candleAtOrBefore(decisionSourceData, activeDecisionAttempt.cursorTime)
    const isLastDayTrade = decisionDayMode && activeDecisionSession
      && activeDecisionSession.currentIndex >= activeDecisionSession.candidates.length - 1
    completeDecisionTrade(activeDecisionAttempt, { time: activeDecisionAttempt.cursorTime, price: current?.close ?? activeDecisionCandidate.trade.entry.price, reason }, !isLastDayTrade)
  }, [activeDecisionAttempt, activeDecisionCandidate, activeDecisionSession, completeDecisionTrade, decisionDayMode, decisionSignalReached, decisionSourceData])

  const cancelPendingDecisionAndAdvance = useCallback(() => {
    if (!activeDecisionAttempt || activeDecisionAttempt.stage !== 'order-pending') return
    const next = nextCandleAfter(decisionSourceData, activeDecisionAttempt.cursorTime)
    if (!next) {
      notify('已经到达可用行情末尾，无法撤单并进入下一根 K 线')
      return
    }
    setDecisionPriceDraft(null)
    setDecisionRiskDraft(null)
    setHoverCandle(null)
    updateActiveDecisionAttempt((attempt) => ({
      ...cancelPendingOrderAndAdvance(attempt, next),
      drawings: withoutTransientMeasurements(decisionDrawings.present),
    }))
    notify('已撤单并进入下一根 K 线')
  }, [activeDecisionAttempt, decisionDrawings.present, decisionSourceData, notify, updateActiveDecisionAttempt])

  const closeActiveDecisionAtMarket = useCallback(() => {
    if (!activeDecisionAttempt?.fill || activeDecisionAttempt.stage !== 'position-open') return
    const current = candleAtOrBefore(decisionSourceData, activeDecisionAttempt.cursorTime)
    if (!current) return
    completeDecisionTrade(activeDecisionAttempt, { time: current.time, price: current.close, reason: 'manual-close' })
  }, [activeDecisionAttempt, completeDecisionTrade, decisionSourceData])

  const startDecisionReplayFromResult = useCallback((sourceSession: DecisionReplaySession | null, result: DecisionTradeResult) => {
    if (!sourceSession) {
      notify('找不到这笔历史结果所属的练习场次')
      return
    }
    const currentActiveSession = normalizedDecisionStore.activeSessionId
      ? normalizedDecisionStore.sessions.find((session) => session.id === normalizedDecisionStore.activeSessionId && session.status === 'active') ?? null
      : null
    const returnSessionId = currentActiveSession?.origin === 'review'
      ? decisionReviewReturnSessionId
      : currentActiveSession?.id ?? null
    const replaySession = createDecisionReviewSession(sourceSession, result, Date.now())
    setDecisionStore((current) => ({
      ...current,
      // A review is a new active session. The source session and its attempt
      // remain byte-for-byte untouched, and the candidate is not marked seen.
      activeSessionId: replaySession.id,
      sessions: [replaySession, ...current.sessions],
    }))
    setDecisionCenterOpen(false)
    setDecisionHistoryOpen(false)
    setDecisionResultsSessionId(null)
    setDecisionReviewReturnSessionId(returnSessionId)
    setDecisionPriceDraft(null)
    setDecisionRiskDraft(null)
    setHoverCandle(null)
    // A review must never inherit drawings from the source attempt, even when
    // both attempts happen to use the same candidate key and React keeps the
    // chart context mounted.
    decisionDrawingLoadingRef.current = true
    decisionDrawingContextRef.current = null
    dispatchDecisionDrawing({ type: 'load', drawings: [] })
    window.setTimeout(() => { decisionDrawingLoadingRef.current = false }, 0)
    setDecisionFocusTick((value) => value + 1)
    notify('已从信号 K 开始独立复盘，可重新进行完整决策')
  }, [decisionReviewReturnSessionId, normalizedDecisionStore, notify])

  const navigateDecisionExercise = useCallback((direction: -1 | 1) => {
    const session = activeDecisionSession ?? decisionResultsSession
    if (!session) {
      notify('当前没有可回看的练习')
      return
    }
    const target = adjacentDecisionExerciseTarget(session, null, direction)
    if (!target) {
      notify(direction < 0 ? '已经是本场最早可回看的练习' : '当前已经是最新练习，不能向后跳题')
      return
    }
    setDecisionCenterOpen(false)
    setDecisionHistoryOpen(false)
    setDecisionResultsSessionId(null)
    setDecisionPriceDraft(null)
    setDecisionRiskDraft(null)
    setHoverCandle(null)
    if (target.kind === 'active') {
      if (decisionSessionPracticeMode(session) === 'day-sequence') focusDecisionDayChart()
      else {
        setDecisionFocusTick((value) => value + 1)
        focusDecisionChartLatest()
      }
      notify('已返回当前最新练习')
      return
    }
    startDecisionReplayFromResult(session, target.result)
  }, [activeDecisionSession, decisionResultsSession, focusDecisionChartLatest, focusDecisionDayChart, notify, startDecisionReplayFromResult])
  const exportWorkspace = useCallback(() => {
    const snapshot = collectPortableWorkspace()
    downloadPortableWorkspace(snapshot, workspaceBackupFileName('sync'))
    notify(`同步备份已下载（${Object.keys(snapshot.entries).length} 项）`)
  }, [notify])
  const importWorkspace = useCallback((file: File) => {
    const before = collectPortableWorkspace()
    downloadPortableWorkspace(before, workspaceBackupFileName('before-import'))
    void file.text().then((raw) => {
      const snapshot = parsePortableWorkspace(raw)
      if (!snapshot) {
        notify('导入失败：文件不是有效的 K 线工作区备份')
        return
      }
      const count = restorePortableWorkspaceSafely(snapshot)
      notify(`已完整导入 ${count} 项；本机原数据已自动备份，正在刷新页面`)
      window.setTimeout(() => window.location.reload(), 250)
    }).catch((error) => notify(`导入失败，未覆盖本机记录：${error instanceof Error ? error.message : '无法读取备份文件'}`))
  }, [notify])
  const mergeWorkspaceProgress = useCallback((files: readonly File[]) => {
    if (files.length === 0) return
    const before = collectPortableWorkspace()
    downloadPortableWorkspace(before, workspaceBackupFileName('before-merge'))
    void Promise.all(files.map((file) => file.text())).then((rawSnapshots) => {
      const snapshots = rawSnapshots.map((raw, index) => {
        const snapshot = parsePortableWorkspace(raw)
        if (!snapshot) throw new Error(`第 ${index + 1} 个文件不是有效的 K 线工作区备份`)
        return snapshot
      })
      const summary = mergePortableWorkspaceProgress(snapshots, localStorage)
      notify(`已安全合并 ${summary.sourceCount} 份备份：${summary.sessionCount} 场、${summary.resultCount} 笔、${summary.favoriteCount} 个收藏，正在刷新页面`)
      window.setTimeout(() => window.location.reload(), 250)
    }).catch((error) => notify(`合并失败，本机记录未被覆盖：${error instanceof Error ? error.message : '无法读取备份文件'}`))
  }, [notify])
  const syncPrivateRepository = useCallback((scope: LocalSyncScope = 'workspace') => {
    if (privateSyncInFlightRef.current) return
    if (decisionPersistTimerRef.current !== null) {
      window.clearTimeout(decisionPersistTimerRef.current)
      decisionPersistTimerRef.current = null
    }
    saveDecisionReplayStoreSnapshot(decisionStoreRef.current)
    saveDecisionReplayFavorites(decisionFavoriteKeysRef.current)
    privateSyncInFlightRef.current = true
    setPrivateSyncBusy(true)
    setPrivateSyncOperation(scope === 'history' ? 'history-sync' : 'sync')
    setPrivateSyncStatus('syncing')
    const executeSync = async () => {
      const localWorkspace = collectPortableWorkspace()
      const before = scope === 'history' ? decisionHistoryWorkspace(localWorkspace) : localWorkspace
      const prepared = await prepareLocalPrivateSync(before, 'manual', scope)
      let summary = mergePortableWorkspaceProgress(prepared.snapshots, localStorage, { persistRecovery: false })
      let expectedHead = prepared.head
      let merged = scope === 'history' ? decisionHistoryWorkspace(collectPortableWorkspace()) : collectPortableWorkspace()
      let published = null
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          published = await publishLocalPrivateSync(expectedHead, merged, 'manual', scope)
          break
        } catch (error) {
          if (!(error instanceof LocalSyncConflictError) || attempt === 2) throw error
          summary = mergePortableWorkspaceProgress(error.snapshots, localStorage, { persistRecovery: false })
          expectedHead = error.head
          merged = scope === 'history' ? decisionHistoryWorkspace(collectPortableWorkspace()) : collectPortableWorkspace()
        }
      }
      if (!published) throw new Error('私有仓库连续发生更新，已保留本机合并结果但未报告上传成功')
      const localSha = await sha256PortableWorkspace(merged)
      const remoteSha = scope === 'history' ? published.submittedSha256 : published.sha256
      if (localSha !== remoteSha) throw new Error(`${scope === 'history' ? '做题历史' : '完整工作区'}与远端回下载 SHA-256 不一致，未报告同步成功`)
      const syncedStore = loadDecisionReplayStore()
      const syncedFavorites = loadDecisionReplayFavorites()
      decisionStoreRef.current = syncedStore
      decisionFavoriteKeysRef.current = syncedFavorites
      setDecisionStore(syncedStore)
      setDecisionFavoriteKeys(syncedFavorites)
      setPrivateSyncStatus('synced')
      notify(`${scope === 'history' ? '仅同步做题历史' : '一键同步'}完成：${summary.sessionCount} 场、${summary.resultCount} 笔、${summary.favoriteCount} 个收藏；远端已回下载校验`)
    }
    void runWithLocalPrivateSyncLock(executeSync, true).then((result) => {
      if (!result.acquired) setPrivateSyncStatus('ready')
    }).catch((error) => {
      setPrivateSyncStatus('error')
      notify(`${scope === 'history' ? '仅同步做题历史' : '一键同步'}失败：${error instanceof Error ? error.message : '未知错误'}；本机记录没有被完整覆盖`)
    }).finally(() => {
      privateSyncInFlightRef.current = false
      setPrivateSyncBusy(false)
      setPrivateSyncOperation(null)
    })
  }, [notify])

  const receivePrivateRepository = useCallback((scope: LocalSyncScope = 'workspace') => {
    if (privateSyncInFlightRef.current) return
    if (decisionPersistTimerRef.current !== null) {
      window.clearTimeout(decisionPersistTimerRef.current)
      decisionPersistTimerRef.current = null
    }
    saveDecisionReplayStoreSnapshot(decisionStoreRef.current)
    saveDecisionReplayFavorites(decisionFavoriteKeysRef.current)
    privateSyncInFlightRef.current = true
    setPrivateSyncBusy(true)
    setPrivateSyncOperation(scope === 'history' ? 'history-receive' : 'receive')
    setPrivateSyncStatus('syncing')
    const executeReceive = async () => {
      const localWorkspace = collectPortableWorkspace()
      const protectedSnapshot = scope === 'history' ? decisionHistoryWorkspace(localWorkspace) : localWorkspace
      const received = await receiveLocalPrivateSync(scope, protectedSnapshot)
      if (received.snapshots.length === 0) throw new Error('私有仓库没有可接收的备份')
      let summary
      if (scope === 'history') {
        summary = mergePortableWorkspaceProgress(received.snapshots, localStorage, { persistRecovery: false })
      } else {
        summary = receivePortableWorkspaceSnapshotsSafely(received.snapshots, localStorage, { persistRecovery: false })
      }
      const receivedStore = loadDecisionReplayStore()
      const receivedFavorites = loadDecisionReplayFavorites()
      decisionStoreRef.current = receivedStore
      decisionFavoriteKeysRef.current = receivedFavorites
      setDecisionStore(receivedStore)
      setDecisionFavoriteKeys(receivedFavorites)
      setPrivateSyncStatus('received')
      notify(`${scope === 'history' ? '仅接收做题历史' : '一键接收'}完成：${summary.sessionCount} 场、${summary.resultCount} 笔、${summary.favoriteCount} 个收藏；接收前备份已保存到 ${received.recovery.path}，本次没有上传`)
    }
    void runWithLocalPrivateSyncLock(executeReceive, true).then((result) => {
      if (!result.acquired) setPrivateSyncStatus('ready')
    }).catch((error) => {
      setPrivateSyncStatus('error')
      notify(`${scope === 'history' ? '仅接收做题历史' : '一键接收'}失败：${error instanceof Error ? error.message : '未知错误'}；本机记录没有被覆盖`)
    }).finally(() => {
      privateSyncInFlightRef.current = false
      setPrivateSyncBusy(false)
      setPrivateSyncOperation(null)
    })
  }, [notify])

  useEffect(() => {
    let cancelled = false
    void localPrivateSyncAvailable().then((available) => {
      if (cancelled) return
      setPrivateSyncStatus(available ? 'ready' : 'unavailable')
    })
    return () => {
      cancelled = true
    }
  }, [])

  const refreshCodeDeployStatus = useCallback((announce = false) => {
    if (codeDeployStatusInFlightRef.current) return
    codeDeployStatusInFlightRef.current = true
    if (announce) setCodeDeployPhase('checking')
    void loadLocalCodeStatus().then((status) => {
      const verifiedAt = new Date().toISOString()
      setCodeDeployStatus(status)
      setCodeDeployActivity((current) => ({ ...current, lastVerifiedAt: verifiedAt }))
      setCodeDeployError('')
      setCodeDeployPhase('ready')
      if (announce) notify(status.updateAvailable
        ? `发现新版本 ${status.remoteHead.slice(0, 7)}`
        : status.clean && status.localHead === status.remoteHead
          ? `代码已是最新版本 ${status.localHead.slice(0, 7)}`
          : `当前有 ${status.dirtyFiles.length} 项未发布代码修改`)
    }).catch((error) => {
      const message = error instanceof Error ? error.message : '未知错误'
      setCodeDeployError(message)
      setCodeDeployPhase(error instanceof LocalCodeDeployUnavailableError ? 'unavailable' : 'status-error')
      if (announce) notify(`代码状态检查失败：${message}；页面会自动重试`)
    }).finally(() => {
      codeDeployStatusInFlightRef.current = false
    })
  }, [notify])

  useEffect(() => {
    const timer = window.setTimeout(() => refreshCodeDeployStatus(false), 0)
    return () => window.clearTimeout(timer)
  }, [refreshCodeDeployStatus])

  useEffect(() => {
    if (codeDeployPhase !== 'unavailable' && codeDeployPhase !== 'status-error') return
    const timer = window.setInterval(() => refreshCodeDeployStatus(false), 5_000)
    return () => window.clearInterval(timer)
  }, [codeDeployPhase, refreshCodeDeployStatus])

  const publishCodeDeployment = useCallback(() => {
    if (codeDeployPhase === 'publishing' || codeDeployPhase === 'updating') return
    setCodeDeployError('')
    setCodeDeployPhase('publishing')
    void publishLocalCode().then((result) => {
      const completedAt = new Date().toISOString()
      setCodeDeployStatus((current) => current ? {
        ...current,
        localHead: result.commit,
        remoteHead: result.commit,
        localHeadTimestamp: completedAt,
        remoteHeadTimestamp: completedAt,
        dirtyFiles: [],
        clean: true,
        updateAvailable: false,
        aheadOfRemote: false,
        diverged: false,
      } : current)
      setCodeDeployActivity({
        lastVerifiedAt: completedAt,
        lastSuccessfulSync: { action: 'publish', at: completedAt, commit: result.commit },
      })
      setCodeDeployPhase('published')
      notify(`代码已部署到 GitHub：${result.commit.slice(0, 7)}，远程提交已回读验证`)
    }).catch((error) => {
      setCodeDeployError(error instanceof Error ? error.message : '未知错误')
      setCodeDeployPhase('error')
      notify(`代码发布失败：${error instanceof Error ? error.message : '未知错误'}`)
    })
  }, [codeDeployPhase, notify])

  const updateCodeDeployment = useCallback(() => {
    if (codeDeployPhase === 'publishing' || codeDeployPhase === 'updating') return
    saveDecisionReplayStoreSnapshot(decisionStoreRef.current)
    saveDecisionReplayFavorites(decisionFavoriteKeysRef.current)
    setCodeDeployError('')
    setCodeDeployPhase('updating')
    void updateLocalCode().then((result) => {
      const completedAt = new Date().toISOString()
      setCodeDeployActivity({
        lastVerifiedAt: completedAt,
        lastSuccessfulSync: { action: 'update', at: completedAt, commit: result.commit },
      })
      if (!result.restartRequired) {
        setCodeDeployStatus((current) => current ? { ...current, localHead: result.commit, remoteHead: result.commit, localHeadTimestamp: completedAt, remoteHeadTimestamp: completedAt, updateAvailable: false } : current)
        setCodeDeployPhase('ready')
        notify(`代码已是最新版本 ${result.commit.slice(0, 7)}`)
        return
      }
      notify(`新版本 ${result.commit.slice(0, 7)} 已验证，正在重启 4173…`)
      const deadline = Date.now() + 120_000
      const poll = () => {
        void loadLocalCodeStatus().then((status) => {
          if (status.localHead === result.commit) {
            window.location.reload()
            return
          }
          if (Date.now() < deadline) window.setTimeout(poll, 1500)
          else {
            setCodeDeployPhase('error')
            notify('代码已更新，但 4173 服务未在 2 分钟内恢复')
          }
        }).catch(() => {
          if (Date.now() < deadline) window.setTimeout(poll, 1500)
          else {
            setCodeDeployPhase('error')
            notify('代码已更新，但 4173 服务未在 2 分钟内恢复')
          }
        })
      }
      window.setTimeout(poll, 1500)
    }).catch((error) => {
      setCodeDeployError(error instanceof Error ? error.message : '未知错误')
      setCodeDeployPhase('error')
      notify(`代码更新失败：${error instanceof Error ? error.message : '未知错误'}`)
    })
  }, [codeDeployPhase, notify])
  const restoreLastWorkspaceImport = useCallback(() => {
    const recovery = loadPortableWorkspaceRecovery()
    if (!recovery) {
      notify('没有可恢复的导入前记录')
      return
    }
    downloadPortableWorkspace(collectPortableWorkspace(), workspaceBackupFileName('before-undo'))
    try {
      const count = restorePortableWorkspaceRecovery()
      notify(`已恢复导入/合并前的 ${count} 项本机数据，正在刷新页面`)
      window.setTimeout(() => window.location.reload(), 250)
    } catch (error) {
      notify(`恢复失败，当前记录保持不变：${error instanceof Error ? error.message : '浏览器存储写入失败'}`)
    }
  }, [notify])
  const deleteReplayRangeObject = useCallback((objectId: string) => {
    setReplayRangeLayers((current) => deleteReplayRangeObjectFromLayers(current, objectId))
    setSelectedReplayRangeId((current) => current === objectId ? null : current)
    notify('已删除震荡区间')
  }, [notify])

  const toggleReplayRangeObject = useCallback((layerId: string, objectId: string) => {
    setReplayRangeLayers((current) => toggleReplayRangeObjectInLayers(current, layerId, objectId))
    setSelectedReplayRangeId((current) => current === objectId ? null : current)
  }, [])
  const closeChartContext = useCallback(() => setChartContext(null), [])

  const openAlertAt = useCallback((price: number) => {
    setChartContext(null)
    setAlertDraft({ price })
  }, [])

  const openOrderAt = useCallback((price: number, side: PaperOrder['side'] = 'buy', type: PaperOrder['type'] = 'limit') => {
    setChartContext(null)
    setOrderDraft({ price, side, type })
  }, [])

  const handleChartContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    setQuickMeasurement(null)
    const bounds = event.currentTarget.getBoundingClientRect()
    const localX = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left))
    const localY = Math.max(0, Math.min(bounds.height, event.clientY - bounds.top))
    const position = clampContextMenuPosition(event.clientX, event.clientY, window.innerWidth, window.innerHeight)
    setChartContext({
      ...position,
      xFraction: bounds.width ? localX / bounds.width : .5,
      yFraction: bounds.height ? localY / bounds.height : .5,
      time: chartRef.current?.coordinateToTime(localX) ?? candle.time,
      price: chartRef.current?.coordinateToPrice(localY) ?? candle.close,
    })
  }

  const pasteDrawingAtContext = () => {
    const source = drawingClipboardRef.current
    if (!source || !chartContext) return
    const copy = duplicateDrawing(source, 0)
    const anchor = copy.points[0]
    const dx = chartContext.xFraction - anchor.x
    const dy = chartContext.yFraction - anchor.y
    copy.points = copy.points.map((point) => ({
      x: Math.max(0, Math.min(1, point.x + dx)),
      y: Math.max(0, Math.min(1, point.y + dy)),
    }))
    dispatchUiDrawing({ type: 'add', drawing: copy })
    notify('已在右键位置粘贴绘图对象')
  }

  const submitAlert = (draft: Omit<ChartAlert, 'id' | 'createdAt'>) => {
    setChartAlerts((current) => [...current, { ...draft, id: `alert-${Date.now()}`, createdAt: Date.now() }])
    setAlertDraft(null)
    notify(`已在 ${formatPrice(draft.price, draft.symbol)} 创建价格警报`)
  }

  const submitOrder = (draft: Omit<PaperOrder, 'id' | 'createdAt'>) => {
    setPaperOrders((current) => [...current, { ...draft, id: `order-${Date.now()}`, createdAt: Date.now() }])
    setOrderDraft(null)
    notify(`已创建${draft.side === 'buy' ? '买入' : '卖出'}模拟${draft.type === 'limit' ? '限价' : '止损'}单`)
  }

  const startReplayAt = (requestedTime: number, mode: ReplayStartMode) => {
    const time = nearestReplayTime(baseData, requestedTime)
    setReplayCursor(time)
    setReplayStartMode(mode)
    setReplayPanelOpen(true)
    setReplaySelecting(false)
    setReplayPointer(null)
    setReplayPlaying(false)
    setLive(false)
    setLiveTick(0)
    setHoverCandle(null)
  }

  const selectReplayBar = () => {
    setReplayPanelOpen(true)
    setReplayStartMode('bar')
    setReplayPlaying(false)
    setReplaySelecting(true)
    setReplayPointer(null)
  }

  const stepReplay = () => {
    if (normalizedReplayCursor === null) return
    const next = advanceReplayTime(normalizedReplayCursor, effectiveReplayResolution, baseData, chartSeconds)
    setReplayCursor(next.time)
    if (next.ended) setReplayPlaying(false)
  }

  const stepReplayBack = () => {
    const cursor = normalizedReplayCursor ?? baseData.at(-1)!.time
    setReplayCursor(Math.max(baseData[0].time, cursor - effectiveReplayResolution))
    setReplayStartMode('bar')
    setReplayPanelOpen(true)
    setReplaySelecting(false)
    setReplayPointer(null)
    setReplayPlaying(false)
    setLive(false)
    setLiveTick(0)
    setHoverCandle(null)
  }

  const jumpToRealtime = (closePanel = false) => {
    if (closePanel) setReplayPanelOpen(false)
    setReplayCursor(null)
    setReplayPlaying(false)
    setReplaySelecting(false)
    setReplayPointer(null)
    setLive(true)
    setLiveTick(0)
    saveReplaySession(null)
    window.setTimeout(() => chartRef.current?.scrollToRealtime(), 0)
    notify('已跳转到实时图表')
  }

  const toggleFullscreen = async () => {
    if (!document.fullscreenElement) await workspaceRef.current?.requestFullscreen()
    else await document.exitFullscreen()
  }

  const resetWorkspace = () => {
    clearWorkspace()
    setSymbol('XAUUSD'); setIntervalId(DEFAULT_INTERVAL); setChartType('candles'); setTheme('dark'); setIndicators(DEFAULT_INDICATORS)
    setIndicatorLegendExpanded(true)
    setCollapsedReplayRangeLayerIds([])
    setPriceScaleAuto(true); setPriceScaleLog(false); setPriceScalePercent(false); setPriceScaleInverted(false)
    dispatchDrawing({ type: 'clear' }); setActiveTool('cursor'); setMagnetMode('off'); setKeepDrawing(false); setDrawingsLocked(false)
    setQuickMeasurement(null)
    setDrawingsHidden(false); setIndicatorsHidden(false); setSyncDrawings(false); notify('已恢复默认工作区')
    setReplayPanelOpen(false); setReplaySelecting(false); setReplayCursor(null); setReplayPlaying(false); setReplayPointer(null)
    setReplaySpeedValue(10); setReplayResolutionSeconds(INTERVALS[DEFAULT_INTERVAL].seconds); setReplayAutoResolution(true); saveReplaySession(null)
  }

  const saveCurrentLayout = useCallback(() => {
    saveWorkspace({
      symbol, interval, chartType, theme, priceScaleAuto, priceScaleLog, priceScalePercent, priceScaleInverted,
      indicators, indicatorLegendExpanded, drawings: withoutTransientMeasurements(drawings.present), collapsedReplayRangeLayerIds,
    })
    notify('图表布局已保存')
  }, [chartType, collapsedReplayRangeLayerIds, drawings.present, indicatorLegendExpanded, indicators, interval, notify, priceScaleAuto, priceScaleInverted, priceScaleLog, priceScalePercent, symbol, theme])

  const loadSavedLayout = useCallback(() => {
    const layout = loadWorkspace()
    if (!layout) {
      notify('没有可加载的本地图表布局')
      return
    }
    setSymbol(layout.symbol); setIntervalId(layout.interval); setChartType(layout.chartType); setTheme(layout.theme)
    setPriceScaleAuto(layout.priceScaleAuto ?? true); setPriceScaleLog(layout.priceScaleLog ?? false)
    setPriceScalePercent(layout.priceScalePercent ?? false); setPriceScaleInverted(layout.priceScaleInverted ?? false)
    setIndicatorLegendExpanded(layout.indicatorLegendExpanded ?? true)
    setCollapsedReplayRangeLayerIds(layout.collapsedReplayRangeLayerIds ?? [])
    setIndicators(layout.indicators); dispatchDrawing({ type: 'load', drawings: withoutTransientMeasurements(layout.drawings) }); setQuickMeasurement(null)
    notify('已加载本地图表布局')
  }, [notify])

  const applyIntervalInput = (value: string) => {
    const next = parseIntervalShortcut(value)
    if (!next) {
      notify(`不支持周期“${value || '空'}”`)
      return false
    }
    setQuickMeasurement(null); setIntervalId(next); setLiveTick(0); setIntervalDialogOpen(false); setIntervalDraft('')
    return true
  }

  const takeSnapshotShortcut = useCallback(() => {
    chartRef.current?.downloadScreenshot()
    void navigator.clipboard?.writeText(window.location.href).catch(() => undefined)
    notify('图表快照已下载，当前地址已复制')
  }, [notify])

  const runQuickSearchItem = (item: QuickSearchItem) => {
    setQuickSearchOpen(false); setQuickSearchQuery('')
    if (item.toolId) {
      setQuickMeasurement(null)
      setActiveTool(item.toolId)
      return
    }
    switch (item.id) {
      case 'symbol': setSymbolQuery(''); setSymbolPickerOpen(true); break
      case 'interval': setIntervalDraft(''); setIntervalDialogOpen(true); break
      case 'indicators': setIndicatorPanelOpen(true); break
      case 'settings': setSettingsOpen(true); break
      case 'go-date': setGoToDateOpen(true); break
      case 'replay': selectReplayBar(); break
      case 'snapshot': takeSnapshotShortcut(); break
      case 'reset-chart': chartRef.current?.fitContent(); break
      case 'toggle-drawings': setDrawingsHidden((value) => !value); break
      case 'shortcut-help': setShortcutsOpen(true); break
    }
  }

  useEffect(() => {
    const keyHandler = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()

      if (event.key === 'Escape') {
        if (activeDecisionAttempt && ['entry-price', 'risk-setup'].includes(activeDecisionAttempt.stage)) {
          event.preventDefault()
          cancelDecisionSetup()
          return
        }
        shiftMeasureActiveRef.current = false
        setShiftMeasureActive(false)
        setActiveTool('cursor'); setSymbolPickerOpen(false); setIndicatorPanelOpen(false); setSettingsOpen(false); setChartMenuOpen(false)
        setQuickSearchOpen(false); setIntervalDialogOpen(false); setGoToDateOpen(false); setShortcutsOpen(false)
        setChartContext(null); setAlertDraft(null); setOrderDraft(null); setDataTableOpen(false); setObjectTreeOpen(false)
        setReplaySelecting(false); setReplayPointer(null)
        setQuickMeasurement(null)
        setSelectedReplayRangeId(null)
        dispatchUiDrawing({ type: 'select', id: null })
        return
      }
      if (isEditableShortcutTarget(event.target)) return

      const decisionNavigationDirection = decisionExerciseNavigationDirection(event)
      if (decisionNavigationDirection && (activeDecisionSession || decisionResultsSession)) {
        event.preventDefault()
        navigateDecisionExercise(decisionNavigationDirection)
        return
      }

      if (isChartAnnotationVisibilityShortcut(event)) {
        event.preventDefault()
        setChartAnnotationsHidden((hidden) => !hidden)
        return
      }

      if (activeDecisionAttempt && !mod && !event.altKey && !event.shiftKey && /^[1-5]$/.test(event.key)) {
        const action = decisionShortcutAction(activeDecisionAttempt.stage, event.key, decisionDayMode ? 'day-sequence' : 'random-count')
        // Numeric keys belong exclusively to the decision flow while a
        // question is active. During price/risk setup an unsupported number
        // must not leak through and unexpectedly change the chart timeframe.
        event.preventDefault()
        // One physical key press must perform at most one state transition.
        // Otherwise OS key-repeat can act again after an exit changes the stage.
        if (event.repeat) return
        if (action === 'advance') advanceActiveDecision()
        else if (action === 'signal-extreme') chooseSignalExtremeOrder()
        else if (action === 'free-price') chooseFreePriceOrder()
        else if (action === 'open-long') chooseDayExtremeOrder('long')
        else if (action === 'open-short') chooseDayExtremeOrder('short')
        else if (action === 'confirm-risk') confirmDecisionRisk()
        else if (action === 'cancel-setup') cancelDecisionSetup()
        else if (action === 'skip') skipActiveDecision('skipped')
        else if (action === 'cancel-pending') cancelPendingDecisionAndAdvance()
        else if (action === 'manual-close') closeActiveDecisionAtMarket()
        else if (action === 'next-trade') goToNextDecisionTrade()
        else if (action === 'restart-trade') restartActiveDecisionTrade()
        return
      }

      if (event.key === 'Shift' && activeTool === 'cursor') {
        shiftMeasureActiveRef.current = true
        setShiftMeasureActive(true)
        return
      }

      if (event.shiftKey && event.key === 'ArrowDown' && normalizedReplayCursor !== null) {
        event.preventDefault()
        if (!replayAtEnd) setReplayPlaying((value) => !value)
        return
      }
      if (event.shiftKey && event.key === 'ArrowRight' && normalizedReplayCursor !== null) {
        event.preventDefault()
        const next = advanceReplayTime(normalizedReplayCursor, effectiveReplayResolution, baseData, chartSeconds)
        setReplayCursor(next.time)
        if (next.ended) setReplayPlaying(false)
        return
      }

      if (mod && event.altKey && key === 'h') {
        event.preventDefault(); setDrawingsHidden((value) => !value); return
      }
      if (mod && key === 'k') {
        event.preventDefault(); setQuickSearchQuery(''); setQuickSearchOpen(true); return
      }
      if (mod && key === '/') {
        event.preventDefault(); setShortcutsOpen(true); return
      }
      if (mod && key === 's') {
        event.preventDefault(); saveCurrentLayout(); return
      }
      const historyShortcut = resolveHistoryShortcut(event)
      if (historyShortcut) {
        event.preventDefault(); dispatchUiDrawing({ type: historyShortcut }); return
      }
      if (mod && key === 'c' && selectedDrawing) {
        event.preventDefault(); drawingClipboardRef.current = selectedDrawing; setDrawingClipboardAvailable(true); notify('已复制绘图对象'); return
      }
      if (mod && key === 'v' && drawingClipboardRef.current) {
        event.preventDefault(); dispatchUiDrawing({ type: 'add', drawing: duplicateDrawing(drawingClipboardRef.current) }); notify('已粘贴绘图对象'); return
      }
      if (mod && event.key === 'ArrowUp') {
        event.preventDefault(); chartRef.current?.zoomVisibleRange(0.8); return
      }
      if (mod && event.key === 'ArrowDown') {
        event.preventDefault(); chartRef.current?.zoomVisibleRange(1.25); return
      }
      if (mod && event.key === 'ArrowLeft') {
        event.preventDefault(); chartRef.current?.moveVisibleRange(-40); return
      }
      if (mod && event.key === 'ArrowRight') {
        event.preventDefault(); chartRef.current?.moveVisibleRange(40); return
      }

      if (event.altKey && key === 'g') {
        event.preventDefault(); setGoToDateOpen(true); return
      }
      if (event.altKey && !event.shiftKey && key === 'a') {
        event.preventDefault(); openAlertAt(candle.close); return
      }
      if (event.altKey && event.shiftKey && (key === 'b' || key === 's')) {
        event.preventDefault(); openOrderAt(candle.close, key === 'b' ? 'buy' : 'sell', key === 'b' ? 'limit' : 'stop'); return
      }
      if (event.altKey && !event.shiftKey && key === 's') {
        event.preventDefault(); takeSnapshotShortcut(); return
      }
      if (event.altKey && !event.shiftKey && key === 'r') {
        event.preventDefault(); chartRef.current?.fitContent(); notify('图表已重置'); return
      }
      if (event.altKey && key === 'i') {
        event.preventDefault(); setPriceScaleInverted((value) => !value); notify('已切换价格坐标方向'); return
      }
      if (event.altKey && key === 'l') {
        event.preventDefault(); setPriceScaleLog((value) => !value); setPriceScalePercent(false); notify('已切换对数价格坐标'); return
      }
      if (event.altKey && key === 'p') {
        event.preventDefault(); setPriceScalePercent((value) => !value); setPriceScaleLog(false); notify('已切换百分比价格坐标'); return
      }
      if (event.altKey && key === 'z') {
        event.preventDefault(); workspaceRef.current?.focus(); notify('键盘图表导航已启用'); return
      }
      if (event.altKey && event.key === 'Enter') {
        event.preventDefault(); void toggleFullscreen(); return
      }
      if (event.altKey && key === 'w') {
        event.preventDefault(); setWatchlistOpen(true); notify(`${symbol} 已在自选列表中`); return
      }
      const drawingShortcut = event.altKey ? (
        event.shiftKey && key === 'r' ? 'rectangle' :
          key === 't' ? 'trend' : key === 'h' ? 'horizontal' : key === 'v' ? 'vertical' :
            key === 'c' ? 'cross-line' : key === 'f' ? 'fib' : null
      ) : null
      if (drawingShortcut) {
        event.preventDefault(); setQuickMeasurement(null); setActiveTool(drawingShortcut); return
      }

      if (!mod && !event.altKey && event.shiftKey && key === 't') {
        event.preventDefault(); openOrderAt(candle.close, 'buy', 'limit'); return
      }

      if (!mod && !event.altKey && event.key === '/') {
        event.preventDefault(); setIndicatorPanelOpen(true); return
      }
      if (!mod && !event.altKey && event.key === '.') {
        event.preventDefault(); loadSavedLayout(); return
      }
      if (!mod && !event.altKey && (event.key === ',' || /^\d$/.test(event.key))) {
        event.preventDefault(); setIntervalDraft(event.key === ',' ? '' : event.key); setIntervalDialogOpen(true); return
      }
      if (!mod && !event.altKey && /^[a-z]$/i.test(event.key)) {
        if (event.shiftKey && (key === 'b' || key === 's')) {
          event.preventDefault(); notify(key === 'b' ? '买入快捷键：本地演示不会发送真实订单' : '卖出快捷键：本地演示不会发送真实订单'); return
        }
        event.preventDefault(); setSymbolQuery(event.key); setSymbolPickerOpen(true); return
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && activeSelectedReplayRangeId) {
        event.preventDefault(); deleteReplayRangeObject(activeSelectedReplayRangeId); return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedDrawingIds.length) {
        event.preventDefault(); dispatchUiDrawing({ type: 'delete-many', ids: selectedDrawingIds }); return
      }
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault()
        if (selectedDrawing) {
          if (!event.repeat) dispatchUiDrawing({ type: 'checkpoint' })
          const step = event.shiftKey ? 0.02 : 0.005
          const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
          const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
          uiDrawings.present.filter((drawing) => selectedDrawingIds.includes(drawing.id)).forEach((drawing) => {
            dispatchUiDrawing({ type: 'update', id: drawing.id, patch: { points: moveDrawing(drawing, dx, dy) } })
          })
        } else if (watchlistOpen && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          const index = SYMBOLS.findIndex((item) => item.id === symbol)
          const direction = event.key === 'ArrowDown' ? 1 : -1
          const next = SYMBOLS[(index + direction + SYMBOLS.length) % SYMBOLS.length]
          setQuickMeasurement(null); setSymbol(next.id); setIntervalId(DEFAULT_INTERVAL)
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          chartRef.current?.moveVisibleRange(event.key === 'ArrowLeft' ? -1 : 1)
        }
      }
    }
    window.addEventListener('keydown', keyHandler)
    return () => window.removeEventListener('keydown', keyHandler)
  }, [activeDecisionAttempt, activeDecisionSession, activeSelectedReplayRangeId, activeTool, advanceActiveDecision, baseData, candle.close, cancelDecisionSetup, cancelPendingDecisionAndAdvance, chartSeconds, chooseDayExtremeOrder, chooseFreePriceOrder, chooseSignalExtremeOrder, closeActiveDecisionAtMarket, confirmDecisionRisk, decisionDayMode, decisionResultsSession, deleteReplayRangeObject, dispatchUiDrawing, effectiveReplayResolution, goToNextDecisionTrade, interval, loadSavedLayout, navigateDecisionExercise, normalizedReplayCursor, notify, openAlertAt, openOrderAt, priceScaleAuto, priceScaleInverted, priceScaleLog, priceScalePercent, replayAtEnd, restartActiveDecisionTrade, saveCurrentLayout, selectedDrawing, selectedDrawingIds, skipActiveDecision, symbol, takeSnapshotShortcut, uiDrawings.present, uiDrawings.selectedId, uiDrawings.selectedIds, watchlistOpen])

  useEffect(() => {
    const cancelMeasure = () => {
      if (!shiftMeasureActiveRef.current) return
      shiftMeasureActiveRef.current = false
      setShiftMeasureActive(false)
      setQuickMeasurement(null)
    }
    const releaseMeasure = (event: KeyboardEvent) => { if (event.key === 'Shift') cancelMeasure() }
    const cancelHiddenMeasure = () => { if (document.hidden) cancelMeasure() }
    window.addEventListener('keyup', releaseMeasure)
    window.addEventListener('blur', cancelMeasure)
    document.addEventListener('visibilitychange', cancelHiddenMeasure)
    return () => {
      window.removeEventListener('keyup', releaseMeasure)
      window.removeEventListener('blur', cancelMeasure)
      document.removeEventListener('visibilitychange', cancelHiddenMeasure)
    }
  }, [])

  const rangeButtons: [string, number | null][] = [
    ['1天', 86400], ['5天', 432000], ['1个月', 2592000], ['3个月', 7776000], ['6个月', 15552000], ['年初至今', 18921600], ['1年', 31536000], ['5年', 157680000], ['全部', null],
  ]

  return (
    <div className={`app theme-${theme}${objectTreeOpen ? ' object-tree-docked' : ''}`} ref={workspaceRef} tabIndex={-1}>
      <header className="topbar">
        <div className="profile-avatar" title="当前账户"><span>D</span><b>12</b></div>
        <div className="symbol-trigger-wrap">
          <button className="symbol-trigger" type="button" aria-label="选择交易品种" aria-expanded={symbolPickerOpen} onClick={() => decisionMode ? notify('决策回放中品种由当前题目锁定') : setSymbolPickerOpen((value) => !value)}>
            <span className="symbol-code">{symbol}</span><span className="symbol-shield">◇</span>
          </button>
          {symbolPickerOpen && (
            <div className="popover symbol-popover">
              <div className="popover-title"><span>商品搜索</span><button onClick={() => setSymbolPickerOpen(false)} aria-label="关闭"><X size={16} /></button></div>
              <label className="search-field"><Search size={15} /><input autoFocus value={symbolQuery} onChange={(event) => setSymbolQuery(event.target.value)} placeholder="输入代码或名称" /></label>
              <div className="symbol-list">
                {SYMBOLS.filter((item) => `${item.id}${item.name}`.toLowerCase().includes(symbolQuery.toLowerCase())).map((item) => (
                  <button key={item.id} className={item.id === symbol ? 'selected' : ''} onClick={() => { setQuickMeasurement(null); setSymbol(item.id); setIntervalId(DEFAULT_INTERVAL); setSymbolPickerOpen(false); setLiveTick(0) }}>
                    <span className="asset-dot" style={{ background: item.accent }}>{item.id.slice(0, 1)}</span>
                    <span><b>{item.id}</b><small>{item.name} · {item.exchange}</small></span>
                    {item.id === symbol && <span className="selected-check">✓</span>}
                  </button>
                ))}
              </div>
              <div className="data-disclaimer">XAUUSD/XAGUSD/US500：OANDA 5 分钟快照；XAGUSD 决策回放：OANDA:XAGUSD 冻结 5 分钟数据；BTCUSDT.P/ETHUSD：BYBIT 5 分钟回放快照</div>
            </div>
          )}
        </div>
        <IconButton label="添加商品" className="add-symbol-button" onClick={() => decisionMode ? notify('决策回放中品种由当前题目锁定') : setSymbolPickerOpen(true)}><Plus size={21} /></IconButton>
        <div className="toolbar-divider" />
        <nav className="intervals" aria-label="K线周期">
          {(Object.keys(INTERVALS) as IntervalId[]).map((id) => <button type="button" key={id} className={interval === id ? 'active' : ''} aria-pressed={interval === id} onClick={() => { setQuickMeasurement(null); setIntervalId(id); setLiveTick(0) }}>{INTERVALS[id].label}</button>)}
        </nav>
        <div className="toolbar-divider" />
        <div className="chart-type-wrap">
          <IconButton label="图表类型" active={chartMenuOpen} onClick={() => setChartMenuOpen((value) => !value)}><ChartCandlestick size={20} /><ChevronDown size={12} /></IconButton>
          {chartMenuOpen && <div className="popover chart-type-popover">{CHART_TYPES.map((item) => { const Icon = item.icon; return <button key={item.id} className={chartType === item.id ? 'selected' : ''} onClick={() => { setChartType(item.id); setChartMenuOpen(false) }}><Icon size={18} /><span>{item.label}</span>{chartType === item.id && '✓'}</button> })}</div>}
        </div>
        <button type="button" className="text-tool-button" onClick={() => setIndicatorPanelOpen(true)}><BarChart3 size={19} /><span>指标</span></button>
        <IconButton label="多图布局" className="layout-button" onClick={() => notify('当前使用单图布局')}><Grid2X2 size={20} /></IconButton>
        <div className={`replay-entry-group ${replayPanelOpen || replayCursor !== null ? 'active' : ''}`} role="group" aria-label="K线回放">
          <button type="button" disabled={decisionMode} className="replay-entry-button replay-launch-button" aria-label="选择K线回放起点" aria-pressed={replaySelecting} title="选择K线回放起点" onClick={selectReplayBar}><AlarmClockPlus size={23} /></button>
          <button type="button" disabled={decisionMode} className="replay-entry-button replay-rewind-button" aria-label="回放上一格" title="回退一格并进入回放" onClick={stepReplayBack}><Rewind size={24} /></button>
        </div>
        <button type="button" className={`decision-entry-button ${decisionMode ? 'active' : ''}`} onClick={() => setDecisionCenterOpen(true)} title="随机交易决策回放"><BrainCircuit size={20} /><span>决策回放</span>{activeDecisionSession && <b>{activeDecisionSession.currentIndex + 1}/{activeDecisionSession.candidates.length}</b>}</button>
        <button type="button" className={`decision-entry-button decision-history-button ${decisionHistoryOpen ? 'active' : ''}`} onClick={() => { setDecisionCenterOpen(false); setDecisionResultsSessionId(null); setDecisionHistoryOpen(true) }} title="查看决策历史记录（可切换当前或全部标的）" aria-label="查看决策历史记录"><History size={19} /><span>历史记录</span></button>
        <div className="toolbar-divider" />
        <IconButton label="撤销 (Ctrl+Z)" disabled={uiDrawings.past.length === 0} onClick={() => dispatchUiDrawing({ type: 'undo' })}><Undo2 size={18} /></IconButton>
        <IconButton label="重做 (Ctrl+Shift+Z)" disabled={uiDrawings.future.length === 0} onClick={() => dispatchUiDrawing({ type: 'redo' })}><Redo2 size={18} /></IconButton>
        <IconButton label="专注模式" className="focus-mode-button" onClick={toggleFullscreen}><Square size={19} /></IconButton>
        <div className="topbar-spacer" />
        <button type="button" className={`live-toggle ${marketStatus.kind === 'snapshot' ? 'snapshot' : ''} ${(marketStatus.kind === 'live' || (live && replayCursor === null)) ? 'active' : ''}`} onClick={() => {
          if (decisionMode) { notify('决策回放严格锁定在当前已知 K 线'); return }
          if (replayCursor !== null) jumpToRealtime()
          else if (isMarketHistory) { setMarketRefreshTick((value) => value + 1); notify(`正在刷新 ${marketStatus.vendor} 行情`) }
          else { setLive((value) => !value); setLiveTick(0) }
        }} title={decisionMode ? '决策回放严格因果模式' : replayCursor !== null ? '退出回放并跳转实时' : marketStatus.detail}><span className="live-dot" />{decisionMode ? '决策中' : replayCursor !== null ? '回放中' : isMarketHistory ? marketStatusLabel : live ? '模拟实时' : '已暂停'}</button>
        <IconButton label="下载图表截图" onClick={() => { chartRef.current?.downloadScreenshot(); notify('图表截图已下载') }}><Camera size={18} /></IconButton>
        <IconButton label="全屏" onClick={toggleFullscreen}><Maximize2 size={18} /></IconButton>
        <button type="button" className="save-status" onClick={() => notify('工作区已保存到本机')}><span>✓</span> 已保存</button>
        <button type="button" className="trade-button" onClick={() => notify('交易面板为界面演示，不会发送真实订单')}>交易</button>
        <button type="button" className="publish-button" onClick={() => notify('图表快照已准备发布')}>发布</button>
      </header>

      <div className="workspace-body">
        <DrawingToolbar
          activeTool={activeTool} setActiveTool={(tool) => {
            setQuickMeasurement(null)
            if (!['cursor', 'eraser'].includes(getTool(tool).behavior)) setDrawingsHidden(false)
            setActiveTool(tool)
          }} history={uiDrawings} dispatch={dispatchUiDrawing}
          favoriteTools={favoriteTools} toggleFavoriteTool={(tool) => setFavoriteTools((current) => toggleFavoriteTool(current, tool))}
          magnetMode={magnetMode} setMagnetMode={setMagnetMode} keepDrawing={keepDrawing} setKeepDrawing={setKeepDrawing}
          drawingsLocked={drawingsLocked} setDrawingsLocked={setDrawingsLocked}
          drawingsHidden={drawingsHidden} setDrawingsHidden={setDrawingsHidden}
          indicatorsHidden={indicatorsHidden} setIndicatorsHidden={setIndicatorsHidden}
          syncDrawings={syncDrawings} setSyncDrawings={setSyncDrawings}
          removeIndicators={() => setIndicators((current) => ({ ...current, ma: false, ema: false, boll: false, volume: false }))}
          notify={notify}
        />

        <main className="chart-column">
          <div
            className="chart-area"
            onContextMenu={handleChartContextMenu}
            onPointerDownCapture={(event) => {
              const target = event.target instanceof Element ? event.target : null
              setSelectedReplayRangeId(null)
              if (activeDefinition.behavior !== 'cursor' || target?.closest('.drawing-overlay')) return
              setQuickMeasurement(null)
              if (target?.closest('button, input, select, textarea, .popover, .floating-tool-options, .reference-quick-tools')) return
              const bounds = event.currentTarget.getBoundingClientRect()
              const point = { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height }
              const drawing = [...uiDrawings.present].reverse().find((item) => {
                if (drawingsLocked || item.locked) return false
                const projected = {
                  ...item,
                  points: item.points.map((drawingPoint) => {
                    if (!Number.isFinite(drawingPoint.time) || !Number.isFinite(drawingPoint.price)) return drawingPoint
                    const x = chartRef.current?.timeToCoordinate(drawingPoint.time!)
                    const y = chartRef.current?.priceToCoordinate(drawingPoint.price!)
                    return typeof x === 'number' && typeof y === 'number'
                      ? { ...drawingPoint, x: x / bounds.width, y: y / bounds.height }
                      : drawingPoint
                  }),
                }
                return hitTestDrawing(projected, point, bounds.width, bounds.height)
              })
              if (!drawing) return
              event.preventDefault()
              event.stopPropagation()
              dispatchUiDrawing({ type: 'select', id: drawing.id, additive: event.ctrlKey || event.metaKey })
            }}
          >
            <ChartSurface
              ref={chartRef} data={data} symbol={symbol} interval={interval} chartType={chartType} theme={theme}
              indicators={visibleIndicators} priceScaleAuto={priceScaleAuto} priceScaleLog={priceScaleLog}
              priceScalePercent={priceScalePercent} priceScaleInverted={priceScaleInverted}
              visibleTradeLayerSourceIds={decisionDayMode ? decisionDayTradeSourceIds : decisionMode ? [] : visibleTradeLayerSourceIds}
              decisionSignalSourceIds={decisionSignalSourceIds}
              // Keep every signal and system execution that has already been
              // revealed. Collision handling must move the interactive labels;
              // it must never erase earlier replay context.
              decisionSignalAfterTime={null}
              visibleRangeLayerSourceIds={decisionMode ? [] : visibleRangeLayerSourceIds}
              suppressedRangeObjectIds={suppressedRangeObjectIds}
              selectedRangeObjectId={activeSelectedReplayRangeId}
              onSelectRangeObject={(id) => {
                setActiveTool('cursor')
                dispatchUiDrawing({ type: 'select', id: null })
                setSelectedReplayRangeId(id)
              }}
              followLatest={!decisionMode && marketStatus.kind === 'live' && replayCursor === null}
              focusLatestKey={marketHydrationKey + (decisionMode && !decisionDayMode ? 10_000 + decisionFocusTick : 0)}
              suppressAutoFocus={decisionDayMode}
              centerLatestByDefault={decisionMode && !decisionDayMode}
              markersHidden={chartAnnotationsHidden}
              onHover={setHoverCandle}
              onViewportChange={refreshDrawingProjection}
              onPriceScaleStateChange={(autoScale, logarithmic, percentage, inverted) => {
                setPriceScaleAuto(autoScale)
                setPriceScaleLog(logarithmic)
                setPriceScalePercent(percentage)
                setPriceScaleInverted(inverted)
              }}
            />
            {activeDecisionSession && activeDecisionCandidate && activeDecisionAttempt && <DecisionChartStatus
              session={activeDecisionSession}
              attempt={activeDecisionAttempt}
              currentPnlByMode={decisionPositionPnlByMode}
              systemTrades={decisionSystemTrades}
              systemCurrentPnlByMode={decisionSystemPnlByMode}
              systemCurrentPnlLocked={decisionSystemPnlLocked}
              positionSizingModes={activeDecisionPositionSizingModes}
            />}
            {contextOverlayPositions.lockedCursorX !== null && <div className="locked-time-cursor" data-testid="locked-time-cursor" style={{ left: contextOverlayPositions.lockedCursorX }}><span>{new Date(lockedCursorTime! * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</span></div>}
            {!decisionMode && chartAlerts.filter((alert) => alert.symbol === symbol).map((alert) => contextOverlayPositions.alertY[alert.id] === null || contextOverlayPositions.alertY[alert.id] === undefined ? null : <div className="context-price-line alert" data-testid="alert-price-line" key={alert.id} style={{ top: contextOverlayPositions.alertY[alert.id]! }}><span>警报 {formatPrice(alert.price, symbol)}</span></div>)}
            {!decisionMode && paperOrders.filter((order) => order.symbol === symbol).map((order) => contextOverlayPositions.orderY[order.id] === null || contextOverlayPositions.orderY[order.id] === undefined ? null : <div className={`context-price-line order-${order.side}`} data-testid="paper-order-line" key={order.id} style={{ top: contextOverlayPositions.orderY[order.id]! }}><span>{order.side === 'buy' ? '买' : '卖'} {order.quantity} @ {formatPrice(order.price, symbol)}</span></div>)}
            <div className="chart-header">
              <div className="instrument-line">
                <span className="asset-dot" style={{ background: symbolInfo.accent }}>{symbol === 'XAUUSD' ? '◆' : symbolInfo.id.slice(0, 1)}</span>
                <strong>{symbolInfo.name}</strong><span className="muted">· {INTERVALS[interval].label.replace('分', '')} · {symbolInfo.exchange}</span>
                <span className="series-toggle">−</span>
                {marketStatus.kind === 'simulated'
                  ? <span className="sim-badge">模拟数据</span>
                  : <span className={`market-data-badge ${marketStatus.kind}`} data-testid="market-data-status" title={`${marketStatus.detail}${marketStatus.fetchedAt ? ` · 截止 ${new Date(marketStatus.fetchedAt * 1000).toLocaleString('zh-CN', { timeZone: 'UTC', hour12: false })} UTC` : ''}`}>{marketStatusLabel}</span>}
                {replayCursor !== null && <span className="replay-badge"><History size={12} />回放</span>}
                {decisionMode && <span className="decision-causal-badge"><BrainCircuit size={12} />严格因果 · 未来 K 线已隐藏</span>}
                <span className="market-status"><i />市场开放</span>
              </div>
              <div className="ohlc-line">
                <span>开=<b>{formatPrice(candle.open, symbol)}</b></span><span>高=<b>{formatPrice(candle.high, symbol)}</b></span><span>低=<b>{formatPrice(candle.low, symbol)}</b></span><span>收=<b>{formatPrice(candle.close, symbol)}</b></span>
                <span className={change >= 0 ? 'positive' : 'negative'}>{change >= 0 ? '+' : ''}{formatPrice(change, symbol)} ({changePercent >= 0 ? '+' : ''}{changePercent.toFixed(2)}%)</span>
              </div>
            </div>
            <button type="button" className="currency-selector" onClick={() => notify('当前价格单位：美元')}>美元<ChevronDown size={16} /></button>
            <div className="price-scale-controls" role="group" aria-label="价格坐标模式">
              <button
                type="button"
                className={priceScaleAuto ? 'active' : ''}
                aria-label="自动跳转到最新K线"
                data-tooltip="自动跳转到最新K线"
                onClick={() => {
                  setPriceScaleAuto(true)
                  chartRef.current?.focusLatest()
                }}
              >A</button>
              <button
                type="button"
                className={priceScaleLog ? 'active' : ''}
                aria-label="对数价格坐标"
                aria-pressed={priceScaleLog}
                data-tooltip="对数"
                onClick={() => { setPriceScaleLog((value) => !value); setPriceScalePercent(false) }}
              >L</button>
            </div>
            {activeDefinition.behavior === 'cursor' && !selectedDrawing && favoriteTools.length > 0 && <QuickDrawingToolbar
              favoriteTools={favoriteTools}
              onSelectTool={(toolId) => { setQuickMeasurement(null); setActiveTool(toolId) }}
              onOpenSettings={() => setSettingsOpen(true)}
            />}
            <DrawingOverlay
              key={`${decisionContextKey ?? 'normal'}-${effectiveDrawingTool}-${drawingsLocked}-${drawingsHidden}`}
              activeTool={effectiveDrawingTool} history={uiDrawings} dispatch={dispatchUiDrawing} color={drawingColor}
              magnetMode={magnetMode} drawingsLocked={drawingsLocked} hidden={drawingsHidden}
              candles={data} symbol={symbol} interval={interval}
              quickMeasurement={quickMeasurement}
              onMeasurePoint={(point) => chartRef.current?.measurementAt(point.x, point.y) ?? null}
              onProjectPoint={(point) => {
                const x = chartRef.current?.timeToCoordinate(point.time)
                const y = chartRef.current?.priceToCoordinate(point.price)
                return typeof x === 'number' && typeof y === 'number' ? { x, y } : null
              }}
              onQuickMeasurementChange={setQuickMeasurement}
              onToolComplete={() => { if (shouldExitDrawingMode(effectiveDrawingTool, keepDrawing)) setActiveTool('cursor') }}
              onZoomSelection={(from, to) => chartRef.current?.zoomToFraction(from, to)}
              onOpenProperties={(drawing) => setDrawingSettingsId(drawing.id)}
            />
            {decisionSubject && decisionSignalReached && <DecisionChartAnnotations
              candidate={decisionSubject}
              latestSignal={latestRevealedDecisionSignal}
              attempt={activeDecisionAttempt}
              result={activeDecisionAttempt?.result ?? null}
              historicalResults={activeDecisionHistoricalResults}
              data={data}
              toX={(time) => chartRef.current?.timeToCoordinate(time) ?? null}
              toY={(price) => chartRef.current?.priceToCoordinate(price) ?? null}
              hidden={chartAnnotationsHidden}
            />}
            {activeDecisionCandidate && activeDecisionAttempt && <DecisionReplayPanel
              candidate={activeDecisionCandidate}
              latestSignal={latestRevealedDecisionSignal}
              attempt={activeDecisionAttempt}
              ordinal={(activeDecisionSession?.currentIndex ?? 0) + 1}
              total={activeDecisionSession?.candidates.length ?? 0}
              currentClose={decisionPositionCandle?.close ?? null}
              currentPnlByMode={decisionPositionPnlByMode}
              positionSizingModes={activeDecisionPositionSizingModes}
              independentReview={activeDecisionSession?.origin === 'review'}
              preSignal={decisionDayMode ? latestRevealedDecisionSignal === null : !decisionSignalReached}
              daySequenceMode={decisionDayMode}
              canAdvanceTrade={!decisionDayMode
                || (activeDecisionSession?.currentIndex ?? 0) < (activeDecisionSession?.candidates.length ?? 0) - 1}
              favorite={decisionFavoriteKeys.includes(decisionReplayFavoriteKey('trade', activeDecisionCandidate.key))}
              onToggleFavorite={() => setDecisionFavoriteKeys((current) => toggleDecisionReplayFavorite(
                current,
                decisionReplayFavoriteKey('trade', activeDecisionCandidate.key),
              ))}
              onAdvance={advanceActiveDecision}
              onSignalExtreme={chooseSignalExtremeOrder}
              onFreePrice={chooseFreePriceOrder}
              onOpenLong={() => chooseDayExtremeOrder('long')}
              onOpenShort={() => chooseDayExtremeOrder('short')}
              onSkip={() => skipActiveDecision('skipped')}
              onManualClose={closeActiveDecisionAtMarket}
              onCancelPending={cancelPendingDecisionAndAdvance}
              onNextTrade={goToNextDecisionTrade}
              onRestartTrade={restartActiveDecisionTrade}
              onStop={stopDecisionSession}
            />}
            {activeDecisionCandidate && activeDecisionAttempt?.stage === 'entry-price' && decisionPriceDraft !== null && <DecisionPricePicker
              value={decisionPriceDraft}
              symbol={activeDecisionCandidate.symbol}
              toPrice={(y) => chartRef.current?.coordinateToPrice(y) ?? null}
              toY={(price) => chartRef.current?.priceToCoordinate(price) ?? null}
              onChange={setDecisionPriceDraft}
              onConfirm={confirmDecisionPrice}
              onCancel={cancelDecisionSetup}
            />}
            {activeDecisionCandidate && activeDecisionAttempt?.stage === 'risk-setup' && activeDecisionAttempt.pendingEntryPrice !== null && effectiveDecisionRiskDraft && <DecisionRiskOverlay
              candidate={activeDecisionCandidate}
              side={activeDecisionUserSide ?? undefined}
              stopLossMode={decisionStopLossMode(activeDecisionAttempt.stopLossMode)}
              onStopLossMode={updateDecisionStopLossMode}
              entryPrice={activeDecisionAttempt.pendingEntryPrice}
              stopLoss={effectiveDecisionRiskDraft.stopLoss}
              takeProfit={effectiveDecisionRiskDraft.takeProfit}
              positionMultiplier={activeDecisionPositionMultiplier}
              onPositionMultiplierChange={updateDecisionPositionMultiplier}
              entryLabel={activeDecisionAttempt.orderKind === 'stop' ? '追单价' : activeDecisionAttempt.orderKind === 'limit' ? '挂单价' : '开仓价'}
              currentCandleX={decisionCurrentCandleX}
              positionSizingModes={activeDecisionPositionSizingModes}
              toPrice={(y) => chartRef.current?.coordinateToPrice(y) ?? null}
              toY={(price) => chartRef.current?.priceToCoordinate(price) ?? null}
              onEntryPrice={moveDecisionPendingEntry}
              onStopLoss={(stopLoss) => setDecisionRiskDraft((current) => ({ ...(current ?? effectiveDecisionRiskDraft), stopLoss }))}
              onTakeProfit={(takeProfit) => setDecisionRiskDraft((current) => ({ ...(current ?? effectiveDecisionRiskDraft), takeProfit }))}
              onConfirm={confirmDecisionRisk}
              onCancel={cancelDecisionSetup}
            />}
            {activeDecisionCandidate && activeDecisionAttempt && (activeDecisionAttempt.stage === 'order-pending' || activeDecisionAttempt.stage === 'position-open') && (activeDecisionAttempt.fill?.price ?? activeDecisionAttempt.pendingEntryPrice) !== null && activeDecisionAttempt.stopLoss !== null && activeDecisionAttempt.takeProfit !== null && <DecisionRiskOverlay
              candidate={activeDecisionCandidate}
              side={activeDecisionUserSide ?? undefined}
              stopLossMode={decisionStopLossMode(activeDecisionAttempt.stopLossMode)}
              onStopLossMode={updateDecisionStopLossMode}
              entryPrice={activeDecisionAttempt.fill?.price ?? activeDecisionAttempt.pendingEntryPrice!}
              entryLabel={activeDecisionAttempt.stage === 'position-open' ? '开仓' : '挂单'}
              stopLoss={activeDecisionAttempt.stopLoss}
              takeProfit={activeDecisionAttempt.takeProfit}
              positionMultiplier={activeDecisionPositionMultiplier}
              initialStopLoss={decisionAttemptInitialStopLoss(activeDecisionCandidate, activeDecisionAttempt) ?? activeDecisionAttempt.stopLoss}
              currentCandleX={decisionCurrentCandleX}
              currentClose={activeDecisionAttempt.stage === 'position-open' ? decisionPositionCandle?.close ?? null : null}
              currentPnlByMode={activeDecisionAttempt.stage === 'position-open' ? decisionPositionPnlByMode : null}
              positionSizingModes={activeDecisionPositionSizingModes}
              toPrice={(y) => chartRef.current?.coordinateToPrice(y) ?? null}
              toY={(price) => chartRef.current?.priceToCoordinate(price) ?? null}
              onStopLoss={(stopLoss) => updateActiveDecisionRisk('stopLoss', stopLoss)}
              onTakeProfit={(takeProfit) => updateActiveDecisionRisk('takeProfit', takeProfit)}
              onConfirm={() => undefined}
              onCancel={() => undefined}
              editable
              showConfirmControls={false}
            />}
            {!decisionMode && replaySelecting && <div
              className="replay-selection-overlay"
              data-testid="replay-selection-overlay"
              onMouseMove={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect()
                const x = event.clientX - bounds.left
                const time = chartRef.current?.coordinateToTime(x)
                if (time !== null && time !== undefined) setReplayPointer({ x, time: nearestReplayTime(baseData, time) })
              }}
              onMouseLeave={() => setReplayPointer(null)}
              onClick={() => { if (replayPointer) startReplayAt(replayPointer.time, 'bar') }}
            >
              <div className="replay-select-hint"><Scissors size={16} />点击一根 K 线作为回放起点 <kbd>Esc</kbd> 取消</div>
              {replayPointer && <div className="replay-cut-line" style={{ left: replayPointer.x }}>
                <Scissors size={19} />
                <span>{new Date(replayPointer.time * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
              </div>}
            </div>}
            <IndicatorLegend
              data={data}
              candle={hoverCandle ?? data.at(-1) ?? null}
              symbol={symbol}
              interval={interval}
              indicators={indicators}
              indicatorsHidden={indicatorsHidden}
              expanded={indicatorLegendExpanded}
              onExpandedChange={setIndicatorLegendExpanded}
              onToggle={(key) => {
                setIndicatorsHidden(false)
                setIndicators((current) => ({ ...current, [key]: !current[key] }))
              }}
              onOpenSettings={() => setIndicatorPanelOpen(true)}
              onRefresh={() => notify('指标已重新计算')}
            />
            {selectedDrawing && <div className="floating-tool-options drawing-properties" data-testid="drawing-properties">
              {['fib', 'fib-extension'].includes(selectedDrawing.behavior)
                ? <button type="button" className="property-tool-glyph property-settings-trigger" aria-label="打开斐波那契设置" title="斐波那契设置" onClick={() => setDrawingSettingsId(selectedDrawing.id)}>{getTool(selectedDrawing.tool).glyph}</button>
                : <span className="property-tool-glyph">{getTool(selectedDrawing.tool).glyph}</span>}
              <strong>{selectedDrawing.label}</strong>
              <input aria-label="绘图颜色" type="color" value={selectedDrawing.color} onPointerDown={() => dispatchUiDrawing({ type: 'checkpoint' })} onChange={(event) => { setDrawingColor(event.target.value); dispatchUiDrawing({ type: 'update', id: selectedDrawing.id, patch: { color: event.target.value } }) }} />
              <select aria-label="线型" value={selectedDrawing.lineStyle ?? 'solid'} onChange={(event) => { dispatchUiDrawing({ type: 'checkpoint' }); dispatchUiDrawing({ type: 'update', id: selectedDrawing.id, patch: { lineStyle: event.target.value as 'solid' | 'dashed' | 'dotted' } }) }}><option value="solid">实线</option><option value="dashed">虚线</option><option value="dotted">点线</option></select>
              <input className="width-range" aria-label="线宽" type="range" min="1" max="14" step="0.5" value={selectedDrawing.width} onPointerDown={() => dispatchUiDrawing({ type: 'checkpoint' })} onKeyDown={(event) => { if (!event.repeat) dispatchUiDrawing({ type: 'checkpoint' }) }} onChange={(event) => dispatchUiDrawing({ type: 'update', id: selectedDrawing.id, patch: { width: Number(event.target.value) } })} />
              <button onClick={() => { dispatchUiDrawing({ type: 'checkpoint' }); dispatchUiDrawing({ type: 'update', id: selectedDrawing.id, patch: { locked: !selectedDrawing.locked } }) }} title={selectedDrawing.locked ? '解锁绘图' : '锁定绘图'}><Lock size={15} /></button>
              <button onClick={() => dispatchUiDrawing({ type: 'delete', id: selectedDrawing.id })} title="删除选中绘图"><Trash2 size={15} /></button>
              <button onClick={() => { setActiveTool('cursor'); dispatchUiDrawing({ type: 'select', id: null }) }} title="退出绘图"><X size={15} /></button>
            </div>}
            <div className="chart-watermark"><span>TV</span><div><b>K线工坊</b><small>专业模拟行情工作台</small></div></div>
            {watchlistOpen && <Watchlist active={symbol} onSelect={(id) => { setQuickMeasurement(null); setSymbol(id); setIntervalId(DEFAULT_INTERVAL); setLiveTick(0) }} onClose={() => setWatchlistOpen(false)} />}
          </div>

          {!decisionMode && replayPanelOpen && <ReplayToolbar
            active={replayCursor !== null}
            selecting={replaySelecting}
            playing={replayPlaying}
            startMode={replayStartMode}
            speed={replaySpeedValue}
            interval={interval}
            resolutionSeconds={effectiveReplayResolution}
            autoResolution={replayAutoResolution}
            atEnd={replayAtEnd}
            firstTime={baseData[0].time}
            lastTime={baseData.at(-1)!.time}
            cursorTime={normalizedReplayCursor}
            onSelectBar={selectReplayBar}
            onSelectDate={(time) => startReplayAt(time, 'date')}
            onFirstAvailable={() => startReplayAt(baseData[0].time, 'first')}
            onRandomBar={() => {
              const lower = Math.floor(baseData.length * 0.08)
              const upper = Math.max(lower + 1, Math.floor(baseData.length * 0.82))
              const index = lower + Math.floor(Math.random() * (upper - lower))
              startReplayAt(baseData[index].time, 'random')
            }}
            onPlayPause={() => { if (!replayAtEnd) setReplayPlaying((value) => !value) }}
            onStepBack={stepReplayBack}
            onStep={stepReplay}
            onSpeed={setReplaySpeedValue}
            onResolution={(seconds, automatic) => { setReplayResolutionSeconds(seconds); setReplayAutoResolution(automatic) }}
            onRealtime={jumpToRealtime}
            onClose={() => jumpToRealtime(true)}
          />}

          <footer className="bottom-bar">
            <div className="ranges">{rangeButtons.map(([label, seconds]) => <button key={label} type="button" onClick={() => chartRef.current?.showDuration(seconds)}>{label}</button>)}</div>
            <button className="goto-button" title="适应全部数据" onClick={() => chartRef.current?.fitContent()}><ChevronsLeft size={17} /><span>适应</span></button>
            <div className="bottom-spacer" />
            <span className="clock">{clock.toLocaleTimeString('zh-CN', { hour12: false })} UTC+8</span>
          </footer>
        </main>

        <aside className="right-toolbar" aria-label="右侧工具">
          <IconButton label="自选列表" active={watchlistOpen} onClick={() => setWatchlistOpen((value) => !value)}><List size={21} /></IconButton>
          <IconButton label="价格提醒" onClick={() => openAlertAt(candle.close)}><AlarmClock size={21} /></IconButton>
          <IconButton label="对象树" active={objectTreeOpen} onClick={() => setObjectTreeOpen((value) => !value)}><Layers3 size={21} /></IconButton>
          <IconButton label="消息中心" onClick={() => notify('当前没有新消息')}><MessageSquare size={21} /></IconButton>
          <IconButton label="数据窗口" active={dataTableOpen} onClick={() => setDataTableOpen(true)}><Database size={21} /></IconButton>
          <IconButton label="市场概览" onClick={() => notify('市场概览已同步当前商品')}><Activity size={21} /></IconButton>
          <IconButton label="技术分析" onClick={() => setIndicatorPanelOpen(true)}><TrendingUp size={21} /></IconButton>
          <IconButton label="经济日历" onClick={() => notify('经济日历为本地演示数据')}><CalendarDays size={21} /></IconButton>
          <IconButton label="资讯流" onClick={() => notify('资讯流未连接外部服务')}><Radio size={21} /></IconButton>
          <IconButton label="通知" onClick={() => notify('没有待处理通知')}><Bell size={21} /></IconButton>
          <div className="tool-spacer" />
          <IconButton label={theme === 'dark' ? '切换亮色主题' : '切换深色主题'} onClick={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={21} /> : <Moon size={21} />}</IconButton>
          <IconButton label="图表设置" active={settingsOpen} onClick={() => setSettingsOpen((value) => !value)}><Settings2 size={21} /></IconButton>
          <IconButton label="帮助" onClick={() => setShortcutsOpen(true)}><CircleHelp size={21} /></IconButton>
        </aside>
      </div>

      {chartContext && <ChartContextMenu
        value={chartContext}
        symbol={symbol}
        priceLabel={formatPrice(chartContext.price, symbol)}
        drawingsCount={uiDrawings.present.length}
        indicatorsCount={activeIndicatorCount}
        clipboardAvailable={drawingClipboardAvailable}
        cursorLocked={lockedCursorTime !== null}
        onClose={closeChartContext}
        onReset={() => { setPriceScaleAuto(true); chartRef.current?.fitContent(); notify('图表视图已重置') }}
        onCopyPrice={() => {
          const text = formatPrice(chartContext.price, symbol)
          void copyTextToClipboard(text).then((copied) => notify(copied ? `已复制价格 ${text}` : '无法访问系统剪贴板'))
        }}
        onPaste={pasteDrawingAtContext}
        onAlert={() => openAlertAt(chartContext.price)}
        onBuy={() => openOrderAt(chartContext.price, 'buy', 'limit')}
        onSell={() => openOrderAt(chartContext.price, 'sell', 'stop')}
        onOrder={() => openOrderAt(chartContext.price, 'buy', 'limit')}
        onToggleCursorLock={() => setLockedCursorTime((current) => current === null ? chartContext.time : null)}
        onTable={() => setDataTableOpen(true)}
        onObjectTree={() => setObjectTreeOpen(true)}
        onSaveTemplate={saveCurrentLayout}
        onApplyTemplate={loadSavedLayout}
        onResetTemplate={() => { setIndicators(DEFAULT_INDICATORS); notify('已恢复默认指标模板') }}
        onRemoveDrawings={() => { dispatchUiDrawing({ type: 'clear' }); notify('已移除全部绘图') }}
        onRemoveIndicators={() => { setIndicators((current) => ({ ...current, ma: false, ema: false, boll: false, volume: false })); notify('已移除全部指标') }}
        onSettings={() => setSettingsOpen(true)}
      />}

      {alertDraft && <AlertDialog symbol={symbol} price={alertDraft.price} onSubmit={submitAlert} onClose={() => setAlertDraft(null)} />}
      {orderDraft && <OrderDialog symbol={symbol} price={orderDraft.price} initialSide={orderDraft.side} initialType={orderDraft.type} onSubmit={submitOrder} onClose={() => setOrderDraft(null)} />}
      {dataTableOpen && <DataTableDialog symbol={symbol} data={data} onClose={() => setDataTableOpen(false)} />}
      {objectTreeOpen && <ObjectTreeDialog
        drawings={uiDrawings.present}
        alerts={decisionMode ? [] : chartAlerts.filter((alert) => alert.symbol === symbol)}
        orders={decisionMode ? [] : paperOrders.filter((order) => order.symbol === symbol)}
        // Object Tree follows the active chart resolution just like TradingView:
        // a 15-minute replay/order layer is not listed while the chart is on 5m.
        replayTradeLayers={decisionMode ? [] : replayTradeLayers.filter((layer) => layer.symbol === symbol && layer.interval === interval)}
        replayRangeLayers={decisionMode ? [] : replayRangeLayers.filter((layer) => layer.symbol === symbol && layer.interval === interval)}
        selectedReplayRangeId={activeSelectedReplayRangeId}
        collapsedReplayRangeLayerIds={collapsedReplayRangeLayerIds.filter((id) => replayRangeLayers.some((layer) => (
          layer.id === id && layer.symbol === symbol && layer.interval === interval
        )))}
        onSelectDrawing={(id) => { setActiveTool('cursor'); dispatchUiDrawing({ type: 'select', id }) }}
        onDeleteDrawing={(id) => dispatchUiDrawing({ type: 'delete', id })}
        onDeleteAlert={(id) => setChartAlerts((current) => current.filter((alert) => alert.id !== id))}
        onDeleteOrder={(id) => setPaperOrders((current) => current.filter((order) => order.id !== id))}
        onToggleReplayTradeLayer={(id) => setReplayTradeLayers((current) => current.map((layer) => layer.id === id ? { ...layer, visible: !layer.visible } : layer))}
        onRenameReplayTradeLayer={(id, name) => {
          setReplayTradeLayers((current) => current.map((layer) => layer.id === id ? { ...layer, name } : layer))
          notify('模拟订单图层已重命名')
        }}
        onDeleteReplayTradeLayer={(id) => {
          setReplayTradeLayers((current) => current.filter((layer) => layer.id !== id))
          notify('已删除整批回放交易图层')
        }}
        onToggleReplayRangeLayer={(id) => {
          setReplayRangeLayers((current) => current.map((layer) => layer.id === id ? { ...layer, visible: !layer.visible } : layer))
          setSelectedReplayRangeId(null)
        }}
        onSetReplayRangeLayerCollapsed={(id, collapsed) => {
          setCollapsedReplayRangeLayerIds((current) => {
            const next = new Set(current)
            if (collapsed) next.add(id)
            else next.delete(id)
            return [...next]
          })
        }}
        onDeleteReplayRangeLayer={(id) => {
          setReplayRangeLayers((current) => current.filter((layer) => layer.id !== id))
          setSelectedReplayRangeId(null)
          notify('已删除整批回放震荡区间图层')
        }}
        onSelectReplayRange={(id, startTime, endTime) => {
          setActiveTool('cursor')
          dispatchDrawing({ type: 'select', id: null })
          setSelectedReplayRangeId(id)
          window.setTimeout(() => chartRef.current?.goToTime((startTime + endTime) / 2), 0)
        }}
        onToggleReplayRangeObject={toggleReplayRangeObject}
        onDeleteReplayRangeObject={deleteReplayRangeObject}
        onClose={() => setObjectTreeOpen(false)}
      />}

      {indicatorPanelOpen && <IndicatorPanel value={indicators} onChange={setIndicators} onClose={() => setIndicatorPanelOpen(false)} />}
      {settingsOpen && <SettingsPanel theme={theme} onTheme={setTheme} onReset={resetWorkspace} onExportWorkspace={exportWorkspace} onMergeProgress={mergeWorkspaceProgress} onPrivateReceive={() => receivePrivateRepository('workspace')} onPrivateSync={() => syncPrivateRepository('workspace')} onHistoryReceive={() => receivePrivateRepository('history')} onHistorySync={() => syncPrivateRepository('history')} privateSyncBusy={privateSyncBusy} privateSyncOperation={privateSyncOperation} privateSyncStatus={privateSyncStatus} codeDeployPhase={codeDeployPhase} codeDeployStatus={codeDeployStatus} codeDeployError={codeDeployError} codeDeployActivity={codeDeployActivity} onCodeDeployRefresh={() => refreshCodeDeployStatus(true)} onCodePublish={publishCodeDeployment} onCodeUpdate={updateCodeDeployment} onImportWorkspace={importWorkspace} onRestoreLastImport={restoreLastWorkspaceImport} canRestoreWorkspace={Boolean(loadPortableWorkspaceRecovery())} onClose={() => setSettingsOpen(false)} />}
      {quickSearchOpen && <QuickSearchDialog items={quickSearchItems} query={quickSearchQuery} onQuery={setQuickSearchQuery} onSelect={runQuickSearchItem} onClose={() => setQuickSearchOpen(false)} />}
      {intervalDialogOpen && <IntervalShortcutDialog value={intervalDraft} onChange={setIntervalDraft} onApply={applyIntervalInput} onClose={() => setIntervalDialogOpen(false)} />}
      {goToDateOpen && <GoToDateDialog initialTime={data.at(-1)?.time ?? 0} onSelect={(time) => { chartRef.current?.goToTime(time); setGoToDateOpen(false); notify('已转到指定日期') }} onClose={() => setGoToDateOpen(false)} />}
      {shortcutsOpen && <ShortcutHelpDialog onClose={() => setShortcutsOpen(false)} />}
      {drawingSettingsTarget && ['fib', 'fib-extension'].includes(drawingSettingsTarget.behavior) && <FibSettingsDialog
        drawing={drawingSettingsTarget}
        logScale={priceScaleLog}
        onApply={(settings, points, label) => {
          dispatchUiDrawing({ type: 'checkpoint' })
          dispatchUiDrawing({ type: 'update', id: drawingSettingsTarget.id, patch: { fib: settings, points, label } })
          setDrawingSettingsId(null)
          notify('斐波那契回撤设置已更新')
        }}
        onClose={() => setDrawingSettingsId(null)}
      />}
      <DecisionReplayCenter
        key={decisionSymbolStats.map((item) => `${item.symbol}:${item.intervals.map((stat) => `${stat.interval}:${stat.total}:${stat.remaining}`).join(',')}`).join('|')}
        open={decisionCenterOpen}
        availableCount={availableDecisionCount}
        totalCount={decisionSymbolStats.reduce((sum, item) => sum + item.total, 0)}
        symbolStats={decisionSymbolStats}
        aiDaySummariesByMode={decisionAiDaySummariesByMode}
        availableCandidateKeys={allDecisionCandidates.map((candidate) => candidate.key)}
        seenTradeKeys={normalizedDecisionStore.seenTradeKeys}
        sessions={normalizedDecisionStore.sessions}
        activeSessionId={normalizedDecisionStore.activeSessionId}
        favoriteKeys={decisionFavoriteKeys}
        onToggleFavorite={(key) => setDecisionFavoriteKeys((current) => toggleDecisionReplayFavorite(current, key))}
        onClose={() => setDecisionCenterOpen(false)}
        onStart={beginDecisionSession}
        anomalyCount={decisionAnomalyCount}
        anomalyUnavailableCount={decisionAnomalies.length - replayableDecisionAnomalies.length}
        anomalyLoading={!availableDecisionHistoryBySymbol.XAUUSD?.length}
        onRedoAnomalies={beginAnomalyReview}
        onContinue={() => { setDecisionCenterOpen(false); setDecisionResultsSessionId(null); focusCurrentDecisionChart() }}
        onResults={(sessionId) => { setDecisionCenterOpen(false); setDecisionResultsSessionId(sessionId) }}
      />
      <DecisionHistoryDialog
        key={`${symbol}-${decisionHistoryOpen ? 'open' : 'closed'}`}
        open={decisionHistoryOpen}
        currentSymbol={symbol}
        sessions={normalizedDecisionStore.sessions}
        favoriteKeys={decisionFavoriteKeys}
        onToggleFavorite={(key) => setDecisionFavoriteKeys((current) => toggleDecisionReplayFavorite(current, key))}
        onClose={() => setDecisionHistoryOpen(false)}
        onOpenSession={(sessionId) => {
           const target = normalizedDecisionStore.sessions.find((session) => session.id === sessionId)
           setDecisionHistoryOpen(false)
           setDecisionCenterOpen(false)
           setDecisionResultsSessionId(target?.status === 'active' ? null : sessionId)
          if (target?.status === 'active') {
            if (decisionSessionPracticeMode(target) === 'day-sequence') focusDecisionDayChart()
            else focusDecisionChartLatest()
          }
        }}
        onOpenFavoriteTrade={(sessionId, candidateKey) => {
          const target = normalizedDecisionStore.sessions.find((session) => session.id === sessionId)
          const result = target?.attempts.find((attempt) => attempt.candidateKey === candidateKey)?.result ?? null
           setDecisionHistoryOpen(false)
           setDecisionCenterOpen(false)
           setDecisionResultsSessionId(null)
           if (result) startDecisionReplayFromResult(target ?? null, result)
           else if (target?.status === 'active') {
             if (decisionSessionPracticeMode(target) === 'day-sequence') focusDecisionDayChart()
             else focusDecisionChartLatest()
           }
         }}
      />
      <DecisionResultsDialog
        session={decisionResultsSession}
        systemCandidates={decisionResultsSystemCandidates}
        favoriteKeys={decisionFavoriteKeys}
        onToggleFavorite={(key) => setDecisionFavoriteKeys((current) => toggleDecisionReplayFavorite(current, key))}
        onClose={() => {
          setDecisionResultsSessionId(null)
          setDecisionReviewReturnSessionId(null)
        }}
        onReview={(result) => startDecisionReplayFromResult(decisionResultsSession, result)}
        onReturnToSource={() => {
          const sourceSessionId = decisionResultsSession?.sourceSessionId
          if (!sourceSessionId) return
          setDecisionResultsSessionId(sourceSessionId)
          notify('已返回原本场次对比')
        }}
        onNew={() => {
          setDecisionResultsSessionId(null)
          setDecisionReviewReturnSessionId(null)
          setDecisionCenterOpen(true)
        }}
      />
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}

function Watchlist({ active, onSelect, onClose }: { active: SymbolId; onSelect: (id: SymbolId) => void; onClose: () => void }) {
  const data = useMemo(() => SYMBOLS.map((symbol) => ({ symbol, candle: generateCandles(symbol.id, '5m', 40).at(-1)! })), [])
  return <aside className="watchlist-panel"><div className="panel-heading"><div><b>自选列表</b><small>3 个品种</small></div><button onClick={onClose} aria-label="关闭自选列表"><PanelRightClose size={18} /></button></div><div className="watchlist-columns"><span>代码</span><span>最新价</span><span>涨跌</span></div>{data.map(({ symbol, candle }) => { const change = ((candle.close - candle.open) / candle.open) * 100; return <button key={symbol.id} className={active === symbol.id ? 'active' : ''} onClick={() => onSelect(symbol.id)}><span><i style={{ background: symbol.accent }}>{symbol.id[0]}</i><b>{symbol.id}</b></span><span>{formatPrice(candle.close, symbol.id)}</span><span className={change >= 0 ? 'positive' : 'negative'}>{change >= 0 ? '+' : ''}{change.toFixed(2)}%</span></button> })}<div className="watchlist-note"><Activity size={15} />本地模拟快照</div></aside>
}

function IndicatorPanel({ value, onChange, onClose }: { value: IndicatorSettings; onChange: (value: IndicatorSettings) => void; onClose: () => void }) {
  const rows: { key: 'ma' | 'ema' | 'boll' | 'volume'; name: string; detail: string; color: string }[] = [
    { key: 'ma', name: '移动平均线', detail: `MA ${value.maPeriod}`, color: '#f59e0b' },
    { key: 'ema', name: '指数移动平均', detail: `EMA ${value.emaPeriod}`, color: '#296cff' },
    { key: 'boll', name: '布林带', detail: `BOLL ${value.bollPeriod}, ${value.bollDeviation}`, color: '#9b7bff' },
    { key: 'volume', name: '成交量', detail: 'Volume + MA20', color: '#21a179' },
  ]
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="modal indicator-modal" role="dialog" aria-modal="true" aria-label="指标设置"><div className="modal-header"><div><b>技术指标</b><small>叠加到主图的本地计算指标</small></div><button onClick={onClose} aria-label="关闭"><X size={18} /></button></div><div className="indicator-list">{rows.map((row) => <div className="indicator-row" key={row.key}><span className="indicator-color" style={{ background: row.color }} /><div><b>{row.name}</b><small>{row.detail}</small></div><label className="switch" aria-label={`${row.name}开关`} title={`${row.name}开关`}><input type="checkbox" checked={value[row.key]} onChange={(event) => onChange({ ...value, [row.key]: event.target.checked })} /><span /></label></div>)}</div><div className="parameter-grid"><label>MA 周期<input type="number" min="2" max="200" value={value.maPeriod} onChange={(event) => onChange({ ...value, maPeriod: Number(event.target.value) })} /></label><label>EMA 周期<input type="number" min="2" max="200" value={value.emaPeriod} onChange={(event) => onChange({ ...value, emaPeriod: Number(event.target.value) })} /></label><label>BOLL 周期<input type="number" min="2" max="200" value={value.bollPeriod} onChange={(event) => onChange({ ...value, bollPeriod: Number(event.target.value) })} /></label><label>标准差<input type="number" step="0.1" min="0.1" max="5" value={value.bollDeviation} onChange={(event) => onChange({ ...value, bollDeviation: Number(event.target.value) })} /></label></div><div className="modal-footer"><button onClick={() => onChange(DEFAULT_INDICATORS)}>恢复指标默认</button><button className="primary" onClick={onClose}>完成</button></div></section></div>
}

function SettingsPanel({ theme, onTheme, onReset, onExportWorkspace, onMergeProgress, onPrivateReceive, onPrivateSync, onHistoryReceive, onHistorySync, privateSyncBusy, privateSyncOperation, privateSyncStatus, codeDeployPhase, codeDeployStatus, codeDeployError, codeDeployActivity, onCodeDeployRefresh, onCodePublish, onCodeUpdate, onImportWorkspace, onRestoreLastImport, canRestoreWorkspace, onClose }: {
  theme: Theme
  onTheme: (theme: Theme) => void
  onReset: () => void
  onExportWorkspace: () => void
  onMergeProgress: (files: readonly File[]) => void
  onPrivateReceive: () => void
  onPrivateSync: () => void
  onHistoryReceive: () => void
  onHistorySync: () => void
  privateSyncBusy: boolean
  privateSyncOperation: PrivateSyncOperation
  privateSyncStatus: PrivateSyncStatus
  codeDeployPhase: CodeDeployPhase
  codeDeployStatus: LocalCodeStatus | null
  codeDeployError: string
  codeDeployActivity: LocalCodeDeployActivity
  onCodeDeployRefresh: () => void
  onCodePublish: () => void
  onCodeUpdate: () => void
  onImportWorkspace: (file: File) => void
  onRestoreLastImport: () => void
  canRestoreWorkspace: boolean
  onClose: () => void
}) {
  const mergeInputRef = useRef<HTMLInputElement>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const codeDeployStatusPending = codeDeployPhase === 'checking' || codeDeployPhase === 'unavailable' || codeDeployPhase === 'status-error'
  const codeDeploySyncState = !codeDeployStatus ? null
    : codeDeployStatus.diverged ? { tone: 'danger', label: '同步异常', detail: '本机与 GitHub 已分叉，必须停止' }
      : codeDeployStatus.updateAvailable ? { tone: 'warning', label: '尚未同步', detail: 'GitHub 有新版本等待更新' }
        : codeDeployStatus.aheadOfRemote ? { tone: 'warning', label: '尚未同步', detail: '本机提交尚未发布到 GitHub' }
          : codeDeployStatus.dirtyFiles.length > 0 ? { tone: 'warning', label: '尚未同步', detail: `${codeDeployStatus.dirtyFiles.length} 项本机修改尚未发布` }
            : codeDeployStatus.localHead === codeDeployStatus.remoteHead ? { tone: 'success', label: '同步成功', detail: '本机与 GitHub 代码完全一致' }
              : { tone: 'warning', label: '需要检查', detail: '本机与 GitHub 提交不一致' }
  return <aside className="settings-panel">
    <div className="panel-heading"><div><b>图表设置</b><small>外观与工作区</small></div><button onClick={onClose} aria-label="关闭"><X size={18} /></button></div>
    <section><h3>外观</h3><div className="theme-options"><button className={theme === 'dark' ? 'active' : ''} onClick={() => onTheme('dark')}><Moon size={18} />深色</button><button className={theme === 'light' ? 'active' : ''} onClick={() => onTheme('light')}><Sun size={18} />亮色</button></div></section>
    <section><h3>交互说明</h3><ul><li>鼠标滚轮：水平缩放</li><li>拖拽主图：平移时间轴</li><li>底部“适应”：显示全部数据</li><li>Shift+↓：播放 / 暂停回放</li><li>Shift+→：回放前进一格</li><li>Delete：删除选中绘图</li><li>Ctrl+Z：撤销</li><li>Ctrl+Y / Ctrl+Shift+Z：重做</li></ul></section>
    <section><h3>跨电脑同步</h3><p>完整操作包含工作区设置和做题历史；“仅…做题历史”只处理场次、逐笔结果、收藏与已见题目，不修改图表设置。所有动作都只在点击时执行。</p><small className="private-sync-status">{privateSyncStatus === 'syncing' ? (privateSyncOperation === 'receive' ? '正在接收完整工作区…' : privateSyncOperation === 'history-receive' ? '正在接收做题历史…' : privateSyncOperation === 'history-sync' ? '正在同步做题历史…' : '正在同步完整工作区…') : privateSyncStatus === 'received' ? '接收完成，本次没有上传' : privateSyncStatus === 'synced' ? '同步完成，远端 SHA-256 已验证' : privateSyncStatus === 'ready' ? '后台服务已连接，等待手动操作' : privateSyncStatus === 'unavailable' ? '当前不是本机服务，无法使用私有仓库同步' : privateSyncStatus === 'error' ? '上次手动操作失败，可点击重试' : '正在检查后台服务…'}</small><div className="workspace-transfer-actions">
      <button type="button" disabled={privateSyncBusy} onClick={onPrivateReceive}><Download size={16} />{privateSyncOperation === 'receive' ? '正在接收…' : '一键接收'}</button>
      <button type="button" className="merge-progress" disabled={privateSyncBusy} onClick={onPrivateSync}><RefreshCcw size={16} />{privateSyncOperation === 'sync' ? '正在同步…' : '一键同步'}</button>
      <button type="button" disabled={privateSyncBusy} onClick={onHistoryReceive}><History size={16} />{privateSyncOperation === 'history-receive' ? '正在接收历史…' : '仅接收做题历史'}</button>
      <button type="button" className="merge-progress" disabled={privateSyncBusy} onClick={onHistorySync}><RefreshCcw size={16} />{privateSyncOperation === 'history-sync' ? '正在同步历史…' : '仅同步做题历史'}</button>
      <button type="button" onClick={onExportWorkspace}><Download size={16} />下载同步备份</button>
      <button type="button" className="merge-progress" onClick={() => mergeInputRef.current?.click()}><Upload size={16} />上传并合并备份</button>
      <button type="button" disabled={!canRestoreWorkspace} onClick={onRestoreLastImport}><History size={16} />撤销上次导入</button>
      <button type="button" onClick={() => importInputRef.current?.click()}><Upload size={16} />完整覆盖导入</button>
      <input ref={mergeInputRef} type="file" accept="application/json,.json" multiple hidden onChange={(event) => { const files = Array.from(event.target.files ?? []); if (files.length) onMergeProgress(files); event.currentTarget.value = '' }} />
      <input ref={importInputRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) onImportWorkspace(file); event.currentTarget.value = '' }} />
    </div></section>
    <section className="code-deploy-section"><h3>跨电脑代码部署</h3><p>上面的数据同步按钮不包含网站代码。发布端会先运行完整验证，再把 Kline Studio 代码提交并推送到公开仓库；接收端只在工作区干净时快进更新，验证后自动重启 4173。不会读写浏览器做题历史。</p>
      <div className={`code-deploy-status ${codeDeployPhase}`}>
        <span className={codeDeploySyncState ? 'code-deploy-summary' : undefined}>{codeDeployPhase === 'publishing' ? '正在验证并发布代码…' : codeDeployPhase === 'updating' ? '正在验证新版本并重启…' : codeDeployPhase === 'unavailable' ? '代码部署服务暂未连接，正在自动重试' : codeDeployPhase === 'status-error' ? '代码版本检查失败，正在自动重试' : codeDeployPhase === 'error' ? '上次代码操作失败' : codeDeploySyncState ? <><b className={`code-deploy-sync-label ${codeDeploySyncState.tone}`}>{codeDeploySyncState.label}</b><em>{codeDeploySyncState.detail}</em></> : '正在读取代码版本…'}</span>
        {codeDeployError ? <small>{codeDeployError}；也可点击“检查代码版本”立即重试</small> : codeDeployStatus && <div className="code-deploy-audit">
          <small>本机 <b>{codeDeployStatus.localHead.slice(0, 7)}</b> · GitHub <b>{codeDeployStatus.remoteHead.slice(0, 7)}</b></small>
          <small>最近检查：<b>{formatCodeDeployTime(codeDeployActivity.lastVerifiedAt)}</b></small>
          <small>上次代码同步（GitHub）：<b>{formatCodeDeployTime(codeDeployStatus.remoteHeadTimestamp)}</b></small>
          <small>本机最近成功操作：<b>{codeDeployActivity.lastSuccessfulSync ? `${codeDeployActivity.lastSuccessfulSync.action === 'publish' ? '发布' : '更新'} · ${formatCodeDeployTime(codeDeployActivity.lastSuccessfulSync.at)} · ${codeDeployActivity.lastSuccessfulSync.commit.slice(0, 7)}` : '暂无记录（从本版本开始记录）'}</b></small>
        </div>}
      </div>
      <div className="workspace-transfer-actions code-deploy-actions">
        <button type="button" className="merge-progress" disabled={privateSyncBusy || codeDeployStatusPending || codeDeployPhase === 'publishing' || codeDeployPhase === 'updating'} onClick={onCodePublish}><Upload size={16} />{codeDeployPhase === 'publishing' ? '正在发布…' : '发布代码到 GitHub'}</button>
        <button type="button" disabled={privateSyncBusy || codeDeployStatusPending || codeDeployPhase === 'publishing' || codeDeployPhase === 'updating'} onClick={onCodeUpdate}><Download size={16} />{codeDeployPhase === 'updating' ? '正在更新…' : '更新代码并重启'}</button>
        <button type="button" className="code-status-refresh" disabled={codeDeployPhase === 'publishing' || codeDeployPhase === 'updating'} onClick={onCodeDeployRefresh}><RefreshCcw size={16} />检查代码版本</button>
      </div>
    </section>
    <section className="danger-section"><h3>工作区</h3><p>品种、周期、指标、绘图和回放进度会自动保存在当前浏览器。</p><button onClick={() => { onReset(); onClose() }}><RefreshCcw size={16} />恢复所有默认设置</button></section>
  </aside>
}

function QuickSearchDialog({ items, query, onQuery, onSelect, onClose }: {
  items: QuickSearchItem[]; query: string; onQuery: (value: string) => void; onSelect: (item: QuickSearchItem) => void; onClose: () => void
}) {
  const normalized = query.trim().toLowerCase()
  const results = items.filter((item) => `${item.label}${item.detail}${item.shortcut ?? ''}`.toLowerCase().includes(normalized)).slice(0, 14)
  return <div className="modal-backdrop shortcut-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="quick-search-dialog" role="dialog" aria-modal="true" aria-label="快速搜索">
      <label className="quick-search-input"><Search size={19} /><input autoFocus value={query} onChange={(event) => onQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && results[0]) onSelect(results[0]) }} placeholder="搜索绘图、功能或设置" /><kbd>Esc</kbd></label>
      <div className="quick-search-results">{results.length ? results.map((item) => <button key={item.id} type="button" onClick={() => onSelect(item)}><span><b>{item.label}</b><small>{item.detail}</small></span>{item.shortcut && <kbd>{item.shortcut}</kbd>}</button>) : <div className="shortcut-empty">没有匹配的命令</div>}</div>
      <footer><span>Enter 执行第一项</span><span>Ctrl+K 快速打开</span></footer>
    </section>
  </div>
}

function IntervalShortcutDialog({ value, onChange, onApply, onClose }: {
  value: string; onChange: (value: string) => void; onApply: (value: string) => boolean; onClose: () => void
}) {
  const options: IntervalId[] = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w']
  return <div className="modal-backdrop shortcut-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="interval-shortcut-dialog" role="dialog" aria-modal="true" aria-label="更改周期">
      <header><b>更改周期</b><button type="button" aria-label="关闭周期选择" onClick={onClose}><X size={17} /></button></header>
      <label><input autoFocus value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') onApply(value) }} placeholder="例如 5、60、2H、D、W" /><kbd>Enter</kbd></label>
      <div>{options.map((id) => <button type="button" key={id} onClick={() => onApply(id)}><span>{INTERVALS[id].label}</span><small>{id.toUpperCase()}</small></button>)}</div>
    </section>
  </div>
}

function GoToDateDialog({ initialTime, onSelect, onClose }: { initialTime: number; onSelect: (time: number) => void; onClose: () => void }) {
  const initial = new Date(initialTime * 1000)
  const [date, setDate] = useState(`${initial.getFullYear()}-${String(initial.getMonth() + 1).padStart(2, '0')}-${String(initial.getDate()).padStart(2, '0')}`)
  const [time, setTime] = useState(`${String(initial.getHours()).padStart(2, '0')}:${String(initial.getMinutes()).padStart(2, '0')}`)
  const submit = () => {
    const timestamp = new Date(`${date}T${time}:00`).getTime()
    if (Number.isFinite(timestamp)) onSelect(Math.floor(timestamp / 1000))
  }
  return <div className="modal-backdrop shortcut-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="go-date-dialog" role="dialog" aria-modal="true" aria-label="转到日期">
      <header><div><b>转到日期</b><small>Alt+G</small></div><button type="button" aria-label="关闭日期选择" onClick={onClose}><X size={17} /></button></header>
      <div><label>日期<input autoFocus type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label><label>时间<input type="time" value={time} onChange={(event) => setTime(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit() }} /></label></div>
      <footer><button type="button" onClick={onClose}>取消</button><button type="button" className="primary" onClick={submit}>转到</button></footer>
    </section>
  </div>
}

function ShortcutHelpDialog({ onClose }: { onClose: () => void }) {
  const sections = ['图表', '绘图', '回放', '交易平台'] as const
  return <div className="modal-backdrop shortcut-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="shortcut-help-dialog" role="dialog" aria-modal="true" aria-label="键盘快捷键">
      <header><div><b>键盘快捷键</b><small>与 TradingView 官方 Advanced Charts 快捷键一致</small></div><button type="button" aria-label="关闭快捷键" onClick={onClose}><X size={18} /></button></header>
      <div className="shortcut-help-scroll">{sections.map((section) => <section key={section}><h3>{section}</h3>{TRADINGVIEW_SHORTCUTS.filter((item) => item.section === section).map((item) => <div key={item.id}><span>{item.label}</span><kbd>{item.keys}</kbd></div>)}</section>)}</div>
    </section>
  </div>
}

export default App
