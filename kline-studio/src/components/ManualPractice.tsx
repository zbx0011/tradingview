import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { BookOpenCheck, CalendarDays, ChevronRight, ClipboardList, Eye, NotebookPen, Pencil, Play, Plus, Trash2, X } from 'lucide-react'
import { INTERVALS, type IntervalId } from '../lib/market'
import {
  barTimeFor,
  manualTimeline,
  NQ_POINT_VALUE_USD,
  openTrade,
  sessionSummary,
  tradePoints,
  tradeQuantity,
  tradeUsd,
  type ManualBarNote,
  type ManualOrderKind,
  type ManualPracticeSession,
  type ManualPracticeStore,
  type ManualSide,
  type ManualTimelineItem,
  type ManualTrade,
} from '../lib/manualPractice'

const beijingFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
const beijingTimeFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })
const formatBeijing = (time: number) => beijingFormatter.format(new Date(time * 1000))
const formatClock = (time: number) => beijingTimeFormatter.format(new Date(time * 1000))
const formatPoints = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)} 点`
const formatUsd = (value: number) => `${value >= 0 ? '+' : '-'}$${Math.abs(value).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`
const exitLabel = (trade: ManualTrade) => trade.exitKind === 'stop' ? '止损' : trade.exitKind === 'target' ? '止盈' : trade.exitKind === 'session-end' ? '收盘平仓' : '手动平仓'

/* ------------------------------------------------------------------ */
/* Floating card: drag by the grip, resize from the corner, no backdrop */
/* ------------------------------------------------------------------ */

interface CardBox { left: number; top: number; width: number; height: number | null }
const CARD_STORAGE_PREFIX = 'kline-studio-manual-card-v1:'
function loadCardBox(id: string): CardBox | null {
  try {
    const value = JSON.parse(localStorage.getItem(CARD_STORAGE_PREFIX + id) ?? 'null') as Partial<CardBox> | null
    if (!value || typeof value.left !== 'number' || typeof value.top !== 'number' || typeof value.width !== 'number') return null
    return { left: value.left, top: value.top, width: value.width, height: typeof value.height === 'number' ? value.height : null }
  } catch {
    return null
  }
}
function saveCardBox(id: string, box: CardBox | null) {
  try {
    if (box) localStorage.setItem(CARD_STORAGE_PREFIX + id, JSON.stringify(box))
    else localStorage.removeItem(CARD_STORAGE_PREFIX + id)
  } catch {
    // Position memory is a convenience only.
  }
}

export function FloatingCard({ id, title, icon, meta, tone = 'neutral', className = '', defaultStyle, minWidth = 240, minHeight = 110, ariaLabel, testId, onClose, closeLabel = '关闭', onKeyDown, children }: {
  id: string
  title: ReactNode
  icon?: ReactNode
  meta?: ReactNode
  tone?: 'neutral' | 'long' | 'short' | 'note'
  className?: string
  /** Placement before the user has moved the card (relative to the chart area). */
  defaultStyle: CSSProperties
  minWidth?: number
  minHeight?: number
  ariaLabel: string
  testId?: string
  onClose?: () => void
  closeLabel?: string
  onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void
  children: ReactNode
}) {
  const ref = useRef<HTMLElement>(null)
  const [box, setBox] = useState<CardBox | null>(() => loadCardBox(id))
  // Dragging and resizing write straight to the element (a GPU transform for
  // moves) once per frame; React state is only updated when the gesture ends.
  const gestureRef = useRef<{ pointerId: number; kind: 'drag' | 'resize'; x: number; y: number; start: CardBox; parent: DOMRect; latest: CardBox; frame: number } | null>(null)
  const boxRef = useRef(box)
  useEffect(() => { boxRef.current = box }, [box])

  // Keep a remembered position inside the chart when the window shrinks.
  useEffect(() => {
    const card = ref.current
    const parent = card?.offsetParent as HTMLElement | null
    if (!card || !parent) return
    const clamp = () => {
      const current = boxRef.current
      if (!current || gestureRef.current) return
      const rect = parent.getBoundingClientRect()
      const width = Math.min(current.width, rect.width)
      const left = Math.max(0, Math.min(rect.width - width, current.left))
      const top = Math.max(0, Math.min(rect.height - 40, current.top))
      if (left !== current.left || top !== current.top || width !== current.width) setBox({ ...current, left, top, width })
    }
    clamp()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(clamp)
    observer?.observe(parent)
    return () => observer?.disconnect()
  }, [])

  const begin = (event: ReactPointerEvent<HTMLElement>, kind: 'drag' | 'resize') => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (kind === 'drag' && event.target instanceof Element && event.target.closest('button, input, textarea, select')) return
    const card = ref.current
    const parent = card?.offsetParent as HTMLElement | null
    if (!card || !parent) return
    event.preventDefault()
    event.stopPropagation()
    const parentRect = parent.getBoundingClientRect()
    const rect = card.getBoundingClientRect()
    const start: CardBox = {
      left: rect.left - parentRect.left,
      top: rect.top - parentRect.top,
      width: rect.width,
      height: kind === 'resize' || box?.height ? rect.height : null,
    }
    // Pin the card at its current pixel box (drops any default centring) before moving it.
    card.style.left = `${start.left}px`
    card.style.top = `${start.top}px`
    card.style.right = 'auto'
    card.style.bottom = 'auto'
    card.style.width = `${start.width}px`
    if (start.height !== null) card.style.height = `${start.height}px`
    card.style.transform = 'none'
    card.style.willChange = kind === 'drag' ? 'transform' : 'width, height'
    card.classList.add(`is-${kind}`)
    gestureRef.current = { pointerId: event.pointerId, kind, x: event.clientX, y: event.clientY, start, parent: parentRect, latest: start, frame: 0 }
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* optional */ }
  }
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    event.preventDefault()
    const dx = event.clientX - gesture.x
    const dy = event.clientY - gesture.y
    const { start, parent } = gesture
    gesture.latest = gesture.kind === 'drag'
      ? { ...start, left: Math.max(0, Math.min(parent.width - start.width, start.left + dx)), top: Math.max(0, Math.min(parent.height - 40, start.top + dy)) }
      : { ...start, width: Math.max(minWidth, Math.min(parent.width - start.left, start.width + dx)), height: Math.max(minHeight, Math.min(parent.height - start.top, (start.height ?? 0) + dy)) }
    if (gesture.frame) return
    gesture.frame = window.requestAnimationFrame(() => {
      const current = gestureRef.current
      const card = ref.current
      if (!current || !card) return
      current.frame = 0
      const next = current.latest
      if (current.kind === 'drag') {
        card.style.transform = `translate3d(${next.left - current.start.left}px, ${next.top - current.start.top}px, 0)`
      } else {
        card.style.width = `${next.width}px`
        card.style.height = `${next.height}px`
      }
    })
  }
  const end = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gestureRef.current = null
    if (gesture.frame) window.cancelAnimationFrame(gesture.frame)
    const card = ref.current
    if (card) {
      card.style.transform = 'none'
      card.style.left = `${gesture.latest.left}px`
      card.style.top = `${gesture.latest.top}px`
      card.style.willChange = ''
      card.classList.remove('is-drag', 'is-resize')
    }
    setBox(gesture.latest)
    saveCardBox(id, gesture.latest)
    try { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* released */ }
  }
  const style: CSSProperties = box
    ? { left: box.left, top: box.top, width: box.width, height: box.height ?? undefined, right: 'auto', bottom: 'auto', transform: 'none' }
    : defaultStyle
  return <section
    ref={ref}
    className={`mp-card tone-${tone}${box?.height ? ' has-height' : ''} ${className}`}
    style={style}
    role="dialog"
    aria-label={ariaLabel}
    data-testid={testId}
    onKeyDown={onKeyDown}
  >
    <header
      className="mp-card-head"
      title="拖动移动，双击恢复默认位置和大小"
      onPointerDown={(event) => begin(event, 'drag')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={(event) => { if (event.target instanceof Element && event.target.closest('button')) return; setBox(null); saveCardBox(id, null) }}
    >
      <strong><span className="mp-card-grip" aria-hidden="true">⠿</span>{icon}{title}</strong>
      {meta && <span className="mp-card-meta">{meta}</span>}
      {onClose && <button type="button" className="mp-icon" aria-label={closeLabel} title={closeLabel} onClick={onClose}><X size={14} /></button>}
    </header>
    <div className="mp-card-body">{children}</div>
    <span
      className="mp-card-resize"
      aria-hidden="true"
      title="拖动调整大小"
      onPointerDown={(event) => begin(event, 'resize')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    />
  </section>
}

/* ------------------------------------------------------------------ */
/* Reason editor: one reason per row, Tab / Enter moves to the next row */
/* ------------------------------------------------------------------ */

export function ReasonEditor({ cardId = 'reason-editor', title, subtitle, initial = [], required = false, background = null, unsupportedReasons = null, allowClear = false, confirmLabel = '保存', tone = 'neutral', children, onSave, onCancel }: {
  cardId?: string
  title: string
  subtitle?: ReactNode
  initial?: readonly string[]
  /** At least one reason is mandatory. */
  required?: boolean
  /** Adds a mandatory 背景 row above the numbered reasons. */
  background?: { initial: string } | null
  /** Optional factors against taking this trade. */
  unsupportedReasons?: { initial: string } | null
  /** Saving with every field empty removes the record instead of complaining. */
  allowClear?: boolean
  confirmLabel?: string
  tone?: 'neutral' | 'long' | 'short'
  children?: ReactNode
  onSave: (reasons: string[], background: string, unsupportedReasons: string) => void
  onCancel: () => void
}) {
  // With a background, row 0 is 背景 and rows 1.. are the numbered reasons.
  const offset = background ? 1 : 0
  const [rows, setRows] = useState<string[]>(() => [
    ...(background ? [background.initial] : []),
    ...(initial.length > 0 ? initial : ['']),
  ])
  const [error, setError] = useState('')
  const [unsupportedDraft, setUnsupportedDraft] = useState(unsupportedReasons?.initial ?? '')
  const inputRefs = useRef<Array<HTMLInputElement | null>>([])
  // Start in 背景 when it is empty, otherwise on the last reason.
  const pendingFocusRef = useRef<number | null>(background && !background.initial.trim() ? 0 : offset + Math.max(0, initial.length - 1))

  useEffect(() => {
    const index = pendingFocusRef.current
    if (index === null) return
    pendingFocusRef.current = null
    const input = inputRefs.current[index]
    input?.focus()
    if (input) input.setSelectionRange(input.value.length, input.value.length)
  })

  const focusRow = (index: number) => {
    pendingFocusRef.current = index
    // Rows that already exist can be focused right away.
    const input = inputRefs.current[index]
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); pendingFocusRef.current = null }
  }

  const save = () => {
    const context = background ? rows[0].trim() : ''
    const reasons = rows.slice(offset).map((row) => row.trim()).filter(Boolean)
    if (allowClear && !context && reasons.length === 0) { onSave([], '', ''); return }
    if (background && !context) {
      setError('背景是必填项，请先写下当前的背景')
      focusRow(0)
      return
    }
    if (required && reasons.length === 0) {
      setError('开仓必须至少填写一条做单理由')
      focusRow(offset)
      return
    }
    onSave(reasons, context, unsupportedReasons ? unsupportedDraft.trim() : '')
  }

  const goNext = (index: number) => {
    if (index < rows.length - 1) { focusRow(index + 1); return }
    if (!rows[index].trim()) return
    setRows((current) => [...current, ''])
    pendingFocusRef.current = index + 1
  }

  const reasonRowCount = rows.length - offset
  const removeRow = (index: number) => {
    setRows((current) => current.filter((_, rowIndex) => rowIndex !== index))
    pendingFocusRef.current = Math.max(0, index - 1)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>, index: number) => {
    // Never act while a Chinese IME candidate is being composed.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); return }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save(); return }
    if (event.key === 'Tab' && event.shiftKey) {
      if (index > 0) { event.preventDefault(); focusRow(index - 1) }
      return
    }
    if (event.key === 'Tab' || event.key === 'Enter') { event.preventDefault(); goNext(index); return }
    if (event.key === 'Backspace' && rows[index] === '' && index >= offset && reasonRowCount > 1) {
      event.preventDefault()
      removeRow(index)
    }
    if (event.key === 'ArrowDown' && index < rows.length - 1) { event.preventDefault(); focusRow(index + 1) }
    if (event.key === 'ArrowUp' && index > 0) { event.preventDefault(); focusRow(index - 1) }
  }

  return <FloatingCard
    id={cardId}
    className="mp-editor"
    tone={tone}
    ariaLabel={title}
    title={<>{title}{(required || background) && <em className="mp-required">必填</em>}</>}
    icon={<NotebookPen size={14} />}
    defaultStyle={{ left: 64, bottom: 56, width: 440 }}
    minWidth={320}
    minHeight={180}
    onClose={onCancel}
    closeLabel="取消"
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() } }}
  >
      {subtitle && <p className="mp-editor-subtitle">{subtitle}</p>}
      {children}
      <ol className="mp-reason-rows">
        {rows.map((row, index) => {
          const isBackground = Boolean(background) && index === 0
          const number = index - offset + 1
          return <li key={index} className={isBackground ? 'is-background' : undefined}>
            <span className={`mp-reason-index${isBackground ? ' background' : ''}`}>{isBackground ? '背景' : number}</span>
            <input
              ref={(element) => { inputRefs.current[index] = element }}
              value={row}
              placeholder={isBackground ? '必填：当前背景，如趋势方向、关键位置、时段、消息…' : number === 1 ? '一条只写一个理由，按 Tab 写下一条' : '下一条理由'}
              aria-label={isBackground ? '背景（必填）' : `理由 ${number}`}
              aria-required={isBackground || undefined}
              onChange={(event) => { const value = event.target.value; setError(''); setRows((current) => current.map((item, rowIndex) => rowIndex === index ? value : item)) }}
              onKeyDown={(event) => handleKeyDown(event, index)}
            />
            {!isBackground && reasonRowCount > 1 && <button type="button" tabIndex={-1} aria-label={`删除理由 ${number}`} onClick={() => removeRow(index)}><Trash2 size={14} /></button>}
          </li>
        })}
      </ol>
      <button type="button" className="mp-add-row" tabIndex={-1} onClick={() => { setRows((current) => [...current, '']); pendingFocusRef.current = rows.length }}><Plus size={14} />添加一条</button>
      {unsupportedReasons && <label className="mp-unsupported-reasons">
        <span>不支持理由<small>（可选）</small></span>
        <textarea
          aria-label="不支持理由"
          value={unsupportedDraft}
          rows={3}
          placeholder="记录不支持本次做单的因素，可分行填写"
          onChange={(event) => setUnsupportedDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save() }
          }}
        />
      </label>}
      {error && <p className="mp-editor-error" role="alert">{error}</p>}
      <footer>
        <span className="mp-editor-hint"><kbd>Tab</kbd>/<kbd>Enter</kbd> 下一条 · <kbd>Shift+Tab</kbd> 上一条 · <kbd>Ctrl+Enter</kbd> 保存 · <kbd>Esc</kbd> 取消</span>
        <button type="button" className="mp-secondary" onClick={onCancel}>取消</button>
        <button type="button" className={`mp-primary tone-${tone}`} onClick={save}>{confirmLabel}</button>
      </footer>
  </FloatingCard>
}

/* ------------------------------------------------------------------ */
/* Start / history dialog                                              */
/* ------------------------------------------------------------------ */

export function ManualPracticeCenter({ store, dayCount, loading, onStart, onContinue, onReview, onDelete, onClose }: {
  store: ManualPracticeStore
  dayCount: number | null
  loading: boolean
  onStart: () => void
  onContinue: (sessionId: string) => void
  onReview: (sessionId: string) => void
  onDelete: (sessionId: string) => void
  onClose: () => void
}) {
  const history = useMemo(() => [...store.sessions].sort((a, b) => b.updatedAt - a.updatedAt), [store.sessions])
  const completedCount = history.filter((session) => session.status === 'completed').length
  // The most recently touched unfinished paper is the one "continue" resumes.
  const active = history.find((session) => session.status === 'active') ?? null
  const usedDays = new Set(store.sessions.map((session) => session.dayKey)).size
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  return <div className="modal-backdrop decision-center-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="decision-center mp-center" role="dialog" aria-modal="true" aria-label="自主逐K复盘">
      <header>
        <span className="decision-center-icon"><NotebookPen size={26} /></span>
        <div><h2>自主逐K复盘 · NQ1!</h2><small>不看 AI 信号，随机抽一个交易日逐根K线练习，记录每一次做单和不做单的理由</small></div>
        <button aria-label="关闭自主逐K复盘" onClick={onClose}><X size={21} /></button>
      </header>
      <div className="decision-center-body">
        {active && <button className="decision-resume-card" onClick={() => onContinue(active.id)}>
          <Play size={22} /><span><b>继续未完成的卷子：{active.dayLabel}</b><small>已到 {formatBeijing(active.cursorTime)} · {active.trades.length} 笔交易 · 进度自动保存</small></span><ChevronRight size={20} />
        </button>}
        <section className="mp-start">
          <div className="mp-start-copy">
            <h3>随机抽一个交易日</h3>
            <p>以 CME 交易时段为一天（北京时间约 06:00 / 07:00 至次日 05:00 / 06:00），图表先显示前几个交易日作为背景，然后从当天开盘逐根揭示。</p>
            <ul className="mp-keys">
              <li><kbd>1</kbd> 下一根K线</li>
              <li><kbd>2</kbd> 做多 / 持仓时平仓</li>
              <li><kbd>3</kbd> 做空</li>
              <li><kbd>`</kbd> 记录本根K线不做单理由（中文输入法下是 <kbd>·</kbd> 键）</li>
            </ul>
            <p className="mp-muted">开仓时必须填写做单理由；不开仓的K线可以随时按 <kbd>·</kbd> 记录理由。一条只写一个理由，<kbd>Tab</kbd> 切到下一条。</p>
          </div>
          <div className="mp-start-action">
            <div className="mp-day-count"><CalendarDays size={18} /><span>{dayCount === null ? (loading ? '正在加载 NQ1! 历史…' : 'NQ1! 历史尚未加载') : `共 ${dayCount.toLocaleString('zh-CN')} 个完整交易日 · 已练 ${usedDays} 天`}</span></div>
            <button type="button" className="mp-primary mp-start-button" disabled={loading} onClick={onStart}>
              {active ? '放弃当前卷子，重新抽一天' : '随机抽一天开始'}
            </button>
            {active && <small className="mp-muted">未完成的卷子会保留在下面的历史记录里，随时可以继续。</small>}
          </div>
        </section>
        <section className="mp-history">
          <h3><ClipboardList size={17} />历史卷子 <span>已完成 {completedCount} · 共 {history.length}</span></h3>
          {history.length === 0
            ? <div className="mp-empty">还没有卷子。完成一天后，这里可以按时间顺序回看你每一次开仓和不开仓的理由。</div>
            : <div className="mp-history-list">
              {history.map((session) => {
                const summary = sessionSummary(session)
                const done = session.status === 'completed'
                return <div className={`mp-history-row${done ? '' : ' unfinished'}`} key={session.id}>
                  <span className="mp-history-day"><b>{session.dayLabel}{!done && <em>未完成</em>}</b><small>{done
                    ? `完成于 ${session.completedAt ? new Date(session.completedAt).toLocaleString('zh-CN', { hour12: false }) : '—'}`
                    : `已到 ${formatBeijing(session.cursorTime)}`}</small></span>
                  <span>{summary.trades} 笔</span>
                  <span className={summary.totalPoints >= 0 ? 'positive' : 'negative'}>{formatPoints(summary.totalPoints)}<small>{formatUsd(summary.totalUsd)}</small></span>
                  <span>{summary.reasonCount} 条理由</span>
                  <span className="mp-history-actions">
                    {done
                      ? <button type="button" className="mp-secondary" onClick={() => onReview(session.id)}><Eye size={14} />复盘</button>
                      : <button type="button" className="mp-secondary" onClick={() => onContinue(session.id)}><Play size={14} />继续</button>}
                    {confirmDeleteId === session.id
                      ? <><button type="button" className="mp-danger" onClick={() => { onDelete(session.id); setConfirmDeleteId(null) }}>确认删除</button><button type="button" className="mp-secondary" onClick={() => setConfirmDeleteId(null)}>取消</button></>
                      : <button type="button" className="mp-icon" aria-label={`删除 ${session.dayLabel}`} onClick={() => setConfirmDeleteId(session.id)}><Trash2 size={14} /></button>}
                  </span>
                </div>
              })}
            </div>}
        </section>
      </div>
    </section>
  </div>
}

