import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import {
  Archive, BarChart3, CalendarDays, Check, ChevronRight, CircleDollarSign, Eye, Flag, History, ListOrdered, LogOut,
  MousePointer2, Play, RotateCcw, Shield, Star, Target, X,
} from 'lucide-react'
import type { ReplayDecisionCandidate } from '../lib/replayTradeRegistry'
import type {
  DecisionAttempt, DecisionHistorySort, DecisionPositionSizingMode, DecisionPracticeMode, DecisionReplayInterval, DecisionReplaySession, DecisionStopLossMode, DecisionTradeResult,
} from '../lib/decisionReplay'
import {
  aggregateDecisionResults, compareDecisionHistorySortValues, decisionAttemptSide, decisionPositionSizingLabel, decisionResultInitialStopLoss, decisionResultPnl, decisionResultR, decisionResultSide,
  decisionSessionPracticeMode, decisionStopLossMode, decisionSessionPositionSizingModes, decisionSessionUserRStats, DECISION_REPLAY_INTERVALS, DEFAULT_DECISION_POSITION_SIZING_MODES,
  formatDecisionDate, formatDecisionDay, pnlForDecisionMode, rewardRiskRatio, sessionResults, symbolPrecision, toggleDecisionHistoryIntervalSelection, toggleDecisionHistorySymbolSelection,
} from '../lib/decisionReplay'
import { formatPrice, INTERVALS, SYMBOLS, type Candle, type IntervalId, type SymbolId } from '../lib/market'
import type { TradeSide } from '../lib/tradeMarkers'
import { extractReasonCandleIndexes, resolveTradeCandleReferences } from '../lib/tradeCandleReferences'
import {
  loadDecisionChartStatusPreferences, loadDecisionReplayCenterPreferences, loadDecisionReplayMenuPreferences, loadDecisionReplayPanelPreferences,
  saveDecisionChartStatusPreferences, saveDecisionReplayCenterPreferences, saveDecisionReplayMenuPreferences, saveDecisionReplayPanelPreferences,
  type DecisionChartStatusPreferences, type DecisionReplayMenuPreferences, type DecisionReplayPanelPreferences,
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

function decisionChartStatusStyle(preferences: DecisionChartStatusPreferences): CSSProperties | undefined {
  if (!preferences.position) return undefined
  return {
    left: `${preferences.position.left}px`,
    top: `${preferences.position.top}px`,
    right: 'auto',
    transform: 'none',
  }
}

function money(value: number) {
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
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

function decisionWinStats(results: readonly DecisionTradeResult[], mode: DecisionPositionSizingMode, actor: 'user' | 'system') {
  const wins = results.filter((result) => decisionResultPnl(result, mode, actor) > 0).length
  return { wins, total: results.length, rate: results.length > 0 ? wins / results.length * 100 : null }
}

function decisionWinRateText(stats: ReturnType<typeof decisionWinStats>) {
  return stats.rate === null ? '—' : `${stats.rate.toFixed(1)}%`
}

function decisionSizingLabels(modes: readonly DecisionPositionSizingMode[]) {
  return modes.map((mode) => decisionPositionSizingLabel(mode)).join(' · ')
}

function formatDecisionPnl(value: number) {
  if (value === 0) return '$0.00'
  return `${value > 0 ? '+' : '-'}$${Math.abs(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatDecisionR(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}R`
}

function formatInitialStopDistance(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—'
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 6 })
}

function statusLabel(status: DecisionReplaySession['status']) {
  if (status === 'active') return '进行中'
  if (status === 'completed') return '已完成'
  return '已提前退出'
}

function decisionSessionTimeLabel(session: Pick<DecisionReplaySession, 'startedAt' | 'updatedAt' | 'finishedAt' | 'status'>) {
  const startedAt = new Date(session.startedAt).toLocaleString('zh-CN')
  const endLabel = session.status !== 'active' && typeof session.finishedAt === 'number'
    ? `完成：${new Date(session.finishedAt).toLocaleString('zh-CN')}`
    : `最后作答：${new Date(session.updatedAt).toLocaleString('zh-CN')}`
  return `开始：${startedAt} · ${endLabel}`
}

type DecisionHistoryViewMode = 'trades' | 'sessions'

function orderKindLabel(kind: DecisionAttempt['orderKind']) {
  if (kind === 'limit') return '限价挂单'
  if (kind === 'stop') return '突破挂单'
  return '待确定'
}

function choiceLabel(result: DecisionTradeResult) {
  if (result.choice === 'skipped') return '未参与'
  if (result.choice === 'unfilled') return '挂单未成交'
  const mode = result.entryMode === 'signal-extreme' ? '本 K 突破价' : result.entryMode === 'market-close' ? '当前 K 收盘开仓' : '自由选价'
  if (result.entryMode === 'market-close') return `${decisionResultSide(result) === 'long' ? '开多' : '开空'} · ${mode}`
  return `${mode} · ${orderKindLabel(result.orderKind)}`
}

