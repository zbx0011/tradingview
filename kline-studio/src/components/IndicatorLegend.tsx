import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Eye, EyeOff, RefreshCcw } from 'lucide-react'
import { bollinger, ema, sma, volumeSma } from '../lib/indicators'
import { formatPrice, INTERVALS, type Candle, type IntervalId, type SymbolId } from '../lib/market'
import type { IndicatorSettings } from './ChartSurface'
import { useHoverCandle } from '../lib/hoverStore'
import { historyIndexAtTime, MAX_CHART_BARS } from '../lib/chartHistoryWindow'

type IndicatorKey = 'ma' | 'ema' | 'boll' | 'volume' | 'smc'

interface Props {
  data: Candle[]
  candle: Candle | null
  symbol: SymbolId
  interval: IntervalId
  indicators: IndicatorSettings
  indicatorsHidden: boolean
  expanded: boolean
  onToggle: (key: IndicatorKey) => void
  onExpandedChange: (expanded: boolean) => void
  onOpenSettings: () => void
  onRefresh?: () => void
  summaryActions?: ReactNode
}

interface IndicatorRow {
  key: IndicatorKey
  name: string
  detail: string
  color: string
}

function valueAt<T extends { time: number }>(points: T[], time: number | undefined) {
  if (time === undefined) return points.at(-1)
  // Binary search: points are sorted by time and this runs on every hovered bar.
  let low = 0
  let high = points.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const candidate = points[middle].time
    if (candidate === time) return points[middle]
    if (candidate < time) low = middle + 1
    else high = middle - 1
  }
  return points.at(-1)
}

