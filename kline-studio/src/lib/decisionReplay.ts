import type { Drawing } from './drawings'
import type { Candle, IntervalId, SymbolId } from './market'
import type { ReplayDecisionCandidate } from './replayTradeRegistry'
import type { TradeSide } from './tradeMarkers'

export const DECISION_REPLAY_STORAGE_KEY = 'kline-studio-decision-replay-v1'
export const DECISION_REPLAY_VERSION = 1 as const
export const DECISION_PLANNED_RISK_USD = 100
export const DECISION_FIXED_NOTIONAL_USD = 10_000

export type DecisionPositionSizingMode = 'fixed-risk' | 'fixed-notional'
export const DEFAULT_DECISION_POSITION_SIZING_MODES: readonly DecisionPositionSizingMode[] = ['fixed-risk', 'fixed-notional']

export type DecisionEntryMode = 'signal-extreme' | 'free-price'
export type DecisionOrderKind = 'stop' | 'limit'
export type DecisionAttemptStage = 'entry-decision' | 'entry-price' | 'risk-setup' | 'order-pending' | 'position-open' | 'post-exit' | 'complete'
export type DecisionSessionStatus = 'active' | 'completed' | 'stopped'
export type DecisionExitReason = 'skipped' | 'manual-close' | 'stop-loss' | 'take-profit' | 'end-of-data'
export type DecisionShortcutAction = 'advance' | 'signal-extreme' | 'free-price' | 'skip' | 'cancel-pending' | 'manual-close' | 'next-trade' | 'confirm-risk' | 'cancel-setup'

export interface DecisionFill {
  time: number
  price: number
}

export interface DecisionExit {
  time: number
  price: number
  reason: DecisionExitReason
}

export interface DecisionTradeResult {
  candidateKey: string
  candidate: ReplayDecisionCandidate
  choice: 'skipped' | 'unfilled' | 'traded'
  entryMode: DecisionEntryMode | null
  orderKind: DecisionOrderKind | null
  cursorTime: number
  userEntry: DecisionFill | null
  userExit: DecisionExit
  stopLoss: number | null
  takeProfit: number | null
  plannedRiskUsd: number
  userPnlUsd: number
  userR: number
  systemPnlUsd: number
  systemR: number
  differenceUsd: number
  drawings: Drawing[]
}

export interface DecisionAttempt {
  candidateKey: string
  cursorTime: number
  stage: DecisionAttemptStage
  entryMode: DecisionEntryMode | null
  orderKind: DecisionOrderKind | null
  pendingEntryPrice: number | null
  /** The stop used to size fixed-risk positions; it stays unchanged after trailing edits. */
  initialStopLoss: number | null
  stopLoss: number | null
  takeProfit: number | null
  fill: DecisionFill | null
  drawings: Drawing[]
  result: DecisionTradeResult | null
}

export interface DecisionReplaySession {
  id: string
  requestedCount: number
  candidates: ReplayDecisionCandidate[]
  attempts: DecisionAttempt[]
  currentIndex: number
  status: DecisionSessionStatus
  startedAt: number
  updatedAt: number
  finishedAt: number | null
  positionSizingModes?: DecisionPositionSizingMode[]
}

export interface DecisionReplayStore {
  version: typeof DECISION_REPLAY_VERSION
  seenTradeKeys: string[]
  activeSessionId: string | null
  sessions: DecisionReplaySession[]
}

export interface DecisionBarEvaluation {
  attempt: DecisionAttempt
  exit: DecisionExit | null
}

export function emptyDecisionReplayStore(): DecisionReplayStore {
  return { version: DECISION_REPLAY_VERSION, seenTradeKeys: [], activeSessionId: null, sessions: [] }
}