/* ------------------------------------------------------------------ */
/* In-chart control panel                                              */
/* ------------------------------------------------------------------ */

export function ManualPracticePanel({ session, review, lastPrice, interval, currentBarNote, onAdvance, onOpen, onClose, onCancelOrder, onNote, onPickBack, picking = false, onRisk, onFinish, onExit, onOpenTimeline }: {
  session: ManualPracticeSession
  review: boolean
  lastPrice: number | null
  interval: IntervalId
  currentBarNote: ManualBarNote | null
  onAdvance: () => void
  onOpen: (side: ManualSide) => void
  onClose: () => void
  onCancelOrder: () => void
  onNote: () => void
  /** Look back: pick an earlier candle on the chart and record 应该开单 / 未开单 reasons for it. */
  onPickBack: () => void
  picking?: boolean
  onRisk: (field: 'stopLoss' | 'takeProfit', value: number | null) => void
  onFinish: () => void
  onExit: () => void
  onOpenTimeline: () => void
}) {
  const [confirmFinish, setConfirmFinish] = useState(false)
  const position = openTrade(session)
  const summary = sessionSummary(session)
  const floating = position && lastPrice !== null ? tradePoints(position, lastPrice) : null
  const progress = Math.max(0, Math.min(1, (session.cursorTime - session.startTime) / Math.max(1, session.endTime - session.startTime)))
  const started = session.cursorTime > session.startTime
  return <FloatingCard
    id="panel"
    className="mp-panel"
    testId="manual-practice-panel"
    ariaLabel="自主逐K复盘"
    icon={<NotebookPen size={14} />}
    title={review ? '复盘 · NQ1!' : '自主复盘 · NQ1!'}
    meta={session.dayLabel}
    defaultStyle={{ right: 122, top: 12, width: 300 }}
    minWidth={260}
    minHeight={160}
    onClose={onExit}
    closeLabel={review ? '退出复盘' : '暂停并退出（进度已保存）'}
  >
    <div className="mp-progress" aria-label={`进度 ${Math.round(progress * 100)}%`}><i style={{ width: `${progress * 100}%` }} /></div>
    <div className="mp-panel-meta">
      <span>{review ? '整日' : started ? `已到 ${formatClock(session.cursorTime)}` : '开盘前'}</span>
      <span>{INTERVALS[interval].label}</span>
      {lastPrice !== null && <span>现价 <b>{lastPrice.toFixed(2)}</b></span>}
    </div>
    {position && !review && <div className={`mp-position side-${position.side}`}>
      <div className="mp-position-head">
        <b>{position.side === 'long' ? '多单' : '空单'} ×{tradeQuantity(position)} @ {position.entryPrice.toFixed(2)}</b>
        {floating !== null && <span className={floating >= 0 ? 'positive' : 'negative'}>{formatPoints(floating)} · {formatUsd(floating * NQ_POINT_VALUE_USD * tradeQuantity(position))}</span>}
      </div>
      <div className="mp-risk-fields">
        <RiskInput label="止损" value={position.stopLoss} onCommit={(value) => onRisk('stopLoss', value)} />
        <RiskInput label="止盈" value={position.takeProfit} onCommit={(value) => onRisk('takeProfit', value)} />
      </div>
    </div>}
    {session.pendingOrder && !position && !review && <div className={`mp-position side-${session.pendingOrder.side}`}>
      <div className="mp-position-head">
        <b>{session.pendingOrder.side === 'long' ? '多单' : '空单'}{session.pendingOrder.orderKind === 'stop' ? '追单' : '挂单'} ×{session.pendingOrder.quantity} @ {session.pendingOrder.entryPrice.toFixed(2)}</b>
        <span className="mp-muted">等待成交</span>
      </div>
      <div className="mp-muted">止损 {session.pendingOrder.stopLoss.toFixed(2)} · 止盈 {session.pendingOrder.takeProfit.toFixed(2)}；在图上拖线可改</div>
    </div>}
    {!review && <div className="mp-actions">
      <button type="button" className="mp-primary" onClick={onAdvance}><kbd>1</kbd>下一根</button>
      {position
        ? <button type="button" className="mp-close" onClick={onClose}><kbd>2</kbd>平仓</button>
        : session.pendingOrder
          ? <button type="button" className="mp-close" onClick={onCancelOrder}><kbd>2</kbd>取消挂单</button>
          : <>
          <button type="button" className="mp-long" disabled={!started} onClick={() => onOpen('long')}><kbd>2</kbd>做多</button>
          <button type="button" className="mp-short" disabled={!started} onClick={() => onOpen('short')}><kbd>3</kbd>做空</button>
        </>}
      <button type="button" className={`mp-note${currentBarNote ? ' has-note' : ''}`} disabled={!started} onClick={onNote} title="记录本根K线的理由"><kbd>·</kbd>{position ? '记录理由' : '不做单理由'}{currentBarNote ? `（${currentBarNote.reasons.length}）` : ''}</button>
      <button type="button" className={`mp-note mp-back${picking ? ' has-note' : ''}`} disabled={!started} onClick={onPickBack} title="往前选一根K线，补记应该开单 / 未开单的理由">{picking ? '点图上的K线…（Esc 取消）' : '往前选K线记录理由'}</button>
    </div>}
    <div className="mp-panel-stats">
      <span>交易 <b>{summary.trades}</b></span>
      <span>已实现 <b className={summary.totalPoints >= 0 ? 'positive' : 'negative'}>{formatPoints(summary.totalPoints)}</b></span>
      <span>理由 <b>{summary.reasonCount}</b></span>
    </div>
    <footer>
      <button type="button" className="mp-secondary" onClick={onOpenTimeline}><BookOpenCheck size={14} />{review ? '理由时间线' : '已记录的理由'}</button>
      {!review && (confirmFinish
        ? <><button type="button" className="mp-danger" onClick={() => { setConfirmFinish(false); onFinish() }}>确认结束（持仓按现价平）</button><button type="button" className="mp-secondary" onClick={() => setConfirmFinish(false)}>取消</button></>
        : <button type="button" className="mp-secondary" onClick={() => setConfirmFinish(true)}>结束今天</button>)}
    </footer>
  </FloatingCard>
}

