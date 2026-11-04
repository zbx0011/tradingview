import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  AlarmClockPlus, Bold, Check, ChevronDown, ChevronRight, Copy, CopyPlus, EyeOff, Italic, Layers, LockKeyhole, MoreHorizontal,
  Pencil, Plus, Settings, Trash2, UnlockKeyhole, X,
} from 'lucide-react'
import type { Drawing, DrawingLineStyle, DrawingStat, DrawingVisibility, PositionSettings } from '../lib/drawings'
import {
  DATE_RANGE_STAT_OPTIONS, FONT_SIZES, FORECAST_COLOR_ROWS, POSITION_STAT_OPTIONS, STAT_OPTIONS, STATS_POSITION_OPTIONS, TV_COLOR_PALETTE, VISIBILITY_ROWS,
  channelLevelsFor, drawingOption, fibLevelsFor, forecastColor, hexToRgba, levelGroup, normalizeVisibility, positionSettingsFor, settingsKindFor, type SettingsKind,
} from '../lib/lineToolSettings'
import { formatPrice, type Candle, type SymbolId } from '../lib/market'

export type LineSettingsTab = 'inputs' | 'style' | 'text' | 'coordinates' | 'visibility'

const WIDTHS = [1, 2, 3, 4]
const LINE_STYLES: { id: DrawingLineStyle; label: string; dash?: string }[] = [
  { id: 'solid', label: '线条' },
  { id: 'dashed', label: '虚线', dash: '5 4' },
  { id: 'dotted', label: '点线', dash: '1.5 3' },
]

/** Close a popover when clicking outside of it or pressing Escape. */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose() }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
    document.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('pointerdown', onPointer, true); window.removeEventListener('keydown', onKey, true) }
  }, [open, ref, onClose])
}

function LinePreview({ width, style, color = 'currentColor' }: { width: number; style: DrawingLineStyle; color?: string }) {
  const dash = LINE_STYLES.find((item) => item.id === style)?.dash
  return <svg width="28" height="10" viewBox="0 0 28 10" aria-hidden="true"><line x1="1" y1="5" x2="27" y2="5" stroke={color} strokeWidth={width} strokeDasharray={dash} /></svg>
}

/** TradingView colour picker: palette, custom colour, opacity and optionally thickness + line style. */
export function ColorPalettePanel({
  color, opacity, onColor, onOpacity, width, onWidth, lineStyle, onLineStyle,
}: {
  color: string
  opacity: number
  onColor: (color: string) => void
  onOpacity?: (opacity: number) => void
  width?: number
  onWidth?: (width: number) => void
  lineStyle?: DrawingLineStyle
  onLineStyle?: (style: DrawingLineStyle) => void
}) {
  const [customOpen, setCustomOpen] = useState(false)
  if (customOpen) return <div className="tvd-palette" role="dialog" aria-label="自定义颜色">
    <CustomColorPicker initial={color} onAdd={(value) => { onColor(value); setCustomOpen(false) }} />
  </div>
  return <div className="tvd-palette" role="dialog" aria-label="颜色">
    <div className="tvd-palette-grid">
      {TV_COLOR_PALETTE.map((row, rowIndex) => <div className={`tvd-palette-row${rowIndex === 0 ? ' is-gray' : ''}`} key={rowIndex}>
        {row.map((swatch, index) => <button
          type="button" key={`${swatch}-${index}`} className={`tvd-swatch${swatch.toLowerCase() === color.toLowerCase() ? ' selected' : ''}`}
          style={{ background: swatch }} aria-label={swatch} onClick={() => onColor(swatch)}
        />)}
      </div>)}
    </div>
    <div className="tvd-palette-custom">
      <button type="button" aria-label="自定义颜色" onClick={() => setCustomOpen(true)}><Plus size={18} /></button>
    </div>
    {onOpacity && <div className="tvd-palette-section">
      <span>不透明度</span>
      <div className="tvd-opacity">
        <input
          type="range" min={0} max={100} value={Math.round(opacity * 100)} aria-label="不透明度"
          style={{ background: `linear-gradient(90deg, ${hexToRgba(color, 0)}, ${hexToRgba(color, 1)})` }}
          onChange={(event) => onOpacity(Number(event.target.value) / 100)}
        />
        <span className="tvd-opacity-value">{Math.round(opacity * 100)}%</span>
      </div>
    </div>}
    {onWidth && width !== undefined && <div className="tvd-palette-section">
      <span>厚度</span>
      <div className="tvd-segment">
        {WIDTHS.map((item) => <button type="button" key={item} className={Math.round(width) === item ? 'active' : ''} aria-label={`${item}px`} onClick={() => onWidth(item)}><span style={{ height: item }} /></button>)}
      </div>
    </div>}
    {onLineStyle && lineStyle && <div className="tvd-palette-section">
      <span>线条样式</span>
      <div className="tvd-segment">
        {LINE_STYLES.map((item) => <button type="button" key={item.id} className={lineStyle === item.id ? 'active' : ''} aria-label={item.label} onClick={() => onLineStyle(item.id)}><LinePreview width={1.5} style={item.id} /></button>)}
      </div>
    </div>}
  </div>
}

function hexToHsv(hex: string) {
  const value = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : '2962ff'
  const r = parseInt(value.slice(0, 2), 16) / 255
  const g = parseInt(value.slice(2, 4), 16) / 255
  const b = parseInt(value.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let h = 0
  if (delta) h = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  return { h: (h * 60 + 360) % 360, s: max === 0 ? 0 : delta / max, v: max }
}

function hsvToHex(h: number, s: number, v: number) {
  const f = (n: number) => {
    const k = (n + h / 60) % 6
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255).toString(16).padStart(2, '0')
  }
  return `#${f(5)}${f(3)}${f(1)}`
}

/** TradingView "+" custom colour: saturation/value square, hue bar, hex input and 添加. */
function CustomColorPicker({ initial, onAdd }: { initial: string; onAdd: (color: string) => void }) {
  const [hsv, setHsv] = useState(() => hexToHsv(initial))
  const hex = hsvToHex(hsv.h, hsv.s, hsv.v)
  const [hexDraft, setHexDraft] = useState(hex.toUpperCase())
  const drag = (event: React.PointerEvent<HTMLDivElement>, apply: (x: number, y: number) => void) => {
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    const move = (clientX: number, clientY: number) => {
      const rect = target.getBoundingClientRect()
      apply(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)))
    }
    move(event.clientX, event.clientY)
    const onMove = (moveEvent: PointerEvent) => move(moveEvent.clientX, moveEvent.clientY)
    const onUp = () => { target.removeEventListener('pointermove', onMove); target.removeEventListener('pointerup', onUp) }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
  }
  const setFromHsv = (next: typeof hsv) => { setHsv(next); setHexDraft(hsvToHex(next.h, next.s, next.v).toUpperCase()) }
  return <div className="tvd-custom-color">
    <div className="tvd-sv" style={{ background: `hsl(${hsv.h} 100% 50%)` }} onPointerDown={(event) => drag(event, (x, y) => setFromHsv({ ...hsv, s: x, v: 1 - y }))}>
      <div className="tvd-sv-white" /><div className="tvd-sv-black" />
      <span className="tvd-sv-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
    </div>
    <div className="tvd-hue" onPointerDown={(event) => drag(event, (x) => setFromHsv({ ...hsv, h: x * 359.9 }))}>
      <span className="tvd-hue-thumb" style={{ left: `${hsv.h / 360 * 100}%` }} />
    </div>
    <div className="tvd-custom-row">
      <span className="tvd-color-chip" style={{ background: hex }} />
      <input className="tvd-number wide" value={hexDraft} aria-label="十六进制颜色" onChange={(event) => {
        const value = event.target.value.trim()
        setHexDraft(value)
        const normalized = value.startsWith('#') ? value : `#${value}`
        if (/^#[0-9a-f]{6}$/i.test(normalized)) setHsv(hexToHsv(normalized))
      }} />
      <button type="button" className="tvd-button primary" onClick={() => onAdd(hex)}>添加</button>
    </div>
  </div>
}

