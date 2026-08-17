import { useEffect, useState } from 'react'
import { Pencil, X } from 'lucide-react'
import {
  createDefaultFibSettings, normalizeFibSettings,
  type Drawing, type DrawingLineStyle, type DrawingPoint, type FibSettings,
} from '../lib/drawings'

type FibSettingsTab = 'style' | 'coordinates' | 'visibility'

interface Props {
  drawing: Drawing
  onApply: (settings: FibSettings, points: DrawingPoint[], label: string) => void
  onClose: () => void
}

const LINE_STYLE_LABELS: Record<DrawingLineStyle, string> = {
  solid: '实线',
  dashed: '虚线',
  dotted: '点线',
}

export function FibSettingsDialog({ drawing, onApply, onClose }: Props) {
  const [tab, setTab] = useState<FibSettingsTab>('style')
  const [settings, setSettings] = useState(() => normalizeFibSettings(drawing.fib))
  const [points, setPoints] = useState(() => drawing.points.map((point) => ({ ...point })))
  const [label, setLabel] = useState(drawing.label)
  const [editingLabel, setEditingLabel] = useState(false)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const updateLevel = (id: string, patch: Partial<FibSettings['levels'][number]>) => {
    setSettings((current) => ({
      ...current,
      levels: current.levels.map((level) => level.id === id ? { ...level, ...patch } : level),
    }))
  }

  const updatePoint = (index: number, axis: keyof DrawingPoint, percentage: number) => {
    const normalized = Math.max(0, Math.min(100, Number.isFinite(percentage) ? percentage : 0)) / 100
    setPoints((current) => current.map((point, pointIndex) => pointIndex === index ? { ...point, [axis]: normalized } : point))
  }

  const applyTemplate = (template: string) => {
    if (template === 'default') {
      setSettings(createDefaultFibSettings())
      return
    }
    setSettings((current) => ({
      ...current,
      levels: current.levels.map((level) => ({
        ...level,
        visible: template === 'all' || [0, .5, .618, 1].includes(level.value),
      })),
    }))
  }

  return <div className="fib-settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="fib-settings-dialog" role="dialog" aria-modal="true" aria-label="斐波那契回撤设置">
      <header className="fib-settings-header">
        <div>
          {editingLabel
            ? <input className="fib-settings-name-input" aria-label="绘图名称" value={label} autoFocus onChange={(event) => setLabel(event.target.value)} onBlur={() => setEditingLabel(false)} onKeyDown={(event) => { if (event.key === 'Enter') setEditingLabel(false) }} />
            : <h2>{label}</h2>}
          <button type="button" aria-label="编辑绘图名称" title="编辑名称" onClick={() => setEditingLabel(true)}><Pencil size={21} /></button>
        </div>
        <button type="button" className="fib-settings-close" aria-label="关闭斐波那契设置" onClick={onClose}><X size={28} /></button>
      </header>

      <nav className="fib-settings-tabs" aria-label="斐波那契设置分类">
        <button type="button" className={tab === 'style' ? 'active' : ''} aria-pressed={tab === 'style'} onClick={() => setTab('style')}>样式</button>
        <button type="button" className={tab === 'coordinates' ? 'active' : ''} aria-pressed={tab === 'coordinates'} onClick={() => setTab('coordinates')}>坐标</button>
        <button type="button" className={tab === 'visibility' ? 'active' : ''} aria-pressed={tab === 'visibility'} onClick={() => setTab('visibility')}>可见范围</button>
      </nav>

      <div className="fib-settings-scroll">
        {tab === 'style' && <div className="fib-style-tab">
          <div className="fib-setting-row">
            <label className="fib-checkbox-label"><input type="checkbox" checked={settings.trendLineVisible} onChange={(event) => setSettings((current) => ({ ...current, trendLineVisible: event.target.checked }))} /><span />趋势线</label>
            <div className="fib-line-controls">
              <input aria-label="趋势线颜色" type="color" value={settings.trendLineColor} onChange={(event) => setSettings((current) => ({ ...current, trendLineColor: event.target.value }))} />
              <select aria-label="趋势线线型" value={settings.trendLineStyle} onChange={(event) => setSettings((current) => ({ ...current, trendLineStyle: event.target.value as DrawingLineStyle }))}>{Object.entries(LINE_STYLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            </div>
          </div>
          <div className="fib-setting-row">
            <span>水平线</span>
            <div className="fib-line-controls">
              <input aria-label="水平线颜色" type="color" value={settings.horizontalLineColor} onChange={(event) => setSettings((current) => ({ ...current, horizontalLineColor: event.target.value }))} />
              <select aria-label="水平线线型" value={settings.horizontalLineStyle} onChange={(event) => setSettings((current) => ({ ...current, horizontalLineStyle: event.target.value as DrawingLineStyle }))}>{Object.entries(LINE_STYLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
              <select aria-label="水平线宽度" value={settings.horizontalLineWidth} onChange={(event) => setSettings((current) => ({ ...current, horizontalLineWidth: Number(event.target.value) }))}>{[1, 1.5, 2, 3, 4].map((width) => <option key={width} value={width}>{width}px</option>)}</select>
            </div>
          </div>
          <div className="fib-setting-row">
            <span>延伸</span>
            <select className="fib-extend-select" aria-label="斐波那契延伸方式" value={settings.extend} onChange={(event) => setSettings((current) => ({ ...current, extend: event.target.value as FibSettings['extend'] }))}>
              <option value="none">不要扩大</option><option value="right">向右延伸</option><option value="left">向左延伸</option><option value="both">两侧延伸</option>
            </select>
          </div>
          <div className="fib-level-grid" aria-label="斐波那契层级">
            {settings.levels.map((level) => <div className={`fib-level-row${level.visible ? ' enabled' : ''}`} key={level.id}>
              <label className="fib-level-toggle"><input type="checkbox" aria-label={`显示 ${level.value} 层级`} checked={level.visible} onChange={(event) => updateLevel(level.id, { visible: event.target.checked })} /><span /></label>
              <input className="fib-level-value" aria-label={`${level.value} 层级数值`} type="number" step="0.001" value={level.value} disabled={!level.visible} onChange={(event) => updateLevel(level.id, { value: Number(event.target.value) })} />
              <input className="fib-level-color" aria-label={`${level.value} 层级颜色`} type="color" value={level.color} onChange={(event) => updateLevel(level.id, { color: event.target.value })} />
            </div>)}
          </div>
        </div>}

        {tab === 'coordinates' && <div className="fib-coordinates-tab">
          <p>使用画布百分比精确设置回撤线的两个锚点。</p>
          {points.slice(0, 2).map((point, index) => <fieldset key={index}>
            <legend>点 {index + 1}</legend>
            <label>X 位置<input type="number" min="0" max="100" step="0.1" value={(point.x * 100).toFixed(1)} onChange={(event) => updatePoint(index, 'x', Number(event.target.value))} /><span>%</span></label>
            <label>Y 位置<input type="number" min="0" max="100" step="0.1" value={(point.y * 100).toFixed(1)} onChange={(event) => updatePoint(index, 'y', Number(event.target.value))} /><span>%</span></label>
          </fieldset>)}
        </div>}

        {tab === 'visibility' && <div className="fib-visibility-tab">
          <p>选择该斐波那契回撤在不同周期中的可见范围。</p>
          {([['minutes', '分钟'], ['hours', '小时'], ['days', '日'], ['weeks', '周及以上']] as const).map(([key, label]) => <label key={key} className="fib-checkbox-label"><input type="checkbox" checked={settings.visibility[key]} onChange={(event) => setSettings((current) => ({ ...current, visibility: { ...current.visibility, [key]: event.target.checked } }))} /><span />{label}</label>)}
        </div>}
      </div>

      <footer className="fib-settings-footer">
        <select aria-label="斐波那契模板" defaultValue="custom" onChange={(event) => applyTemplate(event.target.value)}><option value="custom" disabled>模板</option><option value="default">TradingView 默认</option><option value="classic">经典 0 / 0.5 / 0.618 / 1</option><option value="all">显示全部层级</option></select>
        <div><button type="button" onClick={onClose}>取消</button><button type="button" className="primary" onClick={() => onApply(settings, points, label.trim() || drawing.label)}>确认</button></div>
      </footer>
    </section>
  </div>
}
