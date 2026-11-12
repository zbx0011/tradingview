import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  PriceScaleMode,
  createSeriesMarkers,
  createChart,
  type IChartApi,
  type Logical,
  type MouseEventParams,
  type SeriesMarker,
  type UTCTimestamp,
} from 'lightweight-charts'
import { bollinger, ema, sma, volumeSma } from '../lib/indicators'
import { attachSmartMoneyOverlay } from '../lib/smartMoneyOverlay'
import { futureTimeOffset } from '../lib/futureTradingTimeline'
import { captureChartView, loadChartView, restoredChartRange, saveChartView } from '../lib/chartViewPersistence'
import {
  centeredLatestLogicalRange,
  initialChartLogicalRange,
  isRealtimeScrollPosition,
  shouldDeferViewportProjectionSync,
  viewportActionAfterDataUpdate,
} from '../lib/chartViewport'
import { formatBeijingChartTime, formatBeijingTickMark } from '../lib/chartTime'
import { normalizedWheelDelta, zoomLogicalRangeAt } from '../lib/chartWheelZoom'
import { formatPrice, INTERVALS, type Candle, type IntervalId, type SymbolId } from '../lib/market'
import {
  loadTradeMarkerPanelPreferences, saveTradeMarkerPanelPreferences,
  type TradeMarkerFontSize, type TradeMarkerPanelPosition, type TradeMarkerPanelSize,
} from '../lib/persistence'
import {
  exitReasonDetail, exitReasonLabel, toggleXauTradeMarkerSelection, tradeLevelMethodLabel, tradeMarkerTitle, tradeRuleLabel, triggerConditionLabel,
} from '../lib/tradeMarkers'
import {
  resolveReplayDecisionSignalMarker, resolveReplayTradeMarker, toReplayDecisionSignalSeriesMarkers, toReplayTradeConnectionSpecs, toReplayTradeSeriesMarkers,
  type ReplayDecisionSignalMarkerSelection, type ReplayTradeActiveSelection, type ReplayTradeConnectionSpec, type ReplayTradeMarkerSelection,
} from '../lib/replayTradeRegistry'
import {
  resolveReplaySignalMarker, toReplaySignalRangeSpecs, toReplaySignalSeriesMarkers, toggleReplaySignalMarkerSelection,
  replaySignalCandleBeijingTime,
  type ReplaySignalMarkerSelection,
} from '../lib/replaySignalRegistry'
import {
  resolveResearchSignalMarker, toResearchSignalSeriesMarkers,
  type ResearchSignalMarkerSelection,
} from '../lib/researchSignalRegistry'
import { hasReplayRangeDataset, shouldRenderReplayRangeSpec, toReplayRangeSpecs, type ReplayRangeSpec } from '../lib/replayRangeRegistry'
import { extractReasonCandleIndexes, resolveTradeCandleReferences } from '../lib/tradeCandleReferences'
import { labelLayoutObstacle, tradeEndpointLabelLayout, type TradeLabelObstacle } from '../lib/tradeEndpointLabelLayout'
import { chartMarkersForVisibility } from '../lib/chartMarkerVisibility'
import type { ApprenticeActionMarker } from './AlSwingApprenticePanel'

export interface IndicatorSettings {
  ma: boolean
  ema: boolean
  boll: boolean
  /** Smart Money Concepts (LuxAlgo port) overlay. */
  smc?: boolean
  volume: boolean
  maPeriod: number
  emaPeriod: number
  bollPeriod: number
  bollDeviation: number
}

export interface ChartSurfaceHandle {
  getVisibleLogicalRange: () => { from: number; to: number } | null
  setVisibleLogicalRange: (range: { from: number; to: number }) => void
  fitContent: () => void
  plotSize: () => { width: number; height: number } | null
  showDuration: (seconds: number | null) => void
  showTimeRange: (from: number, to: number) => void
  zoomToFraction: (from: number, to: number) => void
  coordinateToTime: (x: number) => number | null
  coordinateToPrice: (y: number) => number | null
  priceToCoordinate: (price: number) => number | null
  measurementAt: (xFraction: number, yFraction: number) => { time: number; price: number } | null
  timeToCoordinate: (time: number) => number | null
  focusLatest: () => void
  scrollToRealtime: () => void
  moveVisibleRange: (bars: number) => void
  zoomVisibleRange: (factor: number) => void
  goToTime: (time: number) => void
  selectResearchSignal: (markerId: string) => void
  downloadScreenshot: () => void
}

export interface ChartSurfaceProps {
  data: Candle[]
  symbol: SymbolId
  interval: IntervalId
  chartType: 'candles' | 'hollow' | 'line' | 'area'
  theme: 'dark' | 'light'
  /** Bars painted solid black (e.g. the candle a manual-practice trade entered on). */
  blackBarTimes?: readonly number[]
  futureTradingTimes?: readonly number[]
  /** Candle times hidden after a replay point: kept as empty slots so the time axis (and the layout) does not move. */
  hiddenTailTimes?: readonly number[]
  indicators: IndicatorSettings
  priceScaleAuto: boolean
  priceScaleLog: boolean
  priceScalePercent: boolean
  priceScaleInverted: boolean
  visibleTradeLayerSourceIds?: string[]
  visibleResearchSignalSourceIds?: string[]
  showAllResearchReviews?: boolean
  exerciseSignalMarkers?: SeriesMarker<UTCTimestamp>[]
  apprenticeActionMarkers?: readonly ApprenticeActionMarker[]
  apprenticeOnly?: boolean
  apprenticeFocusRange?: { startTime: number; endTime: number } | null
  decisionSignalSourceIds?: string[]
  decisionSignalAfterTime?: number | null
  visibleRangeLayerSourceIds?: string[]
  suppressedRangeObjectIds?: string[]
  selectedRangeObjectId?: string | null
  onSelectRangeObject?: (id: string | null) => void
  followLatest?: boolean
  focusLatestKey?: number
  focusHistoryBars?: number
  /** Keep the current viewport while a historical review is opened. */
  suppressAutoFocus?: boolean
  centerLatestByDefault?: boolean
  markersHidden?: boolean
  showFilledGaps?: boolean
  onHover: (candle: Candle | null) => void
  onPriceScaleStateChange: (autoScale: boolean, logarithmic: boolean, percentage: boolean, inverted: boolean) => void
  onViewportChange?: () => void
}

interface SeriesState {
  main: any
  volume?: any
  volumeAverage?: any
  ma?: any
  ema?: any
  bollUpper?: any
  bollMiddle?: any
  bollLower?: any
  markers?: any
  smc?: ReturnType<typeof attachSmartMoneyOverlay>
}

interface TradeConnectionSegment extends ReplayTradeConnectionSpec {
  x1: number
  y1: number
  x2: number
  y2: number
}

function sameTradeLabelObstacles(left: readonly TradeLabelObstacle[], right: readonly TradeLabelObstacle[]) {
  return left.length === right.length && left.every((obstacle, index) => {
    const next = right[index]
    return obstacle.left === next.left && obstacle.right === next.right && obstacle.top === next.top && obstacle.bottom === next.bottom
  })
}

function tradeDetailsPanelObstacle(
  panelPosition: TradeMarkerPanelPosition | null,
  panelSize: TradeMarkerPanelSize | null,
  viewportWidth: number,
  viewportHeight: number,
): TradeLabelObstacle {
  const outerGap = 14
  const panelWidth = Math.min(panelSize?.width ?? 368, Math.max(0, viewportWidth - outerGap * 2))
  const left = panelPosition?.left ?? Math.max(outerGap, viewportWidth - panelWidth - outerGap)
  const top = panelPosition?.top ?? 68
  return {
    left,
    right: Math.min(viewportWidth, left + panelWidth),
    top,
    bottom: Math.min(viewportHeight, top + (panelSize?.height ?? Math.max(0, viewportHeight - top - 20))),
  }
}

interface SignalRangeSegment {
  id: string
  kind: 'two_sided_range' | 'one_sided_edge'
  activeEdge?: 'upper' | 'lower'
  signalNumbers: number[]
  name?: string
  startTime: number
  endTime: number
  x1: number
  x2: number
  yUpperZoneLow?: number
  yUpperZoneHigh?: number
  yLowerZoneLow?: number
  yLowerZoneHigh?: number
  yMidpoint?: number
  yEdgeZoneLow?: number
  yEdgeZoneHigh?: number
}


function hitTestSignalRange(segments: readonly SignalRangeSegment[], x: number, y: number): string | null {
  const hit = [...segments].reverse().find((segment) => {
    const left = Math.min(segment.x1, segment.x2) - 3
    const right = Math.max(segment.x1, segment.x2) + 3
    if (x < left || x > right) return false
    if (segment.kind === 'one_sided_edge') {
      const top = Math.min(segment.yEdgeZoneHigh!, segment.yEdgeZoneLow!) - 5
      const bottom = Math.max(segment.yEdgeZoneHigh!, segment.yEdgeZoneLow!) + 5
      return y >= top && y <= bottom
    }
    const top = Math.min(segment.yUpperZoneHigh!, segment.yUpperZoneLow!, segment.yLowerZoneHigh!, segment.yLowerZoneLow!) - 3
    const bottom = Math.max(segment.yUpperZoneHigh!, segment.yUpperZoneLow!, segment.yLowerZoneHigh!, segment.yLowerZoneLow!) + 3
    return y >= top && y <= bottom
  })
  return hit?.id ?? null
}

const FONT_SIZE_CYCLE: TradeMarkerFontSize[] = ['medium', 'large', 'small']

interface CachedViewportRange {
  from: number
  to: number
}

const viewportRangeCache = new Map<string, CachedViewportRange>()

function viewportRangeCacheKey(symbol: SymbolId, interval: IntervalId) {
  return `${symbol}:${interval}`
}

const BREAKOUT_SETUP_PHRASE = '震荡区间向上突破'
const REVERSAL_SETUP_PHRASE = '上侧假突破反转空头'

function highlightTradeSetup(setup: string): ReactNode {
  const matches = [
    { phrase: BREAKOUT_SETUP_PHRASE, className: 'trade-marker-breakout-highlight' },
    { phrase: REVERSAL_SETUP_PHRASE, className: 'trade-marker-reversal-highlight' },
  ].map((item) => ({ ...item, index: setup.indexOf(item.phrase) })).filter((item) => item.index >= 0).sort((left, right) => left.index - right.index)
  const match = matches[0]
  if (!match) return setup
  return <>{setup.slice(0, match.index)}<strong className={match.className}>{match.phrase}</strong>{highlightTradeSetup(setup.slice(match.index + match.phrase.length))}</>
}

function tradeSetupTitleClass(setup: string, long: boolean): string {
  const directionClass = /空头|下破|反转空/.test(setup)
    ? 'trade-marker-red'
    : /多头|上破|反转多/.test(setup)
      ? 'trade-marker-green'
      : long ? 'trade-marker-green' : 'trade-marker-red'
  return `trade-marker-setup-title ${directionClass}`
}

function highlightReasonReferenceIndexes(
  reason: string,
  referenceIndexes: ReadonlySet<number>,
  keyPrefix: string,
  orangeReferenceIndexes: ReadonlySet<number> = new Set(),
): ReactNode {
  if (referenceIndexes.size === 0) return reason
  const parts: ReactNode[] = []
  let cursor = 0
  for (const match of reason.matchAll(/\d+/g)) {
    const offset = match.index ?? 0
    const token = match[0]
    const index = Number(token)
    if (!referenceIndexes.has(index)) continue
    if (offset > cursor) parts.push(reason.slice(cursor, offset))
    const className = orangeReferenceIndexes.has(index) ? 'trade-marker-k-index trade-marker-k-index-exit' : 'trade-marker-k-index'
    parts.push(<span key={`${keyPrefix}-${offset}-${index}`} className={className} title={`图中已标注 K${index}`} aria-label={`K线序号 ${index}，图中已标注`}>K{index}</span>)
    cursor = offset + token.length
  }
  if (cursor === 0) return reason
  if (cursor < reason.length) parts.push(reason.slice(cursor))
  return parts
}

function highlightTradeReason(
  reason: string,
  referenceIndexes: ReadonlySet<number> = new Set(),
  orangeReferenceIndexes: ReadonlySet<number> = new Set(),
): ReactNode {
  const clauses = reason.match(/[^。！？；]+[。！？；]?/g) ?? [reason]
  return clauses.map((clause, index) => {
    const isKeyClause = index === clauses.length - 1 || /构成可执行|已形成|明确跟随|未获接受|失败破位|失败上攻|强反向|移动止盈|固定初始止损/.test(clause)
    const content = highlightReasonReferenceIndexes(clause, referenceIndexes, `reason-${index}`, orangeReferenceIndexes)
    return isKeyClause
      ? <strong key={`${clause}-${index}`} className="trade-marker-reason-emphasis">{content}</strong>
      : <span key={`${clause}-${index}`}>{content}</span>
  })
}

function nextTradeMarkerFontSize(size: TradeMarkerFontSize): TradeMarkerFontSize {
  return FONT_SIZE_CYCLE[(FONT_SIZE_CYCLE.indexOf(size) + 1) % FONT_SIZE_CYCLE.length]
}

function clampTradeMarkerPanelPosition(position: TradeMarkerPanelPosition, containerRect: DOMRect, cardRect: DOMRect): TradeMarkerPanelPosition {
  const maxLeft = Math.max(8, containerRect.width - cardRect.width - 8)
  const maxTop = Math.max(8, containerRect.height - cardRect.height - 8)
  return {
    left: Math.min(maxLeft, Math.max(8, position.left)),
    top: Math.min(maxTop, Math.max(8, position.top)),
  }
}

const TRADE_MARKER_PANEL_MIN_WIDTH = 280
const TRADE_MARKER_PANEL_MIN_HEIGHT = 220

function clampTradeMarkerPanelSize(size: TradeMarkerPanelSize, position: TradeMarkerPanelPosition, containerRect: DOMRect): TradeMarkerPanelSize {
  const maxWidth = Math.max(1, containerRect.width - position.left - 8)
  const maxHeight = Math.max(1, containerRect.height - position.top - 8)
  const minWidth = Math.min(TRADE_MARKER_PANEL_MIN_WIDTH, maxWidth)
  const minHeight = Math.min(TRADE_MARKER_PANEL_MIN_HEIGHT, maxHeight)
  return {
    width: Math.min(maxWidth, Math.max(minWidth, size.width)),
    height: Math.min(maxHeight, Math.max(minHeight, size.height)),
  }
}

function tradeMarkerPanelStyle(position: TradeMarkerPanelPosition | null, size: TradeMarkerPanelSize | null): CSSProperties | undefined {
  if (!position && !size) return undefined
  return {
    ...(position ? { left: `${position.left}px`, top: `${position.top}px`, right: 'auto' } : {}),
    ...(size ? { width: `${size.width}px`, height: `${size.height}px`, maxWidth: 'none', maxHeight: 'none' } : {}),
  }
}

const toLine = (points: { time: number; value: number }[]) => points.map((point) => ({ time: point.time as UTCTimestamp, value: point.value }))

const blackBarPoint = (candle: Candle, border: string) => ({
  time: candle.time as UTCTimestamp, open: candle.open, high: candle.high, low: candle.low, close: candle.close,
  color: '#000000', borderColor: border, wickColor: border,
})

function updateSeries(series: SeriesState, data: Candle[], chartType: ChartSurfaceProps['chartType'], indicators: IndicatorSettings, black?: { times: ReadonlySet<number>; border: string }, hiddenTail: readonly number[] = []) {
  // Hidden replay candles stay in the series as fully transparent flat bars: the time scale keeps the same
  // last bar, so nothing slides or rescales when later candles are hidden (empty slots would move the base index).
  const hold = data.at(-1)?.close ?? 0
  const clear = 'rgba(0,0,0,0)'
  if (chartType === 'line' || chartType === 'area') {
    series.main.setData([...data.map(({ time, close }) => ({ time: time as UTCTimestamp, value: close })), ...hiddenTail.map((time) => ({ time: time as UTCTimestamp }))] as never)
  } else {
    series.main.setData([
      ...data.map((candle) => black?.times.has(candle.time) ? blackBarPoint(candle, black.border) : ({ time: candle.time as UTCTimestamp, open: candle.open, high: candle.high, low: candle.low, close: candle.close })),
      ...hiddenTail.map((time) => ({ time: time as UTCTimestamp, open: hold, high: hold, low: hold, close: hold, color: clear, borderColor: clear, wickColor: clear })),
    ] as never)
  }
  if (series.volume) {
    series.volume.setData(data.map((item) => ({
      time: item.time as UTCTimestamp,
      value: item.volume,
      color: item.close >= item.open ? 'rgba(8,153,129,.46)' : 'rgba(242,54,69,.42)',
    })))
    series.volumeAverage?.setData(toLine(volumeSma(data, 20)))
  }
  series.ma?.setData(toLine(sma(data, indicators.maPeriod)))
  series.ema?.setData(toLine(ema(data, indicators.emaPeriod)))
  if (series.bollUpper && series.bollMiddle && series.bollLower) {
    const points = bollinger(data, indicators.bollPeriod, indicators.bollDeviation)
    series.bollUpper.setData(toLine(points.map((point) => ({ time: point.time, value: point.upper }))))
    series.bollMiddle.setData(toLine(points.map((point) => ({ time: point.time, value: point.middle }))))
    series.bollLower.setData(toLine(points.map((point) => ({ time: point.time, value: point.lower }))))
  }
}