function RiskInput({ label, value, onCommit }: { label: string; value: number | null; onCommit: (value: number | null) => void }) {
  const [draft, setDraft] = useState(value === null ? '' : value.toFixed(2))
  // Follow outside changes of the value (adjusting state while rendering, as React recommends).
  const [seenValue, setSeenValue] = useState(value)
  if (seenValue !== value) {
    setSeenValue(value)
    setDraft(value === null ? '' : value.toFixed(2))
  }
  const commit = () => {
    const trimmed = draft.trim()
    if (!trimmed) { onCommit(null); return }
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed) && parsed > 0) onCommit(parsed)
    else setDraft(value === null ? '' : value.toFixed(2))
  }
  return <label className="mp-risk-input"><span>{label}</span><input inputMode="decimal" value={draft} placeholder="未设置" onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); event.currentTarget.blur() } if (event.key === 'Escape') { event.stopPropagation(); setDraft(value === null ? '' : value.toFixed(2)); event.currentTarget.blur() } }} /></label>
}

/* ------------------------------------------------------------------ */
/* Open-position dialog: side, optional stop/target, mandatory reasons */
/* ------------------------------------------------------------------ */

export function OpenTradeDialog({ side, price, orderKind = null, quantity, stopLoss, takeProfit, initialBackground = '', onStopLoss, onTakeProfit, onConfirm, onCancel }: {
  initialBackground?: string
  side: ManualSide
  /** Entry price: the close for a market fill, or the dragged order price. */
  price: number
  /** null = market fill at the close; otherwise a resting 追单 / 挂单. */
  orderKind?: ManualOrderKind | null
  quantity: number
  /** Live levels: the same values the lines on the chart show and drag. */
  stopLoss: number
  takeProfit: number
  onStopLoss: (price: number) => void
  onTakeProfit: (price: number) => void
  onConfirm: (reasons: string[], background: string, unsupportedReasons: string) => void
  onCancel: () => void
}) {
  const [riskError, setRiskError] = useState('')
  const long = side === 'long'
  const usdAt = (exit: number) => (exit - price) * (long ? 1 : -1) * NQ_POINT_VALUE_USD * quantity
  const usdText = (exit: number) => `${usdAt(exit) >= 0 ? '+' : '-'}$${Math.abs(usdAt(exit)).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`
  return <ReasonEditor
    cardId="open-trade"
    title={`${long ? '做多' : '做空'}${orderKind === 'stop' ? '追单' : orderKind === 'limit' ? '挂单' : ''} ${quantity} 手 @ ${price.toFixed(2)} · 做单理由`}
    subtitle={orderKind ? '追单（stop 入场）：价格突破开仓线才成交，成交后才开始判断止损 / 止盈（每点 $20）。拖动图上的开仓、止损、止盈线调整；手数在开仓线上加减。' : '按当前K线收盘价成交（每点 $20）。拖动止损 / 止盈线调整风险，手数在开仓线上加减。'}
    required
    tone={long ? 'long' : 'short'}
    confirmLabel={orderKind ? (long ? '确认多单挂单' : '确认空单挂单') : (long ? '确认做多' : '确认做空')}
    onCancel={onCancel}
    background={{ initial: initialBackground }}
    unsupportedReasons={{ initial: '' }}
    onSave={(reasons, background, unsupportedReasons) => {
      if (long ? stopLoss >= price : stopLoss <= price) { setRiskError(`止损必须${long ? '低于' : '高于'}开仓价`); return }
      if (long ? takeProfit <= price : takeProfit >= price) { setRiskError(`止盈必须${long ? '高于' : '低于'}开仓价`); return }
      onConfirm(reasons, background, unsupportedReasons)
    }}
  >
    <div className="mp-open-risk">
      <PriceField label="止损价" value={stopLoss} hint={usdText(stopLoss)} onCommit={(value) => { setRiskError(''); onStopLoss(value) }} />
      <PriceField label="止盈价" value={takeProfit} hint={usdText(takeProfit)} onCommit={(value) => { setRiskError(''); onTakeProfit(value) }} />
      {riskError && <p className="mp-editor-error" role="alert">{riskError}</p>}
    </div>
  </ReasonEditor>
}