export function normalizeDecisionPositionSizingModes(value: unknown): DecisionPositionSizingMode[] {
  if (!Array.isArray(value)) return [...DEFAULT_DECISION_POSITION_SIZING_MODES]
  const modes = value.filter((mode): mode is DecisionPositionSizingMode => mode === 'fixed-risk' || mode === 'fixed-notional')
  return modes.length ? [...new Set(modes)] : [...DEFAULT_DECISION_POSITION_SIZING_MODES]
}

export function decisionSessionPositionSizingModes(session: Pick<DecisionReplaySession, 'positionSizingModes'> | null | undefined) {
  return normalizeDecisionPositionSizingModes(session?.positionSizingModes)
}

export function decisionPositionSizingLabel(mode: DecisionPositionSizingMode, compact = false) {
  if (mode === 'fixed-notional') return compact ? '仓位 10,000U' : '固定仓位 10,000U'
  return compact ? '风险 100U' : '固定风险 100U'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

export function parseDecisionReplayStore(raw: string | null): DecisionReplayStore {
  if (!raw) return emptyDecisionReplayStore()
  try {
    const value = JSON.parse(raw) as Partial<DecisionReplayStore>
    if (value.version !== DECISION_REPLAY_VERSION || !Array.isArray(value.sessions) || !Array.isArray(value.seenTradeKeys)) return emptyDecisionReplayStore()
    const sessions = value.sessions.filter((session): session is DecisionReplaySession => (
      isObject(session)
      && typeof session.id === 'string'
      && Array.isArray(session.candidates)
      && Array.isArray(session.attempts)
      && ['active', 'completed', 'stopped'].includes(String(session.status))
    )).map((session) => ({
      ...session,
      positionSizingModes: normalizeDecisionPositionSizingModes(session.positionSizingModes),
    }))
    const activeSessionId = typeof value.activeSessionId === 'string'
      && sessions.some((session) => session.id === value.activeSessionId && session.status === 'active')
      ? value.activeSessionId
      : null
    return {
      version: DECISION_REPLAY_VERSION,
      seenTradeKeys: [...new Set(value.seenTradeKeys.filter((key): key is string => typeof key === 'string'))],
      activeSessionId,
      sessions,
    }
  } catch {
    return emptyDecisionReplayStore()
  }
}

function sessionProgressRank(session: DecisionReplaySession) {
  const completed = session.attempts.filter((attempt) => attempt.result).length
  const stageRank = Math.max(0, ...session.attempts.map((attempt) => (
    attempt.stage === 'post-exit' ? 3 : attempt.stage === 'position-open' ? 2 : attempt.stage === 'order-pending' ? 1 : 0
  )))
  return [completed, session.currentIndex, stageRank, session.updatedAt] as const
}

function newerDecisionSession(left: DecisionReplaySession, right: DecisionReplaySession) {
  const leftRank = sessionProgressRank(left)
  const rightRank = sessionProgressRank(right)
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] !== rightRank[index]) return leftRank[index] > rightRank[index] ? left : right
  }
  return left
}

/** Merge independently-created exercise histories without discarding either computer's progress. */
export function mergeDecisionReplayStores(local: DecisionReplayStore, imported: DecisionReplayStore): DecisionReplayStore {
  const sessionsById = new Map(local.sessions.map((session) => [session.id, session]))
  for (const session of imported.sessions) {
    const existing = sessionsById.get(session.id)
    sessionsById.set(session.id, existing ? newerDecisionSession(existing, session) : session)
  }
  const sessions = [...sessionsById.values()].sort((left, right) => right.startedAt - left.startedAt)
  const activeSessionId = [local.activeSessionId, imported.activeSessionId]
    .flatMap((id) => id ? sessions.filter((session) => session.id === id && session.status === 'active') : [])
    .sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id ?? null
  return {
    version: DECISION_REPLAY_VERSION,
    seenTradeKeys: [...new Set([...local.seenTradeKeys, ...imported.seenTradeKeys])],
    activeSessionId,
    sessions,
  }
}

