import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Eye, EyeOff, RefreshCcw } from 'lucide-react'
import { bollinger, ema, sma, volumeSma } from '../lib/indicators'
import { formatPrice, INTERVALS, type Candle, type IntervalId, type SymbolId } from '../lib/market'
import type { IndicatorSettings } from './ChartSurface'

type IndicatorKey = 'ma' | 'ema' | 'boll' | 'volume'

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
}

interface IndicatorRow {
  key: IndicatorKey
  name: string
  detail: string
  color: string
}

function valueAt<T extends { time: number }>(points: T[], time: number | undefined) {
  if (time === undefined) return points.at(-1)
  return points.find((point) => point.time === time) ?? points.at(-1)
}

export function IndicatorLegend({ data, candle, symbol, interval, indicators, indicatorsHidden, expanded, onToggle, onExpandedChange, onOpenSettings, onRefresh }: Props) {
  const [refreshing, setRefreshing] = useState(false)
  const activeCandle = candle ?? data.at(-1) ?? null
  const values = useMemo(() => {
    const time = activeCandle?.time
    const ma = valueAt(sma(data, indicators.maPeriod), time)?.value
    const emaValue = valueAt(ema(data, indicators.emaPeriod), time)?.value
    const bollValue = valueAt(bollinger(data, indicators.bollPeriod, indicators.bollDeviation), time)
    const volumeAverage = valueAt(volumeSma(data, 20), time)?.value
    return { ma, ema: emaValue, boll: bollValue, volumeAverage }
  }, [activeCandle?.time, data, indicators.bollDeviation, indicators.bollPeriod, indicators.emaPeriod, indicators.maPeriod])
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
  ]
  const total = rows.length
  const toggleRefresh = () => {
    onRefresh?.()
    setRefreshing(true)
    window.setTimeout(() => setRefreshing(false), 420)
  }
  return <section className={`indicator-legend${expanded ? ' is-expanded' : ' is-collapsed'}${indicatorsHidden ? ' all-hidden' : ''}`} data-testid="indicator-legend" aria-label="图表指标">
    <div className="indicator-legend-summary">
      <button type="button" className="indicator-summary-toggle" aria-label={`${expanded ? '隐藏' : '显示'}图表指标列表`} aria-expanded={expanded} data-testid="indicator-summary-toggle" title={`${expanded ? '隐藏' : '显示'}图表指标列表`} onClick={() => onExpandedChange(!expanded)}>
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}<span>{total}</span>
      </button>
      <button type="button" className={`indicator-summary-refresh${refreshing ? ' is-refreshing' : ''}`} aria-label="刷新指标" title="重新计算指标" data-testid="indicator-summary-refresh" onClick={toggleRefresh}><RefreshCcw size={17} /></button>
    </div>
    {expanded && <div className="indicator-legend-list">
      {rows.map((row) => {
       const visible = indicators[row.key] && !indicatorsHidden
       return <div className={`indicator-legend-row${visible ? ' is-visible' : ' is-hidden'}`} data-testid={`indicator-legend-row-${row.key}`} key={row.key}>
          <button type="button" className="indicator-legend-main" onClick={onOpenSettings} title="打开指标设置"><span className="indicator-legend-name" style={{ color: row.color }}>{row.name}</span><span className="indicator-legend-detail">{row.detail}</span></button>
          <button type="button" className="indicator-legend-toggle" aria-label={`${visible ? '隐藏' : '显示'} ${row.name}`} aria-pressed={visible} title={`${visible ? '隐藏' : '显示'} ${row.name}`} onClick={() => onToggle(row.key)}>{visible ? <Eye size={17} /> : <EyeOff size={17} />}</button>
        </div>
      })}
    </div>}
  </section>
}
