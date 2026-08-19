import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import {
  Archive, BarChart3, Check, ChevronRight, CircleDollarSign, Eye, Flag, History, LogOut,
  MousePointer2, Play, RotateCcw, Shield, Star, Target, X,
} from 'lucide-react'
import type { ReplayDecisionCandidate } from '../lib/replayTradeRegistry'
import type {
  DecisionAttempt, DecisionPositionSizingMode, DecisionReplaySession, DecisionTradeResult,
} from '../lib/decisionReplay'
import {
  aggregateDecisionResults, decisionPositionSizingLabel, decisionResultPnl,
  decisionSessionPositionSizingModes, DEFAULT_DECISION_POSITION_SIZING_MODES,
  formatDecisionDate, rewardRiskRatio, sessionResults, symbolPrecision,
} from '../lib/decisionReplay'
import { formatPrice, INTERVALS, SYMBOLS, type Candle, type SymbolId } from '../lib/market'
import { extractReasonCandleIndexes, resolveTradeCandleReferences } from '../lib/tradeCandleReferences'
import {
  loadDecisionReplayMenuPreferences, loadDecisionReplayPanelPreferences,
  saveDecisionReplayMenuPreferences, saveDecisionReplayPanelPreferences,
  type DecisionReplayMenuPreferences, type DecisionReplayPanelPreferences,
  type TradeMarkerPanelPosition, type TradeMarkerPanelSize,
} from '../lib/persistence'
import { decisionReplayFavoriteKey } from '../lib/decisionReplayFavorites'

const DECISION_PANEL_EDGE = 8
const DECISION_PANEL_MIN_WIDTH = 390
const DECISION_PANEL_MIN_HEIGHT = 330
const DECISION_MENU_EDGE = 8

function clampDecisionPanelPosition(position: TradeMarkerPanelPosition, containerRect: DOMRect, panelRect: DOMRect): TradeMarkerPanelPosition {
  return {
    left: Math.min(Math.max(DECISION_PANEL_EDGE, containerRect.width - panelRect.width - DECISION_PANEL_EDGE), Math.max(DECISION_PANEL_EDGE, position.left)),
    top: Math.min(Math.max(DECISION_PANEL_EDGE, containerRect.height - panelRect.height - DECISION_PANEL_EDGE), Math.max(DECISION_PANEL_EDGE, position.top)),
  }
}

function clampDecisionPanelSize(size: TradeMarkerPanelSize, position: TradeMarkerPanelPosition, containerRect: DOMRect): TradeMarkerPanelSize {
  const maxWidth = Math.max(1, containerRect.width - position.left - DECISION_PANEL_EDGE)
  const maxHeight = Math.max(1, containerRect.height - position.top - DECISION_PANEL_EDGE)
  return {
    width: Math.min(maxWidth, Math.max(Math.min(DECISION_PANEL_MIN_WIDTH, maxWidth), size.width)),
    height: Math.min(maxHeight, Math.max(Math.min(DECISION_PANEL_MIN_HEIGHT, maxHeight), size.height)),
  }
}

function decisionPanelStyle(preferences: DecisionReplayPanelPreferences): CSSProperties | undefined {
  if (!preferences.position && !preferences.size) return undefined
  return {
    ...(preferences.position ? { left: `${preferences.position.left}px`, top: `${preferences.position.top}px`, right: 'auto' } : {}),
    ...(preferences.size ? { width: `${preferences.size.width}px`, height: `${preferences.size.height}px`, maxWidth: 'none', maxHeight: 'none' } : {}),
  }
}

function clampDecisionMenuPosition(position: TradeMarkerPanelPosition, containerRect: DOMRect, menuRect: DOMRect): TradeMarkerPanelPosition {
  return {
    left: Math.min(Math.max(DECISION_MENU_EDGE, containerRect.width - menuRect.width - DECISION_MENU_EDGE), Math.max(DECISION_MENU_EDGE, position.left)),
    top: Math.min(Math.max(DECISION_MENU_EDGE, containerRect.height - menuRect.height - DECISION_MENU_EDGE), Math.max(DECISION_MENU_EDGE, position.top)),
  }
}

function decisionMenuStyle(preferences: DecisionReplayMenuPreferences): CSSProperties | undefined {
  if (!preferences.position) return undefined
  return {
    left: `${preferences.position.left}px`,
    top: `${preferences.position.top}px`,
    right: 'auto',
    bottom: 'auto',
    transform: 'none',
  }
}

