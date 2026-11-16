import type { CSSProperties } from 'react'
import { BAR_COUNT_HIGH_COLOR, BAR_COUNT_LOW_COLOR } from '../lib/barCountOverlay'
import { setAllBarCounts, toggleBarCountSide, visibleBarCountSides, type BarCountSettings } from '../lib/barCountSettings'

interface Props {
  value: BarCountSettings
  hidden: boolean
  chartType: 'candles' | 'hollow' | 'line' | 'area'
  onChange: (value: BarCountSettings) => void
}

/** Same bar as the three-push / AB=CD controls, one row below AB=CD. */
export function BarCountControls({ value, hidden, chartType, onChange }: Props) {
  const effective = hidden ? { ...value, barCount: false } : value
  const visible = visibleBarCountSides(effective)
  const enabled = visible.high || visible.low
  const candles = chartType !== 'line' && chartType !== 'area'
  const high = { '--three-push-color': BAR_COUNT_HIGH_COLOR } as CSSProperties
  const low = { '--three-push-color': BAR_COUNT_LOW_COLOR } as CSSProperties

  return <div className="three-push-controls bar-count-controls" role="group" aria-label="高低计数控制" onPointerDown={(event) => event.stopPropagation()}>
    <div className="three-push-control-bar">
      <button type="button" className={`three-push-master bar-count-master${enabled ? ' is-active' : ''}`} aria-label={`${enabled ? '隐藏' : '显示'}高低计数`} aria-pressed={enabled} disabled={!candles} title={candles ? '阿布数K线：回调里的高1/2/3、反弹里的低1/2/3' : '高低计数适用于K线图'} onClick={() => onChange(setAllBarCounts(value, !enabled))}>高低计数</button>
      <span className="three-push-control-divider" />
      <button type="button" className={`three-push-level${visible.high && candles ? ' is-active' : ''}`} style={high} disabled={!candles} aria-pressed={visible.high} title="高1/2/3：回调里高点高于前一根高点的K线" onClick={() => onChange(toggleBarCountSide(effective, 'high'))}>高1/2/3</button>
      <button type="button" className={`three-push-level${visible.low && candles ? ' is-active' : ''}`} style={low} disabled={!candles} aria-pressed={visible.low} title="低1/2/3：反弹里低点低于前一根低点的K线" onClick={() => onChange(toggleBarCountSide(effective, 'low'))}>低1/2/3</button>
    </div>
  </div>
}