/** Colour swatch button that opens the TradingView palette in a floating layer (replaces native colour inputs). */
export function TvColorInput({ value, onChange, label, className = '', opacity, onOpacity }: { value: string; onChange: (color: string) => void; label: string; className?: string; opacity?: number; onOpacity?: (opacity: number) => void }) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (!layerRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }
    document.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('pointerdown', onPointer, true); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !layerRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    const layer = layerRef.current.getBoundingClientRect()
    const left = Math.max(8, Math.min(window.innerWidth - layer.width - 8, rect.left))
    const below = rect.bottom + 6
    const top = below + layer.height > window.innerHeight - 8 ? Math.max(8, rect.top - layer.height - 6) : below
    setPosition({ left, top })
  }, [open])
  return <>
    <button ref={buttonRef} type="button" className={`tvd-color-input ${className}`} aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>
      <span style={{ background: hexToRgba(value, opacity ?? 1) }} />
    </button>
    {open && createPortal(<div ref={layerRef} className="tvd-color-layer" style={{ left: position?.left ?? -9999, top: position?.top ?? -9999 }}>
      <ColorPalettePanel color={value} opacity={opacity ?? 1} onColor={onChange} onOpacity={onOpacity} />
    </div>, document.body)}
  </>
}

function Popover({ open, onClose, trigger, children, className = '' }: { open: boolean; onClose: () => void; trigger: ReactNode; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(open, ref, onClose)
  return <div className={`tvd-popover-anchor ${className}`} ref={ref}>
    {trigger}
    {open && <div className="tvd-popover">{children}</div>}
  </div>
}

function Select<T extends string | number>({ value, options, onChange, label, width }: { value: T; options: { id: T; label: string }[]; onChange: (value: T) => void; label: string; width?: number }) {
  const [open, setOpen] = useState(false)
  const current = options.find((option) => option.id === value)
  return <Popover open={open} onClose={() => setOpen(false)} trigger={
    <button type="button" className={`tvd-select${open ? ' open' : ''}`} style={width ? { width } : undefined} aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>
      <span>{current?.label ?? String(value)}</span><ChevronDown size={16} />
    </button>
  }>
    <div className="tvd-menu" role="listbox" aria-label={label}>
      {options.map((option) => <button type="button" role="option" aria-selected={option.id === value} key={String(option.id)} className={option.id === value ? 'selected' : ''} onClick={() => { onChange(option.id); setOpen(false) }}>{option.label}</button>)}
    </div>
  </Popover>
}

function CheckSelect({ summary, label, items }: { summary: string; label: string; items: { id: string; label: string; checked: boolean; onChange: (checked: boolean) => void }[] }) {
  const [open, setOpen] = useState(false)
  return <Popover open={open} onClose={() => setOpen(false)} trigger={
    <button type="button" className={`tvd-select${open ? ' open' : ''}`} aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>
      <span>{summary}</span><ChevronDown size={16} />
    </button>
  }>
    <div className="tvd-menu" role="listbox" aria-label={label}>
      {items.map((item) => <label key={item.id} className="tvd-menu-check"><Checkbox checked={item.checked} onChange={item.onChange} /><span>{item.label}</span></label>)}
    </div>
  </Popover>
}

function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label?: string }) {
  return <span className={`tvd-checkbox${checked ? ' checked' : ''}`}>
    <input type="checkbox" checked={checked} aria-label={label} onChange={(event) => onChange(event.target.checked)} />
    {checked && <Check size={13} strokeWidth={3} />}
  </span>
}

function CheckRow({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return <label className="tvd-check-row"><Checkbox checked={checked} onChange={onChange} /><span>{label}</span></label>
}

function EndStyleButton({ value, side, onChange }: { value: 'normal' | 'arrow'; side: 'left' | 'right'; onChange: (value: 'normal' | 'arrow') => void }) {
  const [open, setOpen] = useState(false)
  const icon = (kind: 'normal' | 'arrow') => side === 'left'
    ? <svg width="22" height="12" viewBox="0 0 22 12" fill="none" stroke="currentColor" strokeWidth="1.3">{kind === 'normal' ? <><circle cx="4" cy="6" r="2.5" /><path d="M6.5 6H21" /></> : <path d="M6 2 2 6l4 4M2 6h19" />}</svg>
    : <svg width="22" height="12" viewBox="0 0 22 12" fill="none" stroke="currentColor" strokeWidth="1.3">{kind === 'normal' ? <><path d="M1 6h14.5" /><circle cx="18" cy="6" r="2.5" /></> : <path d="M16 2l4 4-4 4M1 6h19" />}</svg>
  return <Popover open={open} onClose={() => setOpen(false)} trigger={
    <button type="button" className={`tvd-icon-select${open ? ' open' : ''}`} aria-label={side === 'left' ? '左端点' : '右端点'} onClick={() => setOpen(!open)}>{icon(value)}</button>
  }>
    <div className="tvd-menu" role="listbox">
      {(['normal', 'arrow'] as const).map((kind) => <button type="button" key={kind} className={kind === value ? 'selected' : ''} onClick={() => { onChange(kind); setOpen(false) }}>{icon(kind)}<span>{kind === 'normal' ? '普通' : '箭头'}</span></button>)}
    </div>
  </Popover>
}

function ColorButton({ color, opacity, onColor, onOpacity, width, onWidth, lineStyle, onLineStyle, label }: {
  color: string; opacity: number; onColor: (color: string) => void; onOpacity?: (opacity: number) => void; label: string
  width?: number; onWidth?: (width: number) => void; lineStyle?: DrawingLineStyle; onLineStyle?: (style: DrawingLineStyle) => void
}) {
  const [open, setOpen] = useState(false)
  return <Popover open={open} onClose={() => setOpen(false)} trigger={
    <button type="button" className={`tvd-color-button${open ? ' open' : ''}`} aria-label={label} onClick={() => setOpen(!open)}>
      <span className="tvd-color-chip" style={{ background: hexToRgba(color, opacity) }} />
      {lineStyle && width !== undefined && <LinePreview width={Math.min(width, 3)} style={lineStyle} color={color} />}
    </button>
  }>
    <ColorPalettePanel color={color} opacity={opacity} onColor={onColor} onOpacity={onOpacity} width={width} onWidth={onWidth} lineStyle={lineStyle} onLineStyle={onLineStyle} />
  </Popover>
}

function nearestIndex(candles: readonly Candle[], time: number | undefined) {
  if (time === undefined || candles.length === 0) return 0
  let low = 0
  let high = candles.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if (candles[middle].time < time) low = middle + 1
    else high = middle
  }
  return low
}

interface DialogProps {
  drawing: Drawing
  candles: readonly Candle[]
  symbol: SymbolId
  initialTab?: LineSettingsTab
  /** Live preview of a change (no undo checkpoint). */
  onPreview: (patch: Partial<Drawing>) => void
  onConfirm: () => void
  onCancel: (original: Drawing) => void
  onSaveTemplate: (drawing: Drawing) => void
  onApplyDefaults: () => void
}

const TAB_LABELS: Record<LineSettingsTab, string> = { inputs: '输入', style: '样式', text: '文本', coordinates: '坐标', visibility: '可见范围' }

function tabsForKind(kind: SettingsKind, drawing: Drawing): LineSettingsTab[] {
  if (kind === 'textbox') return drawing.behavior === 'text' ? ['text', 'visibility'] : ['text', 'coordinates', 'visibility']
  if (kind === 'cross' || kind === 'pattern' || kind === 'label' || kind === 'fiblevels' || kind === 'pitchfork' || kind === 'cycle' || kind === 'forecast') return ['style', 'coordinates', 'visibility']
  if (kind === 'position') return ['inputs', 'style', 'visibility']
  if (['gannbox', 'gannsquare', 'gannfan', 'pitchfan', 'spiral', 'arcs'].includes(kind)) return ['style', 'coordinates', 'visibility']
  if (['wedge', 'barspattern', 'sector', 'path', 'brush', 'arc'].includes(kind)) return ['style', 'visibility']
  if (kind === 'curve') return ['style', 'coordinates', 'visibility']
  if (kind === 'vwap') return ['inputs', 'style', 'visibility']
  if (kind === 'volumeprofile') return ['inputs', 'style', 'coordinates', 'visibility']
  return ['style', 'text', 'coordinates', 'visibility']
}

/** Default text alignment / size per tool family (matches TradingView). */
function textDefaults(drawing: Drawing, kind: SettingsKind) {
  const size = kind === 'hline' || kind === 'range' || kind === 'pattern' || kind === 'position' ? 12 : kind === 'arrowmark' && drawing.tool === 'arrow-marker' ? 16 : 14
  const vAlign = kind === 'hline' ? (drawing.behavior === 'horizontal-ray' ? 'bottom' : 'middle') : kind === 'vline' ? 'middle' : kind === 'shape' ? 'middle' : 'top'
  const hAlign = kind === 'channel' ? 'left' : 'center'
  return { size, vAlign, hAlign } as const
}