// lightweight-charts 5.2's series-markers plugin calls `series.data()` on every
// render just to test whether the series is empty. `data()` copies the whole
// series, so with 200k+ bars (e.g. NQ1! Databento history) every pan/zoom frame
// spent ~40 ms allocating a 200k-element array and dragging dropped to ~15 fps.
// Cache the copy until the series data actually changes.
function memoizeSeriesData(series: any) {
  if (!series || series.__klineDataMemoized) return
  const originalData = series.data.bind(series)
  let cached: unknown = null
  const invalidate = () => { cached = null }
  series.data = () => {
    if (cached === null) cached = originalData()
    return cached
  }
  for (const method of ['setData', 'update', 'pop'] as const) {
    if (typeof series[method] !== 'function') continue
    const original = series[method].bind(series)
    series[method] = (...args: unknown[]) => {
      invalidate()
      return original(...args)
    }
  }
  series.__klineDataMemoized = true
}

function candleAtTime(data: readonly Candle[], time: number): Candle | null {
  let low = 0
  let high = data.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const candidate = data[middle].time
    if (candidate === time) return data[middle]
    if (candidate < time) low = middle + 1
    else high = middle - 1
  }
  return null
}

function candleTimeExists(data: readonly Candle[], time: number): boolean {
  let low = 0
  let high = data.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const candidate = data[middle].time
    if (candidate === time) return true
    if (candidate < time) low = middle + 1
    else high = middle - 1
  }
  return false
}

function tradeReferenceSeriesMarkers(selection: ReplayTradeMarkerSelection, data: readonly Candle[]): SeriesMarker<UTCTimestamp>[] {
  return resolveTradeCandleReferences(selection.trade, data).map((reference) => {
    const exitOnly = reference.sections.length === 1 && reference.sections[0] === 'exit'
    return {
      time: reference.time as UTCTimestamp,
      position: exitOnly ? 'belowBar' : 'aboveBar',
      shape: 'square',
      color: exitOnly ? '#f59e0b' : '#38bdf8',
      text: `K${reference.index}`,
      size: 1.5,
      id: `trade-reference-${selection.sourceId}-${selection.trade.tradeNumber}-${reference.index}`,
    }
  })
}

function visibleTradeMarkers(
  symbol: SymbolId,
  interval: IntervalId,
  data: Candle[],
  sourceIds: readonly string[],
  active?: ReplayTradeActiveSelection | null,
  referenceMarkers: readonly SeriesMarker<UTCTimestamp>[] = [],
  decisionSignalSourceIds: readonly string[] = [],
  decisionSignalAfterTime: number | null = null,
  markersHidden = false,
  researchSignalSourceIds: readonly string[] = [],
  showAllResearchReviews = true,
  apprenticeActionMarkers: readonly ApprenticeActionMarker[] = [],
  apprenticeOnly = false,
) {
  const revealedThrough = data.at(-1)?.time
  if (revealedThrough === undefined) return []
  // lightweight-charts only has a meaningful anchor for a marker when the
  // exact candle timestamp exists in the current series.  If a market data
  // snapshot contains a historical gap, passing timestamps from a replay
  // layer that fall inside that gap makes the library attach every marker to
  // the nearest loaded bar (usually the last bar).  That is what produced the
  // vertical column of labels at the right edge of the chart.  Keep replay
  // annotations causal, but never move them to another candle as a fallback.
  const markers = [
    ...(apprenticeOnly ? [] : toReplayTradeSeriesMarkers(symbol, interval, sourceIds, revealedThrough, active)),
    ...(apprenticeOnly ? [] : toReplaySignalSeriesMarkers(symbol, interval, revealedThrough)),
    ...(apprenticeOnly ? [] : toResearchSignalSeriesMarkers(symbol, interval, researchSignalSourceIds, revealedThrough, showAllResearchReviews)),
    ...(apprenticeOnly ? [] : toReplayDecisionSignalSeriesMarkers(symbol, interval, decisionSignalSourceIds, revealedThrough, decisionSignalAfterTime)),
    ...apprenticeActionSeriesMarkers(apprenticeActionMarkers, data),
    ...referenceMarkers,
  ].filter((marker) => candleTimeExists(data, Number(marker.time)))
    .sort((left, right) => Number(left.time) - Number(right.time) || String(left.id).localeCompare(String(right.id)))
  return chartMarkersForVisibility(markers, markersHidden)
}

// lightweight-charts only lets update() touch the newest bar, so repainting an older bar means re-setting the
// main series. That only happens when a trade is entered or removed, and manual-practice data is small.
function paintBlackBars(series: SeriesState | null, data: readonly Candle[], times: readonly number[], border: string, chartType: ChartSurfaceProps['chartType']) {
  if (!series || chartType === 'line' || chartType === 'area') return
  const black = new Set(times)
  series.main.setData(data.map((candle) => black.has(candle.time)
    ? blackBarPoint(candle, border)
    : { time: candle.time as UTCTimestamp, open: candle.open, high: candle.high, low: candle.low, close: candle.close }) as never)
}

function apprenticeActionSeriesMarkers(markers: readonly ApprenticeActionMarker[], data: readonly Candle[]): SeriesMarker<UTCTimestamp>[] {
  const revealedThrough = data.at(-1)?.time
  if (revealedThrough === undefined) return []
  return markers
    .filter((marker) => marker.time <= revealedThrough && candleTimeExists(data, marker.time))
    .map((marker) => {
      const long = marker.side === 'long'
      const color = marker.kind === 'plan'
        ? '#a78bfa'
        : marker.kind === 'filled'
          ? (long ? '#22c55e' : '#ef4444')
          : marker.kind === 'cancel' ? '#f59e0b' : '#38bdf8'
      const shape = marker.kind === 'plan' ? 'square' : marker.kind === 'filled' ? (long ? 'arrowUp' : 'arrowDown') : 'circle'
      return {
        time: marker.time as UTCTimestamp,
        position: long ? 'belowBar' : 'aboveBar',
        shape,
        color,
        text: marker.label,
        size: marker.kind === 'filled' ? 2 : 1.5,
        id: marker.id,
      }
    })
}

