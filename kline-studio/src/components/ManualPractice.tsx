import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { BookOpenCheck, CalendarDays, ChevronRight, ClipboardList, Eye, LogOut, MessageSquare, NotebookPen, Pencil, Play, Plus, Rewind, RotateCcw, Star, Trash2, TrendingDown, X } from 'lucide-react'
import { INTERVALS, type IntervalId } from '../lib/market'
import { loadPanelState, savePanelState, usePanelDraft } from '../lib/panelDraft'
import { bringFloatingCardToFront, registerFloatingCard } from '../lib/floatingCards'
import {
  barTimeFor,
  manualLossStats,
  manualReasonRows,
  manualItemRisk,
  manualRiskRatio,
  manualReviewCommentKey,
  NQ_POINT_VALUE_USD,
  openTrade,
  sessionSummary,
  tradePoints,
  tradeQuantity,
  tradeUsd,
  type ManualBarNote,
  type ManualLossFilter,
  type ManualLossMark,
  type ManualOrderKind,
  type ManualPracticeSession,
  type ManualPracticeStore,
  type ManualSide,
  type ManualTimelineItem,
  type ManualTrade,
  type ManualTradingDay,
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
const TIMELINE_COMPACT_FLAG = 'kline-studio-manual-card-timeline-compact-v1'
function loadCardBox(id: string): CardBox | null {
  try {
    // The timeline window was redesigned smaller: forget its old remembered size once.
    if (id === 'timeline' && localStorage.getItem(TIMELINE_COMPACT_FLAG) !== '1') {
      localStorage.setItem(TIMELINE_COMPACT_FLAG, '1')
      localStorage.removeItem(CARD_STORAGE_PREFIX + id)
      return null
    }
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
  useLayoutEffect(() => {
    const element = ref.current
    if (element) return registerFloatingCard(id, element)
  }, [id])
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollReady = useRef(false)
  const scrollId = `card-scroll:${id}:${typeof meta === 'string' ? meta : ''}`
  useEffect(() => {
    scrollReady.current = false
    const savedScroll = loadPanelState(scrollId, 0, (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    const frame = requestAnimationFrame(() => {
      if (bodyRef.current) bodyRef.current.scrollTop = savedScroll
      scrollReady.current = true
    })
    return () => cancelAnimationFrame(frame)
  }, [scrollId])
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
      // An old saved size may be larger than the current chart. Bring the
      // resize corner back on screen instead of only preserving the header.
      const height = current.height === null ? null : Math.min(current.height, current.height > rect.height && id === 'panel' ? Math.min(460, rect.height) : rect.height)
      const visibleHeight = height ?? Math.min(card.getBoundingClientRect().height, rect.height)
      const left = Math.max(0, Math.min(rect.width - width, current.left))
      const top = Math.max(0, Math.min(rect.height - visibleHeight, current.top))
      if (left !== current.left || top !== current.top || width !== current.width || height !== current.height) {
        const next = { ...current, left, top, width, height }
        boxRef.current = next
        setBox(next)
        saveCardBox(id, next)
      }
    }
    clamp()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(clamp)
    observer?.observe(parent)
    return () => observer?.disconnect()
  }, [id])

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
      ? { ...start, left: Math.max(0, Math.min(parent.width - start.width, start.left + dx)), top: Math.max(0, Math.min(parent.height - Math.min(start.height ?? ref.current?.getBoundingClientRect().height ?? 40, parent.height), start.top + dy)) }
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
    style={{ ...style, zIndex: 70 }}
    role="dialog"
    aria-label={ariaLabel}
    data-testid={testId}
    onPointerDownCapture={() => { if (ref.current) bringFloatingCardToFront(ref.current) }}
    onFocusCapture={() => { if (ref.current) bringFloatingCardToFront(ref.current) }}
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
    <div className="mp-card-body" ref={bodyRef} onScroll={event => { if (scrollReady.current) savePanelState(scrollId, event.currentTarget.scrollTop) }}>{children}</div>
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

interface ReasonDraft { rows: string[]; unsupported: string }
const validReasonDraft = (value: unknown): value is ReasonDraft => {
  const draft = value as ReasonDraft | null
  return Boolean(draft && Array.isArray(draft.rows) && draft.rows.length > 0 && draft.rows.every(row => typeof row === 'string') && typeof draft.unsupported === 'string')
}

export function ReasonEditor({ cardId = 'reason-editor', title, subtitle, initial = [], required = false, background = null, unsupportedReasons = null, allowClear = false, preserveDraftOnCancel = false, confirmLabel = '保存', tone = 'neutral', draftRef, persistenceId, children, onSave, onCancel }: {
  cardId?: string
  persistenceId?: string
  /** Lets the parent read the unsaved text (e.g. to keep it when the record type is switched). */
  draftRef?: { current: (() => { reasons: string[]; background: string }) | null }
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
  /** Cancelling an unsubmitted order keeps its typed reasons for reopening the same setup. */
  preserveDraftOnCancel?: boolean
  confirmLabel?: string
  tone?: 'neutral' | 'long' | 'short'
  children?: ReactNode
  onSave: (reasons: string[], background: string, unsupportedReasons: string) => void | boolean
  onCancel: () => void
}) {
  // With a background, row 0 is 背景 and rows 1.. are the numbered reasons.
  const offset = background ? 1 : 0
  const [editorDraft, setEditorDraft, discardDraft] = usePanelDraft(`reason:${persistenceId ?? JSON.stringify([cardId, title, typeof subtitle === 'string' ? subtitle : null, initial, background?.initial, unsupportedReasons?.initial])}`, () => ({
    rows: [...(background ? [background.initial] : []), ...(initial.length > 0 ? initial : [''])],
    unsupported: unsupportedReasons?.initial ?? '',
  }), validReasonDraft)
  const rows = editorDraft.rows
  const setRows = (update: (current: string[]) => string[]) => setEditorDraft(current => ({ ...current, rows: update(current.rows) }))
  const unsupportedDraft = editorDraft.unsupported
  // Keep the persisted multiline string compatible with old trades and drafts,
  // but edit each line as a separately numbered reason.
  const unsupportedRows = unsupportedDraft.split(/\r\n|\r|\n/)
  const setUnsupportedRows = (update: (current: string[]) => string[]) => setEditorDraft(current => ({
    ...current, unsupported: update(current.unsupported.split(/\r\n|\r|\n/)).join('\n'),
  }))
  const unsupportedRefs = useRef<Array<HTMLInputElement | null>>([])
  const pendingUnsupportedFocus = useRef<number | null>(null)
  useEffect(() => {
    const index = pendingUnsupportedFocus.current
    if (index === null) return
    pendingUnsupportedFocus.current = null
    const input = unsupportedRefs.current[index]
    input?.focus()
    if (input) input.setSelectionRange(input.value.length, input.value.length)
  })
  const cancel = () => { if (!preserveDraftOnCancel) discardDraft(); onCancel() }
  const [error, setError] = useState('')
  useEffect(() => {
    if (draftRef) draftRef.current = () => ({ reasons: rows.slice(offset).map((row) => row.trim()).filter(Boolean), background: background ? rows[0].trim() : '' })
  })
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
    if (allowClear && !context && reasons.length === 0) { discardDraft(); onSave([], '', ''); return }
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
    if (onSave(reasons, context, unsupportedReasons ? unsupportedRows.map(row => row.trim()).filter(Boolean).join('\n') : '') !== false) discardDraft()
  }

  const goNext = (index: number) => {
    if (index < rows.length - 1) { focusRow(index + 1); return }
    if (!rows[index].trim()) { if (unsupportedReasons) unsupportedRefs.current[0]?.focus(); return }
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
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); return }
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

  const addUnsupportedRow = () => {
    setUnsupportedRows(current => [...current, ''])
    pendingUnsupportedFocus.current = unsupportedRows.length
  }
  const removeUnsupportedRow = (index: number) => {
    setUnsupportedRows(current => current.filter((_, i) => i !== index))
    pendingUnsupportedFocus.current = Math.max(0, index - 1)
  }
  const handleUnsupportedKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>, index: number) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save(); return }
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault()
      if (index > 0) unsupportedRefs.current[index - 1]?.focus()
      else focusRow(rows.length - 1)
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      if (index < unsupportedRows.length - 1) unsupportedRefs.current[index + 1]?.focus()
      else if (unsupportedRows[index].trim()) addUnsupportedRow()
      return
    }
    if (event.key === 'Backspace' && !unsupportedRows[index] && unsupportedRows.length > 1) {
      event.preventDefault(); removeUnsupportedRow(index); return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (index > 0) unsupportedRefs.current[index - 1]?.focus()
      else focusRow(rows.length - 1)
    }
    if (event.key === 'ArrowDown' && index < unsupportedRows.length - 1) {
      event.preventDefault(); unsupportedRefs.current[index + 1]?.focus()
    }
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
    onClose={cancel}
    closeLabel="取消"
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() } }}
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
      {unsupportedReasons && <section className="mp-unsupported-reasons" aria-label="不支持理由条目">
        <span>不支持理由<small>（可选）</small></span>
        <ol className="mp-reason-rows">{unsupportedRows.map((row, index) => <li key={index}>
          <span className="mp-reason-index">{index + 1}</span>
          <input ref={element => { unsupportedRefs.current[index] = element }}
            aria-label={`不支持理由 ${index + 1}`} value={row}
            placeholder="每条填写一个不支持理由"
            onChange={event => { const value = event.target.value; setUnsupportedRows(current => current.map((item, i) => i === index ? value : item)) }}
            onKeyDown={event => handleUnsupportedKeyDown(event, index)}
          />
          {unsupportedRows.length > 1 && <button type="button" tabIndex={-1} aria-label={`删除不支持理由 ${index + 1}`} onClick={() => removeUnsupportedRow(index)}><Trash2 size={14} /></button>}
        </li>)}</ol>
        <button type="button" className="mp-add-row" tabIndex={-1} aria-label="添加不支持理由" onClick={addUnsupportedRow}><Plus size={14} />添加一条</button>
      </section>}
      {error && <p className="mp-editor-error" role="alert">{error}</p>}
      <footer>
        <span className="mp-editor-hint"><kbd>Tab</kbd>/<kbd>Enter</kbd> 下一条 · <kbd>Shift+Tab</kbd> 上一条 · <kbd>Ctrl+Enter</kbd> 保存 · <kbd>Esc</kbd> 取消</span>
        <button type="button" className="mp-secondary" onClick={cancel}>取消</button>
        <button type="button" className={`mp-primary tone-${tone}`} onClick={save}>{confirmLabel}</button>
      </footer>
  </FloatingCard>
}