/** TradingView-style drawing settings dialog. The tabs and rows follow the tool family. */
export function LineToolSettingsDialog({ drawing, candles, symbol, initialTab = 'style', onPreview, onConfirm, onCancel, onSaveTemplate, onApplyDefaults }: DialogProps) {
  const kind = settingsKindFor(drawing.behavior, drawing.tool)
  const tabs = tabsForKind(kind, drawing)
  const [tab, setTab] = useState<LineSettingsTab>(tabs.includes(initialTab) ? initialTab : tabs[0])
  const [original] = useState(drawing)
  const [editingTitle, setEditingTitle] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const templateRef = useRef<HTMLDivElement>(null)
  useDismiss(templateOpen, templateRef, () => setTemplateOpen(false))
  const visibility = useMemo(() => normalizeVisibility(drawing.visibility), [drawing.visibility])
  const stats = drawing.stats ?? (kind === 'range' ? (drawing.tool === 'date-range' ? ['bars-range', 'date-time-range', 'volume'] : ['price-range', 'percent-change', 'pips-change']) as DrawingStat[] : [])
  const update = (patch: Partial<Drawing>) => onPreview(patch)
  const updateVisibility = (patch: Partial<DrawingVisibility>) => update({ visibility: { ...visibility, ...patch } })
  const extendLeft = drawing.extendLeft ?? drawing.behavior === 'extended-line'
  const extendRight = drawing.extendRight ?? (drawing.behavior === 'ray' || drawing.behavior === 'extended-line')
  const extendSummary = extendLeft && extendRight ? '双向延伸' : extendLeft ? '延伸左边线条' : extendRight ? '延伸右边线条' : '不要扩大'
  const statsSummary = stats.length === 0 ? '隐藏' : [...STAT_OPTIONS, ...DATE_RANGE_STAT_OPTIONS.filter((item) => item.id === 'volume')].filter((item) => stats.includes(item.id)).map((item) => item.label).join(', ')
  const toggleStat = (id: DrawingStat, checked: boolean) => update({ stats: checked ? [...stats, id] : stats.filter((item) => item !== id) })
  const defaults = textDefaults(drawing, kind)
  const fillEnabled = drawing.fillEnabled ?? (['shape', 'channel', 'pattern', 'range', 'circle', 'sector', 'arc', 'gannbox', 'gannsquare', 'gannfan', 'pitchfan', 'arcs', 'wedge'].includes(kind))
  const fillColor = drawing.fillColor ?? drawing.color
  const borderEnabled = drawing.borderEnabled ?? (kind !== 'textbox')
  const option = <T extends boolean | number | string>(key: string, fallback: T) => drawingOption(drawing, key, fallback)
  const setOption = (key: string, value: boolean | number | string) => update({ options: { ...(drawing.options ?? {}), [key]: value } })
  const optionCheck = (key: string, label: string, fallback = false) => <div className="tvd-span"><CheckRow label={label} checked={option(key, fallback)} onChange={(value) => setOption(key, value)} /></div>
  const groupGrid = (key: string, title?: string) => {
    const levels = levelGroup(drawing, key)
    return <>
      {title && <div className="tvd-span tvd-section-title">{title}</div>}
      <div className="tvd-span tvd-levels tvd-levels-grid">
        {levels.map((level, index) => {
          const setLevel = (patch: Partial<typeof level>) => update({ levelGroups: { ...(drawing.levelGroups ?? {}), [key]: levels.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) } })
          return <div className={`tvd-level-row${level.enabled ? '' : ' disabled'}`} key={index}>
            <Checkbox checked={level.enabled} label={`启用 ${level.label ?? level.value}`} onChange={(enabled) => setLevel({ enabled })} />
            {level.label
              ? <span className="tvd-level-label">{level.label}</span>
              : <input className="tvd-number" inputMode="decimal" value={level.value} aria-label="水平位" onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) setLevel({ value }) }} />}
            <ColorButton label="水平位颜色" color={drawing.useOneColor ? drawing.color : level.color} opacity={1} onColor={(color) => setLevel({ color })} />
          </div>
        })}
      </div>
    </>
  }
  const fibGrid = () => <div className="tvd-span tvd-levels tvd-levels-grid">
    {fibLevelsFor(drawing).map((level, index, levels) => {
      const setLevel = (patch: Partial<typeof level>) => update({ fibLevels: levels.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) })
      return <div className={`tvd-level-row${level.enabled ? '' : ' disabled'}`} key={index}>
        <Checkbox checked={level.enabled} label={`启用 ${level.value}`} onChange={(enabled) => setLevel({ enabled })} />
        <input className="tvd-number" inputMode="decimal" value={level.value} aria-label="水平位" onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) setLevel({ value }) }} />
        <ColorButton label="水平位颜色" color={drawing.useOneColor ? drawing.color : level.color} opacity={1} onColor={(color) => setLevel({ color })} />
      </div>
    })}
  </div>
  const oneColorRow = <div className="tvd-span"><CheckRow label="使用一种颜色" checked={Boolean(drawing.useOneColor)} onChange={(useOneColor) => update({ useOneColor })} /></div>
  const borderColor = drawing.borderColor ?? drawing.color
  const position = positionSettingsFor(drawing)
  const updatePosition = (patch: Partial<typeof position>) => update({ position: { ...position, ...patch } })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onCancel(original)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, original])

  const updatePoint = (index: number, patch: { price?: number; bar?: number }) => {
    const points = drawing.points.map((point, pointIndex) => {
      if (pointIndex !== index) return point
      const next = { ...point }
      if (patch.price !== undefined && Number.isFinite(patch.price)) next.price = patch.price
      if (patch.bar !== undefined && candles.length) {
        const candle = candles[Math.max(0, Math.min(candles.length - 1, Math.round(patch.bar)))]
        next.time = candle.time
      }
      return next
    })
    update({ points })
  }

  const coordinatePoints = kind === 'hline' || kind === 'vline' || kind === 'cross' ? drawing.points.slice(0, 1) : drawing.points
  const coordinateMode = kind === 'hline' && drawing.behavior === 'horizontal' ? 'price' : kind === 'vline' ? 'bar' : 'both'

  const lineRow = (label = '线形图') => <>
    <span className="tvd-label">{label}</span>
    <div className="tvd-inline">
      <ColorButton
        label="线条颜色" color={drawing.color} opacity={drawing.opacity ?? 1}
        onColor={(color) => update({ color })} onOpacity={(opacity) => update({ opacity })}
        width={drawing.width} onWidth={(width) => update({ width })}
        lineStyle={drawing.lineStyle ?? 'solid'} onLineStyle={(lineStyle) => update({ lineStyle })}
      />
      {kind === 'line' && <>
        <EndStyleButton side="left" value={drawing.leftEnd ?? 'normal'} onChange={(leftEnd) => update({ leftEnd })} />
        <EndStyleButton side="right" value={drawing.rightEnd ?? (drawing.behavior === 'arrow' ? 'arrow' : 'normal')} onChange={(rightEnd) => update({ rightEnd })} />
      </>}
    </div>
  </>
  const extendRow = <>
    <span className="tvd-label">延伸</span>
    <CheckSelect summary={extendSummary} label="延伸" items={[
      { id: 'left', label: '延伸左边线条', checked: extendLeft, onChange: (checked) => update({ extendLeft: checked }) },
      { id: 'right', label: '延伸右边线条', checked: extendRight, onChange: (checked) => update({ extendRight: checked }) },
    ]} />
  </>
  const fillRow = (label = '背景') => <>
    <CheckRow label={label} checked={fillEnabled} onChange={(value) => update({ fillEnabled: value })} />
    <div><ColorButton label={`${label}颜色`} color={fillColor} opacity={drawing.fillOpacity ?? 0.2} onColor={(value) => update({ fillColor: value })} onOpacity={(value) => update({ fillOpacity: value })} /></div>
  </>
  const borderRow = (withCheckbox: boolean) => withCheckbox ? <>
    <CheckRow label="边框" checked={borderEnabled} onChange={(value) => update({ borderEnabled: value })} />
    <div><ColorButton label="边框颜色" color={borderColor} opacity={1} onColor={(value) => update({ borderColor: value })} onOpacity={() => undefined} /></div>
  </> : lineRow('边框')
  const textStyleControls = (labelColor?: boolean) => <div className="tvd-inline">
    <ColorButton label={labelColor ? '标签颜色' : '文字颜色'} color={drawing.textColor ?? drawing.color} opacity={1} onColor={(textColor) => update({ textColor })} onOpacity={() => undefined} />
    <Select label="字号" value={drawing.fontSize ?? defaults.size} options={FONT_SIZES.map((size) => ({ id: size, label: String(size) }))} onChange={(fontSize) => update({ fontSize })} width={92} />
    <button type="button" className={`tvd-toggle${drawing.bold ? ' active' : ''}`} aria-label="粗体" aria-pressed={Boolean(drawing.bold)} onClick={() => update({ bold: !drawing.bold })}><Bold size={16} /></button>
    <button type="button" className={`tvd-toggle${drawing.italic ? ' active' : ''}`} aria-label="斜体" aria-pressed={Boolean(drawing.italic)} onClick={() => update({ italic: !drawing.italic })}><Italic size={16} /></button>
  </div>
  const vAlignOptions = kind === 'shape'
    ? [{ id: 'top' as const, label: '顶部' }, { id: 'middle' as const, label: '内部' }, { id: 'bottom' as const, label: '底部' }]
    : [{ id: 'top' as const, label: '顶部' }, { id: 'middle' as const, label: '中间' }, { id: 'bottom' as const, label: '底部' }]

  return <div className="tvd-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel(original) }}>
    <section className="tvd-dialog" role="dialog" aria-modal="true" aria-label={`${drawing.label}设置`} data-testid="line-tool-settings">
      <header className="tvd-header">
        {editingTitle
          ? <input className="tvd-title-input" autoFocus defaultValue={drawing.label} aria-label="绘图名称" onBlur={(event) => { update({ label: event.target.value.trim() || original.label }); setEditingTitle(false) }} onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur() }} />
          : <h2>{drawing.label}<button type="button" className="tvd-title-edit" aria-label="重命名" onClick={() => setEditingTitle(true)}><Pencil size={15} /></button></h2>}
        <button type="button" className="tvd-close" aria-label="关闭菜单" onClick={() => onCancel(original)}><X size={20} /></button>
      </header>
      <nav className="tvd-tabs" role="tablist">
        {tabs.map((item) => <button type="button" role="tab" aria-selected={tab === item} key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{TAB_LABELS[item]}</button>)}
      </nav>
      <div className="tvd-body">
        {tab === 'inputs' && kind === 'vwap' && <div className="tvd-grid">
          <div className="tvd-span tvd-section-title">带设置</div>
          <span className="tvd-label">带计算模式</span>
          <Select label="带计算模式" value={option('bandMode', 'stdev')} options={[{ id: 'stdev', label: '标准偏差' }, { id: 'percent', label: '百分比' }]} onChange={(value) => setOption('bandMode', value)} />
          {[1, 2, 3].map((index) => <span key={index} className="tvd-span tvd-color-row">
            <CheckRow label={`带乘数#${index}`} checked={option(`band${index}On`, index === 1)} onChange={(value) => setOption(`band${index}On`, value)} />
            <input className="tvd-number" inputMode="decimal" value={option(`band${index}`, index)} aria-label={`带乘数#${index}`} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) setOption(`band${index}`, value) }} />
          </span>)}
          <span className="tvd-label">来源</span>
          <Select label="来源" value={option('source', 'hlc3')} options={[{ id: 'open', label: '开盘价' }, { id: 'high', label: '最高价' }, { id: 'low', label: '最低价' }, { id: 'close', label: '收盘价' }, { id: 'hl2', label: '(高 + 低)/2' }, { id: 'hlc3', label: '(高 + 低 + 收)/3' }, { id: 'ohlc4', label: '(开 + 高 + 低 + 收)/4' }]} onChange={(value) => setOption('source', value)} />
        </div>}
        {tab === 'inputs' && kind === 'volumeprofile' && <div className="tvd-grid">
          <span className="tvd-label">行布局</span>
          <Select label="行布局" value={option('rowLayout', 'rows')} options={[{ id: 'rows', label: '行数' }, { id: 'ticks', label: '每行Tick' }]} onChange={(value) => setOption('rowLayout', value)} />
          <span className="tvd-label">行数</span>
          <input className="tvd-number" inputMode="numeric" value={option('rowSize', 24)} aria-label="行数" onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) setOption('rowSize', Math.max(1, Math.round(value))) }} />
          <span className="tvd-label">成交量</span>
          <Select label="成交量" value={option('volumeMode', 'updown')} options={[{ id: 'updown', label: '上/下' }, { id: 'total', label: '总计' }, { id: 'delta', label: 'Delta' }]} onChange={(value) => setOption('volumeMode', value)} />
          <span className="tvd-label">数值区成交量</span>
          <input className="tvd-number" inputMode="numeric" value={option('valueArea', 70)} aria-label="数值区成交量" onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) setOption('valueArea', Math.max(1, Math.min(100, value))) }} />
          {optionCheck('extendRight', '向右延长', false)}
        </div>}
        {tab === 'inputs' && kind === 'position' && <PositionInputs drawing={drawing} symbol={symbol} settings={position} onSettings={updatePosition} onPoints={(points) => update({ points })} />}

        {tab === 'style' && kind === 'position' && <div className="tvd-grid">
          <span className="tvd-label">线条</span>
          <div><ColorButton label="线条颜色" color={drawing.color} opacity={drawing.opacity ?? 1} onColor={(color) => update({ color })} onOpacity={(opacity) => update({ opacity })} width={drawing.width} onWidth={(width) => update({ width })} lineStyle={drawing.lineStyle ?? 'solid'} onLineStyle={(lineStyle) => update({ lineStyle })} /></div>
          <span className="tvd-label">止损颜色</span>
          <div><ColorButton label="止损颜色" color={position.stopColor} opacity={drawing.fillOpacity ?? 0.2} onColor={(stopColor) => updatePosition({ stopColor })} onOpacity={(fillOpacity) => update({ fillOpacity })} /></div>
          <span className="tvd-label">目标颜色:</span>
          <div><ColorButton label="目标颜色" color={position.targetColor} opacity={drawing.fillOpacity ?? 0.2} onColor={(targetColor) => updatePosition({ targetColor })} onOpacity={(fillOpacity) => update({ fillOpacity })} /></div>
          <span className="tvd-label">文本</span>
          <div className="tvd-inline">
            <ColorButton label="文字颜色" color={drawing.textColor ?? '#ffffff'} opacity={1} onColor={(textColor) => update({ textColor })} onOpacity={() => undefined} />
            <Select label="字号" value={drawing.fontSize ?? 12} options={FONT_SIZES.map((size) => ({ id: size, label: String(size) }))} onChange={(fontSize) => update({ fontSize })} width={92} />
          </div>
          <div className="tvd-span"><CheckRow label="价格标签" checked={drawing.priceLabels ?? true} onChange={(priceLabels) => update({ priceLabels })} /></div>
          <div className="tvd-span tvd-section-title">信息</div>
          <span className="tvd-label">统计数据</span>
          <CheckSelect
            summary={position.stats.length ? POSITION_STAT_OPTIONS.filter((item) => position.stats.includes(item.id)).map((item) => item.label).join(', ') : '隐藏'}
            label="统计数据"
            items={POSITION_STAT_OPTIONS.map((item) => ({ id: item.id, label: item.label, checked: position.stats.includes(item.id), onChange: (checked: boolean) => updatePosition({ stats: checked ? [...position.stats, item.id] : position.stats.filter((id) => id !== item.id) }) }))}
          />
          <div className="tvd-span"><CheckRow label="精简统计模式" checked={position.compactStats} onChange={(compactStats) => updatePosition({ compactStats })} /></div>
          <div className="tvd-span"><CheckRow label="始终显示统计信息" checked={position.alwaysShowStats} onChange={(alwaysShowStats) => updatePosition({ alwaysShowStats })} /></div>
        </div>}

        {tab === 'style' && kind !== 'position' && <div className="tvd-grid">
          {kind === 'channel' && <div className="tvd-span tvd-levels">
            {channelLevelsFor(drawing).map((level, index, levels) => {
              const fixed = level.value === 0 || level.value === 1
              const setLevel = (patch: Partial<typeof level>) => update({ channelLevels: levels.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) })
              return <div className={`tvd-level-row${level.enabled || fixed ? '' : ' disabled'}`} key={index}>
                {fixed ? <span className="tvd-level-spacer" /> : <Checkbox checked={level.enabled} label={`启用 ${level.value}`} onChange={(enabled) => setLevel({ enabled })} />}
                <input className="tvd-number" inputMode="decimal" value={level.value} aria-label="水平位" disabled={fixed} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) setLevel({ value }) }} />
                <ColorButton label="水平位颜色" color={level.color} opacity={1} onColor={(color) => setLevel({ color })} onOpacity={() => undefined} lineStyle={level.lineStyle} width={drawing.width} onLineStyle={(lineStyle) => setLevel({ lineStyle })} onWidth={(width) => update({ width })} />
              </div>
            })}
          </div>}
          {(kind === 'fiblevels' || kind === 'pitchfork') && <>
            {kind === 'pitchfork' && <>
              <div className="tvd-span"><CheckRow label="延长线" checked={Boolean(drawing.extendRight)} onChange={(extendRight) => update({ extendRight })} /></div>
              {lineRow('中线')}
            </>}
            <div className="tvd-span tvd-levels tvd-levels-grid">
              {fibLevelsFor(drawing).map((level, index, levels) => {
                const setLevel = (patch: Partial<typeof level>) => update({ fibLevels: levels.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) })
                return <div className={`tvd-level-row${level.enabled ? '' : ' disabled'}`} key={index}>
                  <Checkbox checked={level.enabled} label={`启用 ${level.value}`} onChange={(enabled) => setLevel({ enabled })} />
                  <input className="tvd-number" inputMode="decimal" value={level.value} aria-label="水平位" onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) setLevel({ value }) }} />
                  <ColorButton label="水平位颜色" color={drawing.useOneColor ? drawing.color : level.color} opacity={1} onColor={(color) => setLevel({ color })} onOpacity={() => undefined} />
                </div>
              })}
            </div>
            <div className="tvd-span"><CheckRow label="使用一种颜色" checked={Boolean(drawing.useOneColor)} onChange={(useOneColor) => update({ useOneColor })} /></div>
            {fillRow()}
            {kind === 'pitchfork' && <>
              <span className="tvd-label">样式</span>
              <Select label="分叉线样式" value={drawing.pitchforkStyle ?? 'original'} options={[{ id: 'original', label: '原始' }, { id: 'schiff', label: '希夫' }, { id: 'modified-schiff', label: '改良希夫' }, { id: 'inside', label: '内部' }]} onChange={(pitchforkStyle) => update({ pitchforkStyle })} />
            </>}
          </>}
          {kind === 'cycle' && (drawing.tool === 'time-cycles' ? <>{lineRow()}{fillRow()}</> : lineRow('线条'))}
          {kind === 'gannbox' && <>
            {groupGrid('gann-price', '价格位')}
            {optionCheck('labelsLeft', '左标签', true)}
            {optionCheck('labelsRight', '右标签', true)}
            <CheckRow label="背景" checked={option('priceBackground', true)} onChange={(value) => setOption('priceBackground', value)} /><div />
            {groupGrid('gann-time', '时间水平')}
            {optionCheck('labelsTop', '顶标签', true)}
            {optionCheck('labelsBottom', '底标签', true)}
            <CheckRow label="背景" checked={option('timeBackground', true)} onChange={(value) => setOption('timeBackground', value)} /><div />
            {oneColorRow}
            {optionCheck('angles', '角度', false)}
            {optionCheck('reverse', '反手', false)}
          </>}
          {kind === 'gannsquare' && <>
            {groupGrid('square-levels', '水平位')}
            {groupGrid('square-fans', '扇形')}
            {groupGrid('square-arcs', '弧形')}
            {oneColorRow}
            {fillRow()}
            {optionCheck('reverse', '反手', false)}
          </>}
          {kind === 'gannfan' && <>
            {groupGrid('gann-fan')}
            {oneColorRow}
            {fillRow()}
            {optionCheck('labels', '标签', true)}
          </>}
          {kind === 'pitchfan' && <>{lineRow('中线')}{fibGrid()}{oneColorRow}{fillRow()}</>}
          {kind === 'spiral' && <>{lineRow()}{optionCheck('counterclockwise', '逆时针方向', false)}</>}
          {(kind === 'arcs' || kind === 'wedge') && <>
            <CheckRow label="趋势线" checked={option('trendLine', true)} onChange={(value) => setOption('trendLine', value)} />
            <div><ColorButton label="趋势线颜色" color={drawing.color} opacity={drawing.opacity ?? 1} onColor={(color) => update({ color })} onOpacity={(opacity) => update({ opacity })} width={drawing.width} onWidth={(width) => update({ width })} lineStyle={drawing.lineStyle ?? 'solid'} onLineStyle={(lineStyle) => update({ lineStyle })} /></div>
            {fibGrid()}
            {oneColorRow}
            {fillRow()}
            {optionCheck('levelLabels', kind === 'arcs' ? '水平位' : '水平', true)}
            {kind === 'arcs' && optionCheck('fullCircles', '完整圆圈', false)}
          </>}
          {kind === 'barspattern' && <>
            <span className="tvd-label">颜色</span>
            <div><ColorButton label="颜色" color={drawing.color} opacity={drawing.opacity ?? 1} onColor={(color) => update({ color })} onOpacity={(opacity) => update({ opacity })} /></div>
            <span className="tvd-label">模式</span>
            <Select label="模式" value={option('mode', 'hl-bars')} options={[{ id: 'hl-bars', label: 'HL Bars' }, { id: 'oc-bars', label: 'OC Bars' }, { id: 'line-open', label: 'Line - Open' }, { id: 'line-high', label: 'Line - High' }, { id: 'line-low', label: 'Line - Low' }, { id: 'line-close', label: 'Line - Close' }, { id: 'line-hl2', label: 'Line - HL/2' }]} onChange={(value) => setOption('mode', value)} />
            {optionCheck('mirror', '镜像', false)}
            {optionCheck('flip', '翻转', false)}
          </>}
          {(kind === 'sector' || kind === 'arc') && <>{kind === 'sector' ? <>{fillRow()}{borderRow(true)}</> : <>{borderRow(true)}{fillRow()}</>}</>}
          {kind === 'circle' && <>{borderRow(true)}{fillRow()}</>}
          {kind === 'curve' && <>{lineRow()}{extendRow}{fillRow()}</>}
          {(kind === 'path' || kind === 'brush') && <>{lineRow()}{kind === 'brush' && fillRow()}</>}
          {kind === 'arrowmark' && <>
            <span className="tvd-label">{drawing.tool === 'arrow-marker' ? '颜色' : '箭头'}</span>
            <div><ColorButton label="箭头颜色" color={drawing.color} opacity={drawing.opacity ?? 1} onColor={(color) => update({ color })} onOpacity={(opacity) => update({ opacity })} /></div>
          </>}
          {kind === 'note' && <>
            <span className="tvd-label">标签背景</span>
            <div><ColorButton label="标签背景" color={drawing.fillColor ?? drawing.color} opacity={drawing.fillOpacity ?? 1} onColor={(fillColor) => update({ fillColor })} onOpacity={(fillOpacity) => update({ fillOpacity })} /></div>
            <span className="tvd-label">标签边框</span>
            <div><ColorButton label="标签边框" color={drawing.borderColor ?? drawing.color} opacity={1} onColor={(borderColor) => update({ borderColor })} /></div>
            <span className="tvd-label">线条颜色</span>
            <div><ColorButton label="线条颜色" color={drawing.color} opacity={drawing.opacity ?? 1} onColor={(color) => update({ color })} onOpacity={(opacity) => update({ opacity })} /></div>
          </>}
          {kind === 'vwap' && <>
            {[['vwap', '成交量加权平均价（VWAP）', '#2962ff'], ['lower1', '下带', '#089981'], ['upper1', '上带', '#089981'], ['bg1', '背景#1', '#089981'], ['lower2', '下带#2', '#9c27b0'], ['upper2', '上带#2', '#9c27b0'], ['lower3', '下带#3', '#2962ff'], ['upper3', '上带#3', '#2962ff']].map(([key, label, color]) => <div className="tvd-span tvd-color-row" key={key}>
              <CheckRow label={label} checked={option(`${key}On`, key === 'vwap' || key.endsWith('1'))} onChange={(value) => setOption(`${key}On`, value)} />
              <ColorButton label={label} color={option(`${key}Color`, key === 'vwap' ? drawing.color : color)} opacity={1} onColor={(value) => key === 'vwap' ? update({ color: value }) : setOption(`${key}Color`, value)} />
            </div>)}
            {optionCheck('priceLabel', '价格标签', true)}
          </>}
          {kind === 'volumeprofile' && <>
            {optionCheck('vpVisible', '成交量分布图(VP)', true)}
            {optionCheck('vpValues', '数值', false)}
            <span className="tvd-label">宽度(Box的%)</span>
            <input className="tvd-number" inputMode="numeric" value={option('vpWidth', 30)} aria-label="宽度" onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) setOption('vpWidth', Math.max(1, Math.min(100, value))) }} />
            <span className="tvd-label">位置</span>
            <Select label="位置" value={option('vpPlacement', 'left')} options={[{ id: 'left', label: '左' }, { id: 'right', label: '右' }]} onChange={(value) => setOption('vpPlacement', value)} />
            {[['upVolume', '上涨成交量', '#1e88e5'], ['downVolume', '下跌成交量', '#fbc02d'], ['upValueArea', '上涨数值区', '#64b5f6'], ['downValueArea', '下跌数值区', '#fff176'], ['vah', 'VAH', '#2962ff'], ['val', 'VAL', '#2962ff'], ['poc', 'POC', '#f23645'], ['developingPoc', '发展POC', '#f23645'], ['developingVa', '发展数值区(VA)', '#2962ff'], ['boxBackground', '直方图框底色', '#2962ff']].map(([key, label, color]) => <div className="tvd-span tvd-color-row" key={key}>
              <CheckRow label={label} checked={option(`${key}On`, !key.startsWith('developing'))} onChange={(value) => setOption(`${key}On`, value)} />
              <ColorButton label={label} color={option(`${key}Color`, color)} opacity={1} onColor={(value) => setOption(`${key}Color`, value)} />
            </div>)}
          </>}
          {kind === 'forecast' && <>
            {lineRow()}
            {FORECAST_COLOR_ROWS.map((row) => <div className="tvd-span tvd-color-row" key={row.key}>
              <span className="tvd-label">{row.label}</span>
              <ColorButton label={row.label} color={forecastColor(drawing, row.key)} opacity={1} onColor={(value) => update({ forecastColors: { ...(drawing.forecastColors ?? {}), [row.key]: value } })} onOpacity={() => undefined} />
            </div>)}
          </>}
          {kind === 'label' && <>
            <span className="tvd-label">文本</span>
            <div className="tvd-inline">
              <ColorButton label="文字颜色" color={drawing.textColor ?? '#ffffff'} opacity={1} onColor={(textColor) => update({ textColor })} onOpacity={() => undefined} />
              <Select label="字号" value={drawing.fontSize ?? 14} options={FONT_SIZES.map((size) => ({ id: size, label: String(size) }))} onChange={(fontSize) => update({ fontSize })} width={92} />
            </div>
            {fillRow()}
            {borderRow(true)}
          </>}
          {(kind === 'line' || kind === 'hline' || kind === 'vline' || kind === 'cross' || kind === 'range' || kind === 'generic') && lineRow()}
          {(kind === 'line' || kind === 'channel' || (kind === 'shape' && drawing.behavior === 'rectangle')) && extendRow}
          {kind === 'shape' && borderRow(false)}
          {kind === 'pattern' && <><span className="tvd-label">标签</span>{textStyleControls(true)}{borderRow(false)}</>}
          {kind === 'shape' && drawing.behavior === 'rectangle' && <>
            <CheckRow label="中线" checked={Boolean(drawing.middleLine)} onChange={(middleLine) => update({ middleLine })} />
            <div />
          </>}
          {(kind === 'shape' || kind === 'channel' || kind === 'pattern' || kind === 'range' || kind === 'generic') && fillRow()}
          {kind === 'range' && extendRow}
          {kind === 'vline' && <div className="tvd-span"><CheckRow label="延伸" checked={drawing.extendRight ?? true} onChange={(extendRight) => update({ extendRight })} /></div>}
          {(kind === 'hline' || kind === 'cross') && <div className="tvd-span"><CheckRow label="价格标签" checked={drawing.priceLabels ?? true} onChange={(priceLabels) => update({ priceLabels })} /></div>}
          {(kind === 'vline' || kind === 'cross') && <div className="tvd-span"><CheckRow label="时间标签" checked={drawing.timeLabel ?? true} onChange={(timeLabel) => update({ timeLabel })} /></div>}
          {kind === 'line' && <>
            <div className="tvd-span"><CheckRow label="中点" checked={Boolean(drawing.middlePoint)} onChange={(middlePoint) => update({ middlePoint })} /></div>
            <div className="tvd-span"><CheckRow label="价格标签" checked={Boolean(drawing.priceLabels)} onChange={(priceLabels) => update({ priceLabels })} /></div>
          </>}
          {(kind === 'line' || kind === 'range') && <>
            <div className="tvd-span tvd-section-title">信息</div>
            <span className="tvd-label">统计数据</span>
            <CheckSelect summary={statsSummary} label="统计数据" items={(drawing.tool === 'date-range' ? DATE_RANGE_STAT_OPTIONS : STAT_OPTIONS).map((item) => ({ id: item.id, label: item.label, checked: stats.includes(item.id), onChange: (checked: boolean) => toggleStat(item.id, checked) }))} />
          </>}
          {kind === 'range' && <>
            <span className="tvd-label">标签</span>
            <div className="tvd-inline">
              <ColorButton label="标签颜色" color={drawing.textColor ?? '#ffffff'} opacity={1} onColor={(textColor) => update({ textColor })} onOpacity={() => undefined} />
              <Select label="字号" value={drawing.fontSize ?? 12} options={FONT_SIZES.map((size) => ({ id: size, label: String(size) }))} onChange={(fontSize) => update({ fontSize })} width={92} />
            </div>
            <CheckRow label="标签背景" checked={drawing.labelBackground ?? true} onChange={(labelBackground) => update({ labelBackground })} />
            <div><ColorButton label="标签背景颜色" color={drawing.labelBackgroundColor ?? '#1e222d'} opacity={1} onColor={(labelBackgroundColor) => update({ labelBackgroundColor })} onOpacity={() => undefined} /></div>
          </>}
          {kind === 'line' && <>
            <span className="tvd-label">统计位置</span>
            <Select label="统计位置" value={drawing.statsPosition ?? 'right'} options={STATS_POSITION_OPTIONS} onChange={(statsPosition) => update({ statsPosition })} />
            <div className="tvd-span"><CheckRow label="始终显示统计信息" checked={Boolean(drawing.alwaysShowStats)} onChange={(alwaysShowStats) => update({ alwaysShowStats })} /></div>
          </>}
        </div>}

        {tab === 'text' && (kind === 'range' || kind === 'circle') && <div className="tvd-text-tab">
          <div className="tvd-inline"><Select label="字号" value={drawing.fontSize ?? 12} options={FONT_SIZES.map((size) => ({ id: size, label: String(size) }))} onChange={(fontSize) => update({ fontSize })} width={92} /></div>
        </div>}

        {tab === 'text' && kind !== 'range' && kind !== 'circle' && <div className="tvd-text-tab">
          {textStyleControls()}
          <textarea className="tvd-textarea" placeholder="添加文字" value={drawing.text ?? ''} aria-label="文字" onChange={(event) => update({ text: event.target.value })} />
          {kind === 'textbox' ? <div className="tvd-grid">
            {fillRow()}
            {borderRow(true)}
            <div className="tvd-span"><CheckRow label="文本换行" checked={Boolean(drawing.wrapText)} onChange={(wrapText) => update({ wrapText })} /></div>
          </div> : <>
            <div className="tvd-inline">
              <span className="tvd-label">文字对齐</span>
              <Select label="垂直对齐" value={drawing.textVAlign ?? defaults.vAlign} options={vAlignOptions} onChange={(textVAlign) => update({ textVAlign })} width={100} />
              <Select label="水平对齐" value={drawing.textHAlign ?? defaults.hAlign} options={[{ id: 'left', label: '左' }, { id: 'center', label: '中心' }, { id: 'right', label: '右' }]} onChange={(textHAlign) => update({ textHAlign })} width={100} />
            </div>
            {kind === 'vline' && <div className="tvd-inline">
              <span className="tvd-label">文字方向</span>
              <Select label="文字方向" value={drawing.textOrientation ?? 'vertical'} options={[{ id: 'vertical', label: '竖式' }, { id: 'horizontal', label: '横式' }]} onChange={(textOrientation) => update({ textOrientation })} width={100} />
            </div>}
          </>}
        </div>}

        {tab === 'coordinates' && <div className="tvd-grid tvd-coordinates">
          {coordinatePoints.map((point, index) => <CoordinateRow
            key={index} index={index} mode={coordinateMode} price={point.price} bar={nearestIndex(candles, point.time)} symbol={symbol}
            onChange={(patch) => updatePoint(index, patch)}
          />)}
        </div>}

        {tab === 'visibility' && <div className="tvd-visibility">
          {kind === 'line' && <CheckRow label="ticks" checked={visibility.ticks} onChange={(ticks) => updateVisibility({ ticks })} />}
          {VISIBILITY_ROWS.map((row) => {
            const range = visibility[row.key]
            const set = (patch: Partial<typeof range>) => updateVisibility({ [row.key]: { ...range, ...patch } } as Partial<DrawingVisibility>)
            return <div className="tvd-visibility-row" key={row.key}>
              <CheckRow label={row.label} checked={range.enabled} onChange={(enabled) => set({ enabled })} />
              <input className="tvd-number" type="number" min={1} max={row.max} value={range.min} disabled={!range.enabled} aria-label={`${row.label}最小值`} onChange={(event) => set({ min: Math.max(1, Math.min(range.max, Number(event.target.value) || 1)) })} />
              <RangeSlider min={1} max={row.max} low={range.min} high={range.max} disabled={!range.enabled} onChange={(min, max) => set({ min, max })} />
              <input className="tvd-number" type="number" min={1} max={row.max} value={range.max} disabled={!range.enabled} aria-label={`${row.label}最大值`} onChange={(event) => set({ max: Math.max(range.min, Math.min(row.max, Number(event.target.value) || row.max)) })} />
            </div>
          })}
          <CheckRow label="Ranges" checked={visibility.ranges} onChange={(ranges) => updateVisibility({ ranges })} />
        </div>}
      </div>
      <footer className="tvd-footer">
        <div className="tvd-popover-anchor" ref={templateRef}>
          <button type="button" className={`tvd-select tvd-template${templateOpen ? ' open' : ''}`} aria-expanded={templateOpen} onClick={() => setTemplateOpen(!templateOpen)}><span>模板</span><ChevronDown size={16} /></button>
          {templateOpen && <div className="tvd-popover tvd-popover-up"><div className="tvd-menu">
            <button type="button" onClick={() => { onSaveTemplate(drawing); setTemplateOpen(false) }}>保存为...</button>
            <button type="button" onClick={() => { onApplyDefaults(); setTemplateOpen(false) }}>应用默认</button>
          </div></div>}
        </div>
        <div className="tvd-footer-actions">
          <button type="button" className="tvd-button" onClick={() => onCancel(original)}>取消</button>
          <button type="button" className="tvd-button primary" onClick={onConfirm}>确认</button>
        </div>
      </footer>
    </section>
  </div>
}