export function IndicatorLegend({ data, candle, symbol, interval, indicators, indicatorsHidden, expanded, onToggle, onExpandedChange, onOpenSettings, onRefresh, summaryActions }: Props) {
  const [refreshing, setRefreshing] = useState(false)
  const hoverCandle = useHoverCandle()
  const activeCandle = hoverCandle ?? candle ?? data.at(-1) ?? null
  // The legend needs values at one candle, not four full multi-million-row
  // indicator arrays. Keep ample warmup for EMA convergence at that candle.
  const indicatorData = useMemo(() => {
    if (data.length <= MAX_CHART_BARS) return data
    const index = Math.max(0, Math.min(data.length - 1, Math.floor(historyIndexAtTime(data, activeCandle?.time ?? data[data.length - 1].time, INTERVALS[interval].seconds))))
    const warmup = Math.max(1000, 40 * Math.max(indicators.maPeriod, indicators.emaPeriod, indicators.bollPeriod))
    return data.slice(Math.max(0, index - warmup), index + 1)
  }, [activeCandle?.time, data, indicators.bollPeriod, indicators.emaPeriod, indicators.maPeriod, interval])
  const maSeries = useMemo(() => sma(indicatorData, indicators.maPeriod), [indicatorData, indicators.maPeriod])
  const emaSeries = useMemo(() => ema(indicatorData, indicators.emaPeriod), [indicatorData, indicators.emaPeriod])
  const bollSeries = useMemo(() => bollinger(indicatorData, indicators.bollPeriod, indicators.bollDeviation), [indicatorData, indicators.bollDeviation, indicators.bollPeriod])
  const volumeSeries = useMemo(() => volumeSma(indicatorData, 20), [indicatorData])
  const values = useMemo(() => {
    const time = activeCandle?.time
    return {
      ma: valueAt(maSeries, time)?.value,
      ema: valueAt(emaSeries, time)?.value,
      boll: valueAt(bollSeries, time),
      volumeAverage: valueAt(volumeSeries, time)?.value,
    }
  }, [activeCandle?.time, bollSeries, emaSeries, maSeries, volumeSeries])
  const rows: IndicatorRow[] = [
    {
      key: 'volume',
      name: '成交量',
      detail: activeCandle ? `${symbol} ${INTERVALS[interval].label} ${Math.round(activeCandle.volume).toLocaleString('zh-CN')} ${values.volumeAverage ? Math.round(values.volumeAverage).toLocaleString('zh-CN') : ''}`.trim() : 'Volume + MA20',
      color: '#21a179',
    },
    { key: 'ma', name: 'MA', detail: `MA ${indicators.maPeriod}${values.ma === undefined ? '' : ` close ${formatPrice(values.ma, symbol)}`}`, color: '#f59e0b' },
    { key: 'ema', name: 'EMA', detail: `EMA ${indicators.emaPeriod}${values.ema === undefined ? '' : ` close ${formatPrice(values.ema, symbol)}`}`, color: '#296cff' },
    {
      key: 'boll',
      name: 'BOLL',
      detail: `BOLL ${indicators.bollPeriod} ${indicators.bollDeviation}${values.boll ? ` close ${formatPrice(values.boll.middle, symbol)}` : ''}`,
      color: '#9b7bff',
    },
    { key: 'smc', name: 'LuxAlgo', detail: 'LuxAlgo - Smart Money Concepts', color: '#089981' },
  ]
  const total = rows.length
  const toggleRefresh = () => {
    onRefresh?.()
    setRefreshing(true)
    window.setTimeout(() => setRefreshing(false), 420)
  }
  const legendRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const legend = legendRef.current
    const parent = legend?.parentElement
    if (!legend || !parent) return
    const place = () => {
      const toolbar = parent.querySelector<HTMLElement>('.reference-quick-tools')
      const base = parseFloat(getComputedStyle(legend).getPropertyValue('--indicator-legend-top')) || 53
      const root = parent.getBoundingClientRect()
      const rect = legend.getBoundingClientRect()
      const tools = toolbar?.getBoundingClientRect()
      const baseTop = root.top + base
      const overlaps = tools && tools.width > 0 && tools.height > 0
        && rect.left < tools.right + 8 && rect.right > tools.left - 8
        && baseTop < tools.bottom + 8 && baseTop + rect.height > tools.top - 8
      const top = overlaps ? tools.bottom - root.top + 8 : base
      const value = `${top}px`
      if (legend.style.top !== value) legend.style.top = value
    }
    const toolbarChanges = new MutationObserver(place)
    const resize = new ResizeObserver(place)
    const connect = () => {
      toolbarChanges.disconnect()
      resize.disconnect()
      resize.observe(parent)
      resize.observe(legend)
      const toolbar = parent.querySelector<HTMLElement>('.reference-quick-tools')
      if (toolbar) { toolbarChanges.observe(toolbar, { attributes: true, attributeFilter: ['style', 'class'] }); resize.observe(toolbar) }
      place()
    }
    const children = new MutationObserver(connect)
    children.observe(parent, { childList: true })
    window.addEventListener('resize', place)
    connect()
    return () => { children.disconnect(); toolbarChanges.disconnect(); resize.disconnect(); window.removeEventListener('resize', place) }
  }, [])
  return <section ref={legendRef} className={`indicator-legend${expanded ? ' is-expanded' : ' is-collapsed'}${indicatorsHidden ? ' all-hidden' : ''}`} data-testid="indicator-legend" aria-label="图表指标">
    <div className="indicator-legend-summary">
      <button type="button" className="indicator-summary-toggle" aria-label={`${expanded ? '隐藏' : '显示'}图表指标列表`} aria-expanded={expanded} data-testid="indicator-summary-toggle" title={`${expanded ? '隐藏' : '显示'}图表指标列表`} onClick={() => onExpandedChange(!expanded)}>
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}<span>{total}</span>
      </button>
      <button type="button" className={`indicator-summary-refresh${refreshing ? ' is-refreshing' : ''}`} aria-label="刷新指标" title="重新计算指标" data-testid="indicator-summary-refresh" onClick={toggleRefresh}><RefreshCcw size={17} /></button>
      {summaryActions}
    </div>
    {expanded && <div className="indicator-legend-list">
      {rows.map((row) => {
       const visible = (row.key === 'smc' ? indicators.smc !== false : indicators[row.key]) && !indicatorsHidden
       return <div className={`indicator-legend-row${visible ? ' is-visible' : ' is-hidden'}`} data-testid={`indicator-legend-row-${row.key}`} key={row.key}>
          <button type="button" className="indicator-legend-main" onClick={onOpenSettings} title="打开指标设置"><span className="indicator-legend-name" style={{ color: row.color }}>{row.name}</span><span className="indicator-legend-detail">{row.detail}</span></button>
          <button type="button" className="indicator-legend-toggle" aria-label={`${visible ? '隐藏' : '显示'} ${row.name}`} aria-pressed={visible} title={`${visible ? '隐藏' : '显示'} ${row.name}`} onClick={() => onToggle(row.key)}>{visible ? <Eye size={17} /> : <EyeOff size={17} />}</button>
        </div>
      })}
    </div>}
  </section>
}