/* ------------------------------------------------------------------ */
/* Start / history dialog                                              */
/* ------------------------------------------------------------------ */

export function ManualPracticeCenter({ store, days, loading, onStart, onStartLoss, onContinue, onRestart, onReview, onDelete, onClose }: {
  store: ManualPracticeStore
  days: readonly ManualTradingDay[] | null
  loading: boolean
  onStart: (date?: string) => void
  /** Play the losing trades one by one (亏损单汇总). */
  onStartLoss: (filter: ManualLossFilter) => void
  onContinue: (sessionId: string) => void
  /** Start the same trading day over (an unfinished paper is replaced, a finished one is kept). */
  onRestart: (sessionId: string) => void
  onReview: (sessionId: string) => void
  onDelete: (sessionId: string) => void
  onClose: () => void
}) {
  const [startMode, setStartMode] = useState<'random' | 'date'>('random')
  const [selectedDate, setSelectedDate] = useState('')
  const dayCount = days?.length ?? null
  const availableDates = useMemo(() => new Set(days?.map(day => day.key.slice(day.key.lastIndexOf(':') + 1)) ?? []), [days])
  const sortedDates = useMemo(() => [...availableDates].sort(), [availableDates])
  const dateAvailable = availableDates.has(selectedDate)
  const history = useMemo(() => [...store.sessions].sort((a, b) => b.updatedAt - a.updatedAt), [store.sessions])
  const completedCount = history.filter((session) => session.status === 'completed').length
  // The most recently touched unfinished paper is the one "continue" resumes.
  const active = history.find((session) => session.status === 'active') ?? null
  const usedDays = new Set(store.sessions.map((session) => session.dayKey)).size
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmRestartId, setConfirmRestartId] = useState<string | null>(null)
  const [lossFilter, setLossFilter] = useState<ManualLossFilter>('all')
  const loss = useMemo(() => manualLossStats(store.sessions), [store.sessions])
  const lossCounts: Record<ManualLossFilter, number> = { all: loss.total, unseen: loss.unseen, confused: loss.confused, favorite: loss.favorite }
  return <div className="modal-backdrop decision-center-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="decision-center mp-center" role="dialog" aria-modal="true" aria-label="自主逐K复盘">
      <header>
        <span className="decision-center-icon"><NotebookPen size={26} /></span>
        <div><h2>自主逐K复盘 · NQ1!</h2><small>不看 AI 信号，随机抽日或指定日期逐根K线练习，记录每一次做单和不做单的理由</small></div>
        <button aria-label="关闭自主逐K复盘" onClick={onClose}><X size={21} /></button>
      </header>
      <div className="decision-center-body">
        {active && <button className="decision-resume-card" onClick={() => onContinue(active.id)}>
          <Play size={22} /><span><b>继续未完成的卷子：{active.dayLabel}</b><small>已到 {formatBeijing(active.cursorTime)} · {active.trades.length} 笔交易 · 进度自动保存</small></span><ChevronRight size={20} />
        </button>}
        <section className="mp-start">
          <div className="mp-start-copy">
            <h3>{startMode === 'random' ? '随机抽一个交易日' : '指定一个交易日'}</h3>
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
            <div className="mp-start-modes" role="group" aria-label="选择出卷模式">
              <button type="button" aria-pressed={startMode === 'random'} onClick={() => setStartMode('random')}>随机抽日</button>
              <button type="button" aria-pressed={startMode === 'date'} onClick={() => setStartMode('date')}>指定日期</button>
            </div>
            {startMode === 'date' && <label className="mp-date-picker">
              <span>选择交易日期</span>
              <input type="date" value={selectedDate} min={sortedDates[0]} max={sortedDates[sortedDates.length - 1]} disabled={loading} onChange={event => setSelectedDate(event.target.value)} />
              <small className="mp-muted">按 CME 交易日日期选择（与历史卷子日期一致）。{sortedDates.length > 0 && `可选范围：${sortedDates[0]} 至 ${sortedDates[sortedDates.length - 1]}。`}</small>
              {selectedDate && !loading && !dateAvailable && <small role="alert" className="mp-editor-error">该日期没有完整交易日数据，请选择其他日期。</small>}
            </label>}
            <div className="mp-day-count"><CalendarDays size={18} /><span>{dayCount === null ? (loading ? '正在加载 NQ1! 历史…' : 'NQ1! 历史尚未加载') : `共 ${dayCount.toLocaleString('zh-CN')} 个完整交易日 · 已练 ${usedDays} 天`}</span></div>
            <button type="button" className="mp-primary mp-start-button" disabled={loading || (startMode === 'date' && !dateAvailable)} onClick={() => onStart(startMode === 'date' ? selectedDate : undefined)}>
              {startMode === 'date' ? '按指定日期开始' : active ? '另抽一天开始' : '随机抽一天开始'}
            </button>
            {active && <small className="mp-muted">未完成的卷子会保留在下面的历史记录里，随时可以继续。</small>}
          </div>
        </section>
        <section className="mp-loss">
          <h3><TrendingDown size={17} />亏损单汇总 <span>共 {loss.total} 笔 · {formatPoints(loss.totalPoints)} · {formatUsd(loss.totalUsd)}</span></h3>
          {loss.total === 0
            ? <div className="mp-empty">还没有已平仓的亏损单。做完几笔单后，这里可以把所有亏损单轮流再看一遍。</div>
            : <div className="mp-loss-body">
              <div className="mp-loss-info">
                <p className="mp-muted">逐笔回看每一笔亏损单：可以写评论、在图上划线。<kbd>1</kbd> 往后一根K线 · <kbd>2</kbd> 下一笔 · <kbd>3</kbd> 已理解 · <kbd>4</kbd> 不理解 · <kbd>5</kbd> 收藏，已理解/不理解会自动进入下一笔，收藏留在当前这笔。</p>
                <p className="mp-loss-counts"><span className="positive">已理解 {loss.understood}</span><span className="negative">不理解 {loss.confused}</span><span className="star">收藏 {loss.favorite}</span><span>未看 {loss.unseen}</span></p>
              </div>
              <div className="mp-loss-action">
                <div className="mp-start-modes" role="group" aria-label="选择要复盘的亏损单">
                  {([['all', '全部'], ['unseen', '未看'], ['confused', '不理解'], ['favorite', '收藏']] as const).map(([key, label]) =>
                    <button type="button" key={key} aria-pressed={lossFilter === key} onClick={() => setLossFilter(key)}>{label} {lossCounts[key]}</button>)}
                </div>
                <button type="button" className="mp-primary mp-start-button" disabled={loading || lossCounts[lossFilter] === 0} onClick={() => onStartLoss(lossFilter)}>
                  {lossCounts[lossFilter] === 0 ? '这一类暂时没有亏损单' : `开始复盘亏损单（${lossCounts[lossFilter]} 笔）`}
                </button>
              </div>
            </div>}
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
                  <span>{summary.reasonCount} 根已记录K线</span>
                  <span className="mp-history-actions">
                    {done
                      ? <button type="button" className="mp-secondary" onClick={() => onReview(session.id)}><Eye size={14} />复盘</button>
                      : <button type="button" className="mp-secondary" onClick={() => onContinue(session.id)}><Play size={14} />继续</button>}
                    {confirmRestartId === session.id
                      ? <><button type="button" className="mp-danger" onClick={() => { onRestart(session.id); setConfirmRestartId(null) }}>{done ? '确认重做（原成绩保留）' : '确认清空重做'}</button><button type="button" className="mp-secondary" onClick={() => setConfirmRestartId(null)}>取消</button></>
                      : confirmDeleteId === session.id
                        ? <><button type="button" className="mp-danger" onClick={() => { onDelete(session.id); setConfirmDeleteId(null) }}>确认删除</button><button type="button" className="mp-secondary" onClick={() => setConfirmDeleteId(null)}>取消</button></>
                        : <>
                          <button type="button" className="mp-secondary" title={done ? '同一天再做一份新卷子（原来的成绩保留）' : '清空这份卷子的进度，从开盘重新开始'} onClick={() => { setConfirmDeleteId(null); setConfirmRestartId(session.id) }}><RotateCcw size={14} />重新做</button>
                          <button type="button" className="mp-icon" aria-label={`删除 ${session.dayLabel}`} onClick={() => { setConfirmRestartId(null); setConfirmDeleteId(session.id) }}><Trash2 size={14} /></button>
                        </>}
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
      <span>已记录K线 <b>{summary.reasonCount}</b></span>
    </div>
    <section className="mp-trade-results" aria-label="每笔交易盈亏">
      <div className="mp-trade-results-head"><b>每笔交易盈亏</b><span>已实现 <strong className={summary.totalUsd >= 0 ? 'positive' : 'negative'}>{formatUsd(summary.totalUsd)}</strong></span></div>
      <p className="mp-muted">胜率 {summary.winRate === null ? '—' : `${(summary.winRate * 100).toFixed(1)}%`} · 胜 {summary.wins} / 负 {summary.losses} / 平 {summary.closed - summary.wins - summary.losses}（仅统计已平仓）</p>
      {session.trades.length === 0
        ? <p className="mp-muted">成交后在这里显示每笔盈亏</p>
        : <ol className="mp-trade-results-list" tabIndex={0} aria-label="交易盈亏明细（最新在前）">
          {[...session.trades].reverse().map((trade, index) => {
            const closed = trade.exitPrice !== null
            const points = tradePoints(trade, lastPrice)
            const usd = tradeUsd(trade, lastPrice)
            const exitLabel = !closed ? '持仓中 · 浮盈亏' : trade.exitKind === 'stop' ? '止损平仓' : trade.exitKind === 'target' ? '止盈平仓' : trade.exitKind === 'session-end' ? '收盘平仓' : '手动平仓'
            return <li key={trade.id}><details className="mp-trade-reasons">
              <summary aria-label={`第 ${session.trades.length - index} 笔交易详情和理由`}><div className="mp-trade-result-title"><b>第 {session.trades.length - index} 笔 · {trade.side === 'long' ? '多单' : '空单'} ×{tradeQuantity(trade)}</b><span className={usd === null ? 'mp-muted' : usd >= 0 ? 'positive' : 'negative'}>{usd === null ? '待报价' : formatUsd(usd)}</span></div>
              <div className="mp-trade-result-detail"><span>{formatClock(trade.entryTime)} @ {trade.entryPrice.toFixed(2)} → {closed ? `${trade.exitTime === null ? '' : formatClock(trade.exitTime) + ' @ '}${trade.exitPrice!.toFixed(2)}` : lastPrice === null ? '—' : lastPrice.toFixed(2)}</span><span className={points === null ? 'mp-muted' : points >= 0 ? 'positive' : 'negative'}>{points === null ? '—' : formatPoints(points)}</span></div>
              <small className="mp-muted">{exitLabel} · 点击查看理由</small></summary>
              <div className="mp-trade-reasons-body">
                <b>背景</b><p>{trade.background || '未记录'}</p>
                <b>做单理由</b>{trade.reasons.length ? <ol>{trade.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ol> : <p>未记录</p>}
                {trade.unsupportedReasons && <><b>不支持理由</b><p>{trade.unsupportedReasons}</p></>}
                <b>平仓理由</b>{trade.exitReasons.length ? <ol>{trade.exitReasons.map((reason, i) => <li key={i}>{reason}</li>)}</ol> : <p>{closed ? `${exitLabel}，未另记理由` : '尚未平仓'}</p>}
              </div>
            </details></li>
          })}
        </ol>}
    </section>
    <footer>
      <button type="button" className="mp-secondary" onClick={onOpenTimeline}><BookOpenCheck size={14} />{review ? '理由时间线' : '已记录的理由'}</button>
      <button type="button" className="mp-secondary mp-exit" onClick={onExit} title={review ? '退出复盘，回到历史卷子' : '退出本轮：进度已自动保存，可在历史卷子里继续或重新做'}><LogOut size={14} />{review ? '退出复盘' : '退出本轮'}</button>
      {!review && (confirmFinish
        ? <><button type="button" className="mp-danger" onClick={() => { setConfirmFinish(false); onFinish() }}>确认结束（持仓按现价平）</button><button type="button" className="mp-secondary" onClick={() => setConfirmFinish(false)}>取消</button></>
        : <button type="button" className="mp-secondary" onClick={() => setConfirmFinish(true)}>结束今天</button>)}
    </footer>
  </FloatingCard>
}

