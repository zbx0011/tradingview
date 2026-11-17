import type { CSSProperties } from 'react'
import { AUTO_TRENDLINE_COLOR, type AutoTrendlinesMode } from '../lib/autoTrendlinesOverlay'

interface Value { autoTrendlines?: boolean; autoTrendlinesMode?: AutoTrendlinesMode }
interface Props {
  value: Value
  hidden: boolean
  chartType: 'candles' | 'hollow' | 'line' | 'area'
  onChange: (value: Value) => void
}

const MODES: { mode: AutoTrendlinesMode; label: string; title: string }[] = [
  { mode: 'near', label: '默认', title: '只显示最新K线附近的趋势线' },
  { mode: 'recent', label: '最近', title: '所有还没被突破的趋势线（最多8条实线+2条虚线）' },
]

/** Same bar as the three-push / AB=CD / bar-count controls, one row below 高低计数. */
export function TrendlineControls({ value, hidden, chartType, onChange }: Props) {
  const enabled = value.autoTrendlines === true && !hidden
  const mode: AutoTrendlinesMode = value.autoTrendlinesMode === 'recent' ? 'recent' : 'near'
  const candles = chartType !== 'line' && chartType !== 'area'
  const color = { '--three-push-color': AUTO_TRENDLINE_COLOR } as CSSProperties
  return <div className="three-push-controls trendline-controls" role="group" aria-label="趋势线控制" onPointerDown={(event) => event.stopPropagation()}>
    <div className="three-push-control-bar">
      <button type="button" className={`three-push-master${enabled ? ' is-active' : ''}`} aria-label={`${enabled ? '隐藏' : '显示'}趋势线`} aria-pressed={enabled} disabled={!candles} title={candles ? '自动趋势线' : '趋势线适用于K线图'} onClick={() => onChange({ autoTrendlines: !enabled })}>趋势线</button>
      <span className="three-push-control-divider" />
      {MODES.map((item) => <button key={item.mode} type="button" className={`three-push-level${enabled && mode === item.mode && candles ? ' is-active' : ''}`} style={color} disabled={!candles} aria-pressed={enabled && mode === item.mode} title={item.title} onClick={() => onChange({ autoTrendlines: true, autoTrendlinesMode: item.mode })}>{item.label}</button>)}
    </div>
  </div>
}