const TICK_SIZE: Partial<Record<SymbolId, number>> = { 'BTCUSDT.P': 0.1 }

/** 输入 tab of the long / short position dialog. */
function PositionInputs({ drawing, symbol, settings, onSettings, onPoints }: {
  drawing: Drawing
  symbol: SymbolId
  settings: PositionSettings
  onSettings: (patch: Partial<PositionSettings>) => void
  onPoints: (points: Drawing['points']) => void
}) {
  const tick = TICK_SIZE[symbol] ?? 0.01
  const entry = drawing.points[0]?.price ?? 0
  const target = drawing.points[2]?.price ?? entry
  const stop = drawing.points[3]?.price ?? entry
  const setPrice = (index: number[], price: number) => {
    if (!Number.isFinite(price) || drawing.points.length < 4) return
    onPoints(drawing.points.map((point, pointIndex) => index.includes(pointIndex) ? { ...point, price } : point))
  }
  const round = (value: number) => Number(value.toFixed(6))
  return <div className="tvd-grid">
    <span className="tvd-label">账户规模</span>
    <div className="tvd-inline"><NumberField value={settings.accountSize} label="账户规模" onChange={(accountSize) => onSettings({ accountSize })} /><span className="tvd-static-select">系统预设</span></div>
    <span className="tvd-label">手数</span>
    <NumberField value={settings.lotSize} label="手数" onChange={(lotSize) => onSettings({ lotSize: Math.max(lotSize, 1e-9) })} />
    <span className="tvd-label">风险</span>
    <div className="tvd-inline"><NumberField value={settings.risk} label="风险" onChange={(risk) => onSettings({ risk })} /><Select label="风险单位" value={settings.riskUnit} options={[{ id: 'percent', label: '%' }, { id: 'currency', label: '货币' }]} onChange={(riskUnit) => onSettings({ riskUnit })} width={100} /></div>
    <span className="tvd-label">进场价格</span>
    <NumberField value={round(entry)} label="进场价格" onChange={(price) => setPrice([0, 1], price)} />
    <span className="tvd-label">杠杆</span>
    <NumberField value={settings.leverage} label="杠杆" onChange={(leverage) => onSettings({ leverage })} />
    <div className="tvd-span tvd-section-title">止盈水平</div>
    <span className="tvd-label">Ticks</span>
    <NumberField value={Math.round(Math.abs(target - entry) / tick)} label="止盈 Ticks" onChange={(ticks) => setPrice([2], entry + Math.sign(target - entry || (drawing.behavior === 'short-position' ? -1 : 1)) * ticks * tick)} />
    <span className="tvd-label">价格</span>
    <NumberField value={round(target)} label="止盈价格" onChange={(price) => setPrice([2], price)} />
    <div className="tvd-span tvd-section-title">止损水平</div>
    <span className="tvd-label">Ticks</span>
    <NumberField value={Math.round(Math.abs(stop - entry) / tick)} label="止损 Ticks" onChange={(ticks) => setPrice([3], entry + Math.sign(stop - entry || (drawing.behavior === 'short-position' ? 1 : -1)) * ticks * tick)} />
    <span className="tvd-label">价格</span>
    <NumberField value={round(stop)} label="止损价格" onChange={(price) => setPrice([3], price)} />
    <span className="tvd-label">QTY精度</span>
    <Select label="QTY精度" value={String(settings.qtyPrecision)} options={[{ id: 'default', label: '默认' }, ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((digits) => ({ id: String(digits), label: String(digits) }))]} onChange={(value) => onSettings({ qtyPrecision: value === 'default' ? 'default' : Number(value) as PositionSettings['qtyPrecision'] })} width={130} />
  </div>
}