export const ChartSurface = forwardRef<ChartSurfaceHandle, ChartSurfaceProps>(function ChartSurface(
  {
    data, symbol, interval, chartType, theme, blackBarTimes, futureTradingTimes, hiddenTailTimes, indicators, priceScaleAuto, priceScaleLog, priceScalePercent, priceScaleInverted,
    visibleTradeLayerSourceIds = [], visibleResearchSignalSourceIds = [], showAllResearchReviews = true, exerciseSignalMarkers = [], apprenticeActionMarkers = [], apprenticeOnly = false, apprenticeFocusRange = null, decisionSignalSourceIds = [], decisionSignalAfterTime = null,
    visibleRangeLayerSourceIds = [], suppressedRangeObjectIds = [], selectedRangeObjectId = null, onSelectRangeObject,
    followLatest = false, focusLatestKey = 0, focusHistoryBars = 110, suppressAutoFocus = false, centerLatestByDefault = false, markersHidden = false, showFilledGaps = false, onHover, onPriceScaleStateChange, onViewportChange,
  },
  forwardedRef,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<SeriesState | null>(null)
  const showFilledGapsRef = useRef(showFilledGaps)
  useEffect(() => {
    showFilledGapsRef.current = showFilledGaps
    seriesRef.current?.smc?.setShowFilledGaps(showFilledGaps)
  }, [showFilledGaps])
  const dataRef = useRef(data)
  const savedViewRef = useRef(loadChartView(symbol, interval))
  const hydrationViewRef = useRef(loadChartView(symbol, interval))
  const savedViewKeyRef = useRef(`${symbol}:${interval}`)
  const restoringViewRef = useRef(false)
  const futureTradingTimesRef = useRef<readonly number[]>(futureTradingTimes ?? [])
  const hiddenTailRef = useRef<readonly number[]>([])
  useEffect(() => { hiddenTailRef.current = hiddenTailTimes ?? [] }, [hiddenTailTimes])
  useEffect(() => {
    futureTradingTimesRef.current = futureTradingTimes ?? []
    seriesRef.current?.smc?.setFutureTimes(futureTradingTimesRef.current)
  }, [futureTradingTimes])
  const pendingRangeRef = useRef<{ range: { from: number; to: number }; expires: number } | null>(null)
  const blackBarTimesRef = useRef<readonly number[]>(blackBarTimes ?? [])
  const blackBarsAppliedRef = useRef<readonly number[]>([])
  const symbolRef = useRef(symbol)
  const intervalRef = useRef(interval)
  const previousLengthRef = useRef(data.length)
  const blackBorderRef = useRef(theme === 'dark' ? '#9aa3b5' : '#000000')
  useEffect(() => { blackBorderRef.current = theme === 'dark' ? '#9aa3b5' : '#000000' }, [theme])
  useEffect(() => {
    // Declared before the data effect, so the data effect already sees the new list.
    const next = blackBarTimes ?? []
    blackBarTimesRef.current = next
    if (next.join(',') === blackBarsAppliedRef.current.join(',')) return
    paintBlackBars(seriesRef.current, dataRef.current, next, theme === 'dark' ? '#9aa3b5' : '#000000', chartType)
    blackBarsAppliedRef.current = next
  }, [blackBarTimes, chartType, theme])
  const previousDataIdentityRef = useRef(data)
  const followLatestRef = useRef(followLatest)
  const focusLatestKeyRef = useRef(focusLatestKey)
  const onHoverRef = useRef(onHover)
  const onPriceScaleStateChangeRef = useRef(onPriceScaleStateChange)
  const onViewportChangeRef = useRef(onViewportChange)
  const onSelectRangeObjectRef = useRef(onSelectRangeObject)
  const priceScaleAutoRef = useRef(priceScaleAuto)
  const priceScaleLogRef = useRef(priceScaleLog)
  const priceScalePercentRef = useRef(priceScalePercent)
    const priceScaleInvertedRef = useRef(priceScaleInverted)
    const visibleTradeLayerSourceIdsRef = useRef<readonly string[]>(visibleTradeLayerSourceIds)
  const visibleResearchSignalSourceIdsRef = useRef<readonly string[]>(visibleResearchSignalSourceIds)
  const apprenticeActionMarkersRef = useRef<readonly ApprenticeActionMarker[]>(apprenticeActionMarkers)
  const apprenticePriceLinesRef = useRef<any[]>([])
  const decisionSignalSourceIdsRef = useRef<readonly string[]>(decisionSignalSourceIds)
  const decisionSignalAfterTimeRef = useRef<number | null>(decisionSignalAfterTime)
  const markersHiddenRef = useRef(markersHidden)
  const visibleRangeLayerSourceIdsRef = useRef<readonly string[]>(visibleRangeLayerSourceIds)
  const suppressedRangeObjectIdsRef = useRef<ReadonlySet<string>>(new Set(suppressedRangeObjectIds))
  const [selectedTradeMarkerId, setSelectedTradeMarkerId] = useState<string | null>(null)
  const selectedTradeMarkerIdRef = useRef<string | null>(null)
    const [selectedSignalMarkerId, setSelectedSignalMarkerId] = useState<string | null>(null)
    const selectedSignalMarkerIdRef = useRef<string | null>(null)
    const [selectedResearchSignalMarkerId, setSelectedResearchSignalMarkerId] = useState<string | null>(null)
    const selectedResearchSignalMarkerIdRef = useRef<string | null>(null)
  const [selectedDecisionSignalMarkerId, setSelectedDecisionSignalMarkerId] = useState<string | null>(null)
  const selectedDecisionSignalMarkerIdRef = useRef<string | null>(null)
  const [hoveredTradeNumber, setHoveredTradeNumber] = useState<number | null>(null)
  const hoveredTradeNumberRef = useRef<number | null>(null)
  const [hoveredTradeSourceId, setHoveredTradeSourceId] = useState<string | null>(null)
  const hoveredTradeSourceIdRef = useRef<string | null>(null)
  const [hoveredMarkerId, setHoveredMarkerId] = useState<string | null>(null)
  const hoveredMarkerIdRef = useRef<string | null>(null)
  const [initialTradeMarkerPanelPreferences] = useState(loadTradeMarkerPanelPreferences)
  const [selectedTradeMarkerPanelPosition, setSelectedTradeMarkerPanelPosition] = useState<TradeMarkerPanelPosition | null>(initialTradeMarkerPanelPreferences.position)
  const [selectedTradeMarkerPanelSize, setSelectedTradeMarkerPanelSize] = useState<TradeMarkerPanelSize | null>(initialTradeMarkerPanelPreferences.size)
  const [tradeMarkerFontSize, setTradeMarkerFontSize] = useState<TradeMarkerFontSize>(initialTradeMarkerPanelPreferences.fontSize)
  const [tradeConnectionSegments, setTradeConnectionSegments] = useState<TradeConnectionSegment[]>([])
  const [tradeLabelObstacles, setTradeLabelObstacles] = useState<TradeLabelObstacle[]>([])
  const [chartViewportSize, setChartViewportSize] = useState({ width: 1000, height: 600 })
  const viewportProjectionSyncFrameRef = useRef<number | null>(null)
  const tradeConnectionSyncFrameRef = useRef<number | null>(null)
  const [signalRangeSegments, setSignalRangeSegments] = useState<SignalRangeSegment[]>([])
  const signalRangeSegmentsRef = useRef<SignalRangeSegment[]>([])
  const signalRangeSyncFrameRef = useRef<number | null>(null)
  const selectedTradeMarker = selectedTradeMarkerId ? resolveReplayTradeMarker(symbol, interval, visibleTradeLayerSourceIds, selectedTradeMarkerId) : null
    const selectedSignalMarker = selectedSignalMarkerId ? resolveReplaySignalMarker(symbol, interval, selectedSignalMarkerId) : null
    const selectedResearchSignalMarker = selectedResearchSignalMarkerId
      ? resolveResearchSignalMarker(symbol, interval, visibleResearchSignalSourceIds, selectedResearchSignalMarkerId)
      : null
  const selectedDecisionSignalMarker = selectedDecisionSignalMarkerId
    ? resolveReplayDecisionSignalMarker(symbol, interval, decisionSignalSourceIds, selectedDecisionSignalMarkerId)
    : null
  const selectedTradeDetails: ReplayTradeMarkerSelection | ReplayDecisionSignalMarkerSelection | null = selectedTradeMarker ?? selectedDecisionSignalMarker
  const tradeReferenceMarkers = useMemo(() => {
    const selection = selectedTradeDetails
    return [...(selection ? tradeReferenceSeriesMarkers(selection, data) : []), ...exerciseSignalMarkers]
  }, [data, selectedTradeDetails, exerciseSignalMarkers])
  const tradeReferenceMarkersRef = useRef<readonly SeriesMarker<UTCTimestamp>[]>(tradeReferenceMarkers)
  const activeTradeNumber = hoveredTradeNumber ?? selectedTradeDetails?.trade.tradeNumber ?? null
  const activeTradeSourceId = hoveredTradeSourceId ?? selectedTradeDetails?.sourceId ?? null
  const activeTrade = useMemo(() => activeTradeNumber !== null && activeTradeSourceId ? { sourceId: activeTradeSourceId, tradeNumber: activeTradeNumber } : null, [activeTradeNumber, activeTradeSourceId])
  const activeTradeRef = useRef<ReplayTradeActiveSelection | null>(activeTrade)
  useEffect(() => {
    tradeReferenceMarkersRef.current = tradeReferenceMarkers
  }, [tradeReferenceMarkers])

  const syncTradeConnections = useCallback(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    const container = containerRef.current
    const viewportWidth = container?.clientWidth ?? 0
    const viewportHeight = container?.clientHeight ?? 0
    if (viewportWidth > 0 && viewportHeight > 0) {
      setChartViewportSize((previous) => previous.width === viewportWidth && previous.height === viewportHeight ? previous : {
        width: viewportWidth,
        height: viewportHeight,
      })
    }
    const clearLabelObstacles = () => {
      setTradeLabelObstacles((previous) => previous.length === 0 ? previous : [])
    }
    if (!chart || !series) {
      clearLabelObstacles()
      setTradeConnectionSegments((previous) => previous.length === 0 ? previous : [])
      return
    }
    if (visibleTradeLayerSourceIdsRef.current.length === 0) {
      clearLabelObstacles()
      setTradeConnectionSegments((previous) => previous.length === 0 ? previous : [])
      return
    }
    const revealedThrough = dataRef.current.at(-1)?.time
    const specs = toReplayTradeConnectionSpecs(symbolRef.current, intervalRef.current, visibleTradeLayerSourceIdsRef.current, revealedThrough)
    const timeScale = chart.timeScale()
    const nextLabelObstacles: TradeLabelObstacle[] = []
    const visibleLogicalRange = timeScale.getVisibleLogicalRange()
    if (activeTradeRef.current && visibleLogicalRange && viewportWidth > 0 && viewportHeight > 0) {
      const firstIndex = Math.max(0, Math.floor(visibleLogicalRange.from) - 2)
      const lastIndex = Math.min(dataRef.current.length - 1, Math.ceil(visibleLogicalRange.to) + 2)
      const barSpacing = Number(timeScale.options().barSpacing)
      const halfCandleWidth = Math.max(3, Math.min(12, Number.isFinite(barSpacing) ? barSpacing * 0.46 : 5))
      if (series.volume) {
        nextLabelObstacles.push({ left: 0, right: viewportWidth, top: viewportHeight * 0.7, bottom: viewportHeight })
      }
      for (let index = firstIndex; index <= lastIndex; index += 1) {
        const candle = dataRef.current[index]
        if (!candle) continue
        const x = timeScale.timeToCoordinate(candle.time as UTCTimestamp)
        const highY = series.main.priceToCoordinate(candle.high)
        const lowY = series.main.priceToCoordinate(candle.low)
        if (typeof x !== 'number' || !Number.isFinite(x) || typeof highY !== 'number' || !Number.isFinite(highY) || typeof lowY !== 'number' || !Number.isFinite(lowY)) continue
        const top = Math.min(highY, lowY) - 3
        const bottom = Math.max(highY, lowY) + 3
        if (x + halfCandleWidth < 0 || x - halfCandleWidth > viewportWidth) continue
        if (bottom >= 0 && top <= viewportHeight) {
          nextLabelObstacles.push({ left: x - halfCandleWidth, right: x + halfCandleWidth, top, bottom })
        }
      }
    }
    setTradeLabelObstacles((previous) => sameTradeLabelObstacles(previous, nextLabelObstacles) ? previous : nextLabelObstacles)
    const nextSegments: TradeConnectionSegment[] = []
    for (const spec of specs) {
      const x1 = timeScale.timeToCoordinate(spec.entryTime as UTCTimestamp)
      const x2 = timeScale.timeToCoordinate(spec.exitTime as UTCTimestamp)
      const y1 = series.main.priceToCoordinate(spec.entryPrice)
      const y2 = series.main.priceToCoordinate(spec.exitPrice)
      if (typeof x1 !== 'number' || !Number.isFinite(x1) || typeof x2 !== 'number' || !Number.isFinite(x2) || typeof y1 !== 'number' || !Number.isFinite(y1) || typeof y2 !== 'number' || !Number.isFinite(y2)) continue
      nextSegments.push({ ...spec, x1, y1, x2, y2 })
    }
    setTradeConnectionSegments((previous) => {
      if (previous.length === nextSegments.length && previous.every((segment, index) => {
        const next = nextSegments[index]
        return segment.id === next.id && segment.x1 === next.x1 && segment.y1 === next.y1 && segment.x2 === next.x2 && segment.y2 === next.y2
      })) return previous
      return nextSegments
    })
  }, [])

  const requestTradeConnectionSync = useCallback(() => {
    if (tradeConnectionSyncFrameRef.current !== null) return
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      syncTradeConnections()
      return
    }
    tradeConnectionSyncFrameRef.current = window.requestAnimationFrame(() => {
      tradeConnectionSyncFrameRef.current = null
      syncTradeConnections()
    })
  }, [syncTradeConnections])

  const syncSignalRanges = useCallback(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    if (!chart || !series) {
      signalRangeSegmentsRef.current = []
      setSignalRangeSegments((previous) => previous.length === 0 ? previous : [])
      return
    }
    const revealedThrough = dataRef.current.at(-1)?.time
    const importedSpecs = toReplayRangeSpecs(
      symbolRef.current,
      intervalRef.current,
      visibleRangeLayerSourceIdsRef.current,
      revealedThrough,
    )
    const specs = (hasReplayRangeDataset(
      symbolRef.current,
      intervalRef.current,
      visibleRangeLayerSourceIdsRef.current,
    )
      ? importedSpecs
      : toReplaySignalRangeSpecs(symbolRef.current, intervalRef.current, revealedThrough))
      .filter(shouldRenderReplayRangeSpec)
      .filter((spec) => !suppressedRangeObjectIdsRef.current.has(spec.id))
    const timeScale = chart.timeScale()
    const nextSegments: SignalRangeSegment[] = []
    for (const spec of specs) {
      const x1 = timeScale.timeToCoordinate(spec.startTime as UTCTimestamp)
      const x2 = timeScale.timeToCoordinate(spec.endTime as UTCTimestamp)
      if (typeof x1 !== 'number' || !Number.isFinite(x1) || typeof x2 !== 'number' || !Number.isFinite(x2)) continue
      if ('kind' in spec && spec.kind === 'one_sided_edge') {
        const yEdgeZoneLow = series.main.priceToCoordinate(spec.edgeZoneLow)
        const yEdgeZoneHigh = series.main.priceToCoordinate(spec.edgeZoneHigh)
        if (typeof yEdgeZoneLow !== 'number' || !Number.isFinite(yEdgeZoneLow) || typeof yEdgeZoneHigh !== 'number' || !Number.isFinite(yEdgeZoneHigh)) continue
        nextSegments.push({
          id: spec.id, kind: spec.kind, activeEdge: spec.activeEdge, signalNumbers: [], name: spec.name,
          startTime: spec.startTime, endTime: spec.endTime, x1, x2, yEdgeZoneLow, yEdgeZoneHigh,
        })
        continue
      }
      let fullSpec: Exclude<ReplayRangeSpec, { kind: 'one_sided_edge' }> | ReturnType<typeof toReplaySignalRangeSpecs>[number]
      if ('kind' in spec) {
        if (spec.kind !== 'two_sided_range') continue
        fullSpec = spec
      } else {
        fullSpec = spec
      }
      const upperZoneLow = fullSpec.upperZoneLow
      const upperZoneHigh = fullSpec.upperZoneHigh
      const lowerZoneLow = fullSpec.lowerZoneLow
      const lowerZoneHigh = fullSpec.lowerZoneHigh
      const midpoint = fullSpec.midpoint
      const yUpperZoneLow = series.main.priceToCoordinate(upperZoneLow)
      const yUpperZoneHigh = series.main.priceToCoordinate(upperZoneHigh)
      const yLowerZoneLow = series.main.priceToCoordinate(lowerZoneLow)
      const yLowerZoneHigh = series.main.priceToCoordinate(lowerZoneHigh)
      const yMidpoint = series.main.priceToCoordinate(midpoint)
      if ([yUpperZoneLow, yUpperZoneHigh, yLowerZoneLow, yLowerZoneHigh, yMidpoint].some((coordinate) => typeof coordinate !== 'number' || !Number.isFinite(coordinate))) continue
      nextSegments.push({
        id: fullSpec.id,
        kind: 'two_sided_range',
        signalNumbers: 'signalNumbers' in fullSpec ? fullSpec.signalNumbers : [],
        name: 'name' in fullSpec ? fullSpec.name : undefined,
        startTime: fullSpec.startTime,
        endTime: fullSpec.endTime,
        x1, x2,
        yUpperZoneLow: yUpperZoneLow as number,
        yUpperZoneHigh: yUpperZoneHigh as number,
        yLowerZoneLow: yLowerZoneLow as number,
        yLowerZoneHigh: yLowerZoneHigh as number,
        yMidpoint: yMidpoint as number,
      })
    }
    signalRangeSegmentsRef.current = nextSegments
    setSignalRangeSegments((previous) => {
      if (previous.length === nextSegments.length && previous.every((segment, index) => {
        const next = nextSegments[index]
        return segment.id === next.id
          && segment.x1 === next.x1 && segment.x2 === next.x2
          && segment.yUpperZoneLow === next.yUpperZoneLow && segment.yUpperZoneHigh === next.yUpperZoneHigh
          && segment.yLowerZoneLow === next.yLowerZoneLow && segment.yLowerZoneHigh === next.yLowerZoneHigh
          && segment.yMidpoint === next.yMidpoint
          && segment.yEdgeZoneLow === next.yEdgeZoneLow && segment.yEdgeZoneHigh === next.yEdgeZoneHigh
          && segment.kind === next.kind && segment.activeEdge === next.activeEdge
          && segment.signalNumbers.join(',') === next.signalNumbers.join(',')
      })) return previous
      return nextSegments
    })
  }, [])

  const requestSignalRangeSync = useCallback(() => {
    if (signalRangeSyncFrameRef.current !== null) return
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      syncSignalRanges()
      return
    }
    signalRangeSyncFrameRef.current = window.requestAnimationFrame(() => {
      signalRangeSyncFrameRef.current = null
      syncSignalRanges()
    })
  }, [syncSignalRanges])

  const cacheVisibleViewport = useCallback(() => {
    if (savedViewRef.current || restoringViewRef.current) return
    const range = chartRef.current?.timeScale().getVisibleLogicalRange()
    if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to)) return
    viewportRangeCache.set(viewportRangeCacheKey(symbolRef.current, intervalRef.current), { from: range.from, to: range.to })
    const scale = chartRef.current?.priceScale('right')
    const priceRange = scale && !scale.options().autoScale ? scale.getVisibleRange() : null
    const snapshot = captureChartView(dataRef.current.map(candle => candle.time), range, priceRange)
    if (snapshot) saveChartView(symbolRef.current, intervalRef.current, snapshot)
  }, [])

  const restoreVisibleViewport = useCallback(() => {
    const snapshot = savedViewRef.current
    const chart = chartRef.current
    if (!snapshot || !chart) return false
    const range = restoredChartRange(dataRef.current.map(candle => candle.time), snapshot)
    if (!range) return false
    restoringViewRef.current = true
    savedViewRef.current = null
    chart.timeScale().setVisibleLogicalRange(range)
    if (snapshot.priceRange) chart.priceScale('right').setVisibleRange(snapshot.priceRange)
    window.requestAnimationFrame(() => {
      if (chartRef.current !== chart) { restoringViewRef.current = false; return }
      chart.timeScale().setVisibleLogicalRange(range)
      if (snapshot.priceRange) chart.priceScale('right').setVisibleRange(snapshot.priceRange)
      restoringViewRef.current = false
    })
    return true
  }, [])

  useEffect(() => {
    const flush = () => cacheVisibleViewport()
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
    }
  }, [cacheVisibleViewport])

  const flushProjectionRef = useRef(false)
  const requestViewportProjectionSync = useCallback(() => {
    if (viewportProjectionSyncFrameRef.current !== null) return
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      cacheVisibleViewport()
      requestTradeConnectionSync()
      requestSignalRangeSync()
      onViewportChangeRef.current?.()
      return
    }
    viewportProjectionSyncFrameRef.current = window.requestAnimationFrame(() => {
      viewportProjectionSyncFrameRef.current = null
      cacheVisibleViewport()
      requestTradeConnectionSync()
      requestSignalRangeSync()
      // Commit the drawing projection in the same frame as the canvas (wheel zoom,
      // trackpad scrolling, keyboard scrolling...). A deferred React render would
      // paint the drawings one frame after the candles, so they visibly trail.
      flushSync(() => { onViewportChangeRef.current?.() })
    })
  }, [cacheVisibleViewport, requestSignalRangeSync, requestTradeConnectionSync])

  useEffect(() => {
    dataRef.current = data
    const viewKey = `${symbol}:${interval}`
    if (savedViewKeyRef.current !== viewKey) {
      savedViewKeyRef.current = viewKey
      savedViewRef.current = loadChartView(symbol, interval)
      hydrationViewRef.current = savedViewRef.current
    }
    symbolRef.current = symbol
    intervalRef.current = interval
    followLatestRef.current = followLatest
    onHoverRef.current = onHover
    onPriceScaleStateChangeRef.current = onPriceScaleStateChange
    onViewportChangeRef.current = onViewportChange
    onSelectRangeObjectRef.current = onSelectRangeObject
    priceScaleAutoRef.current = priceScaleAuto
    priceScaleLogRef.current = priceScaleLog
    priceScalePercentRef.current = priceScalePercent
    priceScaleInvertedRef.current = priceScaleInverted
    visibleTradeLayerSourceIdsRef.current = visibleTradeLayerSourceIds
      decisionSignalSourceIdsRef.current = decisionSignalSourceIds
      decisionSignalAfterTimeRef.current = decisionSignalAfterTime
    visibleResearchSignalSourceIdsRef.current = visibleResearchSignalSourceIds
    apprenticeActionMarkersRef.current = apprenticeActionMarkers
    markersHiddenRef.current = markersHidden
    visibleRangeLayerSourceIdsRef.current = visibleRangeLayerSourceIds
    suppressedRangeObjectIdsRef.current = new Set(suppressedRangeObjectIds)
  }, [apprenticeActionMarkers, data, decisionSignalAfterTime, decisionSignalSourceIds, followLatest, interval, markersHidden, onHover, onPriceScaleStateChange, onSelectRangeObject, onViewportChange, priceScaleAuto, priceScaleInverted, priceScaleLog, priceScalePercent, suppressedRangeObjectIds, symbol, visibleRangeLayerSourceIds, visibleResearchSignalSourceIds, visibleTradeLayerSourceIds, showAllResearchReviews])

  useEffect(() => {
    selectedTradeMarkerIdRef.current = selectedTradeMarkerId
  }, [selectedTradeMarkerId])

  useEffect(() => {
    selectedSignalMarkerIdRef.current = selectedSignalMarkerId
  }, [selectedSignalMarkerId])

  useEffect(() => {
    selectedResearchSignalMarkerIdRef.current = selectedResearchSignalMarkerId
  }, [selectedResearchSignalMarkerId])

  useEffect(() => {
    selectedDecisionSignalMarkerIdRef.current = selectedDecisionSignalMarkerId
  }, [selectedDecisionSignalMarkerId])

  useEffect(() => {
    activeTradeRef.current = activeTrade
  }, [activeTrade])

  useEffect(() => {
    // Decision replay intentionally has no normal trade layer.  A decision
    // signal is still a selectable marker, so only clear its selection when
    // the decision signal source itself disappears (for example, after
    // leaving replay mode), not merely because visibleTradeLayerSourceIds is
    // empty.
    if (decisionSignalSourceIds.length > 0) return
    const clearTimer = window.setTimeout(() => {
      selectedDecisionSignalMarkerIdRef.current = null
      setSelectedDecisionSignalMarkerId(null)
    }, 0)
    return () => window.clearTimeout(clearTimer)
  }, [decisionSignalSourceIds])

  useEffect(() => {
    if (selectedResearchSignalMarkerId === null) return
    const selection = resolveResearchSignalMarker(symbol, interval, visibleResearchSignalSourceIds, selectedResearchSignalMarkerId)
    if (selection) return
    selectedResearchSignalMarkerIdRef.current = null
    // Clear a selection that is no longer valid for the current chart.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedResearchSignalMarkerId(null)
  }, [interval, selectedResearchSignalMarkerId, symbol, visibleResearchSignalSourceIds])

  useEffect(() => {
    const markerApi = seriesRef.current?.markers
    if (!markerApi) return
    const markers = visibleTradeMarkers(symbol, interval, dataRef.current, visibleTradeLayerSourceIds, activeTrade, tradeReferenceMarkers, decisionSignalSourceIds, decisionSignalAfterTime, markersHidden, visibleResearchSignalSourceIds, showAllResearchReviews, apprenticeActionMarkersRef.current, apprenticeOnly)
    markerApi.setMarkers(markers)
    let clearSelectionTimer: number | undefined
    if (visibleTradeLayerSourceIds.length === 0) {
      selectedTradeMarkerIdRef.current = null
      hoveredMarkerIdRef.current = null
      hoveredTradeNumberRef.current = null
      hoveredTradeSourceIdRef.current = null
      const clearDecisionSignalSelection = decisionSignalSourceIds.length === 0
      if (clearDecisionSignalSelection) selectedDecisionSignalMarkerIdRef.current = null
      clearSelectionTimer = window.setTimeout(() => {
        setSelectedTradeMarkerId(null)
        if (clearDecisionSignalSelection) setSelectedDecisionSignalMarkerId(null)
        setHoveredMarkerId(null)
        setHoveredTradeNumber(null)
        setHoveredTradeSourceId(null)
      }, 0)
    }
    requestTradeConnectionSync()
    return () => {
      if (clearSelectionTimer !== undefined) window.clearTimeout(clearSelectionTimer)
    }
  }, [activeTrade, apprenticeActionMarkers, apprenticeOnly, decisionSignalAfterTime, decisionSignalSourceIds, interval, markersHidden, requestTradeConnectionSync, symbol, tradeReferenceMarkers, visibleResearchSignalSourceIds, visibleTradeLayerSourceIds, showAllResearchReviews])

  useImperativeHandle(forwardedRef, () => ({
    getVisibleLogicalRange: () => chartRef.current?.timeScale().getVisibleLogicalRange() ?? null,
    setVisibleLogicalRange: (range) => {
      savedViewRef.current = null; hydrationViewRef.current = null
      pendingRangeRef.current = { range, expires: performance.now() + 600 }
      chartRef.current?.timeScale().setVisibleLogicalRange(range)
    },
    plotSize: () => {
      const chart = chartRef.current
      const container = containerRef.current
      if (!chart || !container) return null
      return { width: chart.timeScale().width(), height: Math.max(0, container.clientHeight - chart.timeScale().height()) }
    },
    fitContent: () => { savedViewRef.current = null; hydrationViewRef.current = null; chartRef.current?.timeScale().fitContent() },
    showDuration: (seconds) => {
      savedViewRef.current = null; hydrationViewRef.current = null
      const currentData = dataRef.current
      if (!chartRef.current || currentData.length === 0) return
      if (seconds === null) {
        chartRef.current.timeScale().fitContent()
        return
      }
      const to = currentData.at(-1)!.time as UTCTimestamp
      chartRef.current.timeScale().setVisibleRange({ from: (Number(to) - seconds) as UTCTimestamp, to })
    },
    showTimeRange: (from, to) => {
      savedViewRef.current = null; hydrationViewRef.current = null
      if (!chartRef.current || !Number.isFinite(from) || !Number.isFinite(to) || from >= to) return
      chartRef.current.timeScale().setVisibleRange({ from: from as UTCTimestamp, to: to as UTCTimestamp })
    },
    zoomToFraction: (from, to) => {
      savedViewRef.current = null; hydrationViewRef.current = null
      const scale = chartRef.current?.timeScale()
      const range = scale?.getVisibleLogicalRange()
      if (!scale || !range) return
      const span = range.to - range.from
      scale.setVisibleLogicalRange({ from: range.from + span * from, to: range.from + span * to })
    },
    coordinateToTime: (x) => {
      const value = chartRef.current?.timeScale().coordinateToTime(x)
      return typeof value === 'number' ? value : null
    },
    coordinateToPrice: (y) => {
      const value = seriesRef.current?.main.coordinateToPrice(y)
      return typeof value === 'number' ? value : null
    },
    priceToCoordinate: (price) => {
      const value = seriesRef.current?.main.priceToCoordinate(price)
      return typeof value === 'number' ? value : null
    },
    measurementAt: (xFraction, yFraction) => {
      const container = containerRef.current
      const chart = chartRef.current
      const series = seriesRef.current?.main
      if (!container || !chart || !series) return null
      const scale = chart.timeScale()
      const x = xFraction * container.clientWidth
      const directTime = scale.coordinateToTime(x)
      const logical = scale.coordinateToLogical(x)
      const currentData = dataRef.current
      let time: number | null = typeof directTime === 'number' ? Number(directTime) : null
      if (time === null && typeof logical === 'number' && Number.isFinite(logical) && currentData.length > 0) {
        const lastIndex = currentData.length - 1
        const intervalSeconds = INTERVALS[intervalRef.current].seconds
        if (logical < 0) time = currentData[0].time + logical * intervalSeconds
        else if (logical > lastIndex) {
          const future = futureTradingTimesRef.current
          const offset = logical - lastIndex
          const index = Math.floor(offset)
          const start = index === 0 ? currentData[lastIndex].time : future[index - 1]
          const end = future[index]
          time = start !== undefined && end !== undefined
            ? start + (end - start) * (offset - index)
            : future.length > 0 && offset >= future.length
              ? future[future.length - 1] + (offset - future.length) * intervalSeconds
              : currentData[lastIndex].time + offset * intervalSeconds
        }
        else {
          const lowerIndex = Math.max(0, Math.floor(logical))
          const upperIndex = Math.min(lastIndex, Math.ceil(logical))
          const lower = currentData[lowerIndex]
          const upper = currentData[upperIndex]
          const progress = logical - lowerIndex
          time = lower.time + (upper.time - lower.time) * progress
        }
      }
      const price = series.coordinateToPrice(yFraction * container.clientHeight)
      return typeof time === 'number' && Number.isFinite(time) && typeof price === 'number'
        ? { time: Math.round(time), price }
        : null
    },
    timeToCoordinate: (time) => {
      const chart = chartRef.current
      const currentData = dataRef.current
      if (!chart || currentData.length === 0) return null
      const scale = chart.timeScale()
      const direct = scale.timeToCoordinate(time as UTCTimestamp)
      if (typeof direct === 'number') return direct
      const lastIndex = currentData.length - 1
      const intervalSeconds = INTERVALS[intervalRef.current].seconds
      let logical: number
      if (time <= currentData[0].time) logical = (time - currentData[0].time) / intervalSeconds
      else if (time >= currentData[lastIndex].time) logical = lastIndex + futureTimeOffset(time, currentData[lastIndex].time, futureTradingTimesRef.current, intervalSeconds)
      else {
        let low = 1
        let high = lastIndex
        while (low < high) {
          const middle = Math.floor((low + high) / 2)
          if (currentData[middle].time < time) low = middle + 1
          else high = middle
        }
        const upperIndex = low
        const lowerIndex = upperIndex - 1
        const lower = currentData[lowerIndex]
        const upper = currentData[upperIndex]
        logical = lowerIndex + (time - lower.time) / Math.max(1, upper.time - lower.time)
      }
      return scale.logicalToCoordinate(logical as Logical)
    },
    focusLatest: () => {
      savedViewRef.current = null; hydrationViewRef.current = null
      const length = dataRef.current.length
      if (!chartRef.current || length === 0) return
      const range = centeredLatestLogicalRange(length)
      const extra = Math.max(0, focusHistoryBars - 110)
      chartRef.current.timeScale().setVisibleLogicalRange({ from: range.from - extra, to: range.to + extra })
    },
    scrollToRealtime: () => { savedViewRef.current = null; hydrationViewRef.current = null; chartRef.current?.timeScale().scrollToRealTime() },
    moveVisibleRange: (bars) => {
      savedViewRef.current = null; hydrationViewRef.current = null
      const scale = chartRef.current?.timeScale()
      const range = scale?.getVisibleLogicalRange()
      if (!scale || !range) return
      scale.setVisibleLogicalRange({ from: range.from + bars, to: range.to + bars })
    },
    zoomVisibleRange: (factor) => {
      savedViewRef.current = null; hydrationViewRef.current = null
      const scale = chartRef.current?.timeScale()
      const range = scale?.getVisibleLogicalRange()
      if (!scale || !range) return
      const center = (range.from + range.to) / 2
      const halfSpan = Math.max(3, (range.to - range.from) * factor / 2)
      scale.setVisibleLogicalRange({ from: center - halfSpan, to: center + halfSpan })
    },
    goToTime: (time) => {
      savedViewRef.current = null; hydrationViewRef.current = null
      const scale = chartRef.current?.timeScale()
      const range = scale?.getVisibleLogicalRange()
      const currentData = dataRef.current
      if (!scale || !range || currentData.length === 0) return
      const found = currentData.findIndex((candle) => candle.time >= time)
      const index = found === -1 ? currentData.length - 1 : found
      const span = range.to - range.from
      const range2 = { from: index - span / 2, to: index + span / 2 }
      // lightweight-charts applies a requested range on the next frame and keeps reporting the old one
      // until then. Remember the request so the data effect (which re-applies the "current" range when
      // React re-renders) does not put the stale range back and undo the jump.
      pendingRangeRef.current = { range: range2, expires: performance.now() + 600 }
      scale.setVisibleLogicalRange(range2)
    },
    selectResearchSignal: (markerId) => {
      selectedResearchSignalMarkerIdRef.current = markerId
      setSelectedResearchSignalMarkerId(markerId)
    },
    downloadScreenshot: () => {
      if (!chartRef.current) return
      const canvas = chartRef.current.takeScreenshot()
      canvas.toBlob((blob) => {
        if (!blob) return
        const link = document.createElement('a')
        const url = URL.createObjectURL(blob)
        link.download = `${symbol}-${new Date().toISOString().slice(0, 10)}.png`
        link.href = url
        document.body.appendChild(link)
        link.click()
        link.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      }, 'image/png')
    },
  }), [symbol, focusHistoryBars])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const dark = theme === 'dark'
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: dark ? '#131722' : '#ffffff' },
        textColor: dark ? '#b2b5be' : '#787b86',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif',
        fontSize: 14,
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: dark ? '#1e222d' : '#f0f3fa', style: 1 },
        horzLines: { color: dark ? '#1e222d' : '#f0f3fa', style: 1 },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: dark ? '#758093' : '#6b7280', width: 1, style: 3, labelBackgroundColor: '#353c4a' },
        horzLine: { color: dark ? '#758093' : '#6b7280', width: 1, style: 3, labelBackgroundColor: '#353c4a' },
      },
      rightPriceScale: {
        autoScale: priceScaleAutoRef.current,
        mode: priceScalePercentRef.current ? PriceScaleMode.Percentage : priceScaleLogRef.current ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
        invertScale: priceScaleInvertedRef.current,
        visible: true,
        borderVisible: true,
        borderColor: dark ? '#2a2e39' : '#e0e3eb',
        textColor: dark ? '#b2b5be' : '#787b86',
        ticksVisible: true,
        entireTextOnly: true,
        minimumWidth: 108,
        ensureEdgeTickMarksVisible: true,
        tickMarkDensity: 2.5,
        scaleMargins: { top: 0.08, bottom: indicators.volume ? 0.27 : 0.08 },
      },
      leftPriceScale: { visible: false },
      timeScale: {
        borderColor: dark ? '#2a2e39' : '#d8dee8',
        minimumHeight: 44,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
        barSpacing: 7,
        minBarSpacing: 0.02,
        fixLeftEdge: false,
        lockVisibleTimeRangeOnResize: true,
        tickMarkFormatter: formatBeijingTickMark,
      },
      // Keep native drag scrolling enabled for the whole chart lifetime. Toggling
      // this option on every pointerdown/pointerup forces lightweight-charts to
      // rebuild its gesture configuration and makes the first pan frames stutter.
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      // Vertical wheel zoom is handled below so accelerated wheel deltas can be
      // accumulated instead of being capped to one library zoom step/event.
      handleScale: { axisPressedMouseMove: true, mouseWheel: false, pinch: true },
      localization: {
        locale: 'zh-CN',
        priceFormatter: (price: number) => formatPrice(price, symbol),
        timeFormatter: formatBeijingChartTime,
      },
    })
    chartRef.current = chart

    let mainSeries: any
    if (chartType === 'line') {
      mainSeries = chart.addSeries(LineSeries, { color: '#2962ff', lineWidth: 2, priceLineVisible: true, lastValueVisible: true, priceLineColor: '#d1d4dc', priceLineStyle: 3 })
    } else if (chartType === 'area') {
      mainSeries = chart.addSeries(AreaSeries, {
        lineColor: '#2962ff', topColor: 'rgba(41, 98, 255, .34)', bottomColor: 'rgba(41, 98, 255, .02)', lineWidth: 2,
      })
    } else {
      // Light theme follows the SMC reference chart: white bodies for up candles,
      // black bodies for down candles, all outlined in black.
      mainSeries = chart.addSeries(CandlestickSeries, dark ? {
        upColor: chartType === 'hollow' ? '#131722' : '#f1f3f6',
        downColor: '#2962ff',
        borderUpColor: '#f1f3f6',
        borderDownColor: '#2962ff',
        wickUpColor: '#d1d4dc',
        wickDownColor: '#2962ff',
        priceLineVisible: true,
        priceLineColor: '#d1d4dc',
        priceLineStyle: 3,
      } : {
        upColor: '#ffffff',
        downColor: chartType === 'hollow' ? '#ffffff' : '#000000',
        borderUpColor: '#000000',
        borderDownColor: '#000000',
        wickUpColor: '#000000',
        wickDownColor: '#000000',
        priceLineVisible: true,
        priceLineColor: '#b2b5be',
        priceLineStyle: 3,
      })
    }

    memoizeSeriesData(mainSeries)
    const series: SeriesState = { main: mainSeries }
    if (indicators.volume) {
      series.volume = chart.addSeries(HistogramSeries, { priceScaleId: 'volume', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false })
      chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.77, bottom: 0 }, visible: false })
      series.volumeAverage = chart.addSeries(LineSeries, { priceScaleId: 'volume', color: '#ff9800', lineWidth: 2, priceLineVisible: false, lastValueVisible: false })
    }
    if (indicators.ma) series.ma = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
    if (indicators.ema) series.ema = chart.addSeries(LineSeries, { color: '#2962ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
    if (indicators.boll) {
      const options = { lineWidth: 1 as const, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }
      series.bollUpper = chart.addSeries(LineSeries, { ...options, color: '#9b7bff' })
      series.bollMiddle = chart.addSeries(LineSeries, { ...options, color: '#7c5cff' })
      series.bollLower = chart.addSeries(LineSeries, { ...options, color: '#9b7bff' })
    }
    seriesRef.current = series
    if (indicators.smc !== false && chartType !== 'line' && chartType !== 'area') {
      series.smc = attachSmartMoneyOverlay(container, chart, mainSeries, symbolRef.current === 'NQ1!')
      series.smc.setShowFilledGaps(showFilledGapsRef.current)
      series.smc.setData(dataRef.current)
      series.smc.setFutureTimes(futureTradingTimesRef.current)
    }
    blackBarsAppliedRef.current = blackBarTimesRef.current
    updateSeries(series, dataRef.current, chartType, indicators, { times: new Set(blackBarTimesRef.current), border: dark ? '#9aa3b5' : '#000000' }, hiddenTailRef.current)
    series.markers = createSeriesMarkers(mainSeries, visibleTradeMarkers(
      symbol,
      interval,
      dataRef.current,
      visibleTradeLayerSourceIdsRef.current,
      activeTradeRef.current,
      tradeReferenceMarkersRef.current,
      decisionSignalSourceIdsRef.current,
      decisionSignalAfterTimeRef.current,
      markersHiddenRef.current,
      visibleResearchSignalSourceIdsRef.current,
      true,
      apprenticeActionMarkersRef.current,
      apprenticeOnly,
    ))
    const timeScale = chart.timeScale()
    const wheelZoomBurstActive = false
    let mousePanBurstActive = false
    let wheelProjectionIdleTimer: number | null = null
    const onTimeScaleChange = () => {
      // Native canvas panning stays on the compositor path. DOM/SVG overlays
      // use a cheap translate preview during the gesture and receive one exact
      // React projection after pointerup.
      if (shouldDeferViewportProjectionSync({ wheelZoomBurstActive, mousePanBurstActive })) return
      requestViewportProjectionSync()
    }
    // Logical-range changes cover both horizontal panning and zooming. A
    // visible-time subscription reports the same gesture again, so listening
    // to both only duplicates projection work.
    timeScale.subscribeVisibleLogicalRangeChange(onTimeScaleChange)
    timeScale.subscribeSizeChange(onTimeScaleChange)
    const initialDataLength = dataRef.current.length
    savedViewRef.current ??= loadChartView(symbol, interval)
    previousLengthRef.current = initialDataLength
    if (initialDataLength > 0) {
      const cachedRange = viewportRangeCache.get(viewportRangeCacheKey(symbol, interval))
      if (!restoreVisibleViewport()) chart.timeScale().setVisibleLogicalRange(initialChartLogicalRange(initialDataLength, cachedRange, centerLatestByDefault))
      cacheVisibleViewport()
      requestViewportProjectionSync()
    }

    chart.subscribeCrosshairMove((param) => {
      // Panning already updates the native canvas directly. Crosshair work is
      // comparatively expensive here because it resolves replay markers and
      // scans the full candle array for every pointer frame. Skipping it while
      // the primary button is held keeps the chart attached to the pointer;
      // normal hover state resumes on the first move after the drag finishes.
      if (mousePanBurstActive) return
      const rawMarkerId = param.hoveredInfo?.objectKind === 'series-marker'
        ? param.hoveredInfo.objectId ?? param.hoveredObjectId
        : undefined
      const markerId = typeof rawMarkerId === 'string' ? rawMarkerId : undefined
      const nextHoveredMarkerId = markerId ?? null
      if (hoveredMarkerIdRef.current !== nextHoveredMarkerId) {
        hoveredMarkerIdRef.current = nextHoveredMarkerId
        setHoveredMarkerId(nextHoveredMarkerId)
      }
      const hoveredSelection = resolveReplayTradeMarker(symbolRef.current, intervalRef.current, visibleTradeLayerSourceIdsRef.current, markerId)
      const nextHoveredTradeNumber = hoveredSelection?.trade.tradeNumber ?? null
      const nextHoveredTradeSourceId = hoveredSelection?.sourceId ?? null
      if (hoveredTradeNumberRef.current !== nextHoveredTradeNumber || hoveredTradeSourceIdRef.current !== nextHoveredTradeSourceId) {
        hoveredTradeNumberRef.current = nextHoveredTradeNumber
        hoveredTradeSourceIdRef.current = nextHoveredTradeSourceId
        setHoveredTradeNumber(nextHoveredTradeNumber)
        setHoveredTradeSourceId(nextHoveredTradeSourceId)
      }
      if (!param.time) {
        onHoverRef.current(null)
        return
      }
      const timestamp = typeof param.time === 'number' ? param.time : 0
      onHoverRef.current(candleAtTime(dataRef.current, timestamp))
    })
    const onChartClick = (param: MouseEventParams) => {
      const clearMarkerDetails = () => {
        selectedTradeMarkerIdRef.current = null
        setSelectedTradeMarkerId(null)
        selectedSignalMarkerIdRef.current = null
        setSelectedSignalMarkerId(null)
        selectedResearchSignalMarkerIdRef.current = null
        setSelectedResearchSignalMarkerId(null)
        selectedDecisionSignalMarkerIdRef.current = null
        setSelectedDecisionSignalMarkerId(null)
        hoveredMarkerIdRef.current = null
        setHoveredMarkerId(null)
        hoveredTradeNumberRef.current = null
        setHoveredTradeNumber(null)
        hoveredTradeSourceIdRef.current = null
        setHoveredTradeSourceId(null)
      }
      if (param.hoveredInfo?.objectKind === 'series-marker') {
        const objectId = param.hoveredInfo.objectId ?? param.hoveredObjectId
        const tradeSelection = resolveReplayTradeMarker(symbolRef.current, intervalRef.current, visibleTradeLayerSourceIdsRef.current, objectId)
        if (tradeSelection) {
          onSelectRangeObjectRef.current?.(null)
          selectedSignalMarkerIdRef.current = null
          setSelectedSignalMarkerId(null)
          selectedResearchSignalMarkerIdRef.current = null
          setSelectedResearchSignalMarkerId(null)
          selectedDecisionSignalMarkerIdRef.current = null
          setSelectedDecisionSignalMarkerId(null)
          const nextId = toggleXauTradeMarkerSelection(selectedTradeMarkerIdRef.current, tradeSelection.id)
          selectedTradeMarkerIdRef.current = nextId
          setSelectedTradeMarkerId(nextId)
          return
        }
        const signalSelection = resolveReplaySignalMarker(symbolRef.current, intervalRef.current, objectId)
        if (signalSelection) {
          onSelectRangeObjectRef.current?.(null)
          selectedTradeMarkerIdRef.current = null
          setSelectedTradeMarkerId(null)
          selectedResearchSignalMarkerIdRef.current = null
          setSelectedResearchSignalMarkerId(null)
          selectedDecisionSignalMarkerIdRef.current = null
          setSelectedDecisionSignalMarkerId(null)
          const nextId = toggleReplaySignalMarkerSelection(selectedSignalMarkerIdRef.current, signalSelection.id)
          selectedSignalMarkerIdRef.current = nextId
          setSelectedSignalMarkerId(nextId)
          return
        }
        const researchSignalSelection = resolveResearchSignalMarker(
          symbolRef.current,
          intervalRef.current,
          visibleResearchSignalSourceIdsRef.current,
          objectId,
        )
        if (researchSignalSelection) {
          onSelectRangeObjectRef.current?.(null)
          selectedTradeMarkerIdRef.current = null
          setSelectedTradeMarkerId(null)
          selectedSignalMarkerIdRef.current = null
          setSelectedSignalMarkerId(null)
          selectedDecisionSignalMarkerIdRef.current = null
          setSelectedDecisionSignalMarkerId(null)
          const nextId = selectedResearchSignalMarkerIdRef.current === researchSignalSelection.id ? null : researchSignalSelection.id
          selectedResearchSignalMarkerIdRef.current = nextId
          setSelectedResearchSignalMarkerId(nextId)
          return
        }
        const decisionSignalSelection = resolveReplayDecisionSignalMarker(
          symbolRef.current,
          intervalRef.current,
          decisionSignalSourceIdsRef.current,
          objectId,
        )
        if (decisionSignalSelection) {
          onSelectRangeObjectRef.current?.(null)
          selectedTradeMarkerIdRef.current = null
          setSelectedTradeMarkerId(null)
          selectedSignalMarkerIdRef.current = null
          setSelectedSignalMarkerId(null)
          selectedResearchSignalMarkerIdRef.current = null
          setSelectedResearchSignalMarkerId(null)
          const nextId = selectedDecisionSignalMarkerIdRef.current === decisionSignalSelection.id ? null : decisionSignalSelection.id
          selectedDecisionSignalMarkerIdRef.current = nextId
          setSelectedDecisionSignalMarkerId(nextId)
        }
        return
      }
      if (!param.point) return
      const rangeObjectId = hitTestSignalRange(signalRangeSegmentsRef.current, param.point.x, param.point.y)
      clearMarkerDetails()
      onSelectRangeObjectRef.current?.(rangeObjectId)
    }
    chart.subscribeClick(onChartClick)
    let pendingWheelDelta = 0
    let pendingWheelX = container.clientWidth / 2
    let wheelZoomFrame: number | null = null
    const cancelQueuedProjectionSync = () => {
      if (viewportProjectionSyncFrameRef.current !== null) {
        window.cancelAnimationFrame(viewportProjectionSyncFrameRef.current)
        viewportProjectionSyncFrameRef.current = null
      }
      if (tradeConnectionSyncFrameRef.current !== null) {
        window.cancelAnimationFrame(tradeConnectionSyncFrameRef.current)
        tradeConnectionSyncFrameRef.current = null
      }
      if (signalRangeSyncFrameRef.current !== null) {
        window.cancelAnimationFrame(signalRangeSyncFrameRef.current)
        signalRangeSyncFrameRef.current = null
      }
    }
    const deferWheelProjectionUntilIdle = () => {
      // Drawings follow every wheel frame (flushed in the same frame as the
      // canvas); the idle sync below only settles the final exact state.
      flushProjectionRef.current = true
      if (wheelProjectionIdleTimer !== null) window.clearTimeout(wheelProjectionIdleTimer)
      wheelProjectionIdleTimer = window.setTimeout(() => {
        wheelProjectionIdleTimer = null
        flushProjectionRef.current = false
        requestViewportProjectionSync()
      }, 120)
    }
    const flushWheelZoom = () => {
      wheelZoomFrame = null
      const delta = pendingWheelDelta
      pendingWheelDelta = 0
      if (delta === 0) return

      const scale = chart.timeScale()
      const range = scale.getVisibleLogicalRange()
      if (!range) return
      const pointerLogical = scale.coordinateToLogical(pendingWheelX)
      const anchorLogical = typeof pointerLogical === 'number' && Number.isFinite(pointerLogical)
        ? pointerLogical
        : (range.from + range.to) / 2
      const nextRange = zoomLogicalRangeAt(range, anchorLogical, delta, {
        minSpan: 6,
        // Match the chart's minBarSpacing limit while still allowing all data
        // to fit on wide/high-resolution screens.
        maxSpan: Math.max(1_000, container.clientWidth / 0.02),
      })
      scale.setVisibleLogicalRange(nextRange)
      if (pendingWheelDelta !== 0 && wheelZoomFrame === null) {
        wheelZoomFrame = window.requestAnimationFrame(flushWheelZoom)
      }
    }
    const handleChartWheel = (event: WheelEvent) => {
      if (event.deltaY === 0 || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return
      savedViewRef.current = null
      hydrationViewRef.current = null
      restoringViewRef.current = false
      // lightweight-charts sets its canvases to pointer-events:none, so wheel
      // events normally target an internal table cell instead of the canvas.
      // This listener is scoped to the chart root; floating replay panels are
      // siblings and therefore keep their own native scrolling.
      event.preventDefault()
      event.stopPropagation()
      deferWheelProjectionUntilIdle()
      pendingWheelDelta += normalizedWheelDelta(event.deltaY, event.deltaMode)
      pendingWheelX = Math.max(0, Math.min(container.clientWidth, event.clientX - container.getBoundingClientRect().left))
      if (wheelZoomFrame === null) wheelZoomFrame = window.requestAnimationFrame(flushWheelZoom)
    }
    let mousePanFinishFrame: number | null = null
    let mousePanPreviewFrame: number | null = null
    let mousePanPreviewX = 0
    let mousePanPreviewY = 0
    type PanPreviewTarget = {
      element: HTMLElement | SVGElement
      axis: 'both' | 'x' | 'y'
      previousTranslate: string
      previousWillChange: string
    }
    let mousePanPreviewTargets: PanPreviewTarget[] = []
    const collectPanPreviewTargets = () => {
      const root = container.closest('.chart-area') ?? container
      const targetGroups: Array<{ selector: string; axis: PanPreviewTarget['axis'] }> = [
        { selector: '.decision-chart-annotations, .drawing-overlay, .signal-range-overlay, .trade-connection-overlay, .mp-annotations', axis: 'both' },
        { selector: '.locked-time-cursor', axis: 'x' },
        { selector: '.context-price-line, .decision-price-line, .decision-risk-line, .decision-position-pnl-line', axis: 'y' },
      ]
      mousePanPreviewTargets = targetGroups.flatMap(({ selector, axis }) => (
        [...root.querySelectorAll<HTMLElement | SVGElement>(selector)].map((element) => ({
          element,
          axis,
          previousTranslate: element.style.translate,
          previousWillChange: element.style.willChange,
        }))
      ))
      for (const target of mousePanPreviewTargets) target.element.style.willChange = 'translate'
    }
    // The preview offset is read from the chart itself (where a reference candle and
    // price now sit) instead of the mouse delta, so it matches the canvas exactly even
    // when the pointer leaves the chart or the library clamps the scroll at the edge.
    let panReference: { logical: Logical; x: number; price: number; y: number } | null = null
    const capturePanReference = () => {
      panReference = null
      const range = timeScale.getVisibleLogicalRange()
      if (!range) return
      const logical = Math.round((range.from + range.to) / 2) as Logical
      const x = timeScale.logicalToCoordinate(logical)
      const y = Math.round((chart.panes()[0]?.getHeight() ?? container.clientHeight) / 2)
      const price = mainSeries?.coordinateToPrice(y) as number | null | undefined
      if (x === null || price === null || price === undefined) return
      panReference = { logical, x, price, y }
    }
    const modelPanOffset = () => {
      if (!panReference) return null
      const x = timeScale.logicalToCoordinate(panReference.logical)
      const y = mainSeries?.priceToCoordinate(panReference.price) as number | null | undefined
      if (x === null || y === null || y === undefined) return null
      return { x: x - panReference.x, y: y - panReference.y }
    }
    const applyPanPreview = () => {
      mousePanPreviewFrame = null
      const offset = modelPanOffset()
      const offsetX = offset?.x ?? mousePanPreviewX
      const offsetY = offset?.y ?? mousePanPreviewY
      for (const target of mousePanPreviewTargets) {
        const x = target.axis === 'y' ? 0 : offsetX
        const y = target.axis === 'x' ? 0 : offsetY
        target.element.style.translate = `${x}px ${y}px`
      }
      // Follow the chart on every frame of the drag. The callback is queued a frame
      // ahead, so it runs after that frame's input has moved the chart and before the
      // library paints, putting overlay and candles in the same frame.
      if (armedPricePan) mousePanPreviewFrame = window.requestAnimationFrame(applyPanPreview)
    }
    const requestPanPreview = (x: number, y: number) => {
      mousePanPreviewX = x
      mousePanPreviewY = y
      if (mousePanPreviewFrame !== null) return
      mousePanPreviewFrame = window.requestAnimationFrame(applyPanPreview)
    }
    const clearPanPreview = () => {
      if (mousePanPreviewFrame !== null) {
        window.cancelAnimationFrame(mousePanPreviewFrame)
        mousePanPreviewFrame = null
      }
      for (const target of mousePanPreviewTargets) {
        target.element.style.translate = target.previousTranslate
        target.element.style.willChange = target.previousWillChange
      }
      mousePanPreviewTargets = []
      mousePanPreviewX = 0
      mousePanPreviewY = 0
      panReference = null
    }
    let armedPricePan: {
      pointerId: number
      startX: number
      startY: number
      maxVerticalDistance: number
      autoScaleWasOn: boolean
    } | null = null
    const armMousePan = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0) return
      // lightweight-charts canvases may use pointer-events:none, so their
      // internal table/cell can be the target. Accept the complete chart root
      // and only exclude controls which own an independent pointer gesture.
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.trade-marker-details, button, input, textarea, select, [role="dialog"], [data-chart-pan-block="true"]')) return
      const bounds = container.getBoundingClientRect()
      const paneHeight = chart.panes()[0]?.getHeight() ?? Math.max(0, container.clientHeight - timeScale.height())
      const paneWidth = Math.max(0, bounds.width - chart.priceScale('right').width())
      const localX = event.clientX - bounds.left
      const localY = event.clientY - bounds.top
      // Keep TradingView-compatible axis gestures intact: the right price
      // axis scales prices and the bottom time axis scales time. Vertical
      // panning is armed only when the actual candle pane is pressed.
      if (localX < 0 || localX > paneWidth || localY < 0 || localY > paneHeight) return
      savedViewRef.current = null
      hydrationViewRef.current = null
      restoringViewRef.current = false
      const priceScale = chart.priceScale('right')
      const autoScaleWasOn = priceScale.options().autoScale
      // lightweight-charts deliberately ignores pane price scrolling while
      // autoScale is active. Disable it before the library receives the same
      // pointerdown so vertical dragging works immediately in every mode.
      if (autoScaleWasOn) priceScale.setAutoScale(false)
      clearPanPreview()
      collectPanPreviewTargets()
      capturePanReference()
      armedPricePan = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, maxVerticalDistance: 0, autoScaleWasOn }
      mousePanPreviewFrame = window.requestAnimationFrame(applyPanPreview)
      container.dataset.pricePanActive = 'true'
      mousePanBurstActive = true
      cancelQueuedProjectionSync()
    }
    const finishMousePan = (event?: Event) => {
      if (event instanceof PointerEvent && armedPricePan && event.pointerId !== armedPricePan.pointerId) return
      const completedPan = armedPricePan
      armedPricePan = null
      delete container.dataset.pricePanActive
      const restoreAutoScale = Boolean(completedPan?.autoScaleWasOn
        && (event?.type === 'pointercancel' || event?.type === 'blur' || completedPan.maxVerticalDistance < 3))
      const shouldSync = mousePanBurstActive
      mousePanBurstActive = false
      if (!shouldSync || mousePanFinishFrame !== null) return
      mousePanFinishFrame = window.requestAnimationFrame(() => {
        mousePanFinishFrame = null
        // Wait until after lightweight-charts receives its native mouseup and
        // clears the internal price-scroll snapshot. Restoring auto scale in
        // the pointerup capture phase would make its end-scroll handler bail
        // out early and leave the next gesture in a stale state.
        if (restoreAutoScale) chart.priceScale('right').setAutoScale(true)
        const options = chart.priceScale('right').options()
        onPriceScaleStateChangeRef.current(options.autoScale, options.mode === PriceScaleMode.Logarithmic, options.mode === PriceScaleMode.Percentage, options.invertScale)
        cancelQueuedProjectionSync()
        // One synchronous projection commit replaces dozens of App-level
        // renders during the gesture. Clear the compositor preview only after
        // the exact coordinates have reached the DOM.
        flushSync(() => {
          cacheVisibleViewport()
          syncTradeConnections()
          syncSignalRanges()
          onViewportChangeRef.current?.()
        })
        clearPanPreview()
      })
    }
    const rejectUnpressedMouseMove = (event: PointerEvent) => {
      if (armedPricePan?.pointerId === event.pointerId) {
        armedPricePan.maxVerticalDistance = Math.max(armedPricePan.maxVerticalDistance, Math.abs(event.clientY - armedPricePan.startY))
        requestPanPreview(event.clientX - armedPricePan.startX, event.clientY - armedPricePan.startY)
      }
      if (event.pointerType === 'mouse' && event.buttons === 0) finishMousePan()
    }
    // Dragging (or wheel-scaling) the price axis changes the vertical mapping
    // without any time-scale event, so DOM/SVG drawings stayed at their old
    // coordinates until the next gesture. Poll the mapping while the axis is
    // being used and re-project whenever it changes, plus once at the end.
    let axisActive = false
    let axisFrame: number | null = null
    let axisProbe = ''
    let axisWheelTimer: number | null = null
    const pollAxis = () => {
      axisFrame = null
      const probe = `${mainSeries.priceToCoordinate(0)}|${mainSeries.priceToCoordinate(1000)}`
      if (probe !== axisProbe) {
        axisProbe = probe
        requestViewportProjectionSync()
      }
      if (axisActive) axisFrame = window.requestAnimationFrame(pollAxis)
      else requestViewportProjectionSync()
    }
    const startAxisPoll = () => {
      axisActive = true
      if (axisFrame === null) axisFrame = window.requestAnimationFrame(pollAxis)
    }
    const stopAxisPoll = () => {
      if (!axisActive) return
      axisActive = false
      if (axisFrame === null) axisFrame = window.requestAnimationFrame(pollAxis)
    }
    const onPointOnPriceAxis = (clientX: number) => {
      const bounds = container.getBoundingClientRect()
      return clientX - bounds.left > Math.max(0, bounds.width - chart.priceScale('right').width())
    }
    const axisPointerDown = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0 || !onPointOnPriceAxis(event.clientX)) return
      axisProbe = ''
      startAxisPoll()
    }
    const axisWheel = (event: WheelEvent) => {
      if (!onPointOnPriceAxis(event.clientX)) return
      axisProbe = ''
      startAxisPoll()
      if (axisWheelTimer !== null) window.clearTimeout(axisWheelTimer)
      axisWheelTimer = window.setTimeout(() => { axisWheelTimer = null; stopAxisPoll() }, 250)
    }
    container.addEventListener('pointerdown', axisPointerDown, true)
    container.addEventListener('wheel', axisWheel, { passive: true, capture: true })
    window.addEventListener('pointerup', stopAxisPoll, true)
    window.addEventListener('pointercancel', stopAxisPoll, true)
    const projectionResizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(requestViewportProjectionSync)
    projectionResizeObserver?.observe(container)
    container.addEventListener('pointerdown', armMousePan, true)
    container.addEventListener('pointermove', rejectUnpressedMouseMove, true)
    container.addEventListener('wheel', handleChartWheel, { passive: false, capture: true })
    window.addEventListener('pointerup', finishMousePan, true)
    window.addEventListener('pointercancel', finishMousePan, true)
    window.addEventListener('blur', finishMousePan)
    return () => {
      projectionResizeObserver?.disconnect()
      container.removeEventListener('pointerdown', axisPointerDown, true)
      container.removeEventListener('wheel', axisWheel, true)
      window.removeEventListener('pointerup', stopAxisPoll, true)
      window.removeEventListener('pointercancel', stopAxisPoll, true)
      axisActive = false
      if (axisFrame !== null) window.cancelAnimationFrame(axisFrame)
      if (axisWheelTimer !== null) window.clearTimeout(axisWheelTimer)
      container.removeEventListener('pointerdown', armMousePan, true)
      container.removeEventListener('pointermove', rejectUnpressedMouseMove, true)
      container.removeEventListener('wheel', handleChartWheel, true)
      if (wheelZoomFrame !== null) window.cancelAnimationFrame(wheelZoomFrame)
      if (wheelProjectionIdleTimer !== null) window.clearTimeout(wheelProjectionIdleTimer)
      if (mousePanFinishFrame !== null) window.cancelAnimationFrame(mousePanFinishFrame)
      clearPanPreview()
      window.removeEventListener('pointerup', finishMousePan, true)
      window.removeEventListener('pointercancel', finishMousePan, true)
      window.removeEventListener('blur', finishMousePan)
      timeScale.unsubscribeVisibleLogicalRangeChange(onTimeScaleChange)
      timeScale.unsubscribeSizeChange(onTimeScaleChange)
      if (viewportProjectionSyncFrameRef.current !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(viewportProjectionSyncFrameRef.current)
        viewportProjectionSyncFrameRef.current = null
      }
      if (tradeConnectionSyncFrameRef.current !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(tradeConnectionSyncFrameRef.current)
        tradeConnectionSyncFrameRef.current = null
      }
      if (signalRangeSyncFrameRef.current !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(signalRangeSyncFrameRef.current)
        signalRangeSyncFrameRef.current = null
      }
      chart.unsubscribeClick(onChartClick)
      selectedTradeMarkerIdRef.current = null
      setSelectedTradeMarkerId(null)
      selectedSignalMarkerIdRef.current = null
      setSelectedSignalMarkerId(null)
      selectedResearchSignalMarkerIdRef.current = null
      setSelectedResearchSignalMarkerId(null)
      selectedDecisionSignalMarkerIdRef.current = null
      setSelectedDecisionSignalMarkerId(null)
      hoveredMarkerIdRef.current = null
      setHoveredMarkerId(null)
      hoveredTradeNumberRef.current = null
      setHoveredTradeNumber(null)
      hoveredTradeSourceIdRef.current = null
      setHoveredTradeSourceId(null)
      activeTradeRef.current = null
      setTradeConnectionSegments([])
      signalRangeSegmentsRef.current = []
      setSignalRangeSegments([])
      series.smc?.destroy()
      apprenticePriceLinesRef.current.forEach((line) => seriesRef.current?.main.removePriceLine(line))
      apprenticePriceLinesRef.current = []
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [apprenticeOnly, cacheVisibleViewport, restoreVisibleViewport, centerLatestByDefault, chartType, indicators, interval, requestSignalRangeSync, requestTradeConnectionSync, requestViewportProjectionSync, symbol, syncSignalRanges, syncTradeConnections, theme])

  useEffect(() => {
    const scale = chartRef.current?.priceScale('right')
    if (scale) {
      // Only touch mode / invert when they really changed: re-applying the same mode refits the price range,
      // which made the chart jump when auto-scale was switched off (e.g. when a replay starts).
      const current = scale.options()
      const mode = priceScalePercent ? PriceScaleMode.Percentage : priceScaleLog ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal
      scale.applyOptions({
        autoScale: priceScaleAuto,
        ...(current.mode !== mode ? { mode } : {}),
        ...(current.invertScale !== priceScaleInverted ? { invertScale: priceScaleInverted } : {}),
      })
    }
    requestTradeConnectionSync()
    requestSignalRangeSync()
    onViewportChangeRef.current?.()
  }, [priceScaleAuto, priceScaleInverted, priceScaleLog, priceScalePercent, requestSignalRangeSync, requestTradeConnectionSync])

  useEffect(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    if (!chart || !series) return
    const dataChanged = previousDataIdentityRef.current !== data
    if (dataChanged) {
      previousDataIdentityRef.current = data
      hoveredMarkerIdRef.current = null
      setHoveredMarkerId(null)
      hoveredTradeNumberRef.current = null
      setHoveredTradeNumber(null)
      hoveredTradeSourceIdRef.current = null
      setHoveredTradeSourceId(null)
    }
    const previousLength = previousLengthRef.current
    const timeScale = chart.timeScale()
    const pendingRange = pendingRangeRef.current && pendingRangeRef.current.expires > performance.now() ? pendingRangeRef.current.range : null
    const visibleRange = pendingRange ?? timeScale.getVisibleLogicalRange()
    const shouldFocusLatest = !suppressAutoFocus && focusLatestKeyRef.current !== focusLatestKey
    // A decision-focus request is issued while the candidate panel changes,
    // but the new candidate's candles can arrive one render later.  Do not
    // consume that request against the previous candidate's non-empty data;
    // wait for the data identity to change so the focus range is calculated
    // from the actual trade being entered.
    const focusReady = shouldFocusLatest && dataChanged && data.length > 0
    const wasAtRealtime = isRealtimeScrollPosition(timeScale.scrollPosition())
    if (dataChanged) {
      blackBarsAppliedRef.current = blackBarTimesRef.current
      if (hydrationViewRef.current) savedViewRef.current = hydrationViewRef.current
      updateSeries(series, data, chartType, indicators, { times: new Set(blackBarTimesRef.current), border: blackBorderRef.current }, hiddenTailRef.current)
      series.smc?.setData(data)
    }
    const restoredViewport = restoringViewRef.current || restoreVisibleViewport()
    const revealedMarkers = visibleTradeMarkers(symbol, interval, data, visibleTradeLayerSourceIds, activeTradeRef.current, tradeReferenceMarkers, decisionSignalSourceIds, decisionSignalAfterTime, markersHidden, visibleResearchSignalSourceIds, showAllResearchReviews, apprenticeActionMarkers, apprenticeOnly)
    series.markers?.setMarkers(revealedMarkers)
    if (!markersHidden && selectedTradeMarkerIdRef.current && !revealedMarkers.some((marker) => marker.id === selectedTradeMarkerIdRef.current)) {
      selectedTradeMarkerIdRef.current = null
      setSelectedTradeMarkerId(null)
    }
    if (!markersHidden && selectedSignalMarkerIdRef.current && !revealedMarkers.some((marker) => marker.id === selectedSignalMarkerIdRef.current)) {
      selectedSignalMarkerIdRef.current = null
      setSelectedSignalMarkerId(null)
    }
    if (!markersHidden && selectedDecisionSignalMarkerIdRef.current && !revealedMarkers.some((marker) => marker.id === selectedDecisionSignalMarkerIdRef.current)) {
      selectedDecisionSignalMarkerIdRef.current = null
      setSelectedDecisionSignalMarkerId(null)
    }
    previousLengthRef.current = data.length
    // Entering another decision candidate may explicitly request a fresh
    // center. Revealing the next candle inside the same trade must preserve
    // the user's horizontal and vertical chart placement.
    const viewportAction = viewportActionAfterDataUpdate({
      focusReady,
      hasVisibleRange: Boolean(visibleRange),
      followLatest: followLatestRef.current,
      wasAtRealtime,
      previousLength,
      nextLength: data.length,
    })
    if (restoredViewport) {
      // The saved time anchor wins over startup centering or realtime following.
    } else if (viewportAction === 'center') {
      const range = centeredLatestLogicalRange(data.length)
      const extra = Math.max(0, focusHistoryBars - 110)
      timeScale.setVisibleLogicalRange({ from: range.from - extra, to: range.to + extra })
    } else if (viewportAction === 'realtime') {
      timeScale.scrollToRealTime()
    } else if (viewportAction === 'preserve' && visibleRange) {
      timeScale.setVisibleLogicalRange(visibleRange)
      // setData keeps the library's right offset, so a shorter / longer series would slide the
      // candles sideways. The range above only lands on the next frame and getVisibleLogicalRange()
      // reports the slid range until then; remember it so an effect re-run in the meantime does
      // not re-apply the slid range (e.g. review replay hiding the later candles).
      if (dataChanged && previousLength !== data.length) pendingRangeRef.current = { range: { from: visibleRange.from, to: visibleRange.to }, expires: performance.now() + 600 }
    }
    // The apprentice report supplies a fixed historical review window.  A
    // normal workspace viewport may have a cached range from a different
    // session, which compresses the hydrated candles against the left edge.
    // Apply the report's actual timestamps after the new series is committed,
    // then let lightweight-charts auto-scale to those candles.
    if (!restoredViewport && apprenticeOnly && dataChanged && apprenticeFocusRange) {
      const startIndex = data.findIndex((candle) => candle.time >= apprenticeFocusRange.startTime)
      let endIndex = -1
      for (let index = data.length - 1; index >= 0; index -= 1) {
        if (data[index].time <= apprenticeFocusRange.endTime) {
          endIndex = index
          break
        }
      }
      if (startIndex >= 0 && endIndex >= startIndex) {
        timeScale.setVisibleLogicalRange({
          from: Math.max(0, startIndex - 4),
          to: Math.min(data.length - 1, endIndex + 4),
        })
        chart.priceScale('right').applyOptions({ autoScale: true })
      }
    }
    // Keep a focus request pending while the causal data set is empty.  The
    // next data commit can then apply it once the signal window is available.
    if (!shouldFocusLatest || focusReady) focusLatestKeyRef.current = focusLatestKey
    requestTradeConnectionSync()
    requestSignalRangeSync()
    // Sibling SVG annotations rendered before setData may have null/stale
    // coordinates. An unchanged visible range does not fire a scale event,
    // so explicitly reproject once the new chart data has been painted.
    if (dataChanged) requestViewportProjectionSync()
  }, [apprenticeActionMarkers, apprenticeFocusRange, apprenticeOnly, chartType, data, decisionSignalAfterTime, decisionSignalSourceIds, focusLatestKey, focusHistoryBars, indicators, interval, markersHidden, requestSignalRangeSync, requestTradeConnectionSync, requestViewportProjectionSync, restoreVisibleViewport, suppressAutoFocus, suppressedRangeObjectIds, symbol, tradeReferenceMarkers, visibleRangeLayerSourceIds, visibleResearchSignalSourceIds, visibleTradeLayerSourceIds, showAllResearchReviews])

  useEffect(() => {
    const series = seriesRef.current?.main
    if (!series) return
    apprenticePriceLinesRef.current.forEach((line) => series.removePriceLine(line))
    apprenticePriceLinesRef.current = []
    if (!apprenticeOnly) return
    const levels = new Map<number, ApprenticeActionMarker>()
    apprenticeActionMarkers.forEach((marker) => {
      if (marker.price !== undefined && Number.isFinite(marker.price) && marker.price > 0) levels.set(marker.price, marker)
    })
    apprenticePriceLinesRef.current = [...levels.values()].map((marker) => {
      const color = marker.kind === 'plan' ? '#a78bfa' : marker.kind === 'filled' ? '#22c55e' : marker.kind === 'cancel' ? '#f59e0b' : '#38bdf8'
      const title = marker.kind === 'plan' ? '计划价' : marker.kind === 'filled' ? '成交价' : marker.kind === 'cancel' ? '撤单价' : '保护/退出价'
      return series.createPriceLine({
        price: marker.price!,
        color,
        lineWidth: 1,
        lineStyle: 3,
        axisLabelVisible: true,
        lineVisible: true,
        title,
      })
    })
    return () => {
      const activeSeries = seriesRef.current?.main
      apprenticePriceLinesRef.current.forEach((line) => activeSeries?.removePriceLine(line))
      apprenticePriceLinesRef.current = []
    }
  }, [apprenticeActionMarkers, apprenticeOnly, data])

  useEffect(() => {
    saveTradeMarkerPanelPreferences({
      position: selectedTradeMarkerPanelPosition,
      size: selectedTradeMarkerPanelSize,
      fontSize: tradeMarkerFontSize,
    })
  }, [selectedTradeMarkerPanelPosition, selectedTradeMarkerPanelSize, tradeMarkerFontSize])

  const closeTradeMarkerDetails = () => {
    selectedTradeMarkerIdRef.current = null
    setSelectedTradeMarkerId(null)
    selectedDecisionSignalMarkerIdRef.current = null
    setSelectedDecisionSignalMarkerId(null)
  }

  const closeSignalMarkerDetails = () => {
    selectedSignalMarkerIdRef.current = null
    setSelectedSignalMarkerId(null)
  }

  const cycleTradeMarkerFontSize = () => setTradeMarkerFontSize((size) => nextTradeMarkerFontSize(size))
  const replaySignalMarkerCount = apprenticeOnly || data.length === 0 ? 0 : toReplaySignalSeriesMarkers(symbol, interval, data.at(-1)?.time).length
  const researchSignalMarkerCount = apprenticeOnly || data.length === 0 ? 0 : toResearchSignalSeriesMarkers(symbol, interval, visibleResearchSignalSourceIds, data.at(-1)?.time, showAllResearchReviews).length
  const tradeDetailsPanelObstacles = selectedTradeDetails
    ? [tradeDetailsPanelObstacle(selectedTradeMarkerPanelPosition, selectedTradeMarkerPanelSize, chartViewportSize.width, chartViewportSize.height)]
    : []
  return <div
    ref={containerRef}
    className="chart-canvas"
    data-testid="chart-canvas"
    data-history-first-time={data[0]?.time}
    data-history-last-time={data.at(-1)?.time}
    data-history-bar-count={data.length}
    data-wheel-zoom="accumulated"
    data-vertical-pan="always"
    data-active-trade-number={activeTradeNumber ?? undefined}
    data-hovered-trade-number={hoveredTradeNumber ?? undefined}
    data-marker-hover-active={hoveredMarkerId !== null ? 'true' : undefined}
    data-markers-hidden={markersHidden ? 'true' : undefined}
    data-replay-signal-marker-count={replaySignalMarkerCount}
    data-research-signal-marker-count={researchSignalMarkerCount}
    data-replay-signal-range-count={signalRangeSegments.length}
    data-trade-reference-count={tradeReferenceMarkers.length}
  >
    <svg
      className="signal-range-overlay"
      data-testid="signal-range-overlay"
      data-range-count={signalRangeSegments.length}
      focusable="false"
      role="group"
      aria-label="回放震荡区间"
    >
      {signalRangeSegments.map((segment) => {
        const left = Math.min(segment.x1, segment.x2)
        const width = Math.max(1, Math.abs(segment.x2 - segment.x1))
        const selected = segment.id === selectedRangeObjectId
        if (segment.kind === 'one_sided_edge') {
          const edgeTop = Math.min(segment.yEdgeZoneHigh!, segment.yEdgeZoneLow!)
          const edgeHeight = Math.max(2, Math.abs(segment.yEdgeZoneLow! - segment.yEdgeZoneHigh!))
          const edgeLabel = segment.activeEdge === 'upper' ? '单边震荡上沿' : '单边震荡下沿'
          return <g key={segment.id} className={`signal-range-object${selected ? ' is-selected' : ''}`} data-testid="signal-range-object" data-range-id={segment.id} data-range-kind={segment.kind} data-active-edge={segment.activeEdge}
            role="button" tabIndex={0} aria-label={edgeLabel} aria-pressed={selected} onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectRangeObject?.(segment.id) }
            }}>
            <rect className={`signal-range-edge signal-range-edge-one-sided signal-range-edge-${segment.activeEdge}`} x={left} y={edgeTop} width={width} height={edgeHeight} />
            <text className="signal-range-label" x={left + 5} y={Math.max(12, edgeTop - 4)}>{edgeLabel}</text>
            {selected && <><circle className="signal-range-selection-handle" cx={left} cy={edgeTop + edgeHeight / 2} r="4" /><circle className="signal-range-selection-handle" cx={left + width} cy={edgeTop + edgeHeight / 2} r="4" /></>}
          </g>
        }
        const upperTop = Math.min(segment.yUpperZoneHigh!, segment.yUpperZoneLow!)
        const upperHeight = Math.max(1, Math.abs(segment.yUpperZoneLow! - segment.yUpperZoneHigh!))
        const lowerTop = Math.min(segment.yLowerZoneHigh!, segment.yLowerZoneLow!)
        const lowerHeight = Math.max(1, Math.abs(segment.yLowerZoneLow! - segment.yLowerZoneHigh!))
        const bodyTop = Math.min(upperTop, lowerTop)
        const bodyBottom = Math.max(upperTop + upperHeight, lowerTop + lowerHeight)
        const signalLabel = segment.signalNumbers.map((number) => `第${number}个`).join('、')
        const label = signalLabel ? `震荡区间 · ${signalLabel}信号` : '震荡区间'
        return <g key={segment.id} className={`signal-range-object${selected ? ' is-selected' : ''}`} data-testid="signal-range-object" data-range-id={segment.id} data-range-kind={segment.kind} data-signal-numbers={segment.signalNumbers.join(',')}
          role="button" tabIndex={0} aria-label={label} aria-pressed={selected} onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectRangeObject?.(segment.id) }
          }}>
          <rect className="signal-range-body" x={left} y={bodyTop} width={width} height={Math.max(1, bodyBottom - bodyTop)} />
          <rect className="signal-range-edge signal-range-edge-upper" x={left} y={upperTop} width={width} height={upperHeight} />
          <rect className="signal-range-edge signal-range-edge-lower" x={left} y={lowerTop} width={width} height={lowerHeight} />
          <line className="signal-range-midpoint" x1={left} y1={segment.yMidpoint!} x2={left + width} y2={segment.yMidpoint!} />
          <text className="signal-range-label" x={left + 5} y={bodyTop + 13}>{label}</text>
          {selected && <>
            <circle className="signal-range-selection-handle" cx={left} cy={bodyTop} r="4" />
            <circle className="signal-range-selection-handle" cx={left + width} cy={bodyTop} r="4" />
            <circle className="signal-range-selection-handle" cx={left} cy={bodyBottom} r="4" />
            <circle className="signal-range-selection-handle" cx={left + width} cy={bodyBottom} r="4" />
          </>}
        </g>
      })}
    </svg>
    <svg
      className="trade-connection-overlay"
      data-testid="trade-connection-overlay"
      data-active-trade-number={activeTradeNumber ?? undefined}
      data-hovered-trade-number={hoveredTradeNumber ?? undefined}
      aria-hidden="true"
      focusable="false"
    >
      {tradeConnectionSegments.map((segment) => {
        const isActive = activeTradeNumber !== null && segment.tradeNumber === activeTradeNumber && segment.sourceId === activeTradeSourceId
        const isHovered = hoveredTradeNumber !== null && segment.tradeNumber === hoveredTradeNumber && segment.sourceId === hoveredTradeSourceId
        const isSelected = selectedTradeDetails?.trade.tradeNumber === segment.tradeNumber && selectedTradeDetails.sourceId === segment.sourceId
        const isMuted = activeTradeNumber !== null && !isActive
        const entryLabel = isActive ? tradeEndpointLabelLayout(
          segment.x1,
          segment.y1,
          'entry',
          chartViewportSize.width,
          chartViewportSize.height,
          tradeLabelObstacles,
          tradeDetailsPanelObstacles,
        ) : null
        const exitLabel = isActive ? tradeEndpointLabelLayout(
          segment.x2,
          segment.y2,
          'exit',
          chartViewportSize.width,
          chartViewportSize.height,
          tradeLabelObstacles,
          entryLabel ? [...tradeDetailsPanelObstacles, labelLayoutObstacle(entryLabel)] : tradeDetailsPanelObstacles,
        ) : null
        return <g key={segment.id}>
          <line
            className={`trade-connection-line trade-connection-line-${segment.outcome}${isActive ? ' is-active' : isMuted ? ' is-muted' : ''}${isHovered ? ' is-hovered' : ''}`}
            data-testid={`trade-connection-line-${segment.tradeNumber}`}
            data-trade-number={segment.tradeNumber}
            x1={segment.x1}
            y1={segment.y1}
            x2={segment.x2}
            y2={segment.y2}
            stroke={segment.color}
            strokeWidth={isActive ? 4 : 2}
          />
            {entryLabel && <g
              className={`trade-endpoint trade-endpoint-entry${isHovered ? ' is-hovered' : ''}${isSelected ? ' is-selected' : ''}${entryLabel.obstacleOverlapArea > 0 ? ' has-candle-overlap' : ''}`}
              data-testid={`trade-entry-point-${segment.tradeNumber}`}
              data-trade-number={segment.tradeNumber}
              data-candle-overlap-area={entryLabel.obstacleOverlapArea}
              data-reserved-overlap-area={entryLabel.reservedOverlapArea}
              aria-label={`开仓 ${formatPrice(segment.entryPrice, symbol)}，${formatBeijingChartTime(segment.entryTime as UTCTimestamp)}`}
            >
              <line className="trade-endpoint-leader" x1={segment.x1} y1={segment.y1} x2={entryLabel.edgeX} y2={entryLabel.edgeY} />
              <circle className="trade-endpoint-dot" cx={segment.x1} cy={segment.y1} r="5" />
              <rect className="trade-endpoint-card" x={entryLabel.boxX} y={entryLabel.boxY} width={entryLabel.boxWidth} height={entryLabel.boxHeight} rx="6" />
              <text className="trade-endpoint-price" x={entryLabel.boxX + 10} y={entryLabel.boxY + 16}>开仓 {formatPrice(segment.entryPrice, symbol)}</text>
              <text className="trade-endpoint-time" x={entryLabel.boxX + 10} y={entryLabel.boxY + 31}>{formatBeijingChartTime(segment.entryTime as UTCTimestamp)}</text>
            </g>}
            {exitLabel && <g
              className={`trade-endpoint trade-endpoint-exit${isHovered ? ' is-hovered' : ''}${isSelected ? ' is-selected' : ''}${exitLabel.obstacleOverlapArea > 0 ? ' has-candle-overlap' : ''}`}
              data-testid={`trade-exit-point-${segment.tradeNumber}`}
              data-trade-number={segment.tradeNumber}
              data-candle-overlap-area={exitLabel.obstacleOverlapArea}
              data-reserved-overlap-area={exitLabel.reservedOverlapArea}
              aria-label={`平仓 ${formatPrice(segment.exitPrice, symbol)}，${formatBeijingChartTime(segment.exitTime as UTCTimestamp)}`}
            >
              <line className="trade-endpoint-leader" x1={segment.x2} y1={segment.y2} x2={exitLabel.edgeX} y2={exitLabel.edgeY} />
              <circle className="trade-endpoint-dot" cx={segment.x2} cy={segment.y2} r="5" />
              <rect className="trade-endpoint-card" x={exitLabel.boxX} y={exitLabel.boxY} width={exitLabel.boxWidth} height={exitLabel.boxHeight} rx="6" />
              <text className="trade-endpoint-price" x={exitLabel.boxX + 10} y={exitLabel.boxY + 16}>平仓 {formatPrice(segment.exitPrice, symbol)}</text>
              <text className="trade-endpoint-time" x={exitLabel.boxX + 10} y={exitLabel.boxY + 31}>{formatBeijingChartTime(segment.exitTime as UTCTimestamp)}</text>
            </g>}
          </g>
      })}
    </svg>
    {selectedTradeDetails && <TradeMarkerDetails
       selection={selectedTradeDetails}
      referenceCount={tradeReferenceMarkers.length}
      panelPosition={selectedTradeMarkerPanelPosition}
      onPositionChange={setSelectedTradeMarkerPanelPosition}
      panelSize={selectedTradeMarkerPanelSize}
      onSizeChange={setSelectedTradeMarkerPanelSize}
      fontSize={tradeMarkerFontSize}
      onCycleFontSize={cycleTradeMarkerFontSize}
      onClose={closeTradeMarkerDetails}
    />}
    {selectedSignalMarker && <SignalMarkerDetails
      selection={selectedSignalMarker}
      panelPosition={selectedTradeMarkerPanelPosition}
      onPositionChange={setSelectedTradeMarkerPanelPosition}
      panelSize={selectedTradeMarkerPanelSize}
      onSizeChange={setSelectedTradeMarkerPanelSize}
      fontSize={tradeMarkerFontSize}
      onCycleFontSize={cycleTradeMarkerFontSize}
      onClose={closeSignalMarkerDetails}
    />}
    {selectedResearchSignalMarker && <ResearchSignalMarkerDetails
      selection={selectedResearchSignalMarker}
      panelPosition={selectedTradeMarkerPanelPosition}
      panelSize={selectedTradeMarkerPanelSize}
      fontSize={tradeMarkerFontSize}
      onCycleFontSize={cycleTradeMarkerFontSize}
      onClose={() => {
        selectedResearchSignalMarkerIdRef.current = null
        setSelectedResearchSignalMarkerId(null)
      }}
    />}
  </div>
})