function money(value: number) {
  const sign = value > 0 ? '+' : ''
  return `${sign}$${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function DecisionModeMoneyStack({ modes, valueFor, className = '', compact = true, valueLabel }: {
  modes: readonly DecisionPositionSizingMode[]
  valueFor: (mode: DecisionPositionSizingMode) => number
  className?: string
  compact?: boolean
  valueLabel?: (value: number, mode: DecisionPositionSizingMode) => string
}) {
  return <span className={`decision-mode-stack ${className}`.trim()}>
    {modes.map((mode) => {
      const value = valueFor(mode)
      return <span className="decision-mode-value" key={mode}>
        <small>{decisionPositionSizingLabel(mode, compact)}</small>
        <b className={value >= 0 ? 'positive' : 'negative'}>{valueLabel ? `${valueLabel(value, mode)} ` : ''}{money(value)}</b>
      </span>
    })}
  </span>
}

function decisionModeMetricText(modes: readonly DecisionPositionSizingMode[], valueFor: (mode: DecisionPositionSizingMode) => string) {
  return modes.map((mode) => `${decisionPositionSizingLabel(mode, true)} ${valueFor(mode)}`).join(' · ')
}

function decisionSizingLabels(modes: readonly DecisionPositionSizingMode[]) {
  return modes.map((mode) => decisionPositionSizingLabel(mode)).join(' · ')
}

function formatDecisionPnl(value: number) {
  if (value === 0) return '$0.00'
  return `${value > 0 ? '+' : '-'}$${Math.abs(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function statusLabel(status: DecisionReplaySession['status']) {
  if (status === 'active') return '进行中'
  if (status === 'completed') return '已完成'
  return '已提前退出'
}

function orderKindLabel(kind: DecisionAttempt['orderKind']) {
  if (kind === 'limit') return '限价挂单'
  if (kind === 'stop') return '突破挂单'
  return '待确定'
}

function choiceLabel(result: DecisionTradeResult) {
  if (result.choice === 'skipped') return '未参与'
  if (result.choice === 'unfilled') return '挂单未成交'
  const mode = result.entryMode === 'signal-extreme' ? '本 K 突破价' : '自由选价'
  return `${mode} · ${orderKindLabel(result.orderKind)}`
}

function exitReasonLabel(reason: DecisionTradeResult['userExit']['reason']) {
  const labels: Record<DecisionTradeResult['userExit']['reason'], string> = {
    skipped: '主动不参与',
    'manual-close': '按 K 线收盘价手动离场',
    'stop-loss': '触及止损',
    'take-profit': '触及止盈',
    'end-of-data': '行情数据结束',
  }
  return labels[reason]
}

function highlightDecisionReasonIndexes(reason: string, referenceIndexes: ReadonlySet<number>): ReactNode {
  if (referenceIndexes.size === 0) return reason
  const parts: ReactNode[] = []
  let cursor = 0
  for (const match of reason.matchAll(/\d+/g)) {
    const offset = match.index ?? 0
    const token = match[0]
    const index = Number(token)
    if (!referenceIndexes.has(index)) continue
    if (offset > cursor) parts.push(reason.slice(cursor, offset))
    parts.push(<span key={`decision-reason-${offset}-${index}`} className="trade-marker-k-index" title={`图中已标注 K${index}`} aria-label={`K线序号 ${index}，图中已标注`}>K{index}</span>)
    cursor = offset + token.length
  }
  if (cursor === 0) return reason
  if (cursor < reason.length) parts.push(reason.slice(cursor))
  return parts
}

function highlightDecisionReason(reason: string, referenceIndexes: ReadonlySet<number>): ReactNode {
  const clauses = reason.match(/[^。！？；]+[。！？；]?/g) ?? [reason]
  return clauses.map((clause, index) => {
    const isKeyClause = index === clauses.length - 1 || /构成可执行|已形成|明确跟随|未获接受|失败破位|失败上攻|强反向|移动止盈|固定初始止损/.test(clause)
    const content = highlightDecisionReasonIndexes(clause, referenceIndexes)
    return isKeyClause
      ? <strong key={`decision-reason-clause-${index}`} className="trade-marker-reason-emphasis">{content}</strong>
      : <span key={`decision-reason-clause-${index}`}>{content}</span>
  })
}

function DecisionFavoriteButton({ favorite, onToggle, label }: { favorite: boolean; onToggle: () => void; label: string }) {
  return <button
    type="button"
    className={`decision-favorite-button${favorite ? ' active' : ''}`}
    aria-label={label}
    aria-pressed={favorite}
    title={label}
    onPointerDown={(event) => event.stopPropagation()}
    onKeyDown={(event) => event.stopPropagation()}
    onClick={(event) => {
      event.stopPropagation()
      onToggle()
    }}
  ><Star size={17} fill={favorite ? 'currentColor' : 'none'} /></button>
}

export interface DecisionSymbolStats {
  symbol: SymbolId
  total: number
  remaining: number
}

export function DecisionReplayCenter({ open, availableCount, totalCount, symbolStats, sessions, activeSessionId, favoriteKeys = [], onToggleFavorite = () => undefined, onClose, onStart, onContinue, onResults }: {
  open: boolean
  availableCount: number
  totalCount: number
  symbolStats: DecisionSymbolStats[]
  sessions: DecisionReplaySession[]
  activeSessionId: string | null
  onClose: () => void
  onStart: (count: number, symbols: SymbolId[], positionSizingModes: DecisionPositionSizingMode[]) => void
  onContinue: () => void
  onResults: (sessionId: string) => void
  favoriteKeys?: readonly string[]
  onToggleFavorite?: (key: string) => void
}) {
  const [count, setCount] = useState(30)
  const [selectedSymbols, setSelectedSymbols] = useState<SymbolId[]>(() => symbolStats.filter((item) => item.remaining > 0).map((item) => item.symbol))
  const [selectedModes, setSelectedModes] = useState<DecisionPositionSizingMode[]>(() => [...DEFAULT_DECISION_POSITION_SIZING_MODES])
  const selectedStats = symbolStats.filter((item) => selectedSymbols.includes(item.symbol))
  const selectedAvailableCount = selectedStats.reduce((sum, item) => sum + item.remaining, 0)
  const selectedTotalCount = selectedStats.reduce((sum, item) => sum + item.total, 0)
  const effectiveAvailableCount = symbolStats.length > 0 ? selectedAvailableCount : availableCount
  const effectiveTotalCount = symbolStats.length > 0 ? selectedTotalCount : totalCount
  const boundedCount = Math.max(1, Math.min(count, Math.max(1, effectiveAvailableCount)))

  if (!open) return null
  return <div className="modal-backdrop decision-center-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="decision-center" role="dialog" aria-modal="true" aria-label="决策回放中心">
      <header>
        <span className="decision-center-icon"><CircleDollarSign size={27} /></span>
        <div><h2>决策回放</h2><small>在不知道未来走势的前提下，重做系统收到信号后的每一步决策</small></div>
        <button aria-label="关闭决策回放中心" onClick={onClose}><X size={21} /></button>
      </header>
      <div className="decision-center-body">
        {activeSessionId && <button className="decision-resume-card" onClick={onContinue}>
          <Play size={22} /><span><b>继续未完成的决策回放</b><small>当前进度已自动保存</small></span><ChevronRight size={20} />
        </button>}
        <section className="decision-new-session">
          <div><h3>开始新的随机练习</h3><p>从所有可用模拟订单中打乱抽取，已经出现过的交易不会再次抽到。</p></div>
          <div className="decision-symbol-filter" aria-label="选择练习标的">
            <div className="decision-symbol-filter-head"><b>选择标的</b><span>可多选，随机抽取只使用已勾选的标的</span></div>
            <div className="decision-symbol-options">
              {symbolStats.length === 0 ? <span className="decision-symbol-empty">当前没有可用的模拟交易</span> : symbolStats.map((item) => {
                const info = SYMBOLS.find((symbol) => symbol.id === item.symbol)
                const disabled = item.remaining === 0
                return <label key={item.symbol} className={`decision-symbol-option${disabled ? ' is-disabled' : ''}`}>
                  <input
                    type="checkbox"
                    checked={selectedSymbols.includes(item.symbol)}
                    disabled={disabled}
                    onChange={() => setSelectedSymbols((current) => current.includes(item.symbol)
                      ? current.filter((symbol) => symbol !== item.symbol)
                      : [...current, item.symbol])}
                  />
                  <span className="decision-symbol-option-copy"><b>{item.symbol}</b><small>{info?.name ?? '未知标的'}</small></span>
                  <span className="decision-symbol-option-count">共 {item.total.toLocaleString('zh-CN')} 笔 · 剩余 {item.remaining.toLocaleString('zh-CN')} 笔</span>
                </label>
              })}
            </div>
          </div>
          <div className="decision-sizing-filter" aria-label="选择仓位计算方式">
            <div className="decision-symbol-filter-head"><b>仓位计算方式</b><span>可单选，也可同时勾选两种口径并行对比</span></div>
            <div className="decision-sizing-options">
              {([
                ['fixed-risk', '固定风险 100U', '按入场价到初始止损距离计算数量，每笔计划风险固定 100U'],
                ['fixed-notional', '固定仓位 10,000U', '每笔名义仓位固定 10,000U，盈亏按价格涨跌幅计算'],
              ] as const).map(([mode, title, description]) => <label key={mode} className="decision-sizing-option">
                <input
                  type="checkbox"
                  checked={selectedModes.includes(mode)}
                  onChange={() => setSelectedModes((current) => current.includes(mode)
                    ? current.filter((item) => item !== mode)
                    : [...current, mode])}
                />
                <span><b>{title}</b><small>{description}</small></span>
              </label>)}
            </div>
          </div>
          <label><span>交易数量 N</span><input className="decision-count-input" type="number" min="1" max={Math.max(1, effectiveAvailableCount)} value={boundedCount} disabled={effectiveAvailableCount === 0} onChange={(event) => setCount(Math.max(1, Number(event.target.value) || 1))} /></label>
          <div className="decision-availability"><b>{effectiveAvailableCount.toLocaleString('zh-CN')}</b> 笔未练习 / 共 {effectiveTotalCount.toLocaleString('zh-CN')} 笔</div>
          <button className="decision-primary" disabled={effectiveAvailableCount === 0 || selectedSymbols.length === 0 || selectedModes.length === 0} onClick={() => onStart(boundedCount, selectedSymbols, selectedModes)}>随机抽取并开始</button>
        </section>
        <section className="decision-archives">
          <div className="decision-section-heading"><Archive size={18} /><h3>永久练习存档</h3><span>{sessions.length} 场</span></div>
          {sessions.length === 0 ? <div className="decision-empty">完成或提前退出一场练习后，结果会永久保存在这里。</div> : <div className="decision-session-list">
            {sessions.map((session) => {
              const results = sessionResults(session)
              const modes = decisionSessionPositionSizingModes(session)
              const favoriteKey = decisionReplayFavoriteKey('session', session.id)
              return <div
                key={session.id}
                className="decision-session-row"
                role="button"
                tabIndex={0}
                onClick={() => onResults(session.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onResults(session.id)
                  }
                }}
              >
                <span className={`decision-session-status ${session.status}`}>{statusLabel(session.status)}</span>
                <span><b>{results.length} / {session.candidates.length} 笔</b><small>{new Date(session.startedAt).toLocaleString('zh-CN')}</small></span>
                <DecisionModeMoneyStack modes={modes} valueFor={(mode) => aggregateDecisionResults(results, mode).userPnlUsd} />
                <span className="decision-list-actions"><DecisionFavoriteButton favorite={favoriteKeys.includes(favoriteKey)} onToggle={() => onToggleFavorite(favoriteKey)} label={favoriteKeys.includes(favoriteKey) ? '取消收藏本场练习' : '收藏本场练习'} /><ChevronRight size={18} /></span>
              </div>
            })}
          </div>}
        </section>
      </div>
    </section>
  </div>
}

/**
 * A compact, symbol-scoped index of completed decision exercises.
 * Opening a card delegates to the existing results dialog, whose individual
 * rows restore the original drawing snapshot and decision review view.
 */
export function DecisionHistoryDialog({ open, currentSymbol, sessions, onClose, onOpenSession, favoriteKeys = [], onToggleFavorite = () => undefined }: {
  open: boolean
  currentSymbol: string
  sessions: DecisionReplaySession[]
  onClose: () => void
  onOpenSession: (sessionId: string) => void
  favoriteKeys?: readonly string[]
  onToggleFavorite?: (key: string) => void
}) {
  const entries = sessions.map((session) => {
    const candidates = session.candidates.filter((candidate) => candidate.symbol === currentSymbol)
    const results = sessionResults(session).filter((result) => result.candidate.symbol === currentSymbol)
    // A session is useful history as soon as it has real progress.  Previously
    // the list required at least one result, which made a partially completed
    // exercise look as if it had never been saved.
    const hasProgress = session.status !== 'active'
      || session.currentIndex > 0
      || session.attempts.some((attempt) => {
        const candidate = session.candidates.find((item) => item.key === attempt.candidateKey)
        return attempt.stage !== 'entry-decision'
          || attempt.drawings.length > 0
          || Boolean(attempt.result)
          || (candidate ? attempt.cursorTime !== candidate.trade.entry.signalTime : false)
      })
    const modes = decisionSessionPositionSizingModes(session)
    const intervals = [...new Set(candidates.map((candidate) => INTERVALS[candidate.interval].label))]
    return { session, candidates, results, modes, intervals, hasProgress }
  }).filter((entry) => entry.candidates.length > 0 && entry.hasProgress)

  if (!open) return null
  const historyModes = [...new Set(entries.flatMap((entry) => entry.modes))]
  return <div className="modal-backdrop decision-history-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="decision-history" role="dialog" aria-modal="true" aria-label="决策历史记录" data-testid="decision-history-dialog">
      <header>
        <span className="decision-history-icon"><History size={25} /></span>
        <div><h2>历史记录</h2><small>{currentSymbol} · 已保存的决策练习</small></div>
        <button aria-label="关闭历史记录" onClick={onClose}><X size={21} /></button>
      </header>
      <div className="decision-history-overview">
        <article><span>练习场次</span><b>{entries.length}</b><small>当前标的</small></article>
        <article><span>你的累计净盈亏</span><DecisionModeMoneyStack modes={historyModes} compact={false} valueFor={(mode) => entries.reduce((sum, entry) => sum + aggregateDecisionResults(entry.results, mode).userPnlUsd, 0)} /><small>已保存练习中的完成结果</small></article>
        <article><span>系统累计净盈亏</span><DecisionModeMoneyStack modes={historyModes} compact={false} valueFor={(mode) => entries.reduce((sum, entry) => sum + aggregateDecisionResults(entry.results, mode).systemPnlUsd, 0)} /><small>V5 原始结果</small></article>
        <article><span>相对系统</span><DecisionModeMoneyStack modes={historyModes} compact={false} valueFor={(mode) => entries.reduce((sum, entry) => sum + aggregateDecisionResults(entry.results, mode).differenceUsd, 0)} /><small>你的净盈亏 − 系统净盈亏</small></article>
      </div>
      <div className="decision-history-body">
        {entries.length === 0 ? <div className="decision-empty">当前标的还没有已保存的练习记录。</div> : <div className="decision-history-list">
          {entries.map(({ session, candidates, results, modes, intervals }) => {
            const favoriteKey = decisionReplayFavoriteKey('session', session.id)
            return <div
              key={session.id}
              className="decision-history-card"
              role="button"
              tabIndex={0}
              onClick={() => onOpenSession(session.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onOpenSession(session.id)
                }
              }}
              aria-label={`查看 ${currentSymbol} 的决策练习`}
            >
              <div className="decision-history-card-head">
                <span className={`decision-session-status ${session.status}`}>{statusLabel(session.status)}</span>
                <span><b>{currentSymbol} · 决策练习</b><small>{new Date(session.startedAt).toLocaleString('zh-CN')} · {intervals.join(' / ') || '多周期'}</small></span>
                <DecisionFavoriteButton favorite={favoriteKeys.includes(favoriteKey)} onToggle={() => onToggleFavorite(favoriteKey)} label={favoriteKeys.includes(favoriteKey) ? '取消收藏本场练习' : '收藏本场练习'} />
                <ChevronRight size={19} />
              </div>
              <div className="decision-history-card-stats">
                <span>完成 <b>{results.length} / {candidates.length}</b> 笔</span>
                <span>你的 <DecisionModeMoneyStack modes={modes} valueFor={(mode) => aggregateDecisionResults(results, mode).userPnlUsd} /></span>
                <span>系统 <DecisionModeMoneyStack modes={modes} valueFor={(mode) => aggregateDecisionResults(results, mode).systemPnlUsd} /></span>
                <span>差额 <DecisionModeMoneyStack modes={modes} valueFor={(mode) => aggregateDecisionResults(results, mode).differenceUsd} /></span>
              </div>
              <small className="decision-history-card-hint">{session.status === 'active' ? '点击继续本场练习；已完成的笔数会立即保留' : '点击查看本场每笔决策、收益对比及独立画图'}</small>
            </div>
          })}
        </div>}
      </div>
    </section>
  </div>
}

function StageBadge({ attempt }: { attempt: DecisionAttempt }) {
  const labels: Record<DecisionAttempt['stage'], string> = {
    'entry-decision': '等待决策', 'entry-price': '选择挂单价', 'risk-setup': '设置止盈止损',
    'order-pending': '挂单等待成交', 'position-open': '持仓中', 'post-exit': '已平仓·观察中', complete: '已完成',
  }
  return <span className={`decision-stage ${attempt.stage}`}>{labels[attempt.stage]}</span>
}

export function DecisionReplayPanel({ candidate, attempt, ordinal, total, currentClose = null, currentPnlUsd = null, currentPnlByMode = null, positionSizingModes = ['fixed-risk'], favorite = false, onToggleFavorite = () => undefined, onAdvance, onSignalExtreme, onFreePrice, onSkip, onManualClose, onCancelPending, onNextTrade, onStop }: {
  candidate: ReplayDecisionCandidate
  attempt: DecisionAttempt
  ordinal: number
  total: number
  currentClose?: number | null
  currentPnlUsd?: number | null
  currentPnlByMode?: Partial<Record<DecisionPositionSizingMode, number>> | null
  positionSizingModes?: readonly DecisionPositionSizingMode[]
  favorite?: boolean
  onToggleFavorite?: () => void
  onAdvance: () => void
  onSignalExtreme: () => void
  onFreePrice: () => void
  onSkip: () => void
  onManualClose: () => void
  onCancelPending: () => void
  onNextTrade: () => void
  onStop: () => void
}) {
  const long = candidate.trade.side === 'long'
  const livePnlMode = positionSizingModes.length === 1 ? positionSizingModes[0] : null
  const livePnlValue = livePnlMode && currentPnlByMode ? currentPnlByMode[livePnlMode] ?? 0 : currentPnlUsd
  const hasLivePnl = currentClose !== null && (currentPnlByMode !== null ? positionSizingModes.length > 0 : currentPnlUsd !== null)
  const panelRef = useRef<HTMLElement>(null)
  const menuRef = useRef<HTMLElement>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; startLeft: number; startTop: number } | null>(null)
  const menuDragRef = useRef<{ pointerId: number; startX: number; startY: number; startLeft: number; startTop: number } | null>(null)
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; startWidth: number; startHeight: number; position: TradeMarkerPanelPosition } | null>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const menuDragCleanupRef = useRef<(() => void) | null>(null)
  const resizeCleanupRef = useRef<(() => void) | null>(null)
  const [panelPreferences, setPanelPreferences] = useState(loadDecisionReplayPanelPreferences)
  const [menuPreferences, setMenuPreferences] = useState(loadDecisionReplayMenuPreferences)
  const [dragging, setDragging] = useState(false)
  const [menuDragging, setMenuDragging] = useState(false)
  const [resizing, setResizing] = useState(false)
  const entryReferenceIndexes = useMemo(
    () => new Set(extractReasonCandleIndexes(candidate.trade.entry.reason, [candidate.trade.entry.signalIdx])),
    [candidate.trade.entry.reason, candidate.trade.entry.signalIdx],
  )

  const clampCurrentPanel = useCallback(() => {
    const panel = panelRef.current
    const parent = panel?.parentElement
    if (!panel || !parent) return
    const containerRect = parent.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    setPanelPreferences((current) => {
      if (!current.position) return current
      const position = clampDecisionPanelPosition(current.position, containerRect, panelRect)
      const size = current.size ? clampDecisionPanelSize(current.size, position, containerRect) : null
      if (position.left === current.position.left && position.top === current.position.top
        && size?.width === current.size?.width && size?.height === current.size?.height) return current
      return { position, size }
    })
  }, [])

  const clampCurrentMenu = useCallback(() => {
    const menu = menuRef.current
    const parent = menu?.parentElement
    if (!menu || !parent) return
    const containerRect = parent.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    setMenuPreferences((current) => {
      if (!current.position) return current
      const position = clampDecisionMenuPosition(current.position, containerRect, menuRect)
      if (position.left === current.position.left && position.top === current.position.top) return current
      return { position }
    })
  }, [])

  useEffect(() => {
    // Do not write the preferences store for every pointermove.  Dragging
    // can produce hundreds of events per second; persisting each intermediate
    // position makes the panel feel sticky and can block the next pointer
    // event.  The final position is still saved as soon as the gesture ends.
    if (dragging || resizing) return
    saveDecisionReplayPanelPreferences(panelPreferences)
  }, [panelPreferences, dragging, resizing])

  useEffect(() => {
    if (menuDragging) return
    saveDecisionReplayMenuPreferences(menuPreferences)
  }, [menuPreferences, menuDragging])

  useEffect(() => {
    const panel = panelRef.current
    const parent = panel?.parentElement
    if (!parent) return
    clampCurrentPanel()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(clampCurrentPanel)
    observer?.observe(parent)
    window.addEventListener('resize', clampCurrentPanel)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', clampCurrentPanel)
    }
  }, [clampCurrentPanel])

  useEffect(() => {
    const menu = menuRef.current
    const parent = menu?.parentElement
    if (!parent) return
    clampCurrentMenu()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(clampCurrentMenu)
    observer?.observe(parent)
    window.addEventListener('resize', clampCurrentMenu)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', clampCurrentMenu)
    }
  }, [clampCurrentMenu])

  useEffect(() => () => {
    dragCleanupRef.current?.()
    menuDragCleanupRef.current?.()
    resizeCleanupRef.current?.()
  }, [])

  const handleDragStart = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('button')) return
    const panel = panelRef.current
    const parent = panel?.parentElement
    if (!panel || !parent) return
    event.preventDefault()
    event.stopPropagation()
    const owner = event.currentTarget as HTMLElement
    try { owner.setPointerCapture(event.pointerId) } catch { /* pointer capture is optional */ }
    const containerRect = parent.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    const position = clampDecisionPanelPosition({ left: panelRect.left - containerRect.left, top: panelRect.top - containerRect.top }, containerRect, panelRect)
    setPanelPreferences((current) => ({ ...current, position }))
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startLeft: position.left, startTop: position.top }
    setDragging(true)
    const handlePointerMove = (pointerEvent: PointerEvent) => {
      const drag = dragRef.current
      const activePanel = panelRef.current
      const activeParent = activePanel?.parentElement
      if (!drag || pointerEvent.pointerId !== drag.pointerId || !activePanel || !activeParent) return
      pointerEvent.preventDefault()
      const activeContainerRect = activeParent.getBoundingClientRect()
      const activePanelRect = activePanel.getBoundingClientRect()
      const next = clampDecisionPanelPosition({
        left: drag.startLeft + pointerEvent.clientX - drag.startX,
        top: drag.startTop + pointerEvent.clientY - drag.startY,
      }, activeContainerRect, activePanelRect)
      setPanelPreferences((current) => ({ ...current, position: next }))
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerEnd)
      window.removeEventListener('pointercancel', handlePointerEnd)
      window.removeEventListener('blur', handleBlur)
      try {
        if (typeof owner.hasPointerCapture === 'function' && owner.hasPointerCapture(event.pointerId)) owner.releasePointerCapture(event.pointerId)
      } catch { /* the pointer may already have been released by the browser */ }
      if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null
    }
    const handlePointerEnd = (pointerEvent: PointerEvent) => {
      if (!dragRef.current || pointerEvent.pointerId !== dragRef.current.pointerId) return
      cleanup()
      dragRef.current = null
      setDragging(false)
    }
    const handleBlur = () => {
      if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return
      cleanup()
      dragRef.current = null
      setDragging(false)
    }
    dragCleanupRef.current?.()
    dragCleanupRef.current = cleanup
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerEnd)
    window.addEventListener('pointercancel', handlePointerEnd)
    window.addEventListener('blur', handleBlur)
  }

  const handleResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const panel = panelRef.current
    const parent = panel?.parentElement
    if (!panel || !parent) return
    event.preventDefault()
    event.stopPropagation()
    const owner = event.currentTarget as HTMLElement
    try { owner.setPointerCapture(event.pointerId) } catch { /* pointer capture is optional */ }
    const containerRect = parent.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    const position = clampDecisionPanelPosition({ left: panelRect.left - containerRect.left, top: panelRect.top - containerRect.top }, containerRect, panelRect)
    const size = clampDecisionPanelSize({ width: panelRect.width, height: panelRect.height }, position, containerRect)
    setPanelPreferences({ position, size })
    resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startWidth: size.width, startHeight: size.height, position }
    setResizing(true)
    const handlePointerMove = (pointerEvent: PointerEvent) => {
      const resize = resizeRef.current
      const activeParent = panelRef.current?.parentElement
      if (!resize || pointerEvent.pointerId !== resize.pointerId || !activeParent) return
      pointerEvent.preventDefault()
      const next = clampDecisionPanelSize({
        width: resize.startWidth + pointerEvent.clientX - resize.startX,
        height: resize.startHeight + pointerEvent.clientY - resize.startY,
      }, resize.position, activeParent.getBoundingClientRect())
      setPanelPreferences((current) => ({ ...current, size: next }))
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerEnd)
      window.removeEventListener('pointercancel', handlePointerEnd)
      window.removeEventListener('blur', handleBlur)
      try {
        if (typeof owner.hasPointerCapture === 'function' && owner.hasPointerCapture(event.pointerId)) owner.releasePointerCapture(event.pointerId)
      } catch { /* the pointer may already have been released by the browser */ }
      if (resizeCleanupRef.current === cleanup) resizeCleanupRef.current = null
    }
    const handlePointerEnd = (pointerEvent: PointerEvent) => {
      if (!resizeRef.current || pointerEvent.pointerId !== resizeRef.current.pointerId) return
      cleanup()
      resizeRef.current = null
      setResizing(false)
    }
    const handleBlur = () => {
      if (!resizeRef.current || resizeRef.current.pointerId !== event.pointerId) return
      cleanup()
      resizeRef.current = null
      setResizing(false)
    }
    resizeCleanupRef.current?.()
    resizeCleanupRef.current = cleanup
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerEnd)
    window.addEventListener('pointercancel', handlePointerEnd)
    window.addEventListener('blur', handleBlur)
  }

  const handleMenuDragStart = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('button, input, select, textarea')) return
    const menu = menuRef.current
    const parent = menu?.parentElement
    if (!menu || !parent) return
    event.preventDefault()
    event.stopPropagation()
    const owner = event.currentTarget as HTMLElement
    try { owner.setPointerCapture(event.pointerId) } catch { /* pointer capture is optional */ }
    const containerRect = parent.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const position = clampDecisionMenuPosition({
      left: menuRect.left - containerRect.left,
      top: menuRect.top - containerRect.top,
    }, containerRect, menuRect)
    setMenuPreferences({ position })
    menuDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: position.left,
      startTop: position.top,
    }
    setMenuDragging(true)
    const handlePointerMove = (pointerEvent: PointerEvent) => {
      const drag = menuDragRef.current
      const activeMenu = menuRef.current
      const activeParent = activeMenu?.parentElement
      if (!drag || pointerEvent.pointerId !== drag.pointerId || !activeMenu || !activeParent) return
      pointerEvent.preventDefault()
      const activeContainerRect = activeParent.getBoundingClientRect()
      const activeMenuRect = activeMenu.getBoundingClientRect()
      const next = clampDecisionMenuPosition({
        left: drag.startLeft + pointerEvent.clientX - drag.startX,
        top: drag.startTop + pointerEvent.clientY - drag.startY,
      }, activeContainerRect, activeMenuRect)
      setMenuPreferences({ position: next })
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerEnd)
      window.removeEventListener('pointercancel', handlePointerEnd)
      window.removeEventListener('blur', handleBlur)
      try {
        if (typeof owner.hasPointerCapture === 'function' && owner.hasPointerCapture(event.pointerId)) owner.releasePointerCapture(event.pointerId)
      } catch { /* the pointer may already have been released by the browser */ }
      if (menuDragCleanupRef.current === cleanup) menuDragCleanupRef.current = null
    }
    const handlePointerEnd = (pointerEvent: PointerEvent) => {
      if (!menuDragRef.current || pointerEvent.pointerId !== menuDragRef.current.pointerId) return
      cleanup()
      menuDragRef.current = null
      setMenuDragging(false)
    }
    const handleBlur = () => {
      if (!menuDragRef.current || menuDragRef.current.pointerId !== event.pointerId) return
      cleanup()
      menuDragRef.current = null
      setMenuDragging(false)
    }
    menuDragCleanupRef.current?.()
    menuDragCleanupRef.current = cleanup
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerEnd)
    window.addEventListener('pointercancel', handlePointerEnd)
    window.addEventListener('blur', handleBlur)
  }

  return <>
    <aside ref={panelRef} style={decisionPanelStyle(panelPreferences)} className={`decision-detail-panel${dragging ? ' is-dragging' : ''}${resizing ? ' is-resizing' : ''}`} data-testid="decision-detail-panel">
      <header onPointerDown={handleDragStart} title="拖动移动决策详情框">
        <span className="decision-grip" role="button" aria-label="拖动移动决策详情框" data-testid="decision-detail-drag-handle">⠿</span>
        <div><h2>第 {ordinal} / {total} 笔 · {candidate.symbol} · {INTERVALS[candidate.interval].label}</h2><small>信号 K：{formatDecisionDate(candidate.trade.entry.signalTime)} · {attempt.result ? '本笔盈亏已锁定，可继续观看后续 K 线' : '系统原结果将在本笔结束后揭晓'}</small></div>
        <DecisionFavoriteButton
          favorite={favorite}
          onToggle={onToggleFavorite}
          label={favorite ? '取消收藏本笔交易' : '收藏本笔交易'}
        />
        <StageBadge attempt={attempt} />
        <button title="提前退出并结算" onClick={onStop}><LogOut size={19} /></button>
      </header>
      <div className="decision-detail-scroll">
        <section className="decision-signal-summary">
          <div className={long ? 'long' : 'short'}>{long ? '开多信号' : '开空信号'}</div>
        </section>
        <section className="decision-reason">
          <h3 className={long ? 'long' : 'short'}>{candidate.trade.entry.setup}</h3>
          <p>{highlightDecisionReason(candidate.trade.entry.reason, entryReferenceIndexes)}</p>
        </section>
        {attempt.pendingEntryPrice !== null && <section className="decision-order-state">
          <h3><Target size={17} />你的订单</h3>
          <dl><dt>方向</dt><dd>{long ? '做多' : '做空'}</dd><dt>类型</dt><dd>{orderKindLabel(attempt.orderKind)}</dd><dt>挂单价</dt><dd>{formatPrice(attempt.pendingEntryPrice, candidate.symbol)}</dd>{attempt.fill && <><dt>成交价</dt><dd>{formatPrice(attempt.fill.price, candidate.symbol)}</dd></>}</dl>
        </section>}
        {attempt.result && <section className="decision-post-exit-summary">
          <h3><Flag size={17} />本笔已经平仓</h3>
          <p>你的盈亏 <DecisionModeMoneyStack modes={positionSizingModes} compact={false} valueFor={(mode) => decisionResultPnl(attempt.result!, mode, 'user')} />，V5 系统盈亏 <DecisionModeMoneyStack modes={positionSizingModes} compact={false} valueFor={(mode) => decisionResultPnl(attempt.result!, mode, 'system')} />。</p>
          <small>按 1 继续逐根观看后续行情；按 4 才会进入下一笔交易。</small>
        </section>}
      </div>
      <div className="decision-resize-handle" data-testid="decision-detail-resize-handle" aria-label="调整决策详情框大小" title="拖动调整详情框大小" onPointerDown={handleResizeStart} />
    </aside>
    <nav ref={menuRef} style={decisionMenuStyle(menuPreferences)} className={`decision-action-menu${menuDragging ? ' is-dragging' : ''}`} aria-label="决策操作菜单" data-testid="decision-action-menu">
      <div className="decision-action-progress" onPointerDown={handleMenuDragStart} title="拖动移动决策操作框">
        <span className="decision-menu-grip" role="button" aria-label="拖动移动决策操作框" data-testid="decision-action-drag-handle">⠿</span>
        <b>决策回放</b><span>{ordinal}/{total}</span><StageBadge attempt={attempt} />
      </div>
      {attempt.stage === 'entry-decision' && <div className="decision-choice-grid">
        <button onClick={onAdvance}><kbd>1</kbd><span><b>先观察</b><small>进入下一根 K 线</small></span></button>
        <button onClick={onSignalExtreme}><kbd>2</kbd><span><b>本 K 突破价挂单</b><small>{long ? '最高价做多' : '最低价做空'}</small></span></button>
        <button onClick={onFreePrice}><kbd>3</kbd><span><b>自由选择挂单价</b><small>在图上点击价格</small></span></button>
        <button className="skip" onClick={onSkip}><kbd>4</kbd><span><b>不参与</b><small>直接进入下一笔</small></span></button>
      </div>}
      {attempt.stage === 'order-pending' && <div className="decision-active-actions"><button onClick={onAdvance}><kbd>1</kbd>进入下一根 K 线</button><button className="danger" onClick={onCancelPending}><kbd>4</kbd>撤销挂单并跳过</button></div>}
      {attempt.stage === 'position-open' && <>
        {hasLivePnl && <div className={`decision-live-pnl${livePnlValue === null ? '' : livePnlValue >= 0 ? ' positive' : ' negative'}`} data-testid="decision-live-pnl">
          <span>本根收盘 {formatPrice(currentClose, candidate.symbol)}</span>
          {currentPnlByMode !== null ? <DecisionModeMoneyStack modes={positionSizingModes} compact={false} valueFor={(mode) => currentPnlByMode[mode] ?? 0} valueLabel={(value) => value >= 0 ? '浮盈' : '浮亏'} /> : <b>{currentPnlUsd! >= 0 ? '浮盈' : '浮亏'} {formatDecisionPnl(currentPnlUsd!)}</b>}
        </div>}
        <div className="decision-active-actions"><button onClick={onAdvance}><kbd>1</kbd>进入下一根 K 线</button><button className="close-position" onClick={onManualClose}><kbd>2</kbd>按当前 K 线收盘价离场</button></div>
      </>}
      {attempt.stage === 'post-exit' && <div className="decision-active-actions"><button onClick={onAdvance}><kbd>1</kbd>继续观看下一根 K 线</button><button className="close-position" onClick={onNextTrade}><kbd>4</kbd>进入下一笔交易</button></div>}
      {attempt.stage === 'entry-price' && <div className="decision-action-hint"><MousePointer2 size={18} />请在图表上完成挂单价设置，单击确认，Esc 可取消</div>}
      {attempt.stage === 'risk-setup' && <div className="decision-action-hint"><MousePointer2 size={18} />设置好止盈止损后，按 <kbd>1</kbd> 确认，按 <kbd>2</kbd> 取消</div>}
    </nav>
  </>
}

