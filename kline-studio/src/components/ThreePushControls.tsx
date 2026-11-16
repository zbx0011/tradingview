import type { CSSProperties } from 'react'
import { INTERVALS, type IntervalId } from '../lib/market'
import { THREE_PUSH_COLORS } from '../lib/threePushOverlay'
import { setAllThreePushTimeframes, THREE_PUSH_TIMEFRAMES, toggleThreePushTimeframe, visibleThreePushTimeframes, type ThreePushSettings } from '../lib/threePushSettings'

interface Props {
  value: ThreePushSettings
  hidden: boolean
  interval: IntervalId
  chartType: 'candles' | 'hollow' | 'line' | 'area'
  minuteSourceAvailable?: boolean
  onChange: (value: ThreePushSettings) => void
}

export function ThreePushControls({ value, hidden, interval, chartType, minuteSourceAvailable = false, onChange }: Props) {
  const effective = hidden ? { ...value, threePush: false } : value
  const visible = visibleThreePushTimeframes(effective)
  const enabled = visible.length > 0
  const candles = chartType !== 'line' && chartType !== 'area'

  return <div className="three-push-controls" role="group" aria-label="三推指标控制" onPointerDown={(event) => event.stopPropagation()}>
    <div className="three-push-control-bar">
      <button type="button" className={`three-push-master${enabled ? ' is-active' : ''}`} aria-label={`${enabled ? '隐藏' : '显示'}全部三推`} aria-pressed={enabled} disabled={!candles} title={candles ? '点击显示或隐藏全部级别的三推' : '三推适用于K线图'} onClick={() => onChange(setAllThreePushTimeframes(value, !enabled))}>三推</button>
      <span className="three-push-control-divider" />
      {THREE_PUSH_TIMEFRAMES.map((timeframe) => {
        const supported = candles && (INTERVALS[interval].seconds <= ({ '1m': 60, '5m': 300, '15m': 900 })[timeframe]
          || (interval === '5m' && timeframe === '1m' && minuteSourceAvailable))
        const selected = visible.includes(timeframe)
        const label = timeframe.replace('m', 'min')
        return <button type="button" key={timeframe} className={`three-push-level${selected && supported ? ' is-active' : ''}`} style={{ '--three-push-color': THREE_PUSH_COLORS[timeframe] } as CSSProperties} disabled={!supported} aria-label={`${selected ? '隐藏' : '显示'}${label}三推`} aria-pressed={selected && supported} title={supported ? `${selected ? '隐藏' : '显示'} ${label} 三推` : `切换到${label}或更小的K线周期查看`} onClick={() => onChange(toggleThreePushTimeframe(effective, timeframe))}>{label}</button>
      })}
    </div>
  </div>
}