function SignalMarkerDetails({
  selection, panelPosition, onPositionChange, panelSize, onSizeChange, fontSize, onCycleFontSize, onClose,
}: {
  selection: ReplaySignalMarkerSelection
  panelPosition: TradeMarkerPanelPosition | null
  onPositionChange: (position: TradeMarkerPanelPosition) => void
  panelSize: TradeMarkerPanelSize | null
  onSizeChange: (size: TradeMarkerPanelSize) => void
  fontSize: TradeMarkerFontSize
  onCycleFontSize: () => void
  onClose: () => void
}) {
  const cardRef = useRef<HTMLElement>(null)
  const dragHandleRef = useRef<HTMLDivElement>(null)
  const resizeHandleRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; startLeft: number; startTop: number } | null>(null)
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; startWidth: number; startHeight: number; startPosition: TradeMarkerPanelPosition } | null>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const resizeCleanupRef = useRef<(() => void) | null>(null)
  const [dragging, setDragging] = useState(false)
  const [resizing, setResizing] = useState(false)
  const { signal } = selection
  const long = signal.side === 'long'
  const context = signal.signalContext
  const stopReferenceTime = replaySignalCandleBeijingTime(signal, context.initial_stop_reference_idx)
  const evidenceTimes = signal.evidenceIndices.map((idx) => replaySignalCandleBeijingTime(signal, idx))
  const structureTimes = context.structure_indices.map((idx) => replaySignalCandleBeijingTime(signal, idx))
  const positionStyle = tradeMarkerPanelStyle(panelPosition, panelSize)
  const fontSizeLabels: Record<TradeMarkerFontSize, string> = { small: '小', medium: '中', large: '大' }
  const nextFontSize = nextTradeMarkerFontSize(fontSize)

  const clampCurrentPosition = useCallback(() => {
    if (!panelPosition || !cardRef.current) return
    const parent = cardRef.current.parentElement
    if (!parent) return
    const parentRect = parent.getBoundingClientRect()
    const cardRect = cardRef.current.getBoundingClientRect()
    const next = clampTradeMarkerPanelPosition(panelPosition, parentRect, cardRect)
    if (next.left !== panelPosition.left || next.top !== panelPosition.top) onPositionChange(next)
    if (panelSize) {
      const size = clampTradeMarkerPanelSize(panelSize, next, parentRect)
      if (size.width !== panelSize.width || size.height !== panelSize.height) onSizeChange(size)
    }
  }, [onPositionChange, onSizeChange, panelPosition, panelSize])

  useEffect(() => {
    if (!panelPosition || !cardRef.current) return
    const parent = cardRef.current.parentElement
    if (!parent) return
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(clampCurrentPosition)
    observer?.observe(parent)
    window.addEventListener('resize', clampCurrentPosition)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', clampCurrentPosition)
    }
  }, [clampCurrentPosition, panelPosition])

  useEffect(() => () => {
    dragCleanupRef.current?.()
    resizeCleanupRef.current?.()
  }, [])

  const handleDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const card = cardRef.current
    const parent = card?.parentElement
    if (!card || !parent) return
    event.preventDefault()
    const parentRect = parent.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    const currentPosition = clampTradeMarkerPanelPosition({ left: cardRect.left - parentRect.left, top: cardRect.top - parentRect.top }, parentRect, cardRect)
    onPositionChange(currentPosition)
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startLeft: currentPosition.left, startTop: currentPosition.top }
    setDragging(true)
    const handlePointerMove = (pointerEvent: PointerEvent) => {
      const drag = dragRef.current
      const activeCard = cardRef.current
      const activeParent = activeCard?.parentElement
      if (!drag || pointerEvent.pointerId !== drag.pointerId || !activeCard || !activeParent) return
      pointerEvent.preventDefault()
      const activeParentRect = activeParent.getBoundingClientRect()
      const activeCardRect = activeCard.getBoundingClientRect()
      onPositionChange(clampTradeMarkerPanelPosition({ left: drag.startLeft + pointerEvent.clientX - drag.startX, top: drag.startTop + pointerEvent.clientY - drag.startY }, activeParentRect, activeCardRect))
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerEnd)
      window.removeEventListener('pointercancel', handlePointerEnd)
      if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null
    }
    const handlePointerEnd = (pointerEvent: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || pointerEvent.pointerId !== drag.pointerId) return
      cleanup()
      dragRef.current = null
      setDragging(false)
    }
    dragCleanupRef.current?.()
    dragCleanupRef.current = cleanup
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerEnd)
    window.addEventListener('pointercancel', handlePointerEnd)
  }

  const handleResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const card = cardRef.current
    const parent = card?.parentElement
    if (!card || !parent) return
    event.preventDefault()
    event.stopPropagation()
    const parentRect = parent.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    const currentPosition = clampTradeMarkerPanelPosition({ left: cardRect.left - parentRect.left, top: cardRect.top - parentRect.top }, parentRect, cardRect)
    const currentSize = clampTradeMarkerPanelSize({ width: cardRect.width, height: cardRect.height }, currentPosition, parentRect)
    onPositionChange(currentPosition)
    onSizeChange(currentSize)
    resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startWidth: currentSize.width, startHeight: currentSize.height, startPosition: currentPosition }
    setResizing(true)
    const handlePointerMove = (pointerEvent: PointerEvent) => {
      const resize = resizeRef.current
      const activeParent = cardRef.current?.parentElement
      if (!resize || pointerEvent.pointerId !== resize.pointerId || !activeParent) return
      pointerEvent.preventDefault()
      onSizeChange(clampTradeMarkerPanelSize({ width: resize.startWidth + pointerEvent.clientX - resize.startX, height: resize.startHeight + pointerEvent.clientY - resize.startY }, resize.startPosition, activeParent.getBoundingClientRect()))
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerEnd)
      window.removeEventListener('pointercancel', handlePointerEnd)
      if (resizeCleanupRef.current === cleanup) resizeCleanupRef.current = null
    }
    const handlePointerEnd = (pointerEvent: PointerEvent) => {
      const resize = resizeRef.current
      if (!resize || pointerEvent.pointerId !== resize.pointerId) return
      cleanup()
      resizeRef.current = null
      setResizing(false)
    }
    resizeCleanupRef.current?.()
    resizeCleanupRef.current = cleanup
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerEnd)
    window.addEventListener('pointercancel', handlePointerEnd)
  }

  return <aside
    ref={cardRef}
    style={positionStyle}
    className={`trade-marker-details signal-marker-details is-right${resizing ? ' is-resizing' : ''}`}
    data-panel-side="right"
    data-font-size={fontSize}
    data-marker-id={selection.id}
    data-testid="signal-marker-details"
    aria-label="信号详情"
  >
    <header className="trade-marker-details-header">
      <div
        ref={dragHandleRef}
        className={`trade-marker-drag-handle${dragging ? ' is-dragging' : ''}`}
        data-testid="signal-marker-drag-handle"
        aria-label="拖动信号详情卡"
        title="拖动详情卡"
        onPointerDown={handleDragStart}
      ><span className="trade-marker-drag-grip" aria-hidden="true">⋮⋮</span><span><strong>第 {signal.signalNumber} 个信号 · <span className={long ? 'trade-marker-green' : 'trade-marker-red'}>{long ? 'V2多' : 'V2空'}</span></strong><small>Custom V2 原始严格因果 PNG 信号</small></span></div>
      <div className="trade-marker-details-actions">
        <button type="button" data-testid="signal-marker-font-size" className="trade-marker-font-size" aria-label={`当前字号${fontSizeLabels[fontSize]}，点击切换为${fontSizeLabels[nextFontSize]}字号`} title={`字号：${fontSizeLabels[fontSize]}（点击切换为${fontSizeLabels[nextFontSize]}）`} onClick={onCycleFontSize}>{fontSize === 'large' ? 'A+' : fontSize === 'small' ? 'A−' : 'Aa'}</button>
        <button type="button" className="trade-marker-details-close" aria-label="关闭信号详情" onClick={onClose}>×</button>
      </div>
    </header>
    <div className="trade-marker-details-scroll">
      <section className="trade-marker-detail-section signal-marker-core-section">
        <h4><span className={long ? 'trade-marker-green' : 'trade-marker-red'}>{long ? '多头信号' : '空头信号'}</span> · {signal.setup}</h4>
        <dl>
          <div><dt>北京时间</dt><dd>{signal.beijingTime}</dd></div>
          <div><dt>信号 K</dt><dd>{signal.beijingTime}</dd></div>
          <div><dt>触发价</dt><dd>{context.entry_trigger_price.toFixed(3)}</dd></div>
          <div><dt>初始止损</dt><dd>{context.initial_stop_price.toFixed(3)}</dd></div>
          <div><dt>止损参考</dt><dd>{stopReferenceTime}</dd></div>
          <div><dt>规则家族</dt><dd>{signal.setup}<small className="trade-marker-code">{context.family}</small></dd></div>
          <div><dt>规则变体</dt><dd><small className="trade-marker-code signal-marker-inline-code">{context.variant}</small></dd></div>
        </dl>
      </section>
      <section className="trade-marker-detail-section signal-marker-reason-section">
        <h4>信号理由完整版</h4>
        <p className="signal-marker-full-reason">{signal.displayReason}</p>
      </section>
      <section className="trade-marker-detail-section signal-marker-evidence-section">
        <h4>严格因果证据</h4>
        <dl>
          <div><dt>证据 K 线<br />（北京时间）</dt><dd className="signal-marker-candle-times">{evidenceTimes.map((time) => <span key={time}>{time}</span>)}</dd></div>
          <div><dt>结构 K 线<br />（北京时间）</dt><dd className="signal-marker-candle-times">{structureTimes.map((time) => <span key={time}>{time}</span>)}</dd></div>
          <div><dt>规则版本</dt><dd>{context.rule_version}<small className="trade-marker-code">{selection.ruleSetId}</small></dd></div>
          <div><dt>记录哈希</dt><dd><small className="trade-marker-code signal-marker-hash">{signal.recordSha256}</small></dd></div>
          <div><dt>链哈希</dt><dd><small className="trade-marker-code signal-marker-hash">{signal.chainSha256}</small></dd></div>
          <div><dt>来源哈希</dt><dd><small className="trade-marker-code signal-marker-hash">{selection.rawSignalsSha256}</small></dd></div>
        </dl>
        <small className="trade-marker-disclaimer">离线严格因果 PNG 回放原始信号；信号不等于成交。</small>
      </section>
    </div>
    <div
      ref={resizeHandleRef}
      className="trade-marker-resize-handle"
      data-testid="signal-marker-resize-handle"
      aria-label="调整信号详情框大小"
      title="拖动调整详情框大小"
      onPointerDown={handleResizeStart}
    />
  </aside>
}