/** 亏损单复盘: one losing trade at a time. No way to open a new position from here. */
export function ManualLossPanel({ session, trade, index, total, mark, entryComment, exitComment, onAdvance, onNext, onPrevious, onUnderstood, onConfused, onFavorite, onToggleFavorite, onComment, onExit }: {
  session: ManualPracticeSession
  trade: ManualTrade
  index: number
  total: number
  mark: ManualLossMark | null
  entryComment: string
  exitComment: string
  onAdvance: () => void
  onNext: () => void
  onPrevious: () => void
  onUnderstood: () => void
  onConfused: () => void
  onFavorite: () => void
  onToggleFavorite: () => void
  onComment: (kind: 'entry' | 'exit') => void
  onExit: () => void
}) {
  const points = tradePoints(trade) ?? 0
  const usd = tradeUsd(trade) ?? 0
  const understanding = mark?.understanding ?? null
  const progress = total > 0 ? (index + 1) / total : 0
  const reasonList = (items: readonly string[], empty: string) => items.length ? <ol>{items.map((reason, i) => <li key={i}>{reason}</li>)}</ol> : <p className="mp-muted">{empty}</p>
  return <FloatingCard
    id="loss-panel"
    className="mp-panel mp-loss-panel"
    testId="manual-loss-panel"
    ariaLabel="亏损单复盘"
    icon={<TrendingDown size={14} />}
    title="亏损单复盘"
    meta={`${index + 1} / ${total} · ${session.dayLabel}`}
    defaultStyle={{ right: 122, top: 12, width: 330 }}
    minWidth={280}
    minHeight={200}
    onClose={onExit}
    closeLabel="退出亏损单复盘"
  >
    <div className="mp-progress" aria-label={`进度 ${index + 1} / ${total}`}><i style={{ width: `${progress * 100}%` }} /></div>
    <div className={`mp-position side-${trade.side}`}>
      <div className="mp-position-head">
        <b>{trade.side === 'long' ? '多单' : '空单'} ×{tradeQuantity(trade)} · {formatClock(trade.entryTime)} @ {trade.entryPrice.toFixed(2)}</b>
        <span className="negative">{formatPoints(points)} · {formatUsd(usd)}</span>
      </div>
      <div className="mp-muted">{exitLabel(trade)} {trade.exitTime === null ? '' : `${formatClock(trade.exitTime)} `}@ {trade.exitPrice?.toFixed(2)}{trade.stopLoss !== null ? ` · 原定止损 ${trade.stopLoss.toFixed(2)}` : ''}{trade.takeProfit !== null ? ` · 原定止盈 ${trade.takeProfit.toFixed(2)}` : ''}</div>
    </div>
    <div className="mp-loss-status" aria-label="当前标记">
      <span className={`mp-loss-chip ${understanding ?? 'none'}`}>{understanding === 'understood' ? '已理解' : understanding === 'confused' ? '不理解' : '未标记'}</span>
      <button type="button" className={`mp-loss-chip star${mark?.favorite ? ' on' : ''}`} aria-pressed={Boolean(mark?.favorite)} onClick={onToggleFavorite} title={mark?.favorite ? '取消收藏（不会跳到下一笔）' : '收藏（不会跳到下一笔）'}><Star size={12} />{mark?.favorite ? '已收藏' : '收藏'}</button>
    </div>
    <div className="mp-loss-actions">
      <button type="button" className="mp-primary mp-loss-advance" onClick={onAdvance} title="往后揭示一根K线，看开仓之后怎么走"><kbd>1</kbd>往后一根K线</button>
      <button type="button" className="mp-secondary" onClick={onNext} title="看下一笔，不做标记"><kbd>2</kbd>下一笔</button>
      <button type="button" className="mp-long" onClick={onUnderstood}><kbd>3</kbd>已理解</button>
      <button type="button" className="mp-short" onClick={onConfused}><kbd>4</kbd>不理解</button>
      <button type="button" className="mp-note" onClick={onFavorite}><kbd>5</kbd>收藏</button>
    </div>
    <section className="mp-loss-reasons" aria-label="这笔单的理由">
      <div className="mp-trade-reasons-body">
        <b>背景</b><p>{trade.background || '未记录'}</p>
        <b>做单理由</b>{reasonList(trade.reasons, '未记录')}
        {trade.unsupportedReasons && <><b>不支持理由</b><p>{trade.unsupportedReasons}</p></>}
        <b>平仓理由</b>{reasonList(trade.exitReasons, `${exitLabel(trade)}，未另记理由`)}
      </div>
      <div className="mp-loss-comments">
        <button type="button" className="mp-secondary" onClick={() => onComment('entry')}><MessageSquare size={13} />评论开仓{entryComment ? '（已写，点击修改）' : ''}</button>
        <button type="button" className="mp-secondary" onClick={() => onComment('exit')}><MessageSquare size={13} />评论平仓{exitComment ? '（已写，点击修改）' : ''}</button>
      </div>
      {entryComment && <p className="mp-loss-comment"><small>开仓评论</small>{entryComment}</p>}
      {exitComment && <p className="mp-loss-comment"><small>平仓评论</small>{exitComment}</p>}
    </section>
    <footer>
      <button type="button" className="mp-secondary" disabled={index <= 0} onClick={onPrevious}>上一笔</button>
      <button type="button" className="mp-secondary mp-exit" onClick={onExit} title="退出亏损单复盘，回到历史卷子"><LogOut size={14} />退出</button>
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

export function OpenTradeDialog({ side, price, orderKind = null, quantity, stopLoss, takeProfit, initialBackground = '', persistenceId, onStopLoss, onTakeProfit, onConfirm, onCancel }: {
  persistenceId?: string
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
    persistenceId={persistenceId}
    title={`${long ? '做多' : '做空'}${orderKind === 'stop' ? '追单' : orderKind === 'limit' ? '挂单' : ''} ${quantity} 手 @ ${price.toFixed(2)} · 做单理由`}
    subtitle={orderKind ? '追单（stop 入场）：价格突破开仓线才成交，成交后才开始判断止损 / 止盈（每点 $20）。拖动图上的开仓、止损、止盈线调整；手数在开仓线上加减。' : '按当前K线收盘价成交（每点 $20）。拖动止损 / 止盈线调整风险，手数在开仓线上加减。'}
    required
    tone={long ? 'long' : 'short'}
    confirmLabel={orderKind ? (long ? '确认多单挂单' : '确认空单挂单') : (long ? '确认做多' : '确认做空')}
    onCancel={onCancel}
    background={{ initial: initialBackground }}
    unsupportedReasons={{ initial: '' }}
    preserveDraftOnCancel
    onSave={(reasons, background, unsupportedReasons) => {
      if (long ? stopLoss >= price : stopLoss <= price) { setRiskError(`止损必须${long ? '低于' : '高于'}开仓价`); return false }
      if (long ? takeProfit <= price : takeProfit >= price) { setRiskError(`止盈必须${long ? '高于' : '低于'}开仓价`); return false }
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

export function ManualPracticeAnnotations({ session, interval, hidden, toX, toY, highlightItem = null, highlightTime = null, highlightPrice = null, hideLevels = false, clipAfterBar = null, barRange, onOpenBar }: {
  session: ManualPracticeSession
  /** Clicking a number opens that candle's reason for editing. */
  onOpenBar?: (barTime: number) => void
  /** High / low of a candle (by bar open time): entry arrows sit outside it so they never cover the candle. */
  barRange?: (barTime: number) => { high: number; low: number } | null
  /** Review replay: hide everything right of this candle (bar open times of the newest and the one before). */
  clipAfterBar?: { last: number; previous: number | null } | null
  interval: IntervalId
  hidden: boolean
  toX: (time: number) => number | null
  toY: (price: number) => number | null
  highlightItem?: ManualTimelineItem | null
  highlightTime?: number | null
  /** Price to ring on the highlighted candle (entry / exit fills). */
  highlightPrice?: number | null
  /** The draggable risk overlay already draws the open position's entry / stop / target. */
  hideLevels?: boolean
}) {
  if (hidden) return null
  const isBarRevealed = (time: number) => !clipAfterBar || barTimeFor(time, interval) <= clipAfterBar.last
  const openPosition = openTrade(session)
  const position = openPosition && isBarRevealed(openPosition.entryTime) ? openPosition : null
  const snap = (time: number) => toX(barTimeFor(time, interval))
  const seqBars = new Map<number, { seqs: number[]; cls: string }>()
  for (const { item, seq } of manualReasonRows(session)) {
    const bar = barTimeFor(item.time, interval)
    if (!isBarRevealed(bar)) continue
    const entry = seqBars.get(bar) ?? { seqs: [], cls: item.kind === 'entry' ? `entry-${item.trade?.side ?? 'long'}` : 'note' }
    entry.seqs.push(seq)
    seqBars.set(bar, entry)
  }
  const line = (price: number | null, className: string, label: string) => {
    if (price === null) return null
    const y = toY(price)
    if (y === null) return null
    return <div className={`mp-level ${className}`} style={{ top: y }}><span>{label} {price.toFixed(2)}</span></div>
  }
  let clipRightX: number | null = null
  if (clipAfterBar) {
    const lastX = toX(clipAfterBar.last)
    const previousX = clipAfterBar.previous === null ? null : toX(clipAfterBar.previous)
    clipRightX = lastX === null ? 0 : lastX + (previousX !== null && lastX > previousX ? (lastX - previousX) / 2 : 3)
  }
  return <div className="mp-annotations" aria-hidden="true" style={clipRightX === null ? undefined : { clipPath: `inset(0px calc(100% - ${Math.max(0, clipRightX)}px) 0px 0px)` }}>
    {highlightItem && isBarRevealed(highlightItem.time) && manualItemRisk(highlightItem) && (() => {
      const plan = manualItemRisk(highlightItem)!
      const x = snap(highlightItem.time)
      const entryY = toY(plan.entryPrice)
      const short = highlightItem.note?.side === 'short' || highlightItem.trade?.side === 'short' || highlightItem.cancelledOrder?.side === 'short'
      if (x === null) return null
      return <>
        {([[plan.entryPrice, 'entry', '初始入场'], [plan.stopLoss, 'stop', '初始止损'], [plan.takeProfit, 'target', '初始止盈']] as const).map(([price, kind, label]) => {
          const y = toY(price)
          return y === null ? null : <div key={kind} className={`mp-initial-risk-line ${kind}`} style={{ top: y, left: Math.max(0, x) }}><span>{label} {price.toFixed(2)}</span></div>
        })}
        {entryY !== null && <div className={`mp-initial-risk-summary ${short ? 'is-short' : 'is-long'}`} style={{ top: entryY }}><strong>盈亏比 {manualRiskRatio(plan).toFixed(2)} : 1</strong><span className="negative">风险 {Math.abs(plan.entryPrice - plan.stopLoss).toFixed(2)} 点</span><span className="positive">收益 {Math.abs(plan.takeProfit - plan.entryPrice).toFixed(2)} 点</span></div>}
      </>
    })()}
    {position && !hideLevels && <>
      {line(position.entryPrice, 'entry', position.side === 'long' ? '多单' : '空单')}
      {line(position.stopLoss, 'stop', '止损')}
      {line(position.takeProfit, 'target', '止盈')}
    </>}
    {session.trades.map((trade) => {
      if (!isBarRevealed(trade.entryTime)) return null
      const entryX = snap(trade.entryTime)
      const entryY = toY(trade.entryPrice)
      // The arrow hugs the outside of the entry candle (above the high for shorts, below the low for longs).
      const range = barRange?.(barTimeFor(trade.entryTime, interval)) ?? null
      const arrowY = range ? toY(trade.side === 'long' ? range.low : range.high) : entryY
      const arrowTop = arrowY === null ? null : arrowY + (trade.side === 'long' ? 5 : -5)
      // Cropping a future exit still leaks its direction and price through the
      // visible half of the dashed connection. Wait for the exit candle itself.
      const exitRevealed = trade.exitTime !== null && isBarRevealed(trade.exitTime)
      const exitX = exitRevealed ? snap(trade.exitTime!) : null
      const exitY = exitRevealed && trade.exitPrice !== null ? toY(trade.exitPrice) : null
      const points = exitRevealed ? tradePoints(trade) : null
      return <div key={trade.id}>
        {entryX !== null && arrowTop !== null && <span className={`mp-marker entry side-${trade.side}`} style={{ left: entryX, top: arrowTop }} title={trade.reasons.join('\n')}>{trade.side === 'long' ? '▲' : '▼'}</span>}
        {exitX !== null && exitY !== null && <span className={`mp-marker exit${points !== null && points < 0 ? ' loss' : ''}`} style={{ left: exitX, top: exitY }} title={`${exitLabel(trade)} ${points !== null ? formatPoints(points) : ''}`}>✕</span>}
        {entryX !== null && entryY !== null && exitX !== null && exitY !== null && <svg className="mp-trade-path"><line x1={entryX} y1={entryY} x2={exitX} y2={exitY} className={points !== null && points < 0 ? 'loss' : 'win'} /></svg>}
      </div>
    })}
    {[...seqBars.entries()].map(([bar, info]) => {
      const x = toX(bar)
      if (x === null) return null
      // Numbers sit in a thin lane along the top of the chart, never on a candle or drawing.
      const title = `理由 ${info.seqs.join('、')}`
      return <Fragment key={bar}><div className="mp-seq-line" style={{ left: x }} /><span className={`mp-note-badge ${info.cls}${highlightTime === bar ? ' highlight' : ''}`} style={{ left: x }} title={`${title}（点击编辑）`} onClick={() => onOpenBar?.(bar)}>{info.seqs.join(',')}</span></Fragment>
    })}
    {highlightTime !== null && isBarRevealed(highlightTime) && (() => {
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

function InitialRiskSummary({ item }: { item: ManualTimelineItem }) {
  const plan = manualItemRisk(item)
  if (!plan) return item.kind === 'no-trade' ? null : <p className="mp-muted">未记录初始止盈止损</p>
  return <p className="mp-initial-risk-text">初始入场 {plan.entryPrice.toFixed(2)} · <span className="negative">止损 {plan.stopLoss.toFixed(2)}</span> · <span className="positive">止盈 {plan.takeProfit.toFixed(2)}</span><br /><b>盈亏比 {manualRiskRatio(plan).toFixed(2)} : 1</b></p>
}

export function ManualTimelineDialog({ session, onClose, onJump, onEditItem, onReviewItem }: {
  session: ManualPracticeSession
  onClose: () => void
  /** Locate the candle a reason belongs to (and mark it on the chart). */
  onJump: (item: ManualTimelineItem) => void
  onEditItem: (item: ManualTimelineItem) => void
  onReviewItem?: (item: ManualTimelineItem) => void
}) {
  const summary = sessionSummary(session)
  const [filter, setFilter] = usePanelDraft<'all' | 'entry' | 'no-trade' | 'should-trade' | 'exit' | 'cancelled-order'>(`timeline:${session.id}:filter`, () => 'all', (value): value is 'all' | 'entry' | 'no-trade' | 'should-trade' | 'exit' | 'cancelled-order' => typeof value === 'string' && ['all', 'entry', 'no-trade', 'should-trade', 'exit', 'cancelled-order'].includes(value))
  const [selectedKey, setSelectedKey] = usePanelDraft<string | null>(`timeline:${session.id}:selected`, () => null, (value): value is string | null => value === null || typeof value === 'string')
  // One card per trade: the entry and the exit it ended with belong together. 平仓理由 only exists
  // for exits the user chose to make; stop / target / end-of-day exits are passive.
  const rows = manualReasonRows(session)
  const visible = rows.filter(({ item, exit, biasItems }) => filter === 'all'
    || (filter === 'exit' ? Boolean(exit && !exit.passive) : (biasItems ?? [item]).some(entry => entry.kind === filter)))
  const commentFor = (item: ManualTimelineItem) => session.reviewComments?.[manualReviewCommentKey(item)]?.text ?? ''
  const reviewAction = (item: ManualTimelineItem, label = '复盘评论') => onReviewItem && <button type="button" className="mp-review-action"
    aria-label={`${commentFor(item) ? '编辑' : '添加'}${label}`} title={label}
    onClick={event => { event.stopPropagation(); onReviewItem(item) }}><MessageSquare size={12} />评论</button>
  const reviewComment = (item: ManualTimelineItem) => commentFor(item) && <div className="mp-review-comment" onClick={event => event.stopPropagation()}>
    <b>复盘评论</b><p>{commentFor(item)}</p>
  </div>
  return <FloatingCard
    id="timeline"
    className="mp-timeline"
    ariaLabel="理由时间线"
    icon={<BookOpenCheck size={14} />}
    title="理由时间线"
    meta={`${session.dayLabel} · ${session.status === 'completed' ? '已完成' : '进行中'}`}
    defaultStyle={{ left: 64, top: 70, width: 400, height: 420 }}
    minWidth={300}
    minHeight={200}
    onClose={onClose}
  >
        <div className="mp-summary-grid">
          <div><small>交易</small><b>{summary.trades}</b></div>
          <div><small>胜 / 负</small><b>{summary.wins} / {summary.losses}</b></div>
          <div><small>胜率</small><b>{summary.winRate === null ? '—' : `${Math.round(summary.winRate * 100)}%`}</b></div>
          <div><small>已实现</small><b className={summary.totalPoints >= 0 ? 'positive' : 'negative'}>{formatPoints(summary.totalPoints)}</b><small>{formatUsd(summary.totalUsd)}</small></div>
          <div><small>未开单 / 应开单</small><b>{summary.noTradeNotes} / {summary.shouldTradeNotes}</b></div>
          <div><small>已记录理由的K线数</small><b>{summary.reasonCount}</b></div>
        </div>
        <div className="mp-filter" role="group" aria-label="筛选理由">
          {([['all', '全部'], ['entry', '做单理由'], ['no-trade', '未开单理由'], ['should-trade', '应该开单理由'], ['exit', '平仓理由'], ['cancelled-order', '已取消挂单']] as const).map(([key, label]) => <button type="button" key={key} className={filter === key ? 'active' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}
        </div>
        {visible.length === 0
          ? <div className="mp-empty">这一类还没有记录。</div>
          : <ol className="mp-timeline-list">
            {visible.map(({ item, exit, seq, biasItems }, index) => {
              const itemKey = `${item.kind}-${item.time}-${item.trade?.id ?? item.cancelledOrder?.id ?? item.note?.interval ?? ''}`
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
                  <div className="mp-timeline-title"><span className={`mp-seq ${item.kind === 'entry' ? `entry-${item.trade?.side ?? 'long'}` : 'note'}`} title={`序号 ${seq}`}>{seq}</span><b>{biasItems ? `${INTERVALS[item.note!.interval].label} K线 · 偏向与理由` : item.title}</b>
                    {!biasItems && reviewAction(item)}
                    <button type="button" className="mp-icon" aria-label="编辑理由" title="编辑理由" onClick={(event) => { event.stopPropagation(); onEditItem(item) }}><Pencil size={13} /></button>
                  </div>
                  {item.background !== null && <p className={`mp-timeline-background${item.background ? '' : ' missing'}`}><span>背景</span>{item.background || '未填写'}</p>}
                  {item.cancelledOrder && <p className="mp-cancelled-order-detail">未成交 · 撤单 {formatBeijing(item.cancelledOrder.cancelledTime)} · {item.cancelledOrder.quantity} 手<br />原计划止损 {item.cancelledOrder.stopLoss.toFixed(2)} · 止盈 {item.cancelledOrder.takeProfit.toFixed(2)}</p>}
                  {!biasItems && <InitialRiskSummary item={item} />}
                  {biasItems ? biasItems.map((entry, rank) => <div className="mp-timeline-bias" key={entry.kind === 'no-trade' ? 'no-trade' : entry.note?.side} onClick={event => { event.stopPropagation(); select(entry, itemKey) }}>
                    <div className="mp-bias-heading"><b>{rank + 1}. {entry.kind === 'no-trade' ? '不开单' : entry.note?.side === 'short' ? '做空' : '做多'}{rank === 0 ? ' · 最偏向' : ''}</b>{reviewAction(entry, `${entry.kind === 'no-trade' ? '不开单' : entry.note?.side === 'short' ? '做空' : '做多'}复盘评论`)}</div>
                    {entry.reasons.length > 0 ? <ol className="mp-reason-list">{entry.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ol> : <p className="mp-muted">未填写理由</p>}
                    <InitialRiskSummary item={entry} />
                    {reviewComment(entry)}
                  </div>) : item.reasons.length > 0
                    ? <ol className="mp-reason-list">{item.reasons.map((reason, reasonIndex) => <li key={reasonIndex}>{reason}</li>)}</ol>
                    : <p className="mp-muted">{item.kind === 'no-trade' || item.kind === 'should-trade' ? '只写了背景，没有分条理由' : '未填写理由'}</p>}
                  {(item.kind === 'entry' || item.kind === 'cancelled-order') && item.unsupportedReasons?.trim() && <div className="mp-timeline-unsupported"><span>不支持理由</span><ol className="mp-reason-list">{item.unsupportedReasons.split(/\r\n|\r|\n/).map(reason => reason.trim()).filter(Boolean).map((reason, index) => <li key={index}>{reason}</li>)}</ol></div>}
                  {!biasItems && reviewComment(item)}
                  {exit && exitKey && <div className={`mp-timeline-exit${selectedKey === exitKey ? ' selected' : ''}`} onClick={(event) => { event.stopPropagation(); select(exit, exitKey) }} title="点击在图上定位到平仓这根K线并标注">
                    <div className="mp-timeline-title"><b>{exit.title}</b>{points !== null && <span className={points >= 0 ? 'positive' : 'negative'}>{formatPoints(points)} · {formatUsd((exit.trade ? tradeUsd(exit.trade) : null) ?? points * NQ_POINT_VALUE_USD)}</span>}
                      {reviewAction(exit, '平仓复盘评论')}
                      {!exit.passive && <button type="button" className="mp-icon" aria-label="编辑平仓理由" title="编辑平仓理由" onClick={(event) => { event.stopPropagation(); onEditItem(exit) }}><Pencil size={13} /></button>}
                    </div>
                    {exit.reasons.length > 0
                      ? <ol className="mp-reason-list">{exit.reasons.map((reason, reasonIndex) => <li key={reasonIndex}>{reason}</li>)}</ol>
                      : exit.passive ? null : <p className="mp-muted">未填写平仓理由</p>}
                    {reviewComment(exit)}
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
/** Review look-back control above the time axis: pick a candle to replay from, then 1 = next candle, 2 = exit. */
export function ManualReplayControls({ picking, replayTime, onPick, onExit }: {
  picking: boolean
  /** Bar open time of the newest candle while replaying, otherwise null. */
  replayTime: number | null
  onPick: () => void
  onExit: () => void
}) {
  return <div className={`mp-replay-controls${replayTime !== null ? ' is-replaying' : ''}`} role="group" aria-label="复盘回放">
    {replayTime !== null && <span className="mp-replay-status"><b>回放中</b><em>{formatBeijing(replayTime)}</em><span><kbd>1</kbd>下一根</span><span><kbd>2</kbd>退出</span></span>}
    <button type="button" className={picking ? 'active' : ''} aria-pressed={picking} onClick={onPick} title="点击图上任意一根K线，从那里开始回放（Esc 取消）"><Rewind size={14} />{picking ? '点图上的K线…' : '往回选K线'}</button>
    {replayTime !== null && <button type="button" onClick={onExit} title="退出回放，恢复全部K线和绘图（快捷键 2）"><X size={13} />退出回放</button>}
  </div>
}

export function ManualBarPicker({ interval, maxBarTime, toTime, toX, onPick, onCancel, hint = '点击要记录的K线（只能选已出现的）· Esc 取消' }: {
  /** Text shown while picking. */
  hint?: string
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
      if (event.key !== 'Escape' && event.code !== 'Escape' && event.keyCode !== 27) return
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
    <div className="mp-picker-hint" role="button" title="点击取消选择" onClick={onCancel}>{hint}</div>
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