/** Price input that follows the chart lines while idle and commits on blur / Enter. */
function PriceField({ label, value, hint, onCommit }: { label: string; value: number; hint: string; onCommit: (value: number) => void }) {
  const [text, setText] = useState(value.toFixed(2))
  const [editing, setEditing] = useState(false)
  // While idle, follow the chart line (adjusting state while rendering, as React recommends).
  const idleText = value.toFixed(2)
  if (!editing && text !== idleText) setText(idleText)
  const commit = () => {
    setEditing(false)
    const parsed = Number(text.trim())
    if (text.trim() && Number.isFinite(parsed) && parsed > 0) onCommit(Math.round(parsed * 4) / 4)
    else setText(value.toFixed(2))
  }
  return <label><span>{label} <em>{hint}</em></span><input tabIndex={-1} inputMode="decimal" value={text} onFocus={() => setEditing(true)} onChange={(event) => setText(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); commit() } }} /></label>
}

/* ------------------------------------------------------------------ */
/* Chart annotations                                                   */
/* ------------------------------------------------------------------ */

export function ManualPracticeAnnotations({ session, interval, hidden, toX, toY, highlightTime = null, highlightPrice = null, hideLevels = false }: {
  session: ManualPracticeSession
  interval: IntervalId
  hidden: boolean
  toX: (time: number) => number | null
  toY: (price: number) => number | null
  highlightTime?: number | null
  /** Price to ring on the highlighted candle (entry / exit fills). */
  highlightPrice?: number | null
  /** The draggable risk overlay already draws the open position's entry / stop / target. */
  hideLevels?: boolean
}) {
  if (hidden) return null
  const position = openTrade(session)
  const snap = (time: number) => toX(barTimeFor(time, interval))
  const noteBars = new Map<number, { count: number; should: number; noTrade: number }>()
  for (const note of session.notes) {
    const bar = barTimeFor(note.barTime, interval)
    const entry = noteBars.get(bar) ?? { count: 0, should: 0, noTrade: 0 }
    const amount = Math.max(1, note.reasons.length)
    entry.count += amount
    if (note.kind === 'should-trade') entry.should += amount
    else entry.noTrade += amount
    noteBars.set(bar, entry)
  }
  const line = (price: number | null, className: string, label: string) => {
    if (price === null) return null
    const y = toY(price)
    if (y === null) return null
    return <div className={`mp-level ${className}`} style={{ top: y }}><span>{label} {price.toFixed(2)}</span></div>
  }
  return <div className="mp-annotations" aria-hidden="true">
    {position && !hideLevels && <>
      {line(position.entryPrice, 'entry', position.side === 'long' ? '多单' : '空单')}
      {line(position.stopLoss, 'stop', '止损')}
      {line(position.takeProfit, 'target', '止盈')}
    </>}
    {session.trades.map((trade) => {
      const entryX = snap(trade.entryTime)
      const entryY = toY(trade.entryPrice)
      const exitX = trade.exitTime !== null ? snap(trade.exitTime) : null
      const exitY = trade.exitPrice !== null ? toY(trade.exitPrice) : null
      const points = tradePoints(trade)
      return <div key={trade.id}>
        {entryX !== null && entryY !== null && <span className={`mp-marker entry side-${trade.side}`} style={{ left: entryX, top: entryY }} title={trade.reasons.join('\n')}>{trade.side === 'long' ? '▲' : '▼'}</span>}
        {exitX !== null && exitY !== null && <span className={`mp-marker exit${points !== null && points < 0 ? ' loss' : ''}`} style={{ left: exitX, top: exitY }} title={`${exitLabel(trade)} ${points !== null ? formatPoints(points) : ''}`}>✕</span>}
        {entryX !== null && entryY !== null && exitX !== null && exitY !== null && <svg className="mp-trade-path"><line x1={entryX} y1={entryY} x2={exitX} y2={exitY} className={points !== null && points < 0 ? 'loss' : 'win'} /></svg>}
      </div>
    })}
    {[...noteBars.entries()].map(([bar, info]) => {
      const x = toX(bar)
      if (x === null) return null
      const title = [info.noTrade ? `未开单理由：${info.noTrade} 条` : '', info.should ? `应该开单理由：${info.should} 条` : ''].filter(Boolean).join('；')
      return <span key={bar} className={`mp-note-badge${info.should ? ' should' : ''}${highlightTime === bar ? ' highlight' : ''}`} style={{ left: x }} title={title}>{info.count}</span>
    })}
    {highlightTime !== null && (() => {
      const x = toX(highlightTime)
      if (x === null) return null
      const y = highlightPrice !== null ? toY(highlightPrice) : null
      return <>
        <div className="mp-focus-band" style={{ left: x }} />
        {y !== null && <span className="mp-focus-ring" style={{ left: x, top: y }} />}
        <span className="mp-focus-tag" style={{ left: x }}>{formatBeijing(highlightTime)}</span>
      </>
    })()}
  </div>
}

