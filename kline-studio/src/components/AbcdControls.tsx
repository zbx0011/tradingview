import type { CSSProperties } from 'react'
import { INTERVALS, type IntervalId } from '../lib/market'
import { ABCD_TIMEFRAMES } from '../lib/abcdChart'
import { ABCD_COLOR } from '../lib/abcdOverlay'
import { setAllAbcdTimeframes, toggleAbcdTimeframe, visibleAbcdTimeframes, type AbcdSettings } from '../lib/abcdSettings'

interface Props {
  value: AbcdSettings
  hidden: boolean
  interval: IntervalId
  chartType: 'candles' | 'hollow' | 'line' | 'area'
  minuteSourceAvailable?: boolean
  onChange: (value: AbcdSettings) => void
}

/** Same bar as the three-push controls, one row below it. */
export function AbcdControls({ value, hidden, interval, chartType, minuteSourceAvailable = false, onChange }: Props) {
  const effective = hidden ? { ...value, abcd: false } : value
  const visible = visibleAbcdTimeframes(effective)
  const enabled = visible.length > 0
  const candles = chartType !== 'line' && chartType !== 'area'
  const style = { '--three-push-color': ABCD_COLOR } as CSSProperties

  return <div className="three-push-controls abcd-controls" role="group" aria-label="AB=CD 指标控制" onPointerDown={(event) => event.stopPropagation()}>
    <div className="three-push-control-bar">
      <button type="button" className={`three-push-master abcd-master${enabled ? ' is-active' : ''}`} style={style} aria-label={`${enabled ? '隐藏' : '显示'}全部 AB=CD`} aria-pressed={enabled} disabled={!candles} title={candles ? '点击显示或隐藏全部级别的 AB=CD' : 'AB=CD 适用于K线图'} onClick={() => onChange(setAllAbcdTimeframes(value, !enabled))}>AB=CD</button>
      <span className="three-push-control-divider" />
      {ABCD_TIMEFRAMES.map(({ label: timeframe, seconds }) => {
        const supported = candles && (INTERVALS[interval].seconds <= seconds || (interval === '5m' && timeframe === '1m' && minuteSourceAvailable))
        const selected = visible.includes(timeframe)
        const label = timeframe.replace('m', 'min')
        return <button type="button" key={timeframe} className={`three-push-level${selected && supported ? ' is-active' : ''}`} style={style} disabled={!supported} aria-label={`${selected ? '隐藏' : '显示'}${label} AB=CD`} aria-pressed={selected && supported} title={supported ? `${selected ? '隐藏' : '显示'} ${label} AB=CD` : `切换到${label}或更小的K线周期查看`} onClick={() => onChange(toggleAbcdTimeframe(effective, timeframe))}>{label}</button>
      })}
    </div>
  </div>
}
