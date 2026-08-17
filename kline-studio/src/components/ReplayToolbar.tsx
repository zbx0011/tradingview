import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight,
  Gauge, Pause, Play, RadioTower, Scissors, Shuffle, SkipBack, SkipForward, X,
} from 'lucide-react'
import type { IntervalId } from '../lib/market'
import { INTERVALS } from '../lib/market'
import { replayResolutions, REPLAY_SPEEDS } from '../lib/replay'

export type ReplayStartMode = 'bar' | 'date' | 'first' | 'random'

interface ReplayToolbarProps {
  active: boolean
  selecting: boolean
  playing: boolean
  startMode: ReplayStartMode
  speed: number
  interval: IntervalId
  resolutionSeconds: number
  autoResolution: boolean
  atEnd: boolean
  firstTime: number
  lastTime: number
  cursorTime: number | null
  onSelectBar: () => void
  onSelectDate: (time: number) => void
  onFirstAvailable: () => void
  onRandomBar: () => void
  onPlayPause: () => void
  onStepBack: () => void
  onStep: () => void
  onSpeed: (speed: number) => void
  onResolution: (seconds: number, automatic: boolean) => void
  onRealtime: () => void
  onClose: () => void
}

const startModeLabel: Record<ReplayStartMode, string> = {
  bar: '选择K线',
  date: '选择日期',
  first: '最早日期',
  random: '随机K线',
}