export function loadDecisionReplayStore(): DecisionReplayStore {
  if (typeof localStorage === 'undefined') return emptyDecisionReplayStore()
  return parseDecisionReplayStore(localStorage.getItem(DECISION_REPLAY_STORAGE_KEY))
}

export function saveDecisionReplayStore(store: DecisionReplayStore) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(DECISION_REPLAY_STORAGE_KEY, JSON.stringify(store))
}

function randomIndex(upperExclusive: number) {
  if (upperExclusive <= 1) return 0
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const ceiling = Math.floor(0x1_0000_0000 / upperExclusive) * upperExclusive
    const value = new Uint32Array(1)
    do crypto.getRandomValues(value)
    while (value[0] >= ceiling)
    return value[0] % upperExclusive
  }
  return Math.floor(Math.random() * upperExclusive)
}

export function sampleDecisionCandidates(candidates: readonly ReplayDecisionCandidate[], seenTradeKeys: readonly string[], requestedCount: number) {
  const seen = new Set(seenTradeKeys)
  const pool = candidates.filter((candidate) => !seen.has(candidate.key))
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1)
    ;[pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]]
  }
  const count = Math.max(0, Math.min(pool.length, Math.floor(requestedCount)))
  return pool.slice(0, count)
}

export function createDecisionAttempt(candidate: ReplayDecisionCandidate): DecisionAttempt {
  return {
    candidateKey: candidate.key,
    cursorTime: candidate.trade.entry.signalTime,
    stage: 'entry-decision',
    entryMode: null,
    orderKind: null,
    pendingEntryPrice: null,
    initialStopLoss: null,
    stopLoss: null,
    takeProfit: null,
    fill: null,
    drawings: [],
    result: null,
  }
}

export function createDecisionSession(
  candidates: ReplayDecisionCandidate[],
  requestedCount: number,
  now = Date.now(),
  positionSizingModes: readonly DecisionPositionSizingMode[] = DEFAULT_DECISION_POSITION_SIZING_MODES,
): DecisionReplaySession {
  if (candidates.length === 0) throw new Error('没有可用于决策回放的未完成交易')
  const id = `decision-${now}-${Math.random().toString(36).slice(2, 9)}`
  return {
    id,
    requestedCount,
    candidates,
    attempts: [createDecisionAttempt(candidates[0])],
    currentIndex: 0,
    status: 'active',
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    positionSizingModes: normalizeDecisionPositionSizingModes(positionSizingModes),
  }
}

export function currentDecisionCandidate(session: DecisionReplaySession | null | undefined) {
  return session?.candidates[session.currentIndex] ?? null
}

export function currentDecisionAttempt(session: DecisionReplaySession | null | undefined) {
  const candidate = currentDecisionCandidate(session)
  return candidate ? session?.attempts.find((attempt) => attempt.candidateKey === candidate.key) ?? null : null
}

export function intervalCutoffTime(cursorTime: number, sourceIntervalSeconds: number) {
  return cursorTime + Math.max(60, sourceIntervalSeconds) - 60
}

export function candlesKnownAt(candles: readonly Candle[], cutoffTime: number) {
  return candles.filter((candle) => candle.time <= cutoffTime)
}

