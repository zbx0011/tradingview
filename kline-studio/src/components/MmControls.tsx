import type { CSSProperties } from 'react'
import { INTERVALS, type IntervalId } from '../lib/market'
import { MM_TIMEFRAMES } from '../lib/mmChart'
import { MM_COLOR } from '../lib/mmOverlay'
import { MM_KINDS, setAllMmTimeframes, toggleMmKind, toggleMmTimeframe, visibleMmKinds, visibleMmTimeframes, type MmSettings } from '../lib/mmSettings'

interface Props {
  value: MmSettings
  hidden: boolean
  interval: IntervalId
  chartType: 'candles' | 'hollow' | 'line' | 'area'
  minuteSourceAvailable?: boolean
  onChange: (value: MmSettings) => void
}

/** Same bar as the three-push / AB=CD controls, one row below AB=CD. */
export function MmControls({ value, hidden, interval, chartType, minuteSourceAvailable = false, onChange }: Props) {
  const effective = hidden ? { ...value, mm: false } : value
  const visible = visibleMmTimeframes(effective)
  const enabled = visible.length > 0
  const candles = chartType !== 'line' && chartType !== 'area'
  const style = { '--three-push-color': MM_COLOR } as CSSProperties

  return <div className="three-push-controls mm-controls" role="group" aria-label="MM 指标控制" onPointerDown={(event) => event.stopPropagation()}>
    <div className="three-push-control-bar">
      <button type="button" className={`three-push-master abcd-master${enabled ? ' is-active' : ''}`} style={style} aria-label={`${enabled ? '隐藏' : '显示'}全部 MM`} aria-pressed={enabled} disabled={!candles} title={candles ? 'Z 的 MM：被实体突破的高低点、连续大阳线 / 大阴线，各量一倍。点击显示或隐藏全部级别' : 'MM 适用于K线图'} onClick={() => onChange(setAllMmTimeframes(value, !enabled))}>MM</button>
      <span className="three-push-control-divider" />
      {MM_TIMEFRAMES.map(({ label: timeframe, seconds }) => {
        const supported = candles && (INTERVALS[interval].seconds <= seconds || (interval === '5m' && timeframe === '1m' && minuteSourceAvailable))
        const selected = visible.includes(timeframe)
        const label = timeframe.replace('m', 'min')
        return <button type="button" key={timeframe} className={`three-push-level${selected && supported ? ' is-active' : ''}`} style={style} disabled={!supported} aria-label={`${selected ? '隐藏' : '显示'}${label} MM`} aria-pressed={selected && supported} title={supported ? `${selected ? '隐藏' : '显示'} ${label} MM` : `切换到${label}或更小的K线周期查看`} onClick={() => onChange(toggleMmTimeframe(effective, timeframe))}>{label}</button>
      })}
      <span className="three-push-control-divider" />
      {MM_KINDS.map(({ kind, label, title }) => {
        const selected = visibleMmKinds(value).includes(kind)
        return <button type="button" key={kind} className={`three-push-level${selected && enabled ? ' is-active' : ''}`} style={style} disabled={!candles} aria-label={`${selected ? '隐藏' : '显示'}${label} MM`} aria-pressed={selected && enabled} title={title} onClick={() => onChange(toggleMmKind(value, kind))}>{label}</button>
      })}
    </div>
  </div>
}