/* ------------------------------------------------------------------ */
/* Review: summary + every reason in time order                        */
/* ------------------------------------------------------------------ */

export function ManualTimelineDialog({ session, onClose, onJump, onEditItem }: {
  session: ManualPracticeSession
  onClose: () => void
  /** Locate the candle a reason belongs to (and mark it on the chart). */
  onJump: (item: ManualTimelineItem) => void
  onEditItem: (item: ManualTimelineItem) => void
}) {
  const summary = sessionSummary(session)
  const timeline = manualTimeline(session)
  const [filter, setFilter] = useState<'all' | 'entry' | 'no-trade' | 'should-trade' | 'exit'>('all')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  // One card per trade: the entry and the exit it ended with belong together. 平仓理由 only exists
  // for exits the user chose to make; stop / target / end-of-day exits are passive.
  const rows = timeline.flatMap((item) => {
    if (item.kind === 'exit') return []
    const exit = item.kind === 'entry' && item.trade ? timeline.find((other) => other.kind === 'exit' && other.trade?.id === item.trade!.id) : undefined
    return [{ item, exit }]
  })
  const visible = rows.filter(({ item, exit }) => filter === 'all'
    || (filter === 'exit' ? Boolean(exit && !exit.passive) : item.kind === filter))
  return <FloatingCard
    id="timeline"
    className="mp-timeline"
    ariaLabel="理由时间线"
    icon={<BookOpenCheck size={14} />}
    title="理由时间线"
    meta={`${session.dayLabel} · ${session.status === 'completed' ? '已完成' : '进行中'}`}
    defaultStyle={{ left: 64, top: 70, width: 520, height: 460 }}
    minWidth={340}
    minHeight={200}
    onClose={onClose}
  >
        <div className="mp-summary-grid">
          <div><small>交易</small><b>{summary.trades}</b></div>
          <div><small>胜 / 负</small><b>{summary.wins} / {summary.losses}</b></div>
          <div><small>胜率</small><b>{summary.winRate === null ? '—' : `${Math.round(summary.winRate * 100)}%`}</b></div>
          <div><small>已实现</small><b className={summary.totalPoints >= 0 ? 'positive' : 'negative'}>{formatPoints(summary.totalPoints)}</b><small>{formatUsd(summary.totalUsd)}</small></div>
          <div><small>未开单 / 应开单</small><b>{summary.noTradeNotes} / {summary.shouldTradeNotes}</b></div>
          <div><small>理由总数</small><b>{summary.reasonCount}</b></div>
        </div>
        <div className="mp-filter" role="group" aria-label="筛选理由">
          {([['all', '全部'], ['entry', '做单理由'], ['no-trade', '未开单理由'], ['should-trade', '应该开单理由'], ['exit', '平仓理由']] as const).map(([key, label]) => <button type="button" key={key} className={filter === key ? 'active' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}
        </div>
        {visible.length === 0
          ? <div className="mp-empty">这一类还没有记录。</div>
          : <ol className="mp-timeline-list">
            {visible.map(({ item, exit }, index) => {
              const itemKey = `${item.kind}-${item.time}-${item.trade?.id ?? item.note?.interval ?? ''}`
              const exitKey = exit ? `exit-${exit.time}-${exit.trade?.id ?? ''}` : null
              const select = (target: ManualTimelineItem, key: string) => { setSelectedKey(key); onJump(target) }
              const points = exit && exit.trade ? tradePoints(exit.trade) : null
              const selected = selectedKey === itemKey || (exitKey !== null && selectedKey === exitKey)
              return <li key={`${itemKey}-${index}`} className={`kind-${item.kind}${item.trade ? ` side-${item.trade.side}` : ''}${selected ? ' selected' : ''}`} onClick={() => select(item, itemKey)} title="点击在图上定位到这根K线并标注">
                <div className="mp-timeline-times">
                  <button type="button" className={`mp-timeline-time${selectedKey === itemKey ? ' on' : ''}`} onClick={(event) => { event.stopPropagation(); select(item, itemKey) }} title="在图上定位到这根K线">{formatBeijing(item.time)}</button>
                  {exit && exitKey && <button type="button" className={`mp-timeline-time exit${selectedKey === exitKey ? ' on' : ''}`} onClick={(event) => { event.stopPropagation(); select(exit, exitKey) }} title="在图上定位到平仓这根K线">{formatBeijing(exit.time)}</button>}
                </div>
                <div className="mp-timeline-body">
                  <div className="mp-timeline-title"><b>{item.title}</b>
                    <button type="button" className="mp-icon" aria-label="编辑理由" title="编辑理由" onClick={(event) => { event.stopPropagation(); onEditItem(item) }}><Pencil size={13} /></button>
                  </div>
                  {item.background !== null && <p className={`mp-timeline-background${item.background ? '' : ' missing'}`}><span>背景</span>{item.background || '未填写'}</p>}
                  {item.reasons.length > 0
                    ? <ol className="mp-reason-list">{item.reasons.map((reason, reasonIndex) => <li key={reasonIndex}>{reason}</li>)}</ol>
                    : <p className="mp-muted">{item.kind === 'no-trade' || item.kind === 'should-trade' ? '只写了背景，没有分条理由' : '未填写理由'}</p>}
                  {item.kind === 'entry' && item.unsupportedReasons && <p className="mp-timeline-unsupported"><span>不支持理由</span>{item.unsupportedReasons}</p>}
                  {exit && exitKey && <div className={`mp-timeline-exit${selectedKey === exitKey ? ' selected' : ''}`} onClick={(event) => { event.stopPropagation(); select(exit, exitKey) }} title="点击在图上定位到平仓这根K线并标注">
                    <div className="mp-timeline-title"><b>{exit.title}</b>{points !== null && <span className={points >= 0 ? 'positive' : 'negative'}>{formatPoints(points)} · {formatUsd((exit.trade ? tradeUsd(exit.trade) : null) ?? points * NQ_POINT_VALUE_USD)}</span>}
                      {!exit.passive && <button type="button" className="mp-icon" aria-label="编辑平仓理由" title="编辑平仓理由" onClick={(event) => { event.stopPropagation(); onEditItem(exit) }}><Pencil size={13} /></button>}
                    </div>
                    {exit.reasons.length > 0
                      ? <ol className="mp-reason-list">{exit.reasons.map((reason, reasonIndex) => <li key={reasonIndex}>{reason}</li>)}</ol>
                      : exit.passive ? null : <p className="mp-muted">未填写平仓理由</p>}
                  </div>}
                </div>
              </li>
            })}
          </ol>}
  </FloatingCard>
}

/**
 * Look-back picker: while active, a click on the chart picks the candle under the cursor (never a future one).
 * It listens at window level so the chart stays scrollable / zoomable while the user looks for the candle.
 */
export function ManualBarPicker({ interval, maxBarTime, toTime, toX, onPick, onCancel }: {
  interval: IntervalId
  /** Newest revealed candle (bar open time): later candles do not exist yet. */
  maxBarTime: number
  toTime: (x: number) => number | null
  toX: (time: number) => number | null
  onPick: (barTime: number) => void
  onCancel: () => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const latest = useRef({ interval, maxBarTime, toTime, onPick, onCancel })
  useEffect(() => { latest.current = { interval, maxBarTime, toTime, onPick, onCancel } })
  useEffect(() => {
    const barAt = (event: PointerEvent | MouseEvent) => {
      const root = rootRef.current?.parentElement
      const target = event.target
      if (!root || !(target instanceof HTMLElement) || !root.contains(target) || !target.closest('canvas')) return null
      const rect = root.getBoundingClientRect()
      const time = latest.current.toTime(event.clientX - rect.left)
      if (time === null) return null
      const bar = barTimeFor(time, latest.current.interval)
      return bar > latest.current.maxBarTime ? null : bar
    }
    const onMove = (event: PointerEvent) => setHover(barAt(event))
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      const bar = barAt(event)
      if (bar === null) return
      event.preventDefault()
      event.stopPropagation()
      latest.current.onPick(bar)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      latest.current.onCancel()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])
  const x = hover === null ? null : toX(hover)
  return <div ref={rootRef} className="mp-picker" aria-hidden="true">
    <div className="mp-picker-hint">点击要记录的K线（只能选已出现的）· Esc 取消</div>
    {x !== null && <div className="mp-picker-line" style={{ left: x }}><span>{formatBeijing(hover!)}</span></div>}
  </div>
}

/** Which kind of note a candle gets: 未开单理由 or 应该开单理由 (long / short). */
export function NoteKindSwitch({ kind, side, onChange }: {
  kind: ManualBarNote['kind']
  side: ManualSide
  onChange: (kind: ManualBarNote['kind'], side: ManualSide) => void
}) {
  const options: { label: string; kind: ManualBarNote['kind']; side: ManualSide; className: string }[] = [
    { label: '未开单理由', kind: 'no-trade', side: 'long', className: 'neutral' },
    { label: '应该开多', kind: 'should-trade', side: 'long', className: 'long' },
    { label: '应该开空', kind: 'should-trade', side: 'short', className: 'short' },
  ]
  return <div className="mp-kind-switch" role="group" aria-label="记录类型">
    {options.map((option) => {
      const active = option.kind === kind && (kind === 'no-trade' || option.side === side)
      return <button key={option.label} type="button" tabIndex={-1} className={`${option.className}${active ? ' active' : ''}`} aria-pressed={active} onClick={() => onChange(option.kind, option.side)}>{option.label}</button>
    })}
  </div>
}