export function ReplayToolbar(props: ReplayToolbarProps) {
  const [menu, setMenu] = useState<'start' | 'speed' | 'resolution' | null>(null)
  const [dateOpen, setDateOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const options = replayResolutions(props.interval)
  const speed = REPLAY_SPEEDS.find((item) => item.value === props.speed) ?? REPLAY_SPEEDS[0]
  const selectedResolution = options.find((item) => item.seconds === props.resolutionSeconds)
  const resolutionLabel = props.autoResolution ? INTERVALS[props.interval].label : (selectedResolution?.shortLabel ?? INTERVALS[props.interval].label)

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenu(null)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenu(null)
        setDateOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  return <>
    <div className="replay-toolbar" ref={rootRef} data-testid="replay-toolbar" data-cursor-time={props.cursorTime ?? ''}>
      <div className="replay-controls">
        <div className="replay-control-wrap replay-start-wrap">
          <button type="button" className={`replay-start-button ${props.selecting ? 'active' : ''}`} title="选择回放起点" onClick={() => { props.onSelectBar(); setMenu(null) }}>
            <CalendarDays size={22} /><span>{startModeLabel[props.startMode]}</span>
          </button>
          <button type="button" className="replay-chevron" aria-label="选择回放起点方式" aria-expanded={menu === 'start'} onClick={() => setMenu((value) => value === 'start' ? null : 'start')}><ChevronDown size={15} /></button>
          {menu === 'start' && <div className="replay-popover replay-start-menu" role="menu">
            <header>选择起点</header>
            <button className={props.startMode === 'bar' ? 'active' : ''} onClick={() => { props.onSelectBar(); setMenu(null) }}><Scissors size={18} /><span>K线</span>{props.startMode === 'bar' && <Check size={15} />}</button>
            <button className={props.startMode === 'date' ? 'active' : ''} onClick={() => { setDateOpen(true); setMenu(null) }}><CalendarDays size={18} /><span>日期…</span>{props.startMode === 'date' && <Check size={15} />}</button>
            <button className={props.startMode === 'first' ? 'active' : ''} onClick={() => { props.onFirstAvailable(); setMenu(null) }}><ChevronLeft size={18} /><span>最早可用日期</span>{props.startMode === 'first' && <Check size={15} />}</button>
            <button className={props.startMode === 'random' ? 'active' : ''} onClick={() => { props.onRandomBar(); setMenu(null) }}><Shuffle size={18} /><span>随机K线</span>{props.startMode === 'random' && <Check size={15} />}</button>
          </div>}
        </div>

        <span className="replay-separator" />
        <button type="button" className="replay-square-button" title={props.playing ? '暂停 (Shift+↓)' : '播放 (Shift+↓)'} aria-label={props.playing ? '暂停回放' : '播放回放'} disabled={!props.active || props.atEnd} onClick={props.onPlayPause}>
          {props.playing ? <Pause size={23} fill="currentColor" /> : <Play size={23} fill="currentColor" />}
        </button>
        <button type="button" className="replay-square-button" title="后退一格 (Shift+←)" aria-label="后退一格" disabled={!props.active} onClick={props.onStepBack}><SkipBack size={23} /></button>
        <button type="button" className="replay-square-button" title="前进 (Shift+→)" aria-label="前进一格" disabled={!props.active || props.atEnd} onClick={props.onStep}><SkipForward size={23} /></button>

        <div className="replay-control-wrap">
          <button type="button" className="replay-text-button" title="回放速度" aria-expanded={menu === 'speed'} onClick={() => setMenu((value) => value === 'speed' ? null : 'speed')}>{speed.label}</button>
          {menu === 'speed' && <div className="replay-popover replay-speed-menu" role="menu">
            {REPLAY_SPEEDS.map((item) => <button key={item.value} className={item.value === props.speed ? 'active' : ''} onClick={() => { props.onSpeed(item.value); setMenu(null) }}>
              <b>{item.label}</b><span>{item.detail}</span>{item.value === props.speed && <Check size={15} />}
            </button>)}
          </div>}
        </div>

        <div className="replay-control-wrap">
          <button type="button" className="replay-text-button" title="更新周期" aria-expanded={menu === 'resolution'} onClick={() => setMenu((value) => value === 'resolution' ? null : 'resolution')}>{resolutionLabel}</button>
          {menu === 'resolution' && <div className="replay-popover replay-resolution-menu" role="menu">
            <header>更新周期</header>
            {options.map((item) => <button key={item.seconds} className={!props.autoResolution && item.seconds === props.resolutionSeconds ? 'active' : ''} onClick={() => { props.onResolution(item.seconds, false); setMenu(null) }}>
              <span>{item.label}</span>{!props.autoResolution && item.seconds === props.resolutionSeconds && <Check size={15} />}
            </button>)}
            <label className="replay-auto-resolution"><span><Gauge size={17} />自动选择周期</span><input type="checkbox" checked={props.autoResolution} onChange={(event) => props.onResolution(INTERVALS[props.interval].seconds, event.target.checked)} /><i /></label>
          </div>}
        </div>

        <span className="replay-separator" />
        <button type="button" className="replay-square-button replay-realtime" title="跳转到实时图表" aria-label="跳转到实时图表" disabled={!props.active} onClick={props.onRealtime}><RadioTower size={23} /></button>
      </div>
      <div className="replay-toolbar-spacer" />
      <button type="button" className="replay-close" title="关闭回放面板" aria-label="关闭回放面板" onClick={props.onClose}><X size={25} /></button>
    </div>
    {dateOpen && <ReplayDateDialog
      firstTime={props.firstTime}
      lastTime={props.lastTime}
      initialTime={props.cursorTime ?? props.lastTime}
      onCancel={() => setDateOpen(false)}
      onFirst={() => { props.onFirstAvailable(); setDateOpen(false) }}
      onSelect={(time) => { props.onSelectDate(time); setDateOpen(false) }}
    />}
  </>
}

function formatInputDate(date: Date) {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatInputTime(date: Date) {
  return `${`${date.getHours()}`.padStart(2, '0')}:${`${date.getMinutes()}`.padStart(2, '0')}`
}

function ReplayDateDialog({ firstTime, lastTime, initialTime, onCancel, onFirst, onSelect }: {
  firstTime: number
  lastTime: number
  initialTime: number
  onCancel: () => void
  onFirst: () => void
  onSelect: (time: number) => void
}) {
  const initial = new Date(Math.min(lastTime, Math.max(firstTime, initialTime)) * 1000)
  const [date, setDate] = useState(() => formatInputDate(initial))
  const [time, setTime] = useState(() => formatInputTime(initial))
  const [month, setMonth] = useState(() => new Date(initial.getFullYear(), initial.getMonth(), 1))
  const minDate = formatInputDate(new Date(firstTime * 1000))
  const maxDate = formatInputDate(new Date(lastTime * 1000))
  const weekdays = ['一', '二', '三', '四', '五', '六', '日']
  const days = useMemo(() => {
    const firstWeekday = (month.getDay() + 6) % 7
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
    return Array.from({ length: 42 }, (_, index) => {
      const day = index - firstWeekday + 1
      return day >= 1 && day <= count ? day : null
    })
  }, [month])

  const choose = () => {
    const parsed = new Date(`${date}T${time || '00:00'}:00`).getTime() / 1000
    onSelect(Math.min(lastTime, Math.max(firstTime, parsed)))
  }

  return <div className="modal-backdrop replay-date-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}>
    <section className="replay-date-dialog" role="dialog" aria-modal="true" aria-label="选择回放日期">
      <div className="replay-date-fields">
        <label>日期<input aria-label="回放日期" type="date" min={minDate} max={maxDate} value={date} onInput={(event) => { const next = event.currentTarget.value; setDate(next); const value = new Date(`${next}T12:00:00`); setMonth(new Date(value.getFullYear(), value.getMonth(), 1)) }} onChange={(event) => setDate(event.target.value)} /></label>
        <label>时间<input aria-label="回放时间" type="time" value={time} onInput={(event) => setTime(event.currentTarget.value)} onChange={(event) => setTime(event.target.value)} /></label>
      </div>
      <div className="replay-month-header"><button aria-label="上一个月" onClick={() => setMonth((value) => new Date(value.getFullYear(), value.getMonth() - 1, 1))}><ChevronLeft size={20} /></button><b>{month.getMonth() + 1}月 {month.getFullYear()}</b><button aria-label="下一个月" onClick={() => setMonth((value) => new Date(value.getFullYear(), value.getMonth() + 1, 1))}><ChevronRight size={20} /></button></div>
      <div className="replay-calendar-weekdays">{weekdays.map((item) => <span key={item}>{item}</span>)}</div>
      <div className="replay-calendar-grid">{days.map((day, index) => {
        if (day === null) return <span key={`empty-${index}`} />
        const candidate = new Date(month.getFullYear(), month.getMonth(), day)
        const value = formatInputDate(candidate)
        const disabled = value < minDate || value > maxDate
        return <button key={value} disabled={disabled} className={date === value ? 'active' : ''} aria-label={`${month.getFullYear()}年${month.getMonth() + 1}月${day}日`} onClick={() => setDate(value)}>{day}</button>
      })}</div>
      <button className="replay-first-date" onClick={onFirst}>选择第一个可用日期</button>
      <footer><button onClick={onCancel}>取消</button><button className="primary" onClick={choose}>选择</button></footer>
    </section>
  </div>
}