export function DecisionPricePicker({ value, symbol, toPrice, toY, onChange, onConfirm, onCancel }: {
  value: number
  symbol: ReplayDecisionCandidate['symbol']
  toPrice: (y: number) => number | null
  toY: (price: number) => number | null
  onChange: (price: number) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const [fixed, setFixed] = useState(false)
  const [point, setPoint] = useState({ x: 0, y: 0 })
  const y = toY(value)
  return <div className="decision-price-picker" data-testid="decision-price-picker" onPointerMove={(event) => {
    if (fixed) return
    const rect = event.currentTarget.getBoundingClientRect()
    const price = toPrice(event.clientY - rect.top)
    if (price !== null) onChange(price)
  }} onPointerDown={(event) => {
    if (event.button !== 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const price = toPrice(event.clientY - rect.top)
    if (price !== null) onChange(price)
    setPoint({ x: event.clientX - rect.left, y: event.clientY - rect.top })
    setFixed(true)
  }}>
    {y !== null && <div className="decision-price-line" style={{ top: y }}><span>挂单价 {formatPrice(value, symbol)}</span></div>}
    <div className="decision-picker-hint"><MousePointer2 size={17} />移动鼠标选择价格，单击后确认</div>
    {fixed && <div className="decision-price-confirm" style={{ left: Math.min(point.x + 12, window.innerWidth - 220), top: Math.max(8, point.y - 20) }} onPointerDown={(event) => event.stopPropagation()}>
      <b>{formatPrice(value, symbol)}</b><button className="primary" onClick={onConfirm}><Check size={16} />确认</button><button onClick={() => setFixed(false)}>重选</button><button onClick={onCancel}><X size={16} /></button>
    </div>}
  </div>
}

function useLineDrag(toPrice: (y: number) => number | null, onValue: (price: number) => void) {
  const moveRef = useRef<((event: PointerEvent) => void) | null>(null)
  useEffect(() => () => {
    if (moveRef.current) window.removeEventListener('pointermove', moveRef.current)
  }, [])
  return (event: React.PointerEvent) => {
    event.preventDefault()
    const root = (event.currentTarget as HTMLElement).closest('.decision-risk-overlay') as HTMLElement | null
    if (!root) return
    const move = (pointer: PointerEvent) => {
      const rect = root.getBoundingClientRect()
      const price = toPrice(pointer.clientY - rect.top)
      if (price !== null) onValue(price)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      moveRef.current = null
    }
    moveRef.current = move
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
  }
}

export function DecisionRiskOverlay({ candidate, entryPrice, entryLabel = '挂单', stopLoss, takeProfit, currentClose = null, currentPnlUsd = null, currentPnlByMode = null, positionSizingModes = ['fixed-risk'], toPrice, toY, onStopLoss, onTakeProfit, onConfirm, onCancel, editable = true, showConfirmControls = editable }: {
  candidate: ReplayDecisionCandidate
  entryPrice: number
  entryLabel?: '挂单' | '开仓'
  stopLoss: number
  takeProfit: number
  currentClose?: number | null
  currentPnlUsd?: number | null
  currentPnlByMode?: Partial<Record<DecisionPositionSizingMode, number>> | null
  positionSizingModes?: readonly DecisionPositionSizingMode[]
  toPrice: (y: number) => number | null
  toY: (price: number) => number | null
  onStopLoss?: (price: number) => void
  onTakeProfit?: (price: number) => void
  onConfirm?: () => void
  onCancel?: () => void
  editable?: boolean
  showConfirmControls?: boolean
}) {
  const entryY = toY(entryPrice)
  const stopY = toY(stopLoss)
  const targetY = toY(takeProfit)
  const ratio = rewardRiskRatio(entryPrice, stopLoss, takeProfit)
  const currentY = currentClose === null ? null : toY(currentClose)
  const currentPnlMode = positionSizingModes.length === 1 ? positionSizingModes[0] : null
  const currentPnlValue = currentPnlMode && currentPnlByMode ? currentPnlByMode[currentPnlMode] ?? 0 : currentPnlUsd
  const hasCurrentPnl = currentClose !== null && currentY !== null && (currentPnlByMode !== null ? positionSizingModes.length > 0 : currentPnlUsd !== null)
  const dragStop = useLineDrag(toPrice, onStopLoss ?? (() => undefined))
  const dragTarget = useLineDrag(toPrice, onTakeProfit ?? (() => undefined))
  const precision = symbolPrecision(candidate.symbol)
  return <div className={`decision-risk-overlay ${editable ? 'editable' : 'locked'}`} data-testid="decision-risk-overlay">
    {targetY !== null && <div className="decision-risk-line target" style={{ top: targetY }} onPointerDown={editable ? dragTarget : undefined}><i /><span><Target size={15} />止盈 {takeProfit.toFixed(precision)}</span></div>}
    {entryY !== null && <div className={`decision-risk-line entry${entryLabel === '开仓' ? ' filled' : ''}`} style={{ top: entryY }}><span>{entryLabel} {entryPrice.toFixed(precision)} · 盈亏比 1 : {ratio.toFixed(2)}</span></div>}
    {hasCurrentPnl && <div className={`decision-position-pnl-line${currentPnlValue === null ? '' : currentPnlValue >= 0 ? ' positive' : ' negative'}`} style={{ top: currentY! }} data-testid="decision-position-pnl-line"><span>收盘 {formatPrice(currentClose!, candidate.symbol)} · {currentPnlByMode !== null ? <DecisionModeMoneyStack modes={positionSizingModes} compact={false} valueFor={(mode) => currentPnlByMode[mode] ?? 0} valueLabel={(value) => value >= 0 ? '浮盈' : '浮亏'} /> : <>{currentPnlUsd! >= 0 ? '浮盈' : '浮亏'} {formatDecisionPnl(currentPnlUsd!)}</>}</span></div>}
    {stopY !== null && <div className="decision-risk-line stop" style={{ top: stopY }} onPointerDown={editable ? dragStop : undefined}><i /><span><Shield size={15} />止损 {stopLoss.toFixed(precision)}</span></div>}
    {editable && showConfirmControls && <div className="decision-risk-confirm"><div><b>拖动上下两个控制点</b><small>当前盈亏比 1 : {ratio.toFixed(2)} · {decisionSizingLabels(positionSizingModes)}</small></div><button onClick={onCancel}>取消</button><button className="primary" onClick={onConfirm}><Check size={17} />确认并进入下一根 K 线</button></div>}
  </div>
}

export function DecisionChartAnnotations({ candidate, attempt, result, data, toX, toY }: {
  candidate: ReplayDecisionCandidate
  attempt?: DecisionAttempt | null
  result?: DecisionTradeResult | null
  data: readonly Candle[]
  toX: (time: number) => number | null
  toY: (price: number) => number | null
}) {
  const reasonReferences = useMemo(() => {
    const references = resolveTradeCandleReferences(candidate.trade, data)
    // This panel shows only the entry explanation.  Keep hidden system-exit
    // reasoning out of the chart, including after the user closes the trade.
    return references.filter((reference) => reference.sections.includes('entry'))
  }, [candidate.trade, data])
  const signalX = toX(candidate.trade.entry.signalTime)
  const systemEntryX = toX(candidate.trade.entry.time)
  const systemEntryY = toY(candidate.trade.entry.price)
  const systemExitX = toX(candidate.trade.exit.time)
  const systemExitY = toY(candidate.trade.exit.price)
  const userEntry = result?.userEntry ?? attempt?.fill ?? null
  const userExit = result?.userExit ?? null
  const userEntryX = userEntry ? toX(userEntry.time) : null
  const userEntryY = userEntry ? toY(userEntry.price) : null
  const userExitX = userExit ? toX(userExit.time) : null
  const userExitY = userExit ? toY(userExit.price) : null
  return <div className="decision-chart-annotations" aria-hidden="true">
    {signalX !== null && <div className="decision-signal-cursor" style={{ left: signalX }}><span>信号 K</span></div>}
    {reasonReferences.map((reference) => {
      const exitOnly = reference.sections.length === 1 && reference.sections[0] === 'exit'
      const x = toX(reference.time)
      const y = toY(exitOnly ? reference.candle.low : reference.candle.high)
      if (x === null || y === null) return null
      return <span
        key={`decision-reason-reference-${reference.index}-${reference.time}`}
        className={`decision-reason-candle-marker${exitOnly ? ' exit' : ''}`}
        style={{ left: x, top: y }}
      >K{reference.index}</span>
    })}
    {result && systemEntryX !== null && systemEntryY !== null && systemExitX !== null && systemExitY !== null && <>
      <svg width="100%" height="100%" preserveAspectRatio="none"><line className="system-path" x1={systemEntryX} y1={systemEntryY} x2={systemExitX} y2={systemExitY} /></svg>
      <span className="decision-point system entry" style={{ left: systemEntryX, top: systemEntryY }}>系统开 {formatPrice(candidate.trade.entry.price, candidate.symbol)}</span>
      <span className="decision-point system exit" style={{ left: systemExitX, top: systemExitY }}>系统平 {formatPrice(candidate.trade.exit.price, candidate.symbol)}</span>
    </>}
    {userEntryX !== null && userEntryY !== null && <span className="decision-point user entry" style={{ left: userEntryX, top: userEntryY }}>你的开仓 {formatPrice(userEntry!.price, candidate.symbol)}</span>}
    {userEntryX !== null && userEntryY !== null && userExitX !== null && userExitY !== null && <>
      <svg width="100%" height="100%" preserveAspectRatio="none"><line className="user-path" x1={userEntryX} y1={userEntryY} x2={userExitX} y2={userExitY} /></svg>
      <span className="decision-point user exit" style={{ left: userExitX, top: userExitY }}>你的平仓 {formatPrice(userExit!.price, candidate.symbol)}</span>
    </>}
  </div>
}

export function DecisionResultsDialog({ session, onClose, onReview, onNew, favoriteKeys = [], onToggleFavorite = () => undefined }: {
  session: DecisionReplaySession | null
  onClose: () => void
  onReview: (result: DecisionTradeResult) => void
  onNew: () => void
  favoriteKeys?: readonly string[]
  onToggleFavorite?: (key: string) => void
}) {
  if (!session) return null
  const results = sessionResults(session)
  const modes = decisionSessionPositionSizingModes(session)
  const userTrades = results.filter((result) => result.choice === 'traded')
  const userWinRateText = decisionModeMetricText(modes, (mode) => `${userTrades.length ? (userTrades.filter((result) => decisionResultPnl(result, mode, 'user') > 0).length / userTrades.length * 100).toFixed(1) : '0.0'}%`)
  const systemWinRateText = decisionModeMetricText(modes, (mode) => `${results.length ? (results.filter((result) => decisionResultPnl(result, mode, 'system') > 0).length / results.length * 100).toFixed(1) : '0.0'}%`)
  return <div className="modal-backdrop decision-results-backdrop">
    <section className="decision-results" role="dialog" aria-modal="true" aria-label="决策回放盈亏对比">
      <header><BarChart3 size={25} /><div><h2>本场决策对比</h2><small>{statusLabel(session.status)} · 完成 {results.length} / {session.candidates.length} 笔</small></div><button aria-label="关闭结果" onClick={onClose}><X size={21} /></button></header>
      <div className="decision-result-summary">
        <article><span>你的净盈亏</span><DecisionModeMoneyStack modes={modes} compact={false} valueFor={(mode) => aggregateDecisionResults(results, mode).userPnlUsd} /><small>胜率 {userWinRateText} · 参与 {userTrades.length} 笔</small></article>
        <article><span>V5 系统净盈亏</span><DecisionModeMoneyStack modes={modes} compact={false} valueFor={(mode) => aggregateDecisionResults(results, mode).systemPnlUsd} /><small>胜率 {systemWinRateText} · {results.length} 笔</small></article>
        <article><span>相对系统</span><DecisionModeMoneyStack modes={modes} compact={false} valueFor={(mode) => aggregateDecisionResults(results, mode).differenceUsd} /><small>按所选仓位口径与系统结果对比</small></article>
      </div>
      <div className="decision-result-table">
        <div className="decision-result-row heading"><span># / 标的</span><span>你的选择</span><span>你的盈亏</span><span>系统盈亏</span><span>差额</span><span /></div>
        {results.map((result, index) => {
          const favoriteKey = decisionReplayFavoriteKey('trade', result.candidateKey)
          return <div
            className="decision-result-row"
            role="button"
            tabIndex={0}
            key={result.candidateKey}
            onClick={() => onReview(result)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onReview(result)
              }
            }}
          >
          <span><b>{index + 1}. {result.candidate.symbol}</b><small>{INTERVALS[result.candidate.interval].label} · {result.candidate.trade.side === 'long' ? '多' : '空'}</small></span>
          <span>{choiceLabel(result)}</span>
          <DecisionModeMoneyStack modes={modes} valueFor={(mode) => decisionResultPnl(result, mode, 'user')} />
          <DecisionModeMoneyStack modes={modes} valueFor={(mode) => decisionResultPnl(result, mode, 'system')} />
          <DecisionModeMoneyStack modes={modes} valueFor={(mode) => decisionResultPnl(result, mode, 'user') - decisionResultPnl(result, mode, 'system')} />
          <span className="decision-list-actions"><DecisionFavoriteButton favorite={favoriteKeys.includes(favoriteKey)} onToggle={() => onToggleFavorite(favoriteKey)} label={favoriteKeys.includes(favoriteKey) ? '取消收藏本笔交易' : '收藏本笔交易'} /><Eye size={18} /></span>
        </div>
        })}
        {results.length === 0 && <div className="decision-empty">本场尚未完成任何一笔交易。</div>}
      </div>
      <footer><button onClick={onClose}>关闭</button><button className="decision-primary" onClick={onNew}><RotateCcw size={17} />开始新一场</button></footer>
    </section>
  </div>
}