function candleIndexAtOrAfter(candles: readonly Candle[], time: number) {
  let low = 0
  let high = candles.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (candles[middle].time < time) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * A random exercise is eligible only when the bundled minute history can
 * reconstruct the complete signal, entry and system-exit source candles.
 * This prevents a valid trade record from opening as an empty chart merely
 * because its older market window is not shipped with the site.
 */
export function historyCoversDecisionCandidate(candidate: ReplayDecisionCandidate, minuteCandles: readonly Candle[] | null | undefined) {
  if (!minuteCandles?.length) return false
  const seconds = intervalSeconds(candidate.interval)
  const sourceTimes = [candidate.trade.entry.signalTime, candidate.trade.entry.time, candidate.trade.exit.time]
  return sourceTimes.every((sourceTime) => {
    const firstIndex = candleIndexAtOrAfter(minuteCandles, sourceTime)
    const lastTime = sourceTime + seconds - 60
    const lastIndex = candleIndexAtOrAfter(minuteCandles, lastTime)
    return minuteCandles[firstIndex]?.time === sourceTime && minuteCandles[lastIndex]?.time === lastTime
  })
}

export function candleAtOrBefore(candles: readonly Candle[], time: number): Candle | null {
  let result: Candle | null = null
  for (const candle of candles) {
    if (candle.time > time) break
    result = candle
  }
  return result
}

export function nextCandleAfter(candles: readonly Candle[], time: number): Candle | null {
  return candles.find((candle) => candle.time > time) ?? null
}

export function defaultDecisionLevels(side: TradeSide, entryPrice: number, suggestedStop: number | null) {
  const fallbackDistance = Math.max(Math.abs(entryPrice) * 0.002, 0.01)
  let stopLoss = suggestedStop ?? (side === 'long' ? entryPrice - fallbackDistance : entryPrice + fallbackDistance)
  if (side === 'long' && stopLoss >= entryPrice) stopLoss = entryPrice - fallbackDistance
  if (side === 'short' && stopLoss <= entryPrice) stopLoss = entryPrice + fallbackDistance
  const distance = Math.abs(entryPrice - stopLoss)
  const takeProfit = side === 'long' ? entryPrice + distance : entryPrice - distance
  return { stopLoss, takeProfit }
}

export function validDecisionLevels(side: TradeSide, entryPrice: number, stopLoss: number, takeProfit: number) {
  if (![entryPrice, stopLoss, takeProfit].every(Number.isFinite)) return false
  return side === 'long'
    ? stopLoss < entryPrice && takeProfit > entryPrice
    : stopLoss > entryPrice && takeProfit < entryPrice
}

/**
 * Once an order is filled, the stop is protection rather than an entry setup.
 * It may therefore cross the entry price to lock in profit. Keep the target
 * on the position's profit side, but do not force the stop to remain at a loss.
 */
export function validOpenPositionLevels(side: TradeSide, entryPrice: number, stopLoss: number, takeProfit: number) {
  if (![entryPrice, stopLoss, takeProfit].every(Number.isFinite)) return false
  return side === 'long' ? takeProfit > entryPrice : takeProfit < entryPrice
}

export function rewardRiskRatio(entryPrice: number, stopLoss: number, takeProfit: number) {
  const risk = Math.abs(entryPrice - stopLoss)
  return risk > 0 ? Math.abs(takeProfit - entryPrice) / risk : 0
}

export function fillPendingOrder(side: TradeSide, orderKind: DecisionOrderKind, entryPrice: number, candle: Candle): DecisionFill | null {
  if (orderKind === 'stop' && side === 'long' && candle.high >= entryPrice) return { time: candle.time, price: candle.open > entryPrice ? candle.open : entryPrice }
  if (orderKind === 'stop' && side === 'short' && candle.low <= entryPrice) return { time: candle.time, price: candle.open < entryPrice ? candle.open : entryPrice }
  if (orderKind === 'limit' && side === 'long' && candle.low <= entryPrice) return { time: candle.time, price: candle.open < entryPrice ? candle.open : entryPrice }
  if (orderKind === 'limit' && side === 'short' && candle.high >= entryPrice) return { time: candle.time, price: candle.open > entryPrice ? candle.open : entryPrice }
  return null
}

export function evaluatePositionBar(side: TradeSide, stopLoss: number, takeProfit: number, candle: Candle): DecisionExit | null {
  const stopHit = side === 'long' ? candle.low <= stopLoss : candle.high >= stopLoss
  const targetHit = side === 'long' ? candle.high >= takeProfit : candle.low <= takeProfit
  // Intrabar ordering is unknowable from OHLC. The replay uses the conservative
  // stop-first convention so a decision result never benefits from future path knowledge.
  if (stopHit) {
    const gapPrice = side === 'long' && candle.open < stopLoss || side === 'short' && candle.open > stopLoss ? candle.open : stopLoss
    return { time: candle.time, price: gapPrice, reason: 'stop-loss' }
  }
  if (targetHit) {
    const gapPrice = side === 'long' && candle.open > takeProfit || side === 'short' && candle.open < takeProfit ? candle.open : takeProfit
    return { time: candle.time, price: gapPrice, reason: 'take-profit' }
  }
  return null
}

export function advanceDecisionAttempt(candidate: ReplayDecisionCandidate, attempt: DecisionAttempt, nextCandle: Candle): DecisionBarEvaluation {
  let nextAttempt = { ...attempt, cursorTime: nextCandle.time }
  if (nextAttempt.stage === 'order-pending' && nextAttempt.pendingEntryPrice !== null && nextAttempt.stopLoss !== null && nextAttempt.takeProfit !== null) {
    const fill = fillPendingOrder(candidate.trade.side, nextAttempt.orderKind ?? 'stop', nextAttempt.pendingEntryPrice, nextCandle)
    if (fill) nextAttempt = { ...nextAttempt, fill, stage: 'position-open' }
  }
  if (nextAttempt.stage === 'position-open' && nextAttempt.stopLoss !== null && nextAttempt.takeProfit !== null) {
    return { attempt: nextAttempt, exit: evaluatePositionBar(candidate.trade.side, nextAttempt.stopLoss, nextAttempt.takeProfit, nextCandle) }
  }
  return { attempt: nextAttempt, exit: null }
}

export function pnlForDecision(side: TradeSide, entryPrice: number, exitPrice: number, stopLoss: number, plannedRiskUsd = DECISION_PLANNED_RISK_USD) {
  const riskDistance = Math.abs(entryPrice - stopLoss)
  if (riskDistance <= 0) return { pnlUsd: 0, rMultiple: 0 }
  const signedMove = side === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice
  const rMultiple = signedMove / riskDistance
  return { pnlUsd: rMultiple * plannedRiskUsd, rMultiple }
}

export function pnlForFixedNotional(
  side: TradeSide,
  entryPrice: number,
  exitPrice: number,
  notionalUsd = DECISION_FIXED_NOTIONAL_USD,
) {
  if (![entryPrice, exitPrice, notionalUsd].every(Number.isFinite) || entryPrice <= 0 || notionalUsd <= 0) {
    return { pnlUsd: 0, returnPercent: 0 }
  }
  const signedReturn = side === 'long' ? (exitPrice - entryPrice) / entryPrice : (entryPrice - exitPrice) / entryPrice
  return { pnlUsd: signedReturn * notionalUsd, returnPercent: signedReturn * 100 }
}

export function pnlForDecisionMode(
  mode: DecisionPositionSizingMode,
  side: TradeSide,
  entryPrice: number,
  exitPrice: number,
  stopLoss: number,
) {
  return mode === 'fixed-risk'
    ? pnlForDecision(side, entryPrice, exitPrice, stopLoss).pnlUsd
    : pnlForFixedNotional(side, entryPrice, exitPrice).pnlUsd
}

export function decisionResultPnl(
  result: DecisionTradeResult,
  mode: DecisionPositionSizingMode,
  actor: 'user' | 'system',
) {
  if (mode === 'fixed-risk') return actor === 'user' ? result.userPnlUsd : result.systemPnlUsd
  if (actor === 'user') {
    if (result.choice !== 'traded' || !result.userEntry) return 0
    return pnlForDecisionMode('fixed-notional', result.candidate.trade.side, result.userEntry.price, result.userExit.price, result.stopLoss ?? result.userEntry.price)
  }
  return pnlForDecisionMode(
    'fixed-notional',
    result.candidate.trade.side,
    result.candidate.trade.entry.price,
    result.candidate.trade.exit.price,
    result.candidate.trade.entry.stopLoss ?? result.candidate.trade.entry.price,
  )
}

export function aggregateDecisionResults(results: readonly DecisionTradeResult[], mode: DecisionPositionSizingMode) {
  const userPnlUsd = results.reduce((sum, result) => sum + decisionResultPnl(result, mode, 'user'), 0)
  const systemPnlUsd = results.reduce((sum, result) => sum + decisionResultPnl(result, mode, 'system'), 0)
  return { userPnlUsd, systemPnlUsd, differenceUsd: userPnlUsd - systemPnlUsd }
}

export function buildDecisionResult(candidate: ReplayDecisionCandidate, attempt: DecisionAttempt, exit: DecisionExit, drawings: Drawing[]): DecisionTradeResult {
  const traded = Boolean(attempt.fill && attempt.stopLoss !== null)
  const choice: DecisionTradeResult['choice'] = traded
    ? 'traded'
    : exit.reason === 'skipped' || attempt.pendingEntryPrice === null ? 'skipped' : 'unfilled'
  const riskStopLoss = attempt.initialStopLoss ?? attempt.stopLoss
  const user = traded
    ? pnlForDecision(candidate.trade.side, attempt.fill!.price, exit.price, riskStopLoss!, DECISION_PLANNED_RISK_USD)
    : { pnlUsd: 0, rMultiple: 0 }
  return {
    candidateKey: candidate.key,
    candidate,
    choice,
    entryMode: attempt.entryMode,
    orderKind: attempt.orderKind ?? null,
    cursorTime: attempt.cursorTime,
    userEntry: attempt.fill,
    userExit: exit,
    stopLoss: attempt.stopLoss,
    takeProfit: attempt.takeProfit,
    plannedRiskUsd: DECISION_PLANNED_RISK_USD,
    userPnlUsd: user.pnlUsd,
    userR: user.rMultiple,
    systemPnlUsd: candidate.trade.result.pnlUsd,
    systemR: candidate.trade.result.rMultiple,
    differenceUsd: user.pnlUsd - candidate.trade.result.pnlUsd,
    drawings: drawings.map((drawing) => ({ ...drawing, points: drawing.points.map((point) => ({ ...point })) })),
  }
}

export function decisionShortcutAction(stage: DecisionAttemptStage, key: string): DecisionShortcutAction | null {
  if (stage === 'entry-decision') {
    if (key === '1') return 'advance'
    if (key === '2') return 'signal-extreme'
    if (key === '3') return 'free-price'
    if (key === '4') return 'skip'
  }
  if (stage === 'order-pending') {
    if (key === '1') return 'advance'
    if (key === '4') return 'cancel-pending'
  }
  if (stage === 'risk-setup') {
    if (key === '1') return 'confirm-risk'
    if (key === '2') return 'cancel-setup'
  }
  if (stage === 'position-open') {
    if (key === '1') return 'advance'
    if (key === '2') return 'manual-close'
  }
  if (stage === 'post-exit') {
    if (key === '1') return 'advance'
    if (key === '4') return 'next-trade'
  }
  return null
}

export function sessionResults(session: DecisionReplaySession) {
  return session.attempts.flatMap((attempt) => attempt.result ? [attempt.result] : [])
}

export function formatDecisionDate(epochSeconds: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(epochSeconds * 1000))
}

export function resultReviewCutoff(result: DecisionTradeResult) {
  return Math.max(result.userExit.time, result.candidate.trade.exit.time)
}

export function intervalSeconds(interval: IntervalId) {
  const seconds: Record<IntervalId, number> = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400, '1w': 604800 }
  return seconds[interval]
}

export function symbolPrecision(symbol: SymbolId) {
  return symbol === 'BTCUSDT.P' || symbol === 'US500' ? 1 : symbol === 'ETHUSD' ? 2 : 3
}