function exitReasonLabel(reason: DecisionTradeResult['userExit']['reason'], stopLossMode?: DecisionStopLossMode) {
  const labels: Record<DecisionTradeResult['userExit']['reason'], string> = {
    skipped: '主动不参与',
    'manual-close': '按 K 线收盘价手动离场',
    'stop-loss': decisionStopLossMode(stopLossMode) === 'close' ? '收盘确认止损（按收盘价成交）' : '触及止损',
    'take-profit': '触及止盈',
    'system-exit': '跟随系统平仓',
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
  intervals: Array<{
    interval: DecisionReplayInterval
    total: number
    remaining: number
  }>
}

export function DecisionReplayCenter({ open, availableCount, totalCount, symbolStats, sessions, activeSessionId, favoriteKeys = [], onToggleFavorite = () => undefined, onClose, onStart, onContinue, onResults, anomalyCount = 0, anomalyUnavailableCount = 0, anomalyLoading = false, onRedoAnomalies }: {
  open: boolean
  availableCount: number
  totalCount: number
  symbolStats: DecisionSymbolStats[]
  sessions: DecisionReplaySession[]
  activeSessionId: string | null
  onClose: () => void
  onStart: (count: number, symbols: SymbolId[], intervals: DecisionReplayInterval[], positionSizingModes: DecisionPositionSizingMode[], practiceMode: DecisionPracticeMode) => void
  onContinue: () => void
  onResults: (sessionId: string) => void
  favoriteKeys?: readonly string[]
  onToggleFavorite?: (key: string) => void
  anomalyCount?: number
  anomalyUnavailableCount?: number
  anomalyLoading?: boolean
  onRedoAnomalies?: (positionSizingModes: DecisionPositionSizingMode[]) => void
}) {
  const [newSessionPreferences, setNewSessionPreferences] = useState(() => loadDecisionReplayCenterPreferences() ?? ({
    count: 30,
    selectedSymbols: symbolStats.filter((item) => item.intervals.some((stat) => stat.interval === '5m' && stat.remaining > 0)).map((item) => item.symbol),
    selectedIntervals: ['5m'] as DecisionReplayInterval[],
    selectedModes: [...DEFAULT_DECISION_POSITION_SIZING_MODES],
    practiceMode: 'random-count' as DecisionPracticeMode,
  }))
  const { count, selectedSymbols, selectedIntervals, selectedModes, practiceMode } = newSessionPreferences
  useEffect(() => saveDecisionReplayCenterPreferences(newSessionPreferences), [newSessionPreferences])
  const selectedStats = symbolStats.filter((item) => selectedSymbols.includes(item.symbol))
  const selectedAvailableCount = selectedStats.reduce((sum, item) => sum + item.intervals
    .filter((stat) => selectedIntervals.includes(stat.interval))
    .reduce((intervalSum, stat) => intervalSum + stat.remaining, 0), 0)
  const selectedTotalCount = selectedStats.reduce((sum, item) => sum + item.intervals
    .filter((stat) => selectedIntervals.includes(stat.interval))
    .reduce((intervalSum, stat) => intervalSum + stat.total, 0), 0)
  const effectiveAvailableCount = symbolStats.length > 0 ? selectedAvailableCount : availableCount
  const effectiveTotalCount = symbolStats.length > 0 ? selectedTotalCount : totalCount
  const boundedCount = Math.max(1, Math.min(count, Math.max(1, effectiveAvailableCount)))
  const intervalOptionStats = DECISION_REPLAY_INTERVALS.map((interval) => {
    const scopedSymbols = selectedSymbols.length > 0 ? selectedStats : symbolStats
    return scopedSymbols.reduce((totals, item) => {
      const stat = item.intervals.find((value) => value.interval === interval)
      return { interval, total: totals.total + (stat?.total ?? 0), remaining: totals.remaining + (stat?.remaining ?? 0) }
    }, { interval, total: 0, remaining: 0 })
  })

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
          <div className="decision-new-session-head">
            <div><h3>开始新的决策练习</h3><p>{practiceMode === 'day-sequence' ? '随机选择一个交易日，按当天信号时间顺序逐笔练习；图表保持整日时间轴，不跳到开仓点。' : '从所有可用模拟订单中打乱抽取，已经出现过的交易不会再次抽到。'}</p></div>
            <div className="decision-anomaly-entry">
              <button className="decision-anomaly-redo" data-testid="decision-anomaly-redo" disabled={anomalyLoading || anomalyCount === 0 || selectedModes.length === 0 || !onRedoAnomalies} onClick={() => onRedoAnomalies?.(selectedModes)} title="按本机 XAUUSD 5分钟历史识别异常题目，创建独立重做卷；原记录和收藏保留，同一道题不重复抽取。">
                <RotateCcw size={17} />{anomalyLoading ? '正在核对异常订单…' : `重做异常订单（${anomalyCount}题）`}
              </button>
              <small>独立重做 · 原记录保留{anomalyUnavailableCount > 0 ? ` · 另${anomalyUnavailableCount}笔缺行情，暂不能重做` : ''}</small>
            </div>
          </div>
          <div className="decision-practice-mode" role="group" aria-label="选择决策回放模式">
            <button
              type="button"
              className={practiceMode === 'random-count' ? 'active' : ''}
              aria-pressed={practiceMode === 'random-count'}
              onClick={() => setNewSessionPreferences((current) => ({ ...current, practiceMode: 'random-count' }))}
            ><ListOrdered size={18} /><span><b>自定义题目数量</b><small>跨日期随机抽题，题量由你设置</small></span></button>
            <button
              type="button"
              className={practiceMode === 'day-sequence' ? 'active' : ''}
              aria-pressed={practiceMode === 'day-sequence'}
              onClick={() => setNewSessionPreferences((current) => ({ ...current, practiceMode: 'day-sequence' }))}
            ><CalendarDays size={18} /><span><b>随机交易日顺序回放</b><small>随机一天，按信号时间从早到晚逐笔练习</small></span></button>
          </div>
          <div className="decision-symbol-filter" aria-label="选择练习标的">
            <div className="decision-symbol-filter-head"><b>选择标的</b><span>可多选，随机抽取只使用已勾选的标的</span></div>
            <div className="decision-symbol-options">
              {symbolStats.length === 0 ? <span className="decision-symbol-empty">当前没有可用的模拟交易</span> : symbolStats.map((item) => {
                const info = SYMBOLS.find((symbol) => symbol.id === item.symbol)
                const selectedIntervalStats = item.intervals.filter((stat) => selectedIntervals.includes(stat.interval))
                const scopedTotal = selectedIntervalStats.reduce((sum, stat) => sum + stat.total, 0)
                const scopedRemaining = selectedIntervalStats.reduce((sum, stat) => sum + stat.remaining, 0)
                const checked = selectedSymbols.includes(item.symbol)
                const disabled = scopedRemaining === 0 && !checked
                return <label key={item.symbol} className={`decision-symbol-option${disabled ? ' is-disabled' : ''}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => setNewSessionPreferences((current) => ({
                      ...current,
                      selectedSymbols: current.selectedSymbols.includes(item.symbol)
                        ? current.selectedSymbols.filter((symbol) => symbol !== item.symbol)
                        : [...current.selectedSymbols, item.symbol],
                    }))}
                  />
                  <span className="decision-symbol-option-copy"><b>{item.symbol}</b><small>{info?.name ?? '未知标的'}</small></span>
                  <span className="decision-symbol-option-count">共 {scopedTotal.toLocaleString('zh-CN')} 笔 · 剩余 {scopedRemaining.toLocaleString('zh-CN')} 笔</span>
                </label>
              })}
            </div>
          </div>
          <div className="decision-interval-filter" aria-label="选择练习时间级别">
            <div className="decision-symbol-filter-head"><b>选择时间级别</b><span>可多选，随机抽取同时匹配已勾选的标的和时间级别</span></div>
            <div className="decision-interval-options">
              {intervalOptionStats.map(({ interval: option, total, remaining }) => {
                const checked = selectedIntervals.includes(option)
                const label = option === '5m' ? '5min' : option === '15m' ? '15min' : '1h'
                return <label key={option} className={`decision-interval-option${checked ? ' active' : ''}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => setNewSessionPreferences((current) => ({
                      ...current,
                      selectedIntervals: current.selectedIntervals.includes(option)
                        ? current.selectedIntervals.filter((interval) => interval !== option)
                        : [...current.selectedIntervals, option],
                    }))}
                  />
                  <span><b>{label}</b><small>共 {total.toLocaleString('zh-CN')} 笔 · 剩余 {remaining.toLocaleString('zh-CN')} 笔</small></span>
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
                  onChange={() => setNewSessionPreferences((current) => ({
                    ...current,
                    selectedModes: current.selectedModes.includes(mode)
                      ? current.selectedModes.filter((item) => item !== mode)
                      : [...current.selectedModes, mode],
                  }))}
                />
                <span><b>{title}</b><small>{description}</small></span>
              </label>)}
            </div>
          </div>
          {practiceMode === 'random-count'
            ? <label><span>交易数量 N</span><input className="decision-count-input" type="number" min="1" max={Math.max(1, effectiveAvailableCount)} value={boundedCount} disabled={effectiveAvailableCount === 0} onChange={(event) => setNewSessionPreferences((current) => ({ ...current, count: Math.max(1, Number(event.target.value) || 1) }))} /></label>
            : <div className="decision-day-mode-note"><CalendarDays size={17} /><span><b>题数按当天实际交易</b><small>仅抽取同一标的、同一周期、完整交易日内的未练习交易；有休市的品种从开盘 K 线开始</small></span></div>}
          <div className="decision-availability"><b>{effectiveAvailableCount.toLocaleString('zh-CN')}</b> 笔未练习 / 共 {effectiveTotalCount.toLocaleString('zh-CN')} 笔</div>
          <button className="decision-primary" disabled={effectiveAvailableCount === 0 || selectedSymbols.length === 0 || selectedIntervals.length === 0 || selectedModes.length === 0} onClick={() => onStart(boundedCount, selectedSymbols, selectedIntervals, selectedModes, practiceMode)}>{practiceMode === 'day-sequence' ? '随机选一天并按顺序开始' : '随机抽取并开始'}</button>
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
                <span><b>{session.reviewKind === 'stop-anomalies' ? '异常订单重做 · ' : session.practiceMode === 'day-sequence' ? '按日顺序 · ' : ''}{results.length} / {session.candidates.length} 笔</b><small>{session.daySequence ? `${formatDecisionDay(session.daySequence.startTime)} · ` : ''}{decisionSessionTimeLabel(session)}</small></span>
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
 * A compact, symbol-filterable index of completed decision exercises.
 * Opening a card delegates to the existing results dialog, whose individual
 * rows open an independent, interactive redo from the signal candle.
 */
function decisionAttemptHasHistoryProgress(candidate: ReplayDecisionCandidate, attempt: DecisionAttempt | null) {
  return Boolean(attempt && (
    attempt.result
    || attempt.stage !== 'entry-decision'
    || attempt.drawings.length > 0
    || attempt.cursorTime !== candidate.trade.entry.signalTime
  ))
}

function decisionHistoryTradeStatus(result: DecisionTradeResult | null, session: DecisionReplaySession) {
  if (!result) return statusLabel(session.status)
  if (result.choice === 'skipped') return '未参与'
  if (result.choice === 'unfilled') return '未成交'
  return '已完成'
}

const DECISION_HISTORY_RENDER_BATCH = 60

interface DecisionHistoryDialogProps {
  open: boolean
  currentSymbol: SymbolId
  sessions: DecisionReplaySession[]
  onClose: () => void
  onOpenSession: (sessionId: string) => void
  onOpenFavoriteTrade?: (sessionId: string, candidateKey: string) => void
  favoriteKeys?: readonly string[]
  onToggleFavorite?: (key: string) => void
  defaultView?: 'history' | 'favorites'
  defaultHistoryView?: DecisionHistoryViewMode
  defaultStatsMode?: 'custom' | 'day-sequence'
}

function sameDecisionHistoryDialogProps(left: DecisionHistoryDialogProps, right: DecisionHistoryDialogProps) {
  return left.open === right.open
    && left.currentSymbol === right.currentSymbol
    && left.sessions === right.sessions
    && left.favoriteKeys === right.favoriteKeys
    && left.defaultView === right.defaultView
    && left.defaultHistoryView === right.defaultHistoryView
    && left.defaultStatsMode === right.defaultStatsMode
}

export const DecisionHistoryDialog = memo(function DecisionHistoryDialog({ open, sessions, onClose, onOpenSession, onOpenFavoriteTrade, favoriteKeys = [], onToggleFavorite = () => undefined, defaultView = 'history', defaultHistoryView = 'trades', defaultStatsMode = 'custom' }: DecisionHistoryDialogProps) {
  const [selectedHistorySymbols, setSelectedHistorySymbols] = useState<SymbolId[]>([])
  const [selectedHistoryIntervals, setSelectedHistoryIntervals] = useState<DecisionReplayInterval[]>([])
  const [favoritesOnly, setFavoritesOnly] = useState(defaultView === 'favorites')
  const [historyViewMode, setHistoryViewMode] = useState<DecisionHistoryViewMode>(defaultHistoryView)
  const [historyPositionMode, setHistoryPositionMode] = useState<DecisionPositionSizingMode>('fixed-notional')
  const [historySort, setHistorySort] = useState<DecisionHistorySort>('time-desc')
  const [historyStatsMode, setHistoryStatsMode] = useState<'custom' | 'day-sequence'>(defaultStatsMode)
  const [historyRenderLimit, setHistoryRenderLimit] = useState(DECISION_HISTORY_RENDER_BATCH)
  // This dialog stays mounted while closed. Returning before any aggregation
  // prevents the clock and chart updates from rescanning thousands of attempts.
  if (!open) return null
  const showAllSymbols = selectedHistorySymbols.length === 0
  const selectedHistorySymbolSet = new Set(selectedHistorySymbols)
  const showAllIntervals = selectedHistoryIntervals.length === 0
  const selectedHistoryIntervalSet = new Set(selectedHistoryIntervals)
  const selectedSymbolLabel = showAllSymbols ? '全部标的' : selectedHistorySymbols.join(' / ')
  const selectedIntervalLabel = showAllIntervals ? '全部周期' : selectedHistoryIntervals.map((interval) => INTERVALS[interval].label).join(' / ')
  const historyScopeLabel = `${favoritesOnly ? '已收藏 · ' : ''}${selectedSymbolLabel}${showAllIntervals ? '' : ` · ${selectedIntervalLabel}`}`
  const historyScopeTitle = `${selectedSymbolLabel}${showAllIntervals ? '' : ` · ${selectedIntervalLabel}`}${favoritesOnly ? '的收藏记录' : ''}`
  const matchesSelectedSymbol = (symbol: SymbolId) => showAllSymbols || selectedHistorySymbolSet.has(symbol)
  const matchesSelectedInterval = (interval: IntervalId) => showAllIntervals || selectedHistoryIntervalSet.has(interval as DecisionReplayInterval)
  // Independent redo sessions are persisted for their own result dialog, but
  // must never alter the source practice session's historical statistics.
  const historySessions = sessions.filter((session) => session.origin !== 'review')

  const tradeEntries = historySessions.flatMap((session) => session.candidates
    .filter((candidate) => matchesSelectedSymbol(candidate.symbol) && matchesSelectedInterval(candidate.interval))
    .flatMap((candidate, index) => {
    const attempt = session.attempts.find((item) => item.candidateKey === candidate.key) ?? null
    if (!decisionAttemptHasHistoryProgress(candidate, attempt)) return []
    const favoriteKey = decisionReplayFavoriteKey('trade', candidate.key)
    return [{
      session,
      candidate,
      attempt,
      result: attempt?.result ?? null,
      favoriteKey,
      favorite: favoriteKeys.includes(favoriteKey),
      ordinal: index + 1,
    }]
  }))
  const historySessionGroups = historySessions.flatMap((session) => {
    const candidatesForScope = session.candidates.filter((candidate) => matchesSelectedSymbol(candidate.symbol) && matchesSelectedInterval(candidate.interval))
    if (candidatesForScope.length === 0) return []
    const sessionEntries = tradeEntries.filter((entry) => entry.session.id === session.id && (!favoritesOnly || entry.favorite))
    if (favoritesOnly && sessionEntries.length === 0) return []
    return [{
      session,
      candidates: candidatesForScope,
      entries: sessionEntries,
      results: sessionEntries.flatMap((entry) => entry.result ? [entry.result] : []),
      symbols: Array.from(new Set(candidatesForScope.map((candidate) => candidate.symbol))),
      favoriteCount: tradeEntries.filter((entry) => entry.session.id === session.id && entry.favorite).length,
    }]
  })

  // Older stores can contain copies whose internal candidate ids or legacy
  // attempt metadata differ while the history card is exactly the same. Use
  // the fields actually shown in the card as a final UI-level safety net.
  const historySessionDisplayKey = (group: typeof historySessionGroups[number]) => {
    const participated = group.results.filter((result) => result.choice === 'traded')
    const userStats = decisionWinStats(participated, historyPositionMode, 'user')
    const systemStats = decisionWinStats(group.results, historyPositionMode, 'system')
    const userPnl = aggregateDecisionResults(group.results, historyPositionMode).userPnlUsd
    const systemPnl = aggregateDecisionResults(group.results, historyPositionMode).systemPnlUsd
    return JSON.stringify({
      practiceMode: decisionSessionPracticeMode(group.session),
      status: group.session.status,
      symbols: [...group.symbols].sort(),
      startedAt: group.session.startedAt,
      finishedAt: group.session.finishedAt ?? null,
      candidateCount: group.candidates.length,
      progressCount: group.entries.length,
      completedCount: group.results.length,
      participatedCount: participated.length,
      skippedCount: group.results.filter((result) => result.choice === 'skipped').length,
      favoriteCount: group.favoriteCount,
      intervals: [...new Set(group.candidates.map((candidate) => candidate.interval))].sort(),
      userWins: userStats.wins,
      userTotal: userStats.total,
      systemWins: systemStats.wins,
      systemTotal: systemStats.total,
      userPnl: userPnl.toFixed(2),
      systemPnl: systemPnl.toFixed(2),
      differencePnl: (userPnl - systemPnl).toFixed(2),
      positionSizingModes: decisionSessionPositionSizingModes(group.session),
    })
  }
  const deduplicatedHistorySessionGroups = [...historySessionGroups.reduce((groups, group) => {
    const key = historySessionDisplayKey(group)
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, group)
      return groups
    }
    const existingScore = [existing.entries.length, existing.results.length, existing.session.updatedAt]
    const nextScore = [group.entries.length, group.results.length, group.session.updatedAt]
    if (nextScore.some((value, index) => value > existingScore[index] && nextScore.slice(0, index).every((item, prefix) => item === existingScore[prefix]))) {
      groups.set(key, group)
    }
    return groups
  }, new Map<string, typeof historySessionGroups[number]>()).values()]
  const sortedHistorySessionGroups = [...deduplicatedHistorySessionGroups].sort((left, right) => compareDecisionHistorySortValues({
    startedAt: left.session.startedAt,
    ordinal: 0,
    pnlUsd: aggregateDecisionResults(left.results, historyPositionMode).userPnlUsd,
  }, {
    startedAt: right.session.startedAt,
    ordinal: 0,
    pnlUsd: aggregateDecisionResults(right.results, historyPositionMode).userPnlUsd,
    }, historySort))

  const visibleSessionIds = new Set(deduplicatedHistorySessionGroups.map((group) => group.session.id))
  const visibleTradeEntries = (favoritesOnly ? tradeEntries.filter((entry) => entry.favorite) : tradeEntries)
    .filter((entry) => visibleSessionIds.has(entry.session.id))
  const sortedTradeEntries = [...visibleTradeEntries].sort((left, right) => {
    return compareDecisionHistorySortValues({
      startedAt: left.session.startedAt,
      ordinal: left.ordinal,
      pnlUsd: left.result?.choice === 'traded' ? decisionResultPnl(left.result, historyPositionMode, 'user') : null,
    }, {
      startedAt: right.session.startedAt,
      ordinal: right.ordinal,
      pnlUsd: right.result?.choice === 'traded' ? decisionResultPnl(right.result, historyPositionMode, 'user') : null,
    }, historySort)
  })

  const customModeTradeEntries = visibleTradeEntries.filter((entry) => decisionSessionPracticeMode(entry.session) === 'random-count')
  const summaryResults = customModeTradeEntries.flatMap((entry) => entry.result ? [entry.result] : [])
  const visibleTradeCount = summaryResults.length
  const historyModes: readonly DecisionPositionSizingMode[] = [historyPositionMode]
  const participatedResults = summaryResults.filter((result) => result.choice === 'traded')
  const skippedTradeCount = summaryResults.filter((result) => result.choice === 'skipped').length
  const unfilledTradeCount = summaryResults.filter((result) => result.choice === 'unfilled').length
  const userWinStats = decisionWinStats(participatedResults, historyPositionMode, 'user')
  const systemParticipatedWinStats = decisionWinStats(participatedResults, historyPositionMode, 'system')
  const systemOverallWinStats = decisionWinStats(summaryResults, historyPositionMode, 'system')
  const customModeSessionCount = deduplicatedHistorySessionGroups.filter((group) => decisionSessionPracticeMode(group.session) === 'random-count').length
  const daySequenceTradeEntries = visibleTradeEntries.filter((entry) => decisionSessionPracticeMode(entry.session) === 'day-sequence')
  const daySequenceResults = daySequenceTradeEntries.flatMap((entry) => entry.result ? [entry.result] : [])
  const daySequenceParticipatedResults = daySequenceResults.filter((result) => result.choice === 'traded')
  const daySequenceSkippedTradeCount = daySequenceResults.filter((result) => result.choice === 'skipped').length
  const daySequenceUnfilledTradeCount = daySequenceResults.filter((result) => result.choice === 'unfilled').length
  const daySequenceSessionCount = deduplicatedHistorySessionGroups.filter((group) => decisionSessionPracticeMode(group.session) === 'day-sequence').length
  const daySequenceUserWinStats = decisionWinStats(daySequenceParticipatedResults, historyPositionMode, 'user')
  const daySequenceSystemWinStats = decisionWinStats(daySequenceResults, historyPositionMode, 'system')
  const selectedPracticeMode = historyStatsMode === 'day-sequence' ? 'day-sequence' : 'random-count'
  const modeHistorySessionGroups = sortedHistorySessionGroups.filter((group) => decisionSessionPracticeMode(group.session) === selectedPracticeMode)
  const modeTradeEntries = sortedTradeEntries.filter((entry) => decisionSessionPracticeMode(entry.session) === selectedPracticeMode)
  const renderedHistorySessionGroups = modeHistorySessionGroups.slice(0, historyRenderLimit)
  const renderedTradeEntries = modeTradeEntries.slice(0, historyRenderLimit)
  const historyItemCount = historyViewMode === 'sessions' ? modeHistorySessionGroups.length : modeTradeEntries.length
  const hasMoreHistoryItems = historyRenderLimit < historyItemCount
  const loadMoreHistoryItems = () => setHistoryRenderLimit((current) => Math.min(historyItemCount, current + DECISION_HISTORY_RENDER_BATCH))
  const openFavoriteTrade = (sessionId: string, candidateKey: string) => {
    if (onOpenFavoriteTrade) onOpenFavoriteTrade(sessionId, candidateKey)
    else onOpenSession(sessionId)
  }
  return <div className="modal-backdrop decision-history-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="decision-history" role="dialog" aria-modal="true" aria-label="决策历史记录" data-testid="decision-history-dialog">
      <header>
        <span className="decision-history-icon"><History size={25} /></span>
        <div><h2>历史记录</h2><small>{historyScopeTitle} · {historyStatsMode === 'day-sequence' ? '日内逐根回放' : '自定义模式'} · {favoritesOnly ? '逐笔收藏交易' : historyViewMode === 'sessions' ? '按卷子汇总' : '逐笔交易记录'}</small></div>
        <div className="decision-history-filters">
          <button
            type="button"
            className={`decision-history-favorites-filter${favoritesOnly ? ' active' : ''}`}
            aria-pressed={favoritesOnly}
            aria-label="查看已收藏记录"
            onClick={() => setFavoritesOnly((value) => !value)}
          ><Star size={14} fill={favoritesOnly ? 'currentColor' : 'none'} />已收藏</button>
        </div>
        <button aria-label="关闭历史记录" onClick={onClose}><X size={21} /></button>
      </header>
      <div className="decision-history-symbol-controls" role="group" aria-label="历史记录标的筛选">
        <span>标的筛选</span>
        <label className={showAllSymbols ? 'active' : ''}>
          <input type="checkbox" checked={showAllSymbols} onChange={() => setSelectedHistorySymbols([])} />
          全部标的
        </label>
        {SYMBOLS.map((item) => {
          const checked = selectedHistorySymbolSet.has(item.id)
          return <label className={checked ? 'active' : ''} key={item.id}>
            <input
              type="checkbox"
              checked={checked}
              onChange={() => setSelectedHistorySymbols((selected) => toggleDecisionHistorySymbolSelection(selected, item.id))}
            />
            {item.id}
          </label>
        })}
        <small>{showAllSymbols ? '默认显示全部；勾选任一标的进入单选' : `已选择 ${selectedHistorySymbols.length} 个标的；可继续勾选进行多选`}</small>
      </div>
      <div className="decision-history-interval-controls" role="group" aria-label="历史记录时间级别筛选">
        <span>时间级别</span>
        <label className={showAllIntervals ? 'active' : ''}>
          <input type="checkbox" checked={showAllIntervals} onChange={() => setSelectedHistoryIntervals([])} />
          全部周期
        </label>
        {DECISION_REPLAY_INTERVALS.map((interval) => {
          const checked = selectedHistoryIntervalSet.has(interval)
          return <label className={checked ? 'active' : ''} key={interval}>
            <input
              type="checkbox"
              checked={checked}
              onChange={() => setSelectedHistoryIntervals((selected) => toggleDecisionHistoryIntervalSelection(selected, interval))}
            />
            {INTERVALS[interval].label}
          </label>
        })}
        <small>{showAllIntervals ? '默认显示全部周期；可勾选一个或多个时间级别' : `已选择 ${selectedHistoryIntervals.length} 个时间级别；可继续勾选进行多选`}</small>
      </div>
      <div className="decision-history-display-controls">
        <span>展示方式</span>
        <div className="decision-history-view-modes" role="group" aria-label="历史记录展示方式">
          <button type="button" className={historyViewMode === 'trades' ? 'active' : ''} aria-pressed={historyViewMode === 'trades'} onClick={() => setHistoryViewMode('trades')}>逐笔交易</button>
          <button type="button" className={historyViewMode === 'sessions' ? 'active' : ''} aria-pressed={historyViewMode === 'sessions'} onClick={() => setHistoryViewMode('sessions')}>按卷子</button>
        </div>
        <span>仓位显示</span>
        <div className="decision-history-position-modes" role="group" aria-label="历史记录仓位显示方式">
          {(['fixed-notional', 'fixed-risk'] as const).map((mode) => <button
            type="button"
            key={mode}
            className={historyPositionMode === mode ? 'active' : ''}
            aria-pressed={historyPositionMode === mode}
            onClick={() => setHistoryPositionMode(mode)}
          >{decisionPositionSizingLabel(mode)}</button>)}
        </div>
        <label className="decision-history-sort-control">
          <span>记录排序</span>
          <select aria-label="历史记录排序" value={historySort} onChange={(event) => setHistorySort(event.target.value as DecisionHistorySort)}>
            <option value="time-desc">时间降序（最新优先）</option>
            <option value="time-asc">时间升序（最早优先）</option>
            <option value="pnl-desc">盈利降序（最高优先）</option>
            <option value="pnl-asc">盈利升序（最低优先）</option>
          </select>
        </label>
        <small>{historyViewMode === 'sessions' ? '按每场练习显示考分；点击卷子查看每笔交易详情' : '盈利排序按当前仓位口径计算'}</small>
      </div>
      <div className="decision-history-stats-modes" role="group" aria-label="历史统计模式">
        <span>统计模式</span>
        <button type="button" className={historyStatsMode === 'custom' ? 'active' : ''} aria-pressed={historyStatsMode === 'custom'} onClick={() => { setHistoryStatsMode('custom'); setHistoryRenderLimit(DECISION_HISTORY_RENDER_BATCH) }}>自定义模式 <b>{visibleTradeCount}</b> 笔</button>
        <button type="button" className={`day-sequence${historyStatsMode === 'day-sequence' ? ' active' : ''}`} aria-pressed={historyStatsMode === 'day-sequence'} onClick={() => { setHistoryStatsMode('day-sequence'); setHistoryRenderLimit(DECISION_HISTORY_RENDER_BATCH) }}>日内逐根回放 <b>{daySequenceResults.length}</b> 笔</button>
        <small>两种模式独立统计；点击切换下方收益卡</small>
      </div>
      {historyStatsMode === 'custom' ? <div className="decision-history-overview" role="region" aria-label="自定义题目模式收益" data-testid="decision-custom-mode-history-summary">
        <article><span>{historyViewMode === 'sessions' ? '自定义模式卷子数' : favoritesOnly ? '自定义模式收藏笔数' : '自定义模式笔数'}</span><b>{historyViewMode === 'sessions' ? customModeSessionCount : visibleTradeCount}</b><small>{historyViewMode === 'sessions' ? `${historyScopeLabel} · 点击进入逐笔详情` : historyScopeLabel} · 不含逐根回放</small></article>
        <article><span>你的自定义模式净盈亏</span><DecisionModeMoneyStack modes={historyModes} compact={false} valueFor={(mode) => aggregateDecisionResults(summaryResults, mode).userPnlUsd} /><small>参与胜率 <strong>{decisionWinRateText(userWinStats)}</strong> · 盈利 {userWinStats.wins} / {userWinStats.total} 笔 · 未参与 {skippedTradeCount} 笔交易{unfilledTradeCount > 0 ? ` · 未成交 ${unfilledTradeCount} 笔` : ''}</small></article>
        <article className="decision-system-summary"><span>自定义模式系统参与净盈亏</span><DecisionModeMoneyStack modes={historyModes} compact={false} valueFor={(mode) => aggregateDecisionResults(participatedResults, mode).systemPnlUsd} /><small>参与部分胜率 <strong>{decisionWinRateText(systemParticipatedWinStats)}</strong> · 盈利 {systemParticipatedWinStats.wins} / {systemParticipatedWinStats.total} 笔</small><span className="decision-system-total-label">自定义模式系统总净盈亏</span><DecisionModeMoneyStack modes={historyModes} compact={false} valueFor={(mode) => aggregateDecisionResults(summaryResults, mode).systemPnlUsd} /><small>总胜率 <strong>{decisionWinRateText(systemOverallWinStats)}</strong> · 盈利 {systemOverallWinStats.wins} / {systemOverallWinStats.total} 笔</small></article>
        <article><span>自定义模式相对系统</span><DecisionModeMoneyStack modes={historyModes} compact={false} valueFor={(mode) => aggregateDecisionResults(summaryResults, mode).differenceUsd} /><small>{decisionPositionSizingLabel(historyPositionMode)} · 全部 {summaryResults.length} 笔</small></article>
      </div> : <div className="decision-history-overview decision-day-sequence-overview" role="region" aria-label="日内逐根回放模式收益" data-testid="decision-day-sequence-history-summary">
        <article><span>逐根回放笔数</span><b>{daySequenceResults.length}</b><small>{daySequenceSessionCount} 场有记录 · 参与 {daySequenceParticipatedResults.length} 笔 · 未参与 {daySequenceSkippedTradeCount} 笔{daySequenceUnfilledTradeCount > 0 ? ` · 未成交 ${daySequenceUnfilledTradeCount} 笔` : ''}</small></article>
        <article><span>你的逐根回放净盈亏</span><DecisionModeMoneyStack modes={historyModes} compact={false} valueFor={(mode) => aggregateDecisionResults(daySequenceResults, mode).userPnlUsd} /><small>参与胜率 <strong>{decisionWinRateText(daySequenceUserWinStats)}</strong> · 盈利 {daySequenceUserWinStats.wins} / {daySequenceUserWinStats.total} 笔</small></article>
        <article><span>逐根回放系统净盈亏</span><DecisionModeMoneyStack modes={historyModes} compact={false} valueFor={(mode) => aggregateDecisionResults(daySequenceResults, mode).systemPnlUsd} /><small>总胜率 <strong>{decisionWinRateText(daySequenceSystemWinStats)}</strong> · 盈利 {daySequenceSystemWinStats.wins} / {daySequenceSystemWinStats.total} 笔</small></article>
        <article><span>逐根回放相对系统</span><DecisionModeMoneyStack modes={historyModes} compact={false} valueFor={(mode) => aggregateDecisionResults(daySequenceResults, mode).differenceUsd} /><small>{decisionPositionSizingLabel(historyPositionMode)} · 全部 {daySequenceResults.length} 笔</small></article>
      </div>}
      <div className="decision-history-body" onScroll={(event) => {
        const target = event.currentTarget
        if (hasMoreHistoryItems && target.scrollHeight - target.scrollTop - target.clientHeight < 240) loadMoreHistoryItems()
      }}>
        {historyViewMode === 'sessions' ? (modeHistorySessionGroups.length === 0 ? <div className="decision-empty">{favoritesOnly ? '当前模式在所选标的中还没有收藏记录。' : historyStatsMode === 'day-sequence' ? '当前筛选还没有日内逐根回放卷子。' : '当前筛选还没有自定义模式卷子。'}</div> : <div className="decision-history-list">
          {renderedHistorySessionGroups.map(({ session, candidates, entries, results, symbols, favoriteCount }) => {
            const participated = results.filter((result) => result.choice === 'traded')
            const userStats = decisionWinStats(participated, historyPositionMode, 'user')
            const systemStats = decisionWinStats(results, historyPositionMode, 'system')
            const completedCount = results.length
            const totalCount = favoritesOnly ? entries.length : candidates.length
            const progressCount = entries.length
            return <div
              key={session.id}
              className="decision-history-card decision-history-session-card"
              role="button"
              tabIndex={0}
              onClick={() => onOpenSession(session.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onOpenSession(session.id)
                }
              }}
              aria-label={`查看${symbols.join(' / ')}第 ${new Date(session.startedAt).toLocaleString('zh-CN')} 场练习详情`}
            >
              <div className="decision-history-card-head decision-history-session-card-head">
                <span className={`decision-session-status ${session.status}`}>{statusLabel(session.status)}</span>
                <span>
                  <b>{symbols.join(' / ')} · {decisionSessionPracticeMode(session) === 'day-sequence' ? '日内逐根回放' : '决策练习'}</b>
                  <small>{decisionSessionTimeLabel(session)} · {progressCount} 笔有记录 · {decisionSizingLabels(decisionSessionPositionSizingModes(session))}</small>
                </span>
                {favoriteCount > 0 ? <span className="decision-history-favorite-count"><Star size={13} fill="currentColor" />{favoriteCount} 笔</span> : <span />}
                <ChevronRight size={19} />
              </div>
              <div className="decision-history-session-progress">
                <span><small>本场进度</small><b>{completedCount} / {totalCount} 笔</b></span>
                <span><small>参与 / 未参与</small><b>{participated.length} / {results.filter((result) => result.choice === 'skipped').length}</b></span>
                <span><small>已结算</small><b>{completedCount} 笔</b></span>
              </div>
              <div className="decision-history-card-stats decision-history-session-stats">
                <span><small>你的考分 · 净盈亏</small><DecisionModeMoneyStack modes={historyModes} valueFor={(mode) => aggregateDecisionResults(results, mode).userPnlUsd} /><small>参与胜率 <strong>{decisionWinRateText(userStats)}</strong> · 盈利 {userStats.wins} / {userStats.total} 笔</small></span>
                <span><small>系统考分 · 净盈亏</small><DecisionModeMoneyStack modes={historyModes} valueFor={(mode) => aggregateDecisionResults(results, mode).systemPnlUsd} /><small>总胜率 <strong>{decisionWinRateText(systemStats)}</strong> · 盈利 {systemStats.wins} / {systemStats.total} 笔</small></span>
                <span><small>相对系统</small><DecisionModeMoneyStack modes={historyModes} valueFor={(mode) => aggregateDecisionResults(results, mode).differenceUsd} /><small>{decisionPositionSizingLabel(historyPositionMode)} · 当前筛选 {completedCount} 笔</small></span>
              </div>
            <small className="decision-history-card-hint">点击查看本场每笔交易详情、收益对比和独立画图；重新回看不会覆盖原结果</small>
            </div>
          })}
        </div>) : (modeTradeEntries.length === 0 ? <div className="decision-empty">{favoritesOnly ? '当前模式在所选标的中还没有收藏记录。' : historyStatsMode === 'day-sequence' ? '当前筛选还没有日内逐根回放交易。' : '当前筛选还没有自定义模式交易。'}</div> : <div className="decision-history-list">
          {renderedTradeEntries.map(({ session, candidate, attempt, result, favoriteKey, favorite, ordinal }) => <div
            key={`${session.id}:${candidate.key}`}
            className={`decision-history-card decision-history-trade-card${favorite ? ' favorite' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => openFavoriteTrade(session.id, candidate.key)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                openFavoriteTrade(session.id, candidate.key)
              }
            }}
            aria-label={`查看交易 ${candidate.symbol} 第 ${candidate.trade.tradeNumber} 笔`}
          >
            <div className="decision-history-card-head decision-history-trade-card-head">
              <span className={`decision-session-status ${result ? 'completed' : session.status}`}>{decisionHistoryTradeStatus(result, session)}</span>
              <span>
                <b>{candidate.symbol} · {INTERVALS[candidate.interval].label} · {(result ? decisionResultSide(result) : attempt ? decisionAttemptSide(candidate, attempt) : candidate.trade.side) === 'long' ? '多头' : '空头'} · 第 {candidate.trade.tradeNumber} 笔</b>
                <small>{decisionSessionPracticeMode(session) === 'day-sequence' ? '日内逐根回放 · ' : ''}练习 {new Date(session.startedAt).toLocaleString('zh-CN')} · 信号 K {formatDecisionDate(candidate.trade.entry.signalTime)} · 本场第 {ordinal} / {session.candidates.length} 笔</small>
              </span>
              <DecisionFavoriteButton favorite={favorite} onToggle={() => onToggleFavorite(favoriteKey)} label={favorite ? '取消收藏本笔交易' : '收藏本笔交易'} />
              <ChevronRight size={19} />
            </div>
            {result ? <div className="decision-history-card-stats">
              <span>你的选择 <b>{choiceLabel(result)}</b></span>
              {result.choice === 'traded' ? <>
                <span>你的 <DecisionModeMoneyStack modes={historyModes} valueFor={(mode) => decisionResultPnl(result, mode, 'user')} /><small>{historyPositionMode === 'fixed-risk'
                  ? `初始止损 ${formatPrice(decisionResultInitialStopLoss(result) ?? 0, candidate.symbol)} · ${decisionResultR(result, 'user').toFixed(2)}R × 100U`
                  : `收益率 ${(decisionResultPnl(result, 'fixed-notional', 'user') / 100).toFixed(2)}% × 10,000U`}</small></span>
                <span>本题系统 <DecisionModeMoneyStack modes={historyModes} valueFor={(mode) => decisionResultPnl(result, mode, 'system')} /></span>
                <span>差额 <DecisionModeMoneyStack modes={historyModes} valueFor={(mode) => decisionResultPnl(result, mode, 'user') - decisionResultPnl(result, mode, 'system')} /></span>
              </> : <>
                <span>你的盈亏 <b>$0.00</b></span>
                <span>本题系统 <DecisionModeMoneyStack modes={historyModes} valueFor={(mode) => decisionResultPnl(result, mode, 'system')} /></span>
                <span>相对系统 <DecisionModeMoneyStack modes={historyModes} valueFor={(mode) => -decisionResultPnl(result, mode, 'system')} /><small>未参与不计入你的胜率</small></span>
              </>}
            </div> : <div className="decision-history-card-stats decision-history-trade-pending">
              <span>交易状态 <b>{attempt ? '进行中，尚未结算' : '等待开始'}</b></span>
              <span>点击后继续这笔交易；结算后会在这里显示本笔盈亏与系统对比。</span>
            </div>}
            <small className="decision-history-card-hint">{result ? '点击直接打开这一笔的 K 线复盘与独立画图；将从信号 K 开始重新做，可重新选择和交易，原结果不会被覆盖' : '点击返回这一笔尚未完成的决策练习'}</small>
            {result && <button
              type="button"
              className="decision-history-replay-action"
              onClick={(event) => {
                event.stopPropagation()
                openFavoriteTrade(session.id, candidate.key)
              }}
            >从信号K开始做</button>}
          </div>)}
        </div>)}
        {hasMoreHistoryItems && <button type="button" className="decision-history-load-more" onClick={loadMoreHistoryItems}>继续向下滚动加载 · 已显示 {historyRenderLimit} / {historyItemCount}</button>}
      </div>
    </section>
  </div>
}, sameDecisionHistoryDialogProps)

export function DecisionChartStatus({ session, attempt, currentPnlByMode = null, systemCurrentPnlByMode = null, systemCurrentPnlLocked = false, positionSizingModes = ['fixed-risk'] }: {
  session: DecisionReplaySession
  attempt: DecisionAttempt
  currentPnlByMode?: Partial<Record<DecisionPositionSizingMode, number>> | null
  systemCurrentPnlByMode?: Partial<Record<DecisionPositionSizingMode, number>> | null
  systemCurrentPnlLocked?: boolean
  positionSizingModes?: readonly DecisionPositionSizingMode[]
}) {
  const statusRef = useRef<HTMLElement>(null)
  const statusDragRef = useRef<{ pointerId: number; startX: number; startY: number; startLeft: number; startTop: number } | null>(null)
  const [statusPreferences, setStatusPreferences] = useState(loadDecisionChartStatusPreferences)
  const [statusDragging, setStatusDragging] = useState(false)
  const results = sessionResults(session)
  const participatedResults = results.filter((result) => result.choice === 'traded')
  const skippedTradeCount = results.filter((result) => result.choice === 'skipped').length
  const positionOpen = attempt.stage === 'position-open' && currentPnlByMode !== null
  const currentCandidate = session.candidates[session.currentIndex]
  const preSignal = decisionSessionPracticeMode(session) === 'day-sequence'
    && attempt.stage === 'entry-decision'
    && Boolean(currentCandidate && attempt.cursorTime < currentCandidate.trade.entry.signalTime)
  const hasCurrentResult = Boolean(attempt.result)
  const hasCurrentPnl = positionOpen || hasCurrentResult
  const currentResultIsUnsettled = attempt.stage === 'post-exit' && hasCurrentResult
  const settledResults = currentResultIsUnsettled
    ? results.filter((result) => result.candidateKey !== attempt.candidateKey)
    : results
  const aiHasCurrentFloat = !systemCurrentPnlLocked && (currentResultIsUnsettled || systemCurrentPnlByMode !== null)
  const aiSettledCount = systemCurrentPnlLocked ? settledResults.length + 1 : settledResults.length
  const stageLabel: Record<DecisionAttempt['stage'], string> = {
    'entry-decision': '等待你的决策',
    'entry-price': '选择挂单价',
    'risk-setup': '设置止损止盈',
    'order-pending': '挂单等待成交',
    'position-open': '实时浮动，随下一根 K 线更新',
    'post-exit': '本笔已结算，仍可继续观察',
    complete: '本笔已完成',
  }
  const currentValueFor = (mode: DecisionPositionSizingMode) => positionOpen
    ? currentPnlByMode?.[mode] ?? 0
    : attempt.result ? decisionResultPnl(attempt.result, mode, 'user') : 0
  const totalValueFor = (mode: DecisionPositionSizingMode) => aggregateDecisionResults(results, mode).userPnlUsd
    + (positionOpen ? currentPnlByMode?.[mode] ?? 0 : 0)
  const aiTotalValueFor = (mode: DecisionPositionSizingMode) => aggregateDecisionResults(settledResults, mode).systemPnlUsd
    + (systemCurrentPnlByMode?.[mode] ?? 0)
  const userWinRate = decisionWinRateText(decisionWinStats(participatedResults, positionSizingModes[0] ?? 'fixed-risk', 'user'))

  const clampCurrentStatus = useCallback(() => {
    const status = statusRef.current
    const parent = status?.parentElement
    if (!status || !parent) return
    const containerRect = parent.getBoundingClientRect()
    const statusRect = status.getBoundingClientRect()
    setStatusPreferences((current) => {
      if (!current.position) return current
      const position = clampDecisionMenuPosition(current.position, containerRect, statusRect)
      if (position.left === current.position.left && position.top === current.position.top) return current
      return { position }
    })
  }, [])

  useEffect(() => {
    if (!statusDragging) saveDecisionChartStatusPreferences(statusPreferences)
  }, [statusDragging, statusPreferences])

  useEffect(() => {
    const status = statusRef.current
    const parent = status?.parentElement
    if (!parent) return
    clampCurrentStatus()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(clampCurrentStatus)
    observer?.observe(parent)
    window.addEventListener('resize', clampCurrentStatus)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', clampCurrentStatus)
    }
  }, [clampCurrentStatus])

  const endStatusDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = statusDragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    statusDragRef.current = null
    setStatusDragging(false)
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    } catch { /* the pointer may already have been released */ }
  }

  const handleStatusDragStart = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const status = statusRef.current
    const parent = status?.parentElement
    if (!status || !parent) return
    event.preventDefault()
    event.stopPropagation()
    const containerRect = parent.getBoundingClientRect()
    const statusRect = status.getBoundingClientRect()
    const position = clampDecisionMenuPosition({
      left: statusRect.left - containerRect.left,
      top: statusRect.top - containerRect.top,
    }, containerRect, statusRect)
    setStatusPreferences({ position })
    statusDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: position.left,
      startTop: position.top,
    }
    setStatusDragging(true)
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* pointer capture is optional */ }
  }

  const handleStatusDragMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = statusDragRef.current
    const status = statusRef.current
    const parent = status?.parentElement
    if (!drag || event.pointerId !== drag.pointerId || !status || !parent) return
    event.preventDefault()
    const next = clampDecisionMenuPosition({
      left: drag.startLeft + event.clientX - drag.startX,
      top: drag.startTop + event.clientY - drag.startY,
    }, parent.getBoundingClientRect(), status.getBoundingClientRect())
    setStatusPreferences({ position: next })
  }

  return <aside ref={statusRef} style={decisionChartStatusStyle(statusPreferences)} className={`decision-chart-status${statusDragging ? ' is-dragging' : ''}`} data-testid="decision-chart-status" aria-label="本场练习盈亏">
    <header
      data-testid="decision-chart-status-drag-handle"
      title="拖动移动本场练习盈亏"
      onPointerDown={handleStatusDragStart}
      onPointerMove={handleStatusDragMove}
      onPointerUp={endStatusDrag}
      onPointerCancel={endStatusDrag}
      onLostPointerCapture={(event) => {
        if (statusDragRef.current?.pointerId !== event.pointerId) return
        statusDragRef.current = null
        setStatusDragging(false)
      }}
    >
      <strong><span className="decision-chart-status-grip" aria-hidden="true">⠿</span><CircleDollarSign size={15} />本场练习盈亏</strong>
      <span>{session.practiceMode === 'day-sequence' && session.daySequence ? `${formatDecisionDay(session.daySequence.startTime)} · 按日顺序 · ` : ''}第 {session.currentIndex + 1} / {session.candidates.length} 笔</span>
    </header>
    <div className="decision-chart-status-grid">
      <article className={`current-pnl${hasCurrentPnl ? ' has-value' : ''}`}>
        <div><span>{positionOpen ? '当前笔实时盈亏' : '当前笔盈亏'}</span><small>{preSignal ? '从开盘逐根等待信号' : stageLabel[attempt.stage]}</small></div>
        {hasCurrentPnl
          ? <DecisionModeMoneyStack modes={positionSizingModes} valueFor={currentValueFor} compact />
          : <b className="decision-chart-status-empty">—</b>}
      </article>
      <article className="user-total has-value">
        <div><span>本场累计净盈亏</span><small>参与胜率 <strong>{userWinRate}</strong> · {positionOpen ? '已参与结果 + 当前浮盈' : `参与 ${participatedResults.length} / 未参与 ${skippedTradeCount} / 已结算 ${results.length} 笔`}</small></div>
        <DecisionModeMoneyStack modes={positionSizingModes} valueFor={totalValueFor} compact />
      </article>
      <article className="ai-total has-value" data-testid="decision-chart-ai-total">
        <div><span>本场 AI 累计净盈亏</span><small>{aiHasCurrentFloat ? `已结算 ${settledResults.length} 笔 + 当前浮动` : `全部已结算 ${systemCurrentPnlLocked ? aiSettledCount : results.length} 笔题目`}</small></div>
        <DecisionModeMoneyStack modes={positionSizingModes} valueFor={aiTotalValueFor} compact />
      </article>
    </div>
  </aside>
}

function StageBadge({ attempt, preSignal = false }: { attempt: DecisionAttempt; preSignal?: boolean }) {
  const labels: Record<DecisionAttempt['stage'], string> = {
    'entry-decision': '等待决策', 'entry-price': '选择挂单价', 'risk-setup': '设置止盈止损',
    'order-pending': '挂单等待成交', 'position-open': '持仓中', 'post-exit': '已平仓·观察中', complete: '已完成',
  }
  return <span className={`decision-stage ${attempt.stage}`}>{preSignal && attempt.stage === 'entry-decision' ? '等待决策' : labels[attempt.stage]}</span>
}

type DecisionAnnotationPlacement =
  | 'placement-above-right' | 'placement-above-left'
  | 'placement-below-right' | 'placement-below-left'
  | 'placement-above' | 'placement-below'
  | 'placement-center-right' | 'placement-center-left'

interface DecisionAnnotationSpec {
  id: string
  x: number
  y: number
  kind: 'point' | 'reason'
  preference: DecisionAnnotationPlacement
  labelY?: number
}

interface DecisionAnnotationRect {
  left: number
  right: number
  top: number
  bottom: number
}

const DECISION_POINT_LABEL_WIDTH = 200
const DECISION_POINT_LABEL_HEIGHT = 44
const DECISION_REASON_LABEL_WIDTH = 48
const DECISION_REASON_LABEL_HEIGHT = 18
const DECISION_ANNOTATION_GAP = 14

function decisionAnnotationRect(spec: DecisionAnnotationSpec, placement: DecisionAnnotationPlacement): DecisionAnnotationRect {
  const width = spec.kind === 'point' ? DECISION_POINT_LABEL_WIDTH : DECISION_REASON_LABEL_WIDTH
  const height = spec.kind === 'point' ? DECISION_POINT_LABEL_HEIGHT : DECISION_REASON_LABEL_HEIGHT
  const y = spec.labelY ?? spec.y
  switch (placement) {
    case 'placement-above-right':
      return { left: spec.x + 8, right: spec.x + 8 + width, top: y - height - DECISION_ANNOTATION_GAP, bottom: y - DECISION_ANNOTATION_GAP }
    case 'placement-above-left':
      return { left: spec.x - 8 - width, right: spec.x - 8, top: spec.y - height - DECISION_ANNOTATION_GAP, bottom: spec.y - DECISION_ANNOTATION_GAP }
    case 'placement-below-right':
      return { left: spec.x + 8, right: spec.x + 8 + width, top: y + DECISION_ANNOTATION_GAP, bottom: y + DECISION_ANNOTATION_GAP + height }
    case 'placement-below-left':
      return { left: spec.x - 8 - width, right: spec.x - 8, top: spec.y + DECISION_ANNOTATION_GAP, bottom: spec.y + DECISION_ANNOTATION_GAP + height }
    case 'placement-above':
      return { left: spec.x - width / 2, right: spec.x + width / 2, top: y - height - DECISION_ANNOTATION_GAP, bottom: y - DECISION_ANNOTATION_GAP }
    case 'placement-below':
      return { left: spec.x - width / 2, right: spec.x + width / 2, top: y + DECISION_ANNOTATION_GAP, bottom: y + DECISION_ANNOTATION_GAP + height }
    case 'placement-center-right':
      return { left: spec.x + 8, right: spec.x + 8 + width, top: spec.y - height / 2, bottom: spec.y + height / 2 }
    case 'placement-center-left':
      return { left: spec.x - 8 - width, right: spec.x - 8, top: spec.y - height / 2, bottom: spec.y + height / 2 }
  }
}

function decisionAnnotationOverlap(left: DecisionAnnotationRect, right: DecisionAnnotationRect) {
  return Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left))
    * Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top))
}

function decisionAnnotationCandidates(spec: DecisionAnnotationSpec): DecisionAnnotationPlacement[] {
  if (spec.kind === 'reason') {
    return spec.preference === 'placement-below'
      ? ['placement-below', 'placement-below-left', 'placement-below-right', 'placement-above', 'placement-above-left', 'placement-above-right']
      : ['placement-above', 'placement-above-left', 'placement-above-right', 'placement-below', 'placement-below-left', 'placement-below-right']
  }
  // Center each label on its candle: system above, user below. Only the
  // vertical row may change when labels collide, never the time coordinate.
  return spec.preference.startsWith('placement-below')
    ? ['placement-below']
    : ['placement-above']
}

/** Keep replay labels readable when several causal references share a candle. */
function layoutDecisionAnnotations(specs: readonly DecisionAnnotationSpec[]) {
  const placements = new Map<string, { placement: DecisionAnnotationPlacement; rect: DecisionAnnotationRect }>()
  const reserved: DecisionAnnotationRect[] = []
  const pointCount = specs.filter((spec) => spec.kind === 'point').length
  specs.forEach((spec) => {
    const preferredPlacements = decisionAnnotationCandidates(spec)
    const candidates = spec.kind === 'point'
      ? Array.from({ length: pointCount }, (_, lane) => preferredPlacements.map((placement) => {
        const rect = decisionAnnotationRect(spec, placement)
        // Both owners get their own band; fill its rows from top to bottom.
        const offset = lane * (DECISION_POINT_LABEL_HEIGHT + 8)
        const top = Math.max(8, rect.top) + offset
        return { placement, rect: { ...rect, top, bottom: top + DECISION_POINT_LABEL_HEIGHT } }
      })).flat()
      : preferredPlacements.map((placement) => ({ placement, rect: decisionAnnotationRect(spec, placement) }))
    let bestPlacement: DecisionAnnotationPlacement | null = null
    let bestRect: DecisionAnnotationRect | null = null
    let bestScore = Number.POSITIVE_INFINITY
    candidates.forEach(({ placement, rect }, rank) => {
      const paddedRect = spec.kind === 'point' ? { ...rect, top: rect.top - 4, bottom: rect.bottom + 4 } : rect
      const overlap = reserved.reduce((total, item) => total + decisionAnnotationOverlap(paddedRect, item), 0)
      const clippedTop = spec.kind === 'point' ? Math.max(0, -rect.top) * (rect.right - rect.left) : 0
      const score = (overlap + clippedTop) * 1000 + rank
      if (score < bestScore) {
        bestPlacement = placement
        bestRect = rect
        bestScore = score
      }
    })
    if (!bestPlacement || !bestRect) return
    placements.set(spec.id, { placement: bestPlacement, rect: bestRect })
    reserved.push(bestRect)
  })
  return placements
}

function decisionReasonConnectorEndpoint(x: number, y: number, placement: DecisionAnnotationPlacement | undefined) {
  switch (placement) {
    case 'placement-above-left': return { x: x - 8, y: y - DECISION_ANNOTATION_GAP }
    case 'placement-above-right': return { x: x + 8, y: y - DECISION_ANNOTATION_GAP }
    case 'placement-below-left': return { x: x - 8, y: y + DECISION_ANNOTATION_GAP }
    case 'placement-below-right': return { x: x + 8, y: y + DECISION_ANNOTATION_GAP }
    case 'placement-below': return { x, y: y + DECISION_ANNOTATION_GAP }
    case 'placement-above':
    default:
      return { x, y: y - DECISION_ANNOTATION_GAP }
  }
}

export function DecisionReplayPanel({ candidate, attempt, ordinal, total, currentClose = null, currentPnlUsd = null, currentPnlByMode = null, positionSizingModes = ['fixed-risk'], favorite = false, independentReview = false, preSignal = false, daySequenceMode = false, canAdvanceTrade = true, onToggleFavorite = () => undefined, onAdvance, onSignalExtreme, onFreePrice, onOpenLong = () => undefined, onOpenShort = () => undefined, onSkip, onManualClose, onCancelPending, onNextTrade, onRestartTrade = () => undefined, onStop }: {
  candidate: ReplayDecisionCandidate
  attempt: DecisionAttempt
  ordinal: number
  total: number
  currentClose?: number | null
  currentPnlUsd?: number | null
  currentPnlByMode?: Partial<Record<DecisionPositionSizingMode, number>> | null
  positionSizingModes?: readonly DecisionPositionSizingMode[]
  favorite?: boolean
  independentReview?: boolean
  preSignal?: boolean
  daySequenceMode?: boolean
  canAdvanceTrade?: boolean
  onToggleFavorite?: () => void
  onAdvance: () => void
  onSignalExtreme: () => void
  onFreePrice: () => void
  onOpenLong?: () => void
  onOpenShort?: () => void
  onSkip: () => void
  onManualClose: () => void
  onCancelPending: () => void
  onNextTrade: () => void
  onRestartTrade?: () => void
  onStop: () => void
}) {
  const systemLong = candidate.trade.side === 'long'
  const userLong = decisionAttemptSide(candidate, attempt) === 'long'
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
        <div><h2>{preSignal ? `${candidate.symbol} · ${INTERVALS[candidate.interval].label} · 日内逐根回放` : `第 ${ordinal} / ${total} 笔 · ${candidate.symbol} · ${INTERVALS[candidate.interval].label}`}</h2><small>{preSignal
          ? `当前 K：${formatDecisionDate(attempt.cursorTime)} · 信号尚未出现，未来信息保持隐藏`
          : <>{independentReview ? '独立复盘 · 原记录不会被覆盖 · ' : ''}信号 K：{formatDecisionDate(candidate.trade.entry.signalTime)} · {attempt.result ? '本笔盈亏已锁定，可继续观看后续 K 线' : '系统原结果将在本笔结束后揭晓'}</>}</small></div>
        {!preSignal && <DecisionFavoriteButton
          favorite={favorite}
          onToggle={onToggleFavorite}
          label={favorite ? '取消收藏本笔交易' : '收藏本笔交易'}
        />}
        <StageBadge attempt={attempt} preSignal={preSignal} />
        <button title="提前退出并结算" onClick={onStop}><LogOut size={19} /></button>
      </header>
      <div className="decision-detail-scroll">
        {preSignal ? <section className="decision-reason decision-pre-signal">
          <h3>从当天第一根 K 线开始</h3>
          <p>按 1 逐根播放行情；按 2 以当前 K 线收盘价开多，按 3 开空。系统方向和理由只会在对应信号 K 到达后显示。</p>
        </section> : <><section className="decision-signal-summary">
          <div className={systemLong ? 'long' : 'short'}>{systemLong ? '开多信号' : '开空信号'}</div>
        </section>
        <section className="decision-reason">
          <h3 className={systemLong ? 'long' : 'short'}>{candidate.trade.entry.setup}</h3>
          <p>{highlightDecisionReason(candidate.trade.entry.reason, entryReferenceIndexes)}</p>
        </section></>}
        {attempt.pendingEntryPrice !== null && <section className="decision-order-state">
          <h3><Target size={17} />你的订单</h3>
          <dl><dt>方向</dt><dd>{userLong ? '做多' : '做空'}</dd><dt>类型</dt><dd>{attempt.entryMode === 'market-close' ? '当前 K 收盘开仓' : orderKindLabel(attempt.orderKind)}</dd><dt>{attempt.fill ? '开仓价' : '挂单价'}</dt><dd>{formatPrice(attempt.pendingEntryPrice, candidate.symbol)}</dd>{attempt.fill && <><dt>成交时间</dt><dd>{formatDecisionDate(attempt.fill.time)}</dd></>}</dl>
          <small>{decisionStopLossMode(attempt.stopLossMode) === 'close' ? '收盘止损 · 收盘越线按收盘价退出；系统先平仓则跟随退出' : '触碰止损 · 仅本笔生效，下笔恢复收盘止损'}</small>
        </section>}
        {attempt.result && <section className="decision-post-exit-summary">
          <h3><Flag size={17} />本笔已经平仓</h3>
          <p>你的盈亏 <DecisionModeMoneyStack modes={positionSizingModes} compact={false} valueFor={(mode) => decisionResultPnl(attempt.result!, mode, 'user')} />，V5 系统盈亏 <DecisionModeMoneyStack modes={positionSizingModes} compact={false} valueFor={(mode) => decisionResultPnl(attempt.result!, mode, 'system')} />。</p>
          <p>{exitReasonLabel(attempt.result.userExit.reason, attempt.result.stopLossMode)}</p>
          <small>按 1 继续逐根观看后续行情；按 4 进入下一笔；按 5 从信号 K 重新开始本笔。</small>
        </section>}
      </div>
      <div className="decision-resize-handle" data-testid="decision-detail-resize-handle" aria-label="调整决策详情框大小" title="拖动调整详情框大小" onPointerDown={handleResizeStart} />
    </aside>
    <nav ref={menuRef} style={decisionMenuStyle(menuPreferences)} className={`decision-action-menu${menuDragging ? ' is-dragging' : ''}`} aria-label="决策操作菜单" data-testid="decision-action-menu">
      <div className="decision-action-progress" onPointerDown={handleMenuDragStart} title="拖动移动决策操作框">
        <span className="decision-menu-grip" role="button" aria-label="拖动移动决策操作框" data-testid="decision-action-drag-handle">⠿</span>
        <b>决策回放</b><span>{ordinal}/{total}</span><StageBadge attempt={attempt} preSignal={preSignal} />
      </div>
      {daySequenceMode && attempt.stage === 'entry-decision' && <div className="decision-choice-grid decision-day-choice-grid">
        <button onClick={onAdvance}><kbd>1</kbd><span><b>播放下一根 K 线</b><small>继续逐根观察</small></span></button>
        <button onClick={onOpenLong}><kbd>2</kbd><span><b>开多</b><small>按当前 K 线收盘价</small></span></button>
        <button onClick={onOpenShort}><kbd>3</kbd><span><b>开空</b><small>按当前 K 线收盘价</small></span></button>
      </div>}
      {!daySequenceMode && !preSignal && attempt.stage === 'entry-decision' && <div className="decision-choice-grid">
        <button onClick={onAdvance}><kbd>1</kbd><span><b>先观察</b><small>进入下一根 K 线</small></span></button>
        <button onClick={onSignalExtreme}><kbd>2</kbd><span><b>本 K 突破价挂单</b><small>{systemLong ? '最高价做多' : '最低价做空'}</small></span></button>
        <button onClick={onFreePrice}><kbd>3</kbd><span><b>自由选择挂单价</b><small>在图上点击价格</small></span></button>
        <button className="skip" onClick={onSkip}><kbd>4</kbd><span><b>不参与</b><small>直接进入下一笔</small></span></button>
      </div>}
      {attempt.stage === 'order-pending' && <div className="decision-active-actions"><button onClick={onAdvance}><kbd>1</kbd>进入下一根 K 线</button><button className="danger" onClick={onCancelPending}><kbd>2</kbd>撤单并进入下一根 K 线</button></div>}
      {attempt.stage === 'position-open' && <>
        {hasLivePnl && <div className={`decision-live-pnl${livePnlValue === null ? '' : livePnlValue >= 0 ? ' positive' : ' negative'}`} data-testid="decision-live-pnl">
          <span>本根收盘 {formatPrice(currentClose, candidate.symbol)}</span>
          {currentPnlByMode !== null ? <DecisionModeMoneyStack modes={positionSizingModes} compact={false} valueFor={(mode) => currentPnlByMode[mode] ?? 0} valueLabel={(value) => value >= 0 ? '浮盈' : '浮亏'} /> : <b>{currentPnlUsd! >= 0 ? '浮盈' : '浮亏'} {formatDecisionPnl(currentPnlUsd!)}</b>}
        </div>}
        <div className="decision-active-actions"><button onClick={onAdvance}><kbd>1</kbd>进入下一根 K 线</button><button className="close-position" onClick={onManualClose}><kbd>2</kbd>按当前 K 线收盘价离场</button></div>
      </>}
      {attempt.stage === 'post-exit' && <div className={`decision-active-actions post-exit-actions${canAdvanceTrade ? '' : ' no-next'}`}><button onClick={onAdvance}><kbd>1</kbd>继续观看下一根 K 线</button>{canAdvanceTrade && <button className="close-position" onClick={onNextTrade}><kbd>4</kbd>进入下一笔交易</button>}<button className="restart-trade" onClick={onRestartTrade}><kbd>5</kbd>重新开始这笔交易</button>{daySequenceMode && !canAdvanceTrade && <small>当天最后一笔结束后，继续按 1 逐根看到收盘。</small>}</div>}
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
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const root = (event.currentTarget as HTMLElement).closest('.decision-risk-overlay') as HTMLElement | null
    if (!root) return
    const pointerId = event.pointerId
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return
      pointer.preventDefault()
      const rect = root.getBoundingClientRect()
      const price = toPrice(pointer.clientY - rect.top)
      if (price !== null) onValue(price)
    }
    const up = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      moveRef.current = null
    }
    moveRef.current = move
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }
}

type DecisionRiskAmountPlacement = 'center' | 'left' | 'right'

const DECISION_RISK_AMOUNT_GAP = 14

export function DecisionRiskOverlay({ candidate, side, entryPrice, entryLabel = '挂单', stopLoss, takeProfit, initialStopLoss = stopLoss, stopLossMode = 'close', onStopLossMode, currentCandleX = null, currentClose = null, currentPnlUsd = null, currentPnlByMode = null, positionSizingModes = ['fixed-risk'], toPrice, toY, onStopLoss, onTakeProfit, onConfirm, onCancel, editable = true, showConfirmControls = editable }: {
  candidate: ReplayDecisionCandidate
  side?: TradeSide
  entryPrice: number
  entryLabel?: '挂单' | '开仓'
  stopLoss: number
  takeProfit: number
  stopLossMode?: DecisionStopLossMode
  onStopLossMode?: (mode: DecisionStopLossMode) => void
  /** Fixed-risk amounts remain sized from the original protective stop after trailing edits. */
  initialStopLoss?: number | null
  /** Horizontal chart coordinate of the latest visible candle, in the overlay's local coordinate system. */
  currentCandleX?: number | null
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
  const [targetAmountPlacement, setTargetAmountPlacement] = useState<DecisionRiskAmountPlacement>('center')
  const [stopAmountPlacement, setStopAmountPlacement] = useState<DecisionRiskAmountPlacement>('center')
  const [stopControlLeft, setStopControlLeft] = useState<number | null>(null)
  const riskOverlayRef = useRef<HTMLDivElement>(null)
  const stopControlRef = useRef<HTMLSpanElement>(null)
  const targetAmountRef = useRef<HTMLDivElement>(null)
  const stopAmountRef = useRef<HTMLDivElement>(null)
  const entryY = toY(entryPrice)
  const stopY = toY(stopLoss)
  const targetY = toY(takeProfit)
  const ratio = rewardRiskRatio(entryPrice, stopLoss, takeProfit)
  const currentY = currentClose === null ? null : toY(currentClose)
  const currentPnlMode = positionSizingModes.length === 1 ? positionSizingModes[0] : null
  const currentPnlValue = currentPnlMode && currentPnlByMode ? currentPnlByMode[currentPnlMode] ?? 0 : currentPnlUsd
  const hasCurrentPnl = currentClose !== null && currentY !== null && (currentPnlByMode !== null ? positionSizingModes.length > 0 : currentPnlUsd !== null)
  const amountModes = positionSizingModes.length > 0 ? positionSizingModes : DEFAULT_DECISION_POSITION_SIZING_MODES
  const riskSizingStopLoss = initialStopLoss ?? stopLoss
  const positionSide = side ?? candidate.trade.side
  const amountAt = (exitPrice: number): Record<DecisionPositionSizingMode, number> => ({
    'fixed-risk': pnlForDecisionMode('fixed-risk', positionSide, entryPrice, exitPrice, riskSizingStopLoss),
    'fixed-notional': pnlForDecisionMode('fixed-notional', positionSide, entryPrice, exitPrice, riskSizingStopLoss),
  })
  const stopLossAmountByMode = amountAt(stopLoss)
  const takeProfitAmountByMode = amountAt(takeProfit)
  const amountPosition = currentCandleX === null ? undefined : { left: currentCandleX, right: 'auto' }
  const amountClassName = (placement: DecisionRiskAmountPlacement) => {
    if (currentCandleX === null) return 'decision-risk-amount'
    const shiftClass = placement === 'left' ? ' is-shifted-left' : placement === 'right' ? ' is-shifted-right' : ''
    return `decision-risk-amount is-anchored${shiftClass}`
  }
  useLayoutEffect(() => {
    const root = riskOverlayRef.current
    if (!root || currentCandleX === null || typeof window === 'undefined') return
    let frame: number | null = null
    let cancelled = false
    const schedule = () => {
      if (cancelled || frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        if (cancelled) return
        const currentRoot = riskOverlayRef.current
        const amountEntries = [
          { key: 'target' as const, element: targetAmountRef.current },
          { key: 'stop' as const, element: stopAmountRef.current },
        ].filter((entry): entry is { key: 'target' | 'stop'; element: HTMLDivElement } => entry.element !== null)
        if (!currentRoot || amountEntries.length === 0) return
        const rootRect = currentRoot.getBoundingClientRect()
        const obstacleSelector = [
          '.decision-chart-annotations .decision-point',
          '.decision-chart-annotations .decision-reason-candle-marker',
          '.decision-signal-cursor span',
          '.decision-price-line > span',
          '.decision-risk-line > span',
          '.decision-position-pnl-line > span',
          '.context-price-line > span',
          '.decision-risk-confirm',
          '.decision-action-menu',
          '.decision-chart-status',
          '.decision-detail-panel',
        ].join(', ')
        const obstacles = [...document.querySelectorAll<HTMLElement>(obstacleSelector)]
          .filter((element) => !element.closest('.decision-risk-amount'))
          .map((element) => element.getBoundingClientRect())
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map((rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }))
        const reserved = [...obstacles]
        const control = stopControlRef.current
        if (control) {
          const rect = control.getBoundingClientRect()
          const blockers = [...document.querySelectorAll<HTMLElement>('.decision-detail-panel, .decision-action-menu, .decision-chart-status, .decision-risk-confirm')]
            .map((element) => element.getBoundingClientRect())
            .filter((item) => item.width > 0 && item.height > 0)
          // Keep the selector on the red line, but out from under draggable panels.
          // Prefer the existing drag handle area rather than covering the latest candle.
          const preferred = rootRect.left + rootRect.width * .23 + 16
          const minLeft = rootRect.left + 12
          const maxLeft = Math.max(minLeft, rootRect.right - rect.width - 12)
          const options = [preferred, minLeft, maxLeft, ...blockers.flatMap((item) => [item.left - rect.width - 12, item.right + 12])]
            .map((left) => Math.max(minLeft, Math.min(maxLeft, left)))
          const best = options.reduce((best, left) => {
            const placed = { left, right: left + rect.width, top: rect.top, bottom: rect.bottom }
            const score = blockers.reduce((sum, item) => sum + decisionAnnotationOverlap(placed, item), 0) * 1000 + Math.abs(left - preferred)
            return score < best.score ? { left, score, rect: placed } : best
          }, { left: minLeft, score: Infinity, rect: { left: minLeft, right: minLeft + rect.width, top: rect.top, bottom: rect.bottom } })
          const localLeft = best.left - rootRect.left
          setStopControlLeft((current) => current !== null && Math.abs(current - localLeft) < .5 ? current : localLeft)
          reserved.push(best.rect)
        }
        const nextPlacement: Partial<Record<'target' | 'stop', DecisionRiskAmountPlacement>> = {}
        for (const entry of amountEntries) {
          const amountRect = entry.element.getBoundingClientRect()
          const base = { top: amountRect.top, bottom: amountRect.bottom }
          const candidates: Array<{ placement: DecisionRiskAmountPlacement; rect: DecisionAnnotationRect }> = [
            {
              placement: 'center',
              rect: {
                ...base,
                left: rootRect.left + currentCandleX - amountRect.width / 2,
                right: rootRect.left + currentCandleX + amountRect.width / 2,
              },
            },
            {
              placement: 'right',
              rect: {
                ...base,
                left: rootRect.left + currentCandleX + DECISION_RISK_AMOUNT_GAP,
                right: rootRect.left + currentCandleX + DECISION_RISK_AMOUNT_GAP + amountRect.width,
              },
            },
            {
              placement: 'left',
              rect: {
                ...base,
                left: rootRect.left + currentCandleX - DECISION_RISK_AMOUNT_GAP - amountRect.width,
                right: rootRect.left + currentCandleX - DECISION_RISK_AMOUNT_GAP,
              },
            },
          ]
          const best = candidates.reduce<{ placement: DecisionRiskAmountPlacement; rect: DecisionAnnotationRect; score: number } | null>((current, candidatePlacement) => {
            const overlap = reserved.reduce((total, obstacle) => total + decisionAnnotationOverlap(candidatePlacement.rect, obstacle), 0)
            const overflow = Math.max(0, rootRect.left - candidatePlacement.rect.left)
              + Math.max(0, candidatePlacement.rect.right - rootRect.right)
            const score = overlap * 1000 + overflow * 100
            return current === null || score < current.score
              ? { ...candidatePlacement, score }
              : current
          }, null)
          if (!best) continue
          nextPlacement[entry.key] = best.placement
          reserved.push(best.rect)
        }
        if (nextPlacement.target) setTargetAmountPlacement((current) => current === nextPlacement.target ? current : nextPlacement.target!)
        if (nextPlacement.stop) setStopAmountPlacement((current) => current === nextPlacement.stop ? current : nextPlacement.stop!)
      })
    }
    schedule()
    const observedRoot = root.parentElement ?? root
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    resizeObserver?.observe(observedRoot)
    const mutationObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule)
    mutationObserver?.observe(observedRoot, { attributes: true, childList: true, subtree: true, attributeFilter: ['class', 'style'] })
    return () => {
      cancelled = true
      if (frame !== null) window.cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
    }
  }, [amountModes, currentCandleX, currentY, editable, entryY, hasCurrentPnl, showConfirmControls, stopY, targetY, stopLossMode])
  const dragStop = useLineDrag(toPrice, onStopLoss ?? (() => undefined))
  const dragTarget = useLineDrag(toPrice, onTakeProfit ?? (() => undefined))
  const precision = symbolPrecision(candidate.symbol)
  return <div ref={riskOverlayRef} className={`decision-risk-overlay ${editable ? 'editable' : 'locked'} ${positionSide}`} data-testid="decision-risk-overlay">
    {targetY !== null && <div className="decision-risk-line target" data-testid="decision-take-profit-line" title={editable ? '拖动调整止盈' : undefined} style={{ top: targetY }} onPointerDown={editable ? dragTarget : undefined}><b className="decision-risk-hit-area" aria-hidden="true" /><i /><span><Target size={15} />止盈 {takeProfit.toFixed(precision)}</span><div ref={targetAmountRef} className={amountClassName(targetAmountPlacement)} data-testid="decision-take-profit-amount" style={amountPosition}><small>止盈金额</small><DecisionModeMoneyStack modes={amountModes} valueFor={(mode) => takeProfitAmountByMode[mode]} /></div></div>}
    {entryY !== null && <div className={`decision-risk-line entry${entryLabel === '开仓' ? ' filled' : ''}`} style={{ top: entryY }}><span>{entryLabel} {entryPrice.toFixed(precision)} · 盈亏比 1 : {ratio.toFixed(2)}</span></div>}
    {hasCurrentPnl && <div className={`decision-position-pnl-line${currentPnlValue === null ? '' : currentPnlValue >= 0 ? ' positive' : ' negative'}`} style={{ top: currentY! }} data-testid="decision-position-pnl-line"><span>收盘 {formatPrice(currentClose!, candidate.symbol)} · {currentPnlByMode !== null ? <DecisionModeMoneyStack modes={positionSizingModes} compact={false} valueFor={(mode) => currentPnlByMode[mode] ?? 0} valueLabel={(value) => value >= 0 ? '浮盈' : '浮亏'} /> : <>{currentPnlUsd! >= 0 ? '浮盈' : '浮亏'} {formatDecisionPnl(currentPnlUsd!)}</>}</span></div>}
    {stopY !== null && <div className="decision-risk-line stop" data-testid="decision-stop-loss-line" title={editable ? '拖动调整止损；按钮只切换本笔模式，不移动价格' : undefined} style={{ top: stopY }} onPointerDown={editable ? dragStop : undefined}>
      <b className="decision-risk-hit-area" aria-hidden="true" /><i />
      <span ref={stopControlRef} className="decision-stop-control" style={{ left: stopControlLeft ?? 12, right: 'auto' }}><Shield size={15} />止损 {stopLoss.toFixed(precision)}
        <span className="decision-stop-mode" role="group" aria-label="本笔止损触发方式" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
          <button type="button" aria-pressed={stopLossMode === 'close'} disabled={!editable || !onStopLossMode} title="默认模式：收盘越过止损线才按收盘价退出，系统先退出则跟随；实际亏损可能超过止损线参考金额" onClick={() => onStopLossMode?.('close')}>收盘止损</button>
          <button type="button" aria-pressed={stopLossMode === 'touch'} disabled={!editable || !onStopLossMode} title="仅本笔：盘中触碰止损线即退出，跳空按开盘价；下一笔恢复收盘止损" onClick={() => onStopLossMode?.('touch')}>触碰止损</button>
        </span>
      </span>
      <div ref={stopAmountRef} className={amountClassName(stopAmountPlacement)} data-testid="decision-stop-loss-amount" style={amountPosition}><small>{stopLossMode === 'close' ? '止损线参考盈亏（非最大亏损）' : '止损金额'}</small><DecisionModeMoneyStack modes={amountModes} valueFor={(mode) => stopLossAmountByMode[mode]} /></div>
    </div>}
    {editable && showConfirmControls && <div className="decision-risk-confirm"><div><b>拖动上下两个控制点</b><small>当前盈亏比 1 : {ratio.toFixed(2)} · {decisionSizingLabels(positionSizingModes)}</small><small>{stopLossMode === 'close' ? '默认收盘止损：可能比止损线亏更多；系统平仓优先' : '触碰止损仅本笔生效，下笔默认收盘止损'}</small></div><button onClick={onCancel}>取消</button><button className="primary" onClick={onConfirm}><Check size={17} />确认并进入下一根 K 线</button></div>}
  </div>
}

export function DecisionChartAnnotations({ candidate, attempt, result, data, toX, toY, hidden = false }: {
  candidate: ReplayDecisionCandidate
  attempt?: DecisionAttempt | null
  result?: DecisionTradeResult | null
  data: readonly Candle[]
  toX: (time: number) => number | null
  toY: (price: number) => number | null
  hidden?: boolean
}) {
  const reasonReferences = useMemo(() => {
    const references = resolveTradeCandleReferences(candidate.trade, data)
    // The chart shows only the entry explanation. Keep hidden system-exit
    // reasoning out of the chart, including after the user closes the trade.
    return references.filter((reference) => reference.sections.includes('entry'))
  }, [candidate.trade, data])
  // A decision chart is a causal tape. The system's fill and exit may be
  // known from the replay data before the user has made the corresponding
  // decision, but they must not appear until their own candles arrive.
  const latestCandle = data.at(-1)
  // A filled/closed order can carry a timestamp inside the last aggregated
  // candle. Treat the whole candle as revealed, then project that timestamp
  // back to its visible candle instead of dropping the user's marker.
  const revealedThrough = latestCandle
    ? latestCandle.time + INTERVALS[candidate.interval].seconds - 1
    : Number.NEGATIVE_INFINITY
  const projectTime = (time: number) => {
    const first = data[0]?.time
    if (first === undefined || time < first || time > revealedThrough) return null
    let projected = first
    for (const candle of data) {
      if (candle.time > time) break
      projected = candle.time
    }
    return projected
  }
  const projectX = (time: number) => {
    const projected = projectTime(time)
    return projected === null ? null : toX(projected)
  }
  const systemEntryVisible = candidate.trade.entry.time <= revealedThrough
  const systemExitVisible = candidate.trade.exit.time <= revealedThrough
  const signalX = projectX(candidate.trade.entry.signalTime)
  const systemEntryX = systemEntryVisible ? projectX(candidate.trade.entry.time) : null
  const systemEntryY = systemEntryVisible ? toY(candidate.trade.entry.price) : null
  const systemExitX = systemExitVisible ? projectX(candidate.trade.exit.time) : null
  const systemExitY = systemExitVisible ? toY(candidate.trade.exit.price) : null
  const userEntry = result?.userEntry ?? attempt?.fill ?? null
  const userExit = result?.userExit ?? null
  const userEntryX = userEntry && userEntry.time <= revealedThrough ? projectX(userEntry.time) : null
  const userEntryY = userEntry === null || userEntryX === null ? null : toY(userEntry.price)
  const userExitX = userExit && userExit.time <= revealedThrough ? projectX(userExit.time) : null
  const userExitY = userExit === null || userExitX === null ? null : toY(userExit.price)
  const pointSpecs = [
    systemEntryX !== null && systemEntryY !== null ? { id: 'system-entry', x: systemEntryX, y: systemEntryY, time: candidate.trade.entry.time, kind: 'point' as const, preference: 'placement-above-right' as const, className: 'system entry', label: `系统开 ${formatPrice(candidate.trade.entry.price, candidate.symbol)}` } : null,
    systemExitX !== null && systemExitY !== null ? { id: 'system-exit', x: systemExitX, y: systemExitY, time: candidate.trade.exit.time, kind: 'point' as const, preference: 'placement-above-right' as const, className: 'system exit', label: `系统平 ${formatPrice(candidate.trade.exit.price, candidate.symbol)}` } : null,
    userEntryX !== null && userEntryY !== null ? { id: 'user-entry', x: userEntryX, y: userEntryY, time: userEntry!.time, kind: 'point' as const, preference: 'placement-below-right' as const, className: 'user entry', label: `你的开仓 ${formatPrice(userEntry!.price, candidate.symbol)}` } : null,
    userExitX !== null && userExitY !== null ? { id: 'user-exit', x: userExitX, y: userExitY, time: userExit!.time, kind: 'point' as const, preference: 'placement-below-right' as const, className: 'user exit', label: `你的平仓 ${formatPrice(userExit!.price, candidate.symbol)}` } : null,
  ].filter((spec): spec is NonNullable<typeof spec> => spec !== null).map((spec) => {
    const candleTime = projectTime(spec.time)!
    const index = data.findIndex((candle) => candle.time === candleTime)
    const candle = data[index]
    const nextX = data[index + 1] ? toX(data[index + 1].time) : null
    const previousX = data[index - 1] ? toX(data[index - 1].time) : null
    const spacing = nextX !== null ? Math.abs(nextX - spec.x) : previousX !== null ? Math.abs(spec.x - previousX) : 12
    return {
      ...spec, candleTime, candleIndex: index, candleSpacing: Math.max(1, spacing),
      candleHighY: Math.min(spec.y, toY(candle.high) ?? spec.y),
      candleLowY: Math.max(spec.y, toY(candle.low) ?? spec.y),
      candleWidth: Math.min(22, Math.max(8, spacing * .8)),
    }
  })
  const candleMarkers: Array<{ id: string; x: number; y: number; candleTime: number; label: string }> = []
  for (const spec of pointSpecs.filter((point) => point.className.startsWith('system'))) {
    let y = spec.candleHighY - 20
    for (const other of candleMarkers) {
      if (Math.abs(spec.x - other.x) < 24 && Math.abs(y - other.y) < 26) y = other.y - 26
    }
    candleMarkers.push({ id: spec.id, x: spec.x, y, candleTime: spec.candleTime, label: spec.id === 'system-entry' ? '开' : '平' })
  }
  // Reserve space outside the nearby candle range, not next to almost equal
  // fill prices. That is where system/user labels used to cover one another.
  const firstLabelX = Math.min(...pointSpecs.map((point) => point.x)) - DECISION_POINT_LABEL_WIDTH / 2
  const lastLabelX = Math.max(...pointSpecs.map((point) => point.x)) + DECISION_POINT_LABEL_WIDTH / 2
  const nearbyStart = Math.max(0, Math.min(...pointSpecs.map((point) => point.candleIndex - Math.ceil(DECISION_POINT_LABEL_WIDTH / 2 / point.candleSpacing) - 1)))
  const nearbyEnd = Math.max(...pointSpecs.map((point) => point.candleIndex + Math.ceil(DECISION_POINT_LABEL_WIDTH / 2 / point.candleSpacing) + 2))
  const nearbyCandles = (pointSpecs.length ? data.slice(nearbyStart, nearbyEnd) : []).flatMap((candle) => {
    const x = toX(candle.time)
    if (x === null || x < firstLabelX || x > lastLabelX) return []
    const high = toY(candle.high)
    const low = toY(candle.low)
    return high === null || low === null ? [] : [{ high, low }]
  })
  const systemLabelY = Math.min(...pointSpecs.map((point) => point.candleHighY), ...nearbyCandles.map((candle) => candle.high), ...candleMarkers.map((marker) => marker.y - 10)) - 12
  const systemBandHeight = candleMarkers.length * DECISION_POINT_LABEL_HEIGHT + Math.max(0, candleMarkers.length - 1) * 8
  const systemBandTop = Math.max(8, systemLabelY - DECISION_ANNOTATION_GAP - systemBandHeight)
  const userLabelY = Math.max(...pointSpecs.map((point) => point.candleLowY), ...nearbyCandles.map((candle) => candle.low))
  const labelSpecs = pointSpecs.map((spec) => ({ ...spec, labelY: spec.className.startsWith('system') ? systemBandTop + DECISION_POINT_LABEL_HEIGHT + DECISION_ANNOTATION_GAP : userLabelY }))
  const reasonSpecs = reasonReferences.flatMap((reference) => {
    const exitOnly = reference.sections.length === 1 && reference.sections[0] === 'exit'
    const x = projectX(reference.time)
    const y = toY(exitOnly ? reference.candle.low : reference.candle.high)
    return x === null || y === null ? [] : [{
      id: `reason-${reference.index}-${reference.time}`,
      x,
      y,
      kind: 'reason' as const,
      preference: exitOnly ? 'placement-below' as const : 'placement-above' as const,
    }]
  })
  const annotationPlacements = layoutDecisionAnnotations([...labelSpecs, ...reasonSpecs])
  const placementFor = (id: string) => annotationPlacements.get(id)?.placement
  return <div
    className={`decision-chart-annotations${hidden ? ' is-hidden' : ''}`}
    aria-hidden="true"
  >
    {signalX !== null && candidate.trade.entry.signalTime <= revealedThrough && <div className="decision-signal-cursor" style={{ left: signalX }}><span>信号 K</span></div>}
    {reasonReferences.length > 0 && <svg className="decision-reason-connectors" width="100%" height="100%" preserveAspectRatio="none">
      {reasonReferences.map((reference) => {
        const exitOnly = reference.sections.length === 1 && reference.sections[0] === 'exit'
        const x = projectX(reference.time)
        const y = toY(exitOnly ? reference.candle.low : reference.candle.high)
        if (x === null || y === null) return null
        const id = `reason-${reference.index}-${reference.time}`
        const endpoint = decisionReasonConnectorEndpoint(x, y, placementFor(id))
        return <line
          key={`decision-reason-anchor-${reference.index}-${reference.time}`}
          className={`decision-reason-anchor-line${exitOnly ? ' exit' : ''}`}
          x1={x}
          y1={y}
          x2={endpoint.x}
          y2={endpoint.y}
        />
      })}
    </svg>}
    {reasonReferences.map((reference) => {
      const exitOnly = reference.sections.length === 1 && reference.sections[0] === 'exit'
      const x = projectX(reference.time)
      const y = toY(exitOnly ? reference.candle.low : reference.candle.high)
      if (x === null || y === null) return null
      return <span
        key={`decision-reason-reference-${reference.index}-${reference.time}`}
        className={`decision-reason-candle-marker${exitOnly ? ' exit' : ''}${placementFor(`reason-${reference.index}-${reference.time}`) ? ` ${placementFor(`reason-${reference.index}-${reference.time}`)}` : ''}`}
        style={{ left: x, top: y }}
      >K{reference.index}</span>
    })}
    {systemEntryX !== null && systemEntryY !== null && systemExitX !== null && systemExitY !== null && <>
      <svg width="100%" height="100%" preserveAspectRatio="none"><line className="system-path" x1={systemEntryX} y1={systemEntryY} x2={systemExitX} y2={systemExitY} /></svg>
    </>}
    {userEntryX !== null && userEntryY !== null && userExitX !== null && userExitY !== null && <>
      <svg width="100%" height="100%" preserveAspectRatio="none"><line className="user-path" x1={userEntryX} y1={userEntryY} x2={userExitX} y2={userExitY} /></svg>
    </>}
    <svg className="decision-point-connectors" width="100%" height="100%" preserveAspectRatio="none">
      {pointSpecs.map((spec) => {
        const rect = annotationPlacements.get(spec.id)!.rect
        const isSystem = spec.className.startsWith('system')
        const labelEdgeY = isSystem ? rect.bottom : rect.top
        const marker = candleMarkers.find((item) => item.id === spec.id)
        return <g key={spec.id} className={spec.className}>
          {isSystem && <rect className="decision-candle-column" data-testid={`decision-candle-column-${spec.id}`} x={spec.x - spec.candleWidth / 2} y={spec.candleHighY - 6} width={spec.candleWidth} height={spec.candleLowY - spec.candleHighY + 12} />}
          <polyline data-testid={`decision-point-connector-${spec.id}`} points={`${spec.x},${spec.y} ${spec.x},${labelEdgeY}`} />
          <circle data-testid={`decision-point-anchor-${spec.id}`} cx={spec.x} cy={spec.y} r={isSystem ? 4 : 7} />
          {marker && <g className="decision-candle-badge" data-testid={`decision-candle-marker-${spec.id}`} data-candle-time={marker.candleTime} transform={`translate(${marker.x}, ${marker.y})`}>
            <rect x={-10} y={-10} width={20} height={19} rx={3} />
            <path d="M -4 9 L 0 14 L 4 9 Z" />
            <text textAnchor="middle" dominantBaseline="central" y={-1}>{marker.label}</text>
          </g>}
        </g>
      })}
    </svg>
    {pointSpecs.map((spec) => {
      const rect = annotationPlacements.get(spec.id)!.rect
      return <span key={spec.id} data-testid={`decision-point-label-${spec.id}`} className={`decision-point ${spec.className}`} title={`${spec.label} · 成交 ${formatDecisionDate(spec.time)}（北京时间）`} style={{ left: rect.left, top: rect.top, width: DECISION_POINT_LABEL_WIDTH, height: DECISION_POINT_LABEL_HEIGHT }}><b>{spec.label}</b><small data-testid={`decision-point-time-${spec.id}`}>K线 {formatDecisionDate(spec.candleTime)}</small></span>
    })}
  </div>
}

export function DecisionResultsDialog({ session, onClose, onReview, onNew, onReturnToSource, favoriteKeys = [], onToggleFavorite = () => undefined }: {
  session: DecisionReplaySession | null
  onClose: () => void
  onReview: (result: DecisionTradeResult) => void
  onNew: () => void
  onReturnToSource?: () => void
  favoriteKeys?: readonly string[]
  onToggleFavorite?: (key: string) => void
}) {
  if (!session) return null
  const results = sessionResults(session)
  const modes = decisionSessionPositionSizingModes(session)
  const userTrades = results.filter((result) => result.choice === 'traded')
  const userRStats = decisionSessionUserRStats(session)
  const skippedTradeCount = results.filter((result) => result.choice === 'skipped').length
  const userWinRateText = decisionModeMetricText(modes, (mode) => decisionWinRateText(decisionWinStats(userTrades, mode, 'user')))
  const systemParticipatedWinRateText = decisionModeMetricText(modes, (mode) => decisionWinRateText(decisionWinStats(userTrades, mode, 'system')))
  const systemOverallWinRateText = decisionModeMetricText(modes, (mode) => decisionWinRateText(decisionWinStats(results, mode, 'system')))
  return <div className="modal-backdrop decision-results-backdrop">
    <section className="decision-results" role="dialog" aria-modal="true" aria-label="决策回放盈亏对比">
      <header><BarChart3 size={25} /><div><h2>本场决策对比</h2><small>{statusLabel(session.status)} · 完成 {results.length} / {session.candidates.length} 笔</small></div><button aria-label="关闭结果" onClick={onClose}><X size={21} /></button></header>
      <div className="decision-result-summary">
        <article><span>你的净盈亏</span><DecisionModeMoneyStack modes={modes} compact={false} valueFor={(mode) => aggregateDecisionResults(results, mode).userPnlUsd} /><small>参与胜率 {userWinRateText} · 参与 {userTrades.length} 笔 · 未参与 {skippedTradeCount} 笔交易</small></article>
        <article className="decision-system-summary"><span>V5 系统参与部分净盈亏</span><DecisionModeMoneyStack modes={modes} compact={false} valueFor={(mode) => aggregateDecisionResults(userTrades, mode).systemPnlUsd} /><small>参与部分胜率 {systemParticipatedWinRateText} · {userTrades.length} 笔</small><span className="decision-system-total-label">V5 系统总净盈亏</span><DecisionModeMoneyStack modes={modes} compact={false} valueFor={(mode) => aggregateDecisionResults(results, mode).systemPnlUsd} /><small>总胜率 {systemOverallWinRateText} · 全部 {results.length} 笔</small></article>
        <article><span>相对系统</span><DecisionModeMoneyStack modes={modes} compact={false} valueFor={(mode) => aggregateDecisionResults(results, mode).differenceUsd} /><small>你的全部题目结果与系统全部题目结果相比</small></article>
        <div className="decision-result-r-summary" data-testid="decision-result-r-summary">
          <article>
            <span>你的总盈亏（R）</span>
            <b data-testid="decision-result-total-r" className={userRStats.totalR === null ? '' : userRStats.totalR >= 0 ? 'positive' : 'negative'}>{formatDecisionR(userRStats.totalR)}</b>
            <small>R 基准：参与订单初始止损距离平均 {formatInitialStopDistance(userRStats.averageInitialStopDistance)} · {userRStats.measuredTradeCount} 笔</small>
          </article>
          <article>
            <span>每笔订单平均盈亏（R）</span>
            <b data-testid="decision-result-average-r" className={userRStats.averageR === null ? '' : userRStats.averageR >= 0 ? 'positive' : 'negative'}>{formatDecisionR(userRStats.averageR)}</b>
            <small>总盈亏 ÷ 参与订单数 · 参与 {userRStats.participatedTradeCount} 笔</small>
          </article>
        </div>
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
          <span><b>{index + 1}. {result.candidate.symbol}</b><small>{INTERVALS[result.candidate.interval].label} · {decisionResultSide(result) === 'long' ? '多' : '空'}</small></span>
          <span>{choiceLabel(result)}</span>
          <DecisionModeMoneyStack modes={modes} valueFor={(mode) => decisionResultPnl(result, mode, 'user')} />
          <DecisionModeMoneyStack modes={modes} valueFor={(mode) => decisionResultPnl(result, mode, 'system')} />
          <DecisionModeMoneyStack modes={modes} valueFor={(mode) => decisionResultPnl(result, mode, 'user') - decisionResultPnl(result, mode, 'system')} />
           <span className="decision-list-actions"><DecisionFavoriteButton favorite={favoriteKeys.includes(favoriteKey)} onToggle={() => onToggleFavorite(favoriteKey)} label={favoriteKeys.includes(favoriteKey) ? '取消收藏本笔交易' : '收藏本笔交易'} /><button type="button" className="decision-result-replay-action" onClick={(event) => { event.stopPropagation(); onReview(result) }}>回看并重新做</button><Eye size={18} /></span>
        </div>
        })}
        {results.length === 0 && <div className="decision-empty">本场尚未完成任何一笔交易。</div>}
      </div>
       <footer><button onClick={onClose}>关闭</button>{session.origin === 'review' && session.sourceSessionId && onReturnToSource && <button onClick={onReturnToSource}>返回原本场次对比</button>}<button className="decision-primary" onClick={onNew}><RotateCcw size={17} />开始新一场</button></footer>
    </section>
  </div>
}

export function DecisionReviewPanel({ result, positionSizingModes = ['fixed-risk'], onBack }: { result: DecisionTradeResult; positionSizingModes?: readonly DecisionPositionSizingMode[]; onBack: () => void }) {
  const initialStopLoss = decisionResultInitialStopLoss(result)
  const fixedRiskExplanation = positionSizingModes.includes('fixed-risk') ? `；固定风险按 ${decisionResultR(result, 'user').toFixed(2)}R × 100U 计算` : ''
  return <aside className="decision-review-panel">
    <header><Flag size={20} /><div><h2>{result.candidate.symbol} · {INTERVALS[result.candidate.interval].label} · 第 {result.candidate.trade.tradeNumber} 笔</h2><small>复盘视图已恢复该笔练习的独立绘图</small></div><button onClick={onBack}><X size={19} /></button></header>
    <div className="decision-review-compare">
      <article><span>你的结果</span><DecisionModeMoneyStack modes={positionSizingModes} compact={false} valueFor={(mode) => decisionResultPnl(result, mode, 'user')} /><small>{result.choice === 'traded' ? `${decisionResultR(result, 'user') >= 0 ? '+' : ''}${decisionResultR(result, 'user').toFixed(2)}R` : choiceLabel(result)}</small></article>
      <article><span>V5 系统结果</span><DecisionModeMoneyStack modes={positionSizingModes} compact={false} valueFor={(mode) => decisionResultPnl(result, mode, 'system')} /><small>{decisionResultR(result, 'system') >= 0 ? '+' : ''}{decisionResultR(result, 'system').toFixed(2)}R</small></article>
    </div>
    <div className="decision-review-details">
      <section><h3>系统开仓信号 · {result.candidate.trade.entry.setup}</h3><p>{result.candidate.trade.entry.reason}</p></section>
      <section><h3>系统平仓 · {result.candidate.trade.exit.setup || result.candidate.trade.exit.reasonCode}</h3><p>{result.candidate.trade.exit.reason || `系统离场原因：${result.candidate.trade.exit.reasonCode}`}</p></section>
      <section><h3>你的执行</h3><p>{result.choice === 'skipped' ? '本次选择不参与。' : result.choice === 'unfilled' ? `${choiceLabel(result)}，截至可用行情结束仍未成交。` : `${choiceLabel(result)}；开仓 ${formatPrice(result.userEntry?.price ?? 0, result.candidate.symbol)}，初始止损 ${formatPrice(initialStopLoss ?? 0, result.candidate.symbol)}，平仓 ${formatPrice(result.userExit.price, result.candidate.symbol)}${fixedRiskExplanation}，离场方式：${exitReasonLabel(result.userExit.reason, result.stopLossMode)}。`}</p></section>
    </div>
    <button className="decision-review-back" onClick={onBack}><ChevronRight size={17} />返回本场对比</button>
  </aside>
}