function ResearchSignalMarkerDetails({
  selection, panelPosition, panelSize, fontSize, onCycleFontSize, onClose,
}: {
  selection: ResearchSignalMarkerSelection
  panelPosition: TradeMarkerPanelPosition | null
  panelSize: TradeMarkerPanelSize | null
  fontSize: TradeMarkerFontSize
  onCycleFontSize: () => void
  onClose: () => void
}) {
  const { signal, window } = selection
  const bar = window.bars?.[signal.idx]
  const review = signal.filterReview
  const verdictLabel = signal.reviewVerdict === 'keep' ? '保留' : signal.reviewVerdict === 'filter' ? '已过滤' : '证据不足'
  const eventLabel = signal.markerLabel ?? (signal.side === 'long' ? '多头信号' : '空头信号')
  const context = signal.context && typeof signal.context === 'object' ? signal.context as Record<string, unknown> : null
  const orderDetails = [
    ['计划编号', context?.plan_id],
    ['委托价', context?.order_price],
    ['成交价', context?.fill_price],
    ['保护止损', context?.stop_price],
  ].filter((item): item is [string, string | number] => typeof item[1] === 'string' && item[1].length > 0 || typeof item[1] === 'number' && Number.isFinite(item[1]))
  const extraEvidenceIndices = signal.evidenceIndices.filter((idx) => idx !== signal.idx)
  const fontSizeLabels: Record<TradeMarkerFontSize, string> = { small: '小', medium: '中', large: '大' }
  const nextFontSize = nextTradeMarkerFontSize(fontSize)
  return <aside
    style={tradeMarkerPanelStyle(panelPosition, panelSize)}
    className="trade-marker-details signal-marker-details is-right research-signal-marker-details"
    data-panel-side="right"
    data-font-size={fontSize}
    data-marker-id={selection.id}
    data-testid="research-signal-marker-details"
    aria-label="研究信号详情"
  >
    <header className="trade-marker-details-header">
      <div className="trade-marker-drag-handle"><span className="trade-marker-drag-grip" aria-hidden="true">⋮⋮</span><span><strong>{review ? `案例复核 · ${verdictLabel}` : selection.name} · {eventLabel}</strong><small>{review ? '只读研究证据，不是成交或练习订单' : '计划与模拟账本事件分开记录'}</small></span></div>
      <div className="trade-marker-details-actions">
        <button type="button" data-testid="research-signal-marker-font-size" className="trade-marker-font-size" aria-label={`当前字号${fontSizeLabels[fontSize]}，点击切换为${fontSizeLabels[nextFontSize]}字号`} onClick={onCycleFontSize}>{fontSize === 'large' ? 'A+' : fontSize === 'small' ? 'A−' : 'Aa'}</button>
        <button type="button" className="trade-marker-details-close" aria-label="关闭研究信号详情" onClick={onClose}>×</button>
      </div>
    </header>
    <div className="trade-marker-details-scroll">
      <section className="trade-marker-detail-section signal-marker-core-section">
        <h4><span className={signal.side === 'long' ? 'trade-marker-green' : 'trade-marker-red'}>{eventLabel}</span>{review ? ` · ${verdictLabel}` : ''}</h4>
        <dl>
          <div><dt>北京时间</dt><dd>{signal.beijingTime ?? formatBeijingChartTime(signal.time as UTCTimestamp)}</dd></div>
          <div><dt>K线位置</dt><dd>K{signal.idx}</dd></div>
          <div><dt>当根收盘价</dt><dd>{bar?.close ?? signal.price ?? '—'}</dd></div>
          {extraEvidenceIndices.length > 0 && <div><dt>其他证据K</dt><dd>{extraEvidenceIndices.map((idx) => `K${idx}`).join('、')}</dd></div>}
        </dl>
      </section>
      <section className="trade-marker-detail-section signal-marker-reason-section">
        <h4>{review ? '复核理由' : '事件说明'}</h4>
        <p className="signal-marker-full-reason">{signal.reason}</p>
        <h4>{review ? '复核说明' : '图层说明'}</h4>
        <p className="signal-marker-full-reason">{signal.reviewNote}</p>
      </section>
      {!review && orderDetails.length > 0 && <section className="trade-marker-detail-section signal-marker-core-section">
        <h4>订单信息</h4>
        <dl>{orderDetails.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl>
      </section>}
      {review && <section className="trade-marker-detail-section signal-marker-evidence-section" data-testid="case-filter-evidence">
        {review.revisionNote && <p>{review.revisionNote}</p>}
        {review.disputes.map((note, index) => <p key={index} style={{ color: '#f4cf58' }}>案例使用争议：{note}</p>)}
        <h4>支持复核结论的证据</h4>
        {review.supportingEvidence.map((text, index) => <p key={index}>{text}</p>)}
        <h4>相反证据</h4>
        {review.counterEvidence.map((text, index) => <p key={index}>{text}</p>)}
        <h4>决定性差别</h4><p>{review.decisiveDifference}</p>
        <h4>等待与失效条件</h4><p>{review.waitConditions}</p>
        <h4>当时结构标注图</h4>
        <a href={review.annotatedImage} target="_blank" rel="noreferrer"><img src={review.annotatedImage} alt="截至信号当时的结构标注" loading="lazy" style={{ width: '100%', height: 'auto' }} /></a>
        <h4>引用案例</h4>
        {review.cases.length === 0 && <p>没有检索到足够相关的案例，没有强行配对；本条理由仅依据当时可见行情。</p>}
        {review.cases.map((item) => <details key={item.caseId}>
          <summary>{item.caseId} · {({ supports_keep: '支持保留', supports_filter: '支持过滤', not_applicable: '不适用', uncertain: '有疑问' } as Record<string, string>)[item.effect] ?? '未采用'}</summary>
          <p>相同：{item.similarities}</p><p>不同：{item.differences}</p><p>{item.basis}</p>
          {item.images.map((src) => <a key={src} href={src} target="_blank" rel="noreferrer"><img src={src} alt="案例结构图" loading="lazy" style={{ width: '100%', height: 'auto' }} /></a>)}
          <details><summary>原视频帧</summary>{item.originalImages.map((src) => <a key={src} href={src} target="_blank" rel="noreferrer"><img src={src} alt="案例原视频帧" loading="lazy" style={{ width: '100%', height: 'auto' }} /></a>)}</details>
        </details>)}
      </section>}
    </div>
  </aside>
}

function TradeMarkerDetails({
  selection, referenceCount, panelPosition, onPositionChange, panelSize, onSizeChange, fontSize, onCycleFontSize, onClose,
}: {
  selection: ReplayTradeMarkerSelection
  referenceCount: number
  panelPosition: TradeMarkerPanelPosition | null
  onPositionChange: (position: TradeMarkerPanelPosition) => void
  panelSize: TradeMarkerPanelSize | null
  onSizeChange: (size: TradeMarkerPanelSize) => void
  fontSize: TradeMarkerFontSize
  onCycleFontSize: () => void
  onClose: () => void
}) {
  const cardRef = useRef<HTMLElement>(null)
  const dragHandleRef = useRef<HTMLDivElement>(null)
  const resizeHandleRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; startLeft: number; startTop: number } | null>(null)
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; startWidth: number; startHeight: number; startPosition: TradeMarkerPanelPosition } | null>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const resizeCleanupRef = useRef<(() => void) | null>(null)
  const [dragging, setDragging] = useState(false)
  const [resizing, setResizing] = useState(false)
  const { trade } = selection
  const { entry, exit, result } = trade
  const long = trade.side === 'long'
  const pnl = `${result.pnlUsd >= 0 ? '+' : ''}${result.pnlUsd.toFixed(2)}`
  const entryReferenceIndexes = useMemo(() => new Set(extractReasonCandleIndexes(entry.reason, [entry.signalIdx])), [entry.reason, entry.signalIdx])
  const exitReferenceIndexes = useMemo(() => new Set(extractReasonCandleIndexes(exit.reason, [exit.signalIdx ?? exit.idx, exit.idx])), [exit.idx, exit.reason, exit.signalIdx])
  const exitOnlyReferenceIndexes = useMemo(() => new Set([...exitReferenceIndexes].filter((index) => !entryReferenceIndexes.has(index))), [entryReferenceIndexes, exitReferenceIndexes])
  const positionStyle = tradeMarkerPanelStyle(panelPosition, panelSize)
  const fontSizeLabels: Record<TradeMarkerFontSize, string> = { small: '小', medium: '中', large: '大' }
  const nextFontSize = nextTradeMarkerFontSize(fontSize)

  const clampCurrentPosition = useCallback(() => {
    if (!panelPosition || !cardRef.current) return
    const parent = cardRef.current.parentElement
    if (!parent) return
    const parentRect = parent.getBoundingClientRect()
    const cardRect = cardRef.current.getBoundingClientRect()
    const next = clampTradeMarkerPanelPosition(panelPosition, parentRect, cardRect)
    if (next.left !== panelPosition.left || next.top !== panelPosition.top) onPositionChange(next)
    if (panelSize) {
      const size = clampTradeMarkerPanelSize(panelSize, next, parentRect)
      if (size.width !== panelSize.width || size.height !== panelSize.height) onSizeChange(size)
    }
  }, [onPositionChange, onSizeChange, panelPosition, panelSize])

  useEffect(() => {
    if (!panelPosition || !cardRef.current) return
    const parent = cardRef.current.parentElement
    if (!parent) return
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(clampCurrentPosition)
    observer?.observe(parent)
    window.addEventListener('resize', clampCurrentPosition)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', clampCurrentPosition)
    }
  }, [clampCurrentPosition, panelPosition])

  useEffect(() => () => {
    dragCleanupRef.current?.()
    resizeCleanupRef.current?.()
  }, [])

  const handleDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const card = cardRef.current
    const parent = card?.parentElement
    if (!card || !parent) return
    event.preventDefault()
    const parentRect = parent.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    const currentPosition = clampTradeMarkerPanelPosition({ left: cardRect.left - parentRect.left, top: cardRect.top - parentRect.top }, parentRect, cardRect)
    onPositionChange(currentPosition)
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startLeft: currentPosition.left, startTop: currentPosition.top }
    setDragging(true)
    const handlePointerMove = (pointerEvent: PointerEvent) => {
      const drag = dragRef.current
      const activeCard = cardRef.current
      const activeParent = activeCard?.parentElement
      if (!drag || pointerEvent.pointerId !== drag.pointerId || !activeCard || !activeParent) return
      pointerEvent.preventDefault()
      const activeParentRect = activeParent.getBoundingClientRect()
      const activeCardRect = activeCard.getBoundingClientRect()
      onPositionChange(clampTradeMarkerPanelPosition({ left: drag.startLeft + pointerEvent.clientX - drag.startX, top: drag.startTop + pointerEvent.clientY - drag.startY }, activeParentRect, activeCardRect))
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerEnd)
      window.removeEventListener('pointercancel', handlePointerEnd)
      if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null
    }
    const handlePointerEnd = (pointerEvent: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || pointerEvent.pointerId !== drag.pointerId) return
      cleanup()
      dragRef.current = null
      setDragging(false)
    }
    dragCleanupRef.current?.()
    dragCleanupRef.current = cleanup
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerEnd)
    window.addEventListener('pointercancel', handlePointerEnd)
  }

  const handleResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const card = cardRef.current
    const parent = card?.parentElement
    if (!card || !parent) return
    event.preventDefault()
    event.stopPropagation()
    const parentRect = parent.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    const currentPosition = clampTradeMarkerPanelPosition({ left: cardRect.left - parentRect.left, top: cardRect.top - parentRect.top }, parentRect, cardRect)
    const currentSize = clampTradeMarkerPanelSize({ width: cardRect.width, height: cardRect.height }, currentPosition, parentRect)
    onPositionChange(currentPosition)
    onSizeChange(currentSize)
    resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startWidth: currentSize.width, startHeight: currentSize.height, startPosition: currentPosition }
    setResizing(true)
    const handlePointerMove = (pointerEvent: PointerEvent) => {
      const resize = resizeRef.current
      const activeParent = cardRef.current?.parentElement
      if (!resize || pointerEvent.pointerId !== resize.pointerId || !activeParent) return
      pointerEvent.preventDefault()
      onSizeChange(clampTradeMarkerPanelSize({ width: resize.startWidth + pointerEvent.clientX - resize.startX, height: resize.startHeight + pointerEvent.clientY - resize.startY }, resize.startPosition, activeParent.getBoundingClientRect()))
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerEnd)
      window.removeEventListener('pointercancel', handlePointerEnd)
      if (resizeCleanupRef.current === cleanup) resizeCleanupRef.current = null
    }
    const handlePointerEnd = (pointerEvent: PointerEvent) => {
      const resize = resizeRef.current
      if (!resize || pointerEvent.pointerId !== resize.pointerId) return
      cleanup()
      resizeRef.current = null
      setResizing(false)
    }
    resizeCleanupRef.current?.()
    resizeCleanupRef.current = cleanup
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerEnd)
    window.addEventListener('pointercancel', handlePointerEnd)
  }

  return <aside ref={cardRef} style={positionStyle} className={`trade-marker-details is-right${resizing ? ' is-resizing' : ''}`} data-panel-side="right" data-font-size={fontSize} data-testid="trade-marker-details" aria-label="交易详情">
    <header className="trade-marker-details-header">
      <div
        ref={dragHandleRef}
        className={`trade-marker-drag-handle${dragging ? ' is-dragging' : ''}`}
        data-testid="trade-marker-drag-handle"
        aria-label="拖动交易详情卡"
        title="拖动详情卡"
        onPointerDown={handleDragStart}
      ><span className="trade-marker-drag-grip" aria-hidden="true">⋮⋮</span><span><strong>{tradeMarkerTitle(trade, selection.kind)}</strong><small>无固定止盈 · 移动线下一根生效 · 第 {trade.tradeNumber} 笔{referenceCount > 0 ? ` · 已标注 ${referenceCount} 根理由K线` : ''}</small></span></div>
      <div className="trade-marker-details-actions">
        <button type="button" data-testid="trade-marker-font-size" className="trade-marker-font-size" aria-label={`当前字号${fontSizeLabels[fontSize]}，点击切换为${fontSizeLabels[nextFontSize]}字号`} title={`字号：${fontSizeLabels[fontSize]}（点击切换为${fontSizeLabels[nextFontSize]}）`} onClick={onCycleFontSize}>{fontSize === 'large' ? 'A+' : fontSize === 'small' ? 'A−' : 'Aa'}</button>
      <button type="button" className="trade-marker-details-close" aria-label="关闭交易详情" onClick={onClose}>×</button>
      </div>
    </header>
    <div className="trade-marker-details-scroll">
      <section className="trade-marker-detail-section trade-entry-section">
        <h4><span className={long ? 'trade-marker-green' : 'trade-marker-red'}>{long ? '开多' : '开空'}</span> 开仓</h4>
        <dl>
          <div><dt>北京时间</dt><dd>{entry.beijingTime}</dd></div>
          <div><dt>成交价</dt><dd>{entry.price.toFixed(3)}</dd></div>
          <div><dt>触发规则</dt><dd>{tradeRuleLabel(entry.ruleVersion)}<span>{triggerConditionLabel(entry.triggerCondition)}</span></dd></div>
          <div><dt>固定止损</dt><dd>{entry.stopLoss.toFixed(3)}</dd></div>
          <div><dt>固定止盈</dt><dd>不设置</dd></div>
          <div><dt>移动止盈</dt><dd>{entry.trailingActivationUsd !== null && entry.trailingDistanceUsd !== null ? `浮盈 ${entry.trailingActivationUsd.toFixed(0)} USD 启动 / 回撤 ${entry.trailingDistanceUsd.toFixed(0)} USD` : '强突破创持仓新极值后，跟踪已确认结构低点/高点'}</dd></div>
          <div><dt>止损方法</dt><dd>{tradeLevelMethodLabel(entry.stopMethod)}</dd></div>
        </dl>
        <p className="trade-marker-setup"><b className={tradeSetupTitleClass(entry.setup, long)}>{highlightTradeSetup(entry.setup)}</b><span>{highlightTradeReason(entry.reason, entryReferenceIndexes)}</span></p>
      </section>
      <section className="trade-marker-detail-section trade-exit-section">
        <h4><span className="trade-marker-amber">{long ? '平多' : '平空'}</span> 平仓</h4>
        <dl>
          <div><dt>北京时间</dt><dd>{exit.beijingTime}</dd></div>
          <div><dt>价格</dt><dd>{exit.price.toFixed(3)}</dd></div>
          <div><dt>退出类型</dt><dd>{exitReasonLabel(exit.reasonCode)}</dd></div>
          <div><dt>最终有效保护线</dt><dd>{exit.finalActiveStop.toFixed(3)}</dd></div>
          <div><dt>移动线状态</dt><dd>{exit.trailingActivated ? `已启动${exit.trailingActivationIdx === null ? '' : `（idx ${exit.trailingActivationIdx}）`}` : '未启动'}</dd></div>
          {exit.trailingStructureIdx !== null && exit.trailingStructureIdx !== undefined && <div><dt>跟踪结构</dt><dd>{exit.trailingStructureIdx}{exit.trailingStructureConfirmationIdx === null || exit.trailingStructureConfirmationIdx === undefined ? '' : `（右侧确认 idx ${exit.trailingStructureConfirmationIdx}）`}{exit.trailingStructurePrice === null || exit.trailingStructurePrice === undefined ? '' : ` @ ${exit.trailingStructurePrice.toFixed(3)}`}</dd></div>}
        </dl>
        <p className="trade-marker-exit-reason">{highlightTradeReason(exitReasonDetail(exit.reasonCode, trade.side))}</p>
        {(exit.reasonCode === 'OPPOSITE_SIGNAL_CLOSE' || exit.reasonCode === 'OPPOSITE_SIGNAL_NEXT_BAR_BREAK') && <p className="trade-marker-setup"><b className={tradeSetupTitleClass(exit.setup ?? '', !long)}>反向信号 · {highlightTradeSetup(exit.setup ?? '')}</b><span>{highlightTradeReason(exit.reason ?? '', exitReferenceIndexes, exitOnlyReferenceIndexes)}</span></p>}
      </section>
      <section className="trade-marker-detail-section trade-result-section">
        <h4>结果</h4>
        <dl>
          <div><dt>持有 K 线</dt><dd>{result.barsHeld}</dd></div>
          <div><dt>R</dt><dd>{result.rMultiple >= 0 ? '+' : ''}{result.rMultiple.toFixed(3)}</dd></div>
          <div><dt>PnL USD</dt><dd className={result.pnlUsd >= 0 ? 'trade-marker-green' : 'trade-marker-red'}>{pnl}</dd></div>
        </dl>
        <small className="trade-marker-disclaimer">离线回测、未计点差手续费</small>
      </section>
    </div>
    <div
      ref={resizeHandleRef}
      className="trade-marker-resize-handle"
      data-testid="trade-marker-resize-handle"
      aria-label="调整交易详情框大小"
      title="拖动调整详情框大小"
      onPointerDown={handleResizeStart}
    />
  </aside>
}