export function DecisionReviewPanel({ result, positionSizingModes = ['fixed-risk'], onBack }: { result: DecisionTradeResult; positionSizingModes?: readonly DecisionPositionSizingMode[]; onBack: () => void }) {
  return <aside className="decision-review-panel">
    <header><Flag size={20} /><div><h2>{result.candidate.symbol} · {INTERVALS[result.candidate.interval].label} · 第 {result.candidate.trade.tradeNumber} 笔</h2><small>复盘视图已恢复该笔练习的独立绘图</small></div><button onClick={onBack}><X size={19} /></button></header>
    <div className="decision-review-compare">
      <article><span>你的结果</span><DecisionModeMoneyStack modes={positionSizingModes} compact={false} valueFor={(mode) => decisionResultPnl(result, mode, 'user')} /><small>{result.choice === 'traded' ? `${result.userR >= 0 ? '+' : ''}${result.userR.toFixed(2)}R` : choiceLabel(result)}</small></article>
      <article><span>V5 系统结果</span><DecisionModeMoneyStack modes={positionSizingModes} compact={false} valueFor={(mode) => decisionResultPnl(result, mode, 'system')} /><small>{result.systemR >= 0 ? '+' : ''}{result.systemR.toFixed(2)}R</small></article>
    </div>
    <div className="decision-review-details">
      <section><h3>系统开仓信号 · {result.candidate.trade.entry.setup}</h3><p>{result.candidate.trade.entry.reason}</p></section>
      <section><h3>系统平仓 · {result.candidate.trade.exit.setup || result.candidate.trade.exit.reasonCode}</h3><p>{result.candidate.trade.exit.reason || `系统离场原因：${result.candidate.trade.exit.reasonCode}`}</p></section>
      <section><h3>你的执行</h3><p>{result.choice === 'skipped' ? '本次选择不参与。' : result.choice === 'unfilled' ? `${choiceLabel(result)}，截至可用行情结束仍未成交。` : `${choiceLabel(result)}；开仓 ${formatPrice(result.userEntry?.price ?? 0, result.candidate.symbol)}，平仓 ${formatPrice(result.userExit.price, result.candidate.symbol)}，离场方式：${exitReasonLabel(result.userExit.reason)}。`}</p></section>
    </div>
    <button className="decision-review-back" onClick={onBack}><ChevronRight size={17} />返回本场对比</button>
  </aside>
}