function NumberField({ value, label, onChange }: { value: number; label: string; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  const [focused, setFocused] = useState(false)
  return <input
    className="tvd-number wide" inputMode="decimal" aria-label={label} value={focused ? draft : String(value)}
    onFocus={() => { setDraft(String(value)); setFocused(true) }} onBlur={() => setFocused(false)}
    onChange={(event) => { setDraft(event.target.value); const next = Number(event.target.value); if (event.target.value.trim() && Number.isFinite(next)) onChange(next) }}
  />
}

function CoordinateRow({ index, mode, price, bar, symbol, onChange }: { index: number; mode: 'price' | 'bar' | 'both'; price?: number; bar: number; symbol: SymbolId; onChange: (patch: { price?: number; bar?: number }) => void }) {
  const [priceDraft, setPriceDraft] = useState(price !== undefined ? formatPrice(price, symbol).replace(/,/g, '') : '')
  const [barDraft, setBarDraft] = useState(String(bar))
  const label = mode === 'price' ? `#${index + 1}(价格)` : mode === 'bar' ? `#${index + 1} (K线)` : `#${index + 1}（价格，K线）`
  return <>
    <span className="tvd-label">{label}</span>
    <div className="tvd-inline">
      {mode !== 'bar' && <input className="tvd-number wide" inputMode="decimal" value={priceDraft} aria-label={`#${index + 1} 价格`} onChange={(event) => { setPriceDraft(event.target.value); const value = Number(event.target.value); if (Number.isFinite(value) && event.target.value.trim()) onChange({ price: value }) }} />}
      {mode !== 'price' && <input className="tvd-number" inputMode="numeric" value={barDraft} aria-label={`#${index + 1} K线`} onChange={(event) => { setBarDraft(event.target.value); const value = Number(event.target.value); if (Number.isFinite(value) && event.target.value.trim()) onChange({ bar: value }) }} />}
    </div>
  </>
}

function RangeSlider({ min, max, low, high, disabled, onChange }: { min: number; max: number; low: number; high: number; disabled?: boolean; onChange: (low: number, high: number) => void }) {
  const percent = (value: number) => ((value - min) / Math.max(1, max - min)) * 100
  return <div className={`tvd-range${disabled ? ' disabled' : ''}`}>
    <div className="tvd-range-track"><div className="tvd-range-fill" style={{ left: `${percent(low)}%`, right: `${100 - percent(high)}%` }} /></div>
    <input type="range" min={min} max={max} value={low} disabled={disabled} aria-label="最小值" onChange={(event) => onChange(Math.min(Number(event.target.value), high), high)} />
    <input type="range" min={min} max={max} value={high} disabled={disabled} aria-label="最大值" onChange={(event) => onChange(low, Math.max(Number(event.target.value), low))} />
  </div>
}

interface ToolbarProps {
  drawing: Drawing
  syncDrawings: boolean
  onUpdate: (patch: Partial<Drawing>, checkpoint?: boolean) => void
  onOpenSettings: (tab?: LineSettingsTab) => void
  onAddAlert: () => void
  onToggleLock: () => void
  onDelete: () => void
  onClone: () => void
  onCopy: () => void
  onReorder: (to: 'front' | 'back' | 'forward' | 'backward') => void
  onHide: () => void
  onSyncChange: (value: boolean) => void
  onSaveTemplate: () => void
  onApplyDefaults: () => void
}

type ToolbarMenu = 'templates' | 'color' | 'text-color' | 'width' | 'style' | 'more' | null

/** Floating toolbar shown for the selected drawing (TradingView style). */
export function DrawingFloatingToolbar({
  drawing, syncDrawings, onUpdate, onOpenSettings, onAddAlert, onToggleLock, onDelete, onClone, onCopy, onReorder, onHide, onSyncChange, onSaveTemplate, onApplyDefaults,
}: ToolbarProps) {
  const [menu, setMenu] = useState<ToolbarMenu>(null)
  const [submenu, setSubmenu] = useState<'order' | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(menu !== null, ref, () => { setMenu(null); setSubmenu(null) })
  const toggle = (next: Exclude<ToolbarMenu, null>) => { setMenu((current) => current === next ? null : next); setSubmenu(null) }
  const width = Math.max(1, Math.min(4, Math.round(drawing.width)))
  const lineStyle = drawing.lineStyle ?? 'solid'
  const textColor = drawing.textColor ?? drawing.color
  const close = () => { setMenu(null); setSubmenu(null) }
  const textOnly = settingsKindFor(drawing.behavior, drawing.tool) === 'textbox'

  return <div className="tvd-floating-toolbar" ref={ref} data-testid="drawing-properties" role="toolbar" aria-label={`${drawing.label}工具栏`} onPointerDown={(event) => event.stopPropagation()}>
    <span className="tvd-ft-grip" aria-hidden="true">⠿</span>
    <div className="tvd-ft-item">
      <button type="button" className={menu === 'templates' ? 'open' : ''} aria-label="模板" title="模板" onClick={() => toggle('templates')}>
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="13" y="3" width="6" height="6" rx="1" /><rect x="3" y="13" width="6" height="6" rx="1" /><path d="M16 13v6M13 16h6" /></svg>
      </button>
      {menu === 'templates' && <div className="tvd-popover"><div className="tvd-menu">
        <button type="button" onClick={() => { onSaveTemplate(); close() }}>保存为...</button>
        <button type="button" onClick={() => { onApplyDefaults(); close() }}>应用默认</button>
      </div></div>}
    </div>
    {!textOnly && <><div className="tvd-ft-item">
      <button type="button" className={`tvd-ft-color${menu === 'color' ? ' open' : ''}`} aria-label="线条工具颜色" title="线条工具颜色" onClick={() => toggle('color')}>
        <Pencil size={18} /><span style={{ background: drawing.color }} />
      </button>
      {menu === 'color' && <div className="tvd-popover"><ColorPalettePanel color={drawing.color} opacity={drawing.opacity ?? 1} onColor={(color) => onUpdate({ color }, true)} onOpacity={(opacity) => onUpdate({ opacity })} /></div>}
    </div></>}
    <div className="tvd-ft-item">
      <button type="button" className={`tvd-ft-color${menu === 'text-color' ? ' open' : ''}`} aria-label="文字颜色" title="文字颜色" onClick={() => toggle('text-color')}>
        <span className="tvd-ft-t">T</span><span style={{ background: textColor }} />
      </button>
      {menu === 'text-color' && <div className="tvd-popover"><ColorPalettePanel color={textColor} opacity={1} onColor={(color) => onUpdate({ textColor: color }, true)} onOpacity={() => undefined} /></div>}
    </div>
    {textOnly && <div className="tvd-ft-item">
      <button type="button" className={menu === 'width' ? 'open' : ''} aria-label="字号" title="字号" onClick={() => toggle('width')}><span>{drawing.fontSize ?? 14}</span></button>
      {menu === 'width' && <div className="tvd-popover"><div className="tvd-menu">
        {FONT_SIZES.map((size) => <button type="button" key={size} className={size === (drawing.fontSize ?? 14) ? 'selected' : ''} onClick={() => { onUpdate({ fontSize: size }, true); close() }}>{size}</button>)}
      </div></div>}
    </div>}
    {!textOnly && <><div className="tvd-ft-item">
      <button type="button" className={`tvd-ft-width${menu === 'width' ? ' open' : ''}`} aria-label="线条工具宽度" title="线条工具宽度" onClick={() => toggle('width')}>
        <span className="tvd-ft-line" style={{ height: width }} /><span>{width}px</span>
      </button>
      {menu === 'width' && <div className="tvd-popover"><div className="tvd-menu">
        {WIDTHS.map((item) => <button type="button" key={item} className={item === width ? 'selected' : ''} onClick={() => { onUpdate({ width: item }, true); close() }}><span className="tvd-ft-line" style={{ height: item }} /><span>{item}px</span></button>)}
      </div></div>}
    </div>
    <div className="tvd-ft-item">
      <button type="button" className={menu === 'style' ? 'open' : ''} aria-label="样式" title="样式" onClick={() => toggle('style')}><LinePreview width={1.5} style={lineStyle} /></button>
      {menu === 'style' && <div className="tvd-popover"><div className="tvd-menu">
        {LINE_STYLES.map((item) => <button type="button" key={item.id} className={item.id === lineStyle ? 'selected' : ''} onClick={() => { onUpdate({ lineStyle: item.id }, true); close() }}><LinePreview width={1.5} style={item.id} /><span>{item.label}</span></button>)}
      </div></div>}
    </div></>}
    <div className="tvd-ft-item"><button type="button" aria-label="设置" title="设置" onClick={() => { close(); onOpenSettings() }}><Settings size={19} strokeWidth={1.4} /></button></div>
    <div className="tvd-ft-item"><button type="button" aria-label="添加警报" title="添加警报" onClick={() => { close(); onAddAlert() }}><AlarmClockPlus size={19} strokeWidth={1.4} /></button></div>
    <div className="tvd-ft-item"><button type="button" className={drawing.locked ? 'active' : ''} aria-label={drawing.locked ? '解锁' : '锁定'} title={drawing.locked ? '解锁' : '锁定'} onClick={() => { close(); onToggleLock() }}>{drawing.locked ? <LockKeyhole size={19} strokeWidth={1.4} /> : <UnlockKeyhole size={19} strokeWidth={1.4} />}</button></div>
    <div className="tvd-ft-item"><button type="button" aria-label="移除" title="移除" onClick={() => { close(); onDelete() }}><Trash2 size={19} strokeWidth={1.4} /></button></div>
    <div className="tvd-ft-item">
      <button type="button" className={menu === 'more' ? 'open' : ''} aria-label="更多" title="更多" onClick={() => toggle('more')}><MoreHorizontal size={19} strokeWidth={1.4} /></button>
      {menu === 'more' && <div className="tvd-popover tvd-popover-right"><div className="tvd-menu tvd-more-menu">
        <div className="tvd-submenu-anchor" onPointerEnter={() => setSubmenu('order')} onPointerLeave={() => setSubmenu(null)}>
          <button type="button" onClick={() => setSubmenu(submenu === 'order' ? null : 'order')}><Layers size={17} strokeWidth={1.4} /><span>视觉顺序</span><ChevronRight size={15} className="tvd-menu-chevron" /></button>
          {submenu === 'order' && <div className="tvd-submenu"><div className="tvd-menu">
            <button type="button" onClick={() => { onReorder('front'); close() }}>置于顶层</button>
            <button type="button" onClick={() => { onReorder('forward'); close() }}>上移一层</button>
            <button type="button" onClick={() => { onReorder('backward'); close() }}>下移一层</button>
            <button type="button" onClick={() => { onReorder('back'); close() }}>置于底层</button>
          </div></div>}
        </div>
        <button type="button" onClick={() => { close(); onOpenSettings('visibility') }}><span className="tvd-menu-icon-space" /><span>时间周期可见性</span><ChevronRight size={15} className="tvd-menu-chevron" /></button>
        <div className="tvd-menu-separator" />
        <button type="button" onClick={() => { onClone(); close() }}><CopyPlus size={17} strokeWidth={1.4} /><span>克隆</span><kbd>Ctrl + Drag</kbd></button>
        <button type="button" onClick={() => { onCopy(); close() }}><Copy size={17} strokeWidth={1.4} /><span>复制</span><kbd>Ctrl + C</kbd></button>
        <div className="tvd-menu-separator" />
        <button type="button" onClick={() => { onSyncChange(false); close() }}><span className="tvd-menu-icon-space">{!syncDrawings && <Check size={16} />}</span><span>没有同步</span></button>
        <button type="button" onClick={() => { onSyncChange(true); close() }}><span className="tvd-menu-icon-space">{syncDrawings && <Check size={16} />}</span><span>同步到所有图表</span></button>
        <div className="tvd-menu-separator" />
        <button type="button" onClick={() => { onHide(); close() }}><EyeOff size={17} strokeWidth={1.4} /><span>隐藏</span></button>
      </div></div>}
    </div>
  </div>
}
