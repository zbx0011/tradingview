import type { Drawing } from './drawings'
import type { Candle, IntervalId, SymbolId } from './market'
import type { ReplayDecisionCandidate } from './replayTradeRegistry'
import type { TradeSide } from './tradeMarkers'
import {
  CLOSED_SESSION_SYMBOLS,
  SESSION_CLOSE_BEIJING_SECONDS,
  SESSION_OPEN_BEIJING_SECONDS,
  isExcludedCommodityTrade,
} from './tradeEligibility'

export const DECISION_REPLAY_STORAGE_KEY = 'kline-studio-decision-replay-v1'
export const DECISION_REPLAY_VERSION = 1 as const
export const DECISION_PLANNED_RISK_USD = 100
export const DECISION_FIXED_NOTIONAL_USD = 10_000
export const DECISION_POSITION_MULTIPLIERS = [0.5, 1, 2, 3] as const

export type DecisionPositionSizingMode = 'fixed-risk' | 'fixed-notional'
export type DecisionPositionMultiplier = (typeof DECISION_POSITION_MULTIPLIERS)[number]
export type DecisionHistorySort = 'time-desc' | 'time-asc' | 'pnl-desc' | 'pnl-asc'
export const DEFAULT_DECISION_POSITION_SIZING_MODES: readonly DecisionPositionSizingMode[] = ['fixed-risk', 'fixed-notional']
export const DECISION_REPLAY_INTERVALS = ['5m', '15m', '1h'] as const
export type DecisionReplayInterval = (typeof DECISION_REPLAY_INTERVALS)[number]

export interface DecisionHistorySortValue {
  startedAt: number
  ordinal: number
  pnlUsd: number | null
}

export type DecisionEntryMode = 'signal-extreme' | 'free-price' | 'market-close'
export type DecisionOrderKind = 'stop' | 'limit'
export type DecisionStopLossMode = 'touch' | 'close'
export type DecisionAttemptStage = 'entry-decision' | 'entry-price' | 'risk-setup' | 'order-pending' | 'position-open' | 'post-exit' | 'complete'
export type DecisionSessionStatus = 'active' | 'completed' | 'stopped'
export type DecisionSessionOrigin = 'practice' | 'review'
export type DecisionPracticeMode = 'random-count' | 'day-sequence'
export type DecisionExitReason = 'skipped' | 'manual-close' | 'stop-loss' | 'take-profit' | 'system-exit' | 'end-of-data'
export type DecisionShortcutAction = 'advance' | 'signal-extreme' | 'free-price' | 'open-long' | 'open-short' | 'skip' | 'cancel-pending' | 'manual-close' | 'next-trade' | 'restart-trade' | 'confirm-risk' | 'cancel-setup'
export type DecisionExerciseNavigationTarget = { kind: 'review'; result: DecisionTradeResult } | { kind: 'active' }

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
  /** User-selected direction in day-sequence mode. Missing legacy values follow the system candidate direction. */
  userSide?: TradeSide
  entryMode: DecisionEntryMode | null
  orderKind: DecisionOrderKind | null
  cursorTime: number
  userEntry: DecisionFill | null
  userExit: DecisionExit
  /** Initial protective stop used to size the fixed-risk position. Legacy results may omit it. */
  initialStopLoss?: number | null
  /** Omitted by legacy results, whose execution remains touch-based. */
  stopLossMode?: DecisionStopLossMode
  stopLoss: number | null
  takeProfit: number | null
  /** Per-order position multiplier. Missing legacy values mean the default 1x size. */
  positionMultiplier?: DecisionPositionMultiplier
  plannedRiskUsd: number
  userPnlUsd: number
  userR: number
  systemPnlUsd: number
  systemR: number
  differenceUsd: number
  drawings: Drawing[]
}

export interface DecisionSystemTradeSnapshot {
  candidateKey: string
  candidate: ReplayDecisionCandidate
  closed: boolean
  pnlByMode: Record<DecisionPositionSizingMode, number>
}

export interface DecisionAttempt {
  candidateKey: string
  cursorTime: number
  stage: DecisionAttemptStage
  /** Set only when day-sequence practice lets the user choose long/short independently. */
  userSide?: TradeSide
  entryMode: DecisionEntryMode | null
  orderKind: DecisionOrderKind | null
  pendingEntryPrice: number | null
  /** The stop used to size fixed-risk positions; it stays unchanged after trailing edits. */
  initialStopLoss: number | null
  /** Per-order setting; never a global preference. Missing legacy values mean touch. */
  stopLossMode?: DecisionStopLossMode
  stopLoss: number | null
  takeProfit: number | null
  /** Per-order position multiplier. Missing legacy values mean the default 1x size. */
  positionMultiplier?: DecisionPositionMultiplier
  fill: DecisionFill | null
  drawings: Drawing[]
  result: DecisionTradeResult | null
}

export interface DecisionDaySequence {
  key: string
  symbol: SymbolId
  interval: DecisionReplayInterval
  /** Inclusive Beijing calendar-day boundary, stored as Unix seconds. */
  startTime: number
  /** Exclusive Beijing calendar-day boundary, stored as Unix seconds. */
  endTime: number
}

export interface DecisionAiDayTradeRef {
  key: string
  symbol: SymbolId
  interval: DecisionReplayInterval
}

export interface DecisionAiDaySummary {
  key: string
  symbol: SymbolId
  interval: DecisionReplayInterval
  /** Inclusive market trading-day boundary. */
  startTime: number
  /** Exclusive market trading-day boundary. */
  endTime: number
  /** AI result for the requested sizing mode, deduplicated by candidate key. */
  pnlUsd: number
  wins: number
  total: number
  trades: DecisionAiDayTradeRef[]
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
  /** Missing legacy values are ordinary custom-count random practice. */
  practiceMode?: DecisionPracticeMode
  /** Present only for a randomly selected, chronologically ordered trading day. */
  daySequence?: DecisionDaySequence
  /**
   * Review sessions are independent attempts created from an immutable historical result.
   * This field is optional so backups written before review sessions remain valid.
   */
  origin?: DecisionSessionOrigin
  sourceSessionId?: string | null
  sourceCandidateKey?: string | null
  reviewKind?: 'stop-anomalies'
  reviewSourceRecords?: Array<{ sessionId: string; candidateKey: string }>
  /** Monotonic marker for an explicit authoritative correction that may move progress backward. */
  correctionRevision?: number
}

export interface DecisionReplayStore {
  version: typeof DECISION_REPLAY_VERSION
  seenTradeKeys: string[]
  activeSessionId: string | null
  sessions: DecisionReplaySession[]
}

const DECISION_REPLAY_COMPACT_FORMAT = 'compact-v1' as const

interface CompactDecisionReplaySession extends Omit<DecisionReplaySession, 'candidates' | 'attempts'> {
  candidateKeys: string[]
  attempts: Array<Omit<DecisionAttempt, 'result'> & {
    result: (Omit<DecisionTradeResult, 'candidate' | 'drawings'> & {
      candidate?: ReplayDecisionCandidate
      drawings?: Drawing[]
    }) | null
  }>
}

interface CompactDecisionReplayStore {
  version: typeof DECISION_REPLAY_VERSION
  storageFormat: typeof DECISION_REPLAY_COMPACT_FORMAT
  seenTradeKeys: string[]
  activeSessionId: string | null
  candidateCatalog: ReplayDecisionCandidate[]
  sessions: CompactDecisionReplaySession[]
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

export function decisionSessionPracticeMode(session: Pick<DecisionReplaySession, 'practiceMode'> | null | undefined): DecisionPracticeMode {
  return session?.practiceMode === 'day-sequence' ? 'day-sequence' : 'random-count'
}

function isDecisionSyncBranch(session: Pick<DecisionReplaySession, 'id'>) {
  return session.id.includes('-sync-')
}

function safeDecisionResultPnl(result: DecisionTradeResult, mode: DecisionPositionSizingMode, actor: 'user' | 'system') {
  if (actor === 'system' && !decisionResultHasSystemBenchmark(result)) return 0
  try {
    return decisionResultPnl(result, mode, actor)
  } catch {
    // Keep legacy/imported records with a minimal result object readable. They
    // cannot be recalculated without a candidate, so use their stored value.
    const storedValue = actor === 'user' ? result.userPnlUsd : result.systemPnlUsd
    return Number.isFinite(storedValue) ? storedValue : 0
  }
}

/**
 * A session id is intentionally random, so it cannot identify duplicated copies
 * created by a rapid double click, another tab, or a repeated workspace merge.
 * These fields describe the exercise itself and stay stable while it progresses.
 */
function decisionSessionResultSignature(session: DecisionReplaySession) {
  const results = session.attempts.flatMap((attempt) => attempt.result ? [attempt.result] : [])
  const participated = results.filter((result) => result.choice === 'traded')
  const systemResults = results.filter(decisionResultHasSystemBenchmark)
  return decisionSessionPositionSizingModes(session).map((mode) => {
    const userPnlUsd = results.reduce((sum, result) => sum + safeDecisionResultPnl(result, mode, 'user'), 0)
    const systemPnlUsd = results.reduce((sum, result) => sum + safeDecisionResultPnl(result, mode, 'system'), 0)
    const systemWins = systemResults.filter((result) => safeDecisionResultPnl(result, mode, 'system') > 0).length
    const userWins = participated.filter((result) => safeDecisionResultPnl(result, mode, 'user') > 0).length
    return {
      mode,
      resultCount: results.length,
      participatedCount: participated.length,
      skippedCount: results.filter((result) => result.choice === 'skipped').length,
      unfilledCount: results.filter((result) => result.choice === 'unfilled').length,
      userWins,
      userTotal: participated.length,
      systemWins,
      systemTotal: systemResults.length,
      userPnl: userPnlUsd.toFixed(2),
      systemPnl: systemPnlUsd.toFixed(2),
      differencePnl: (userPnlUsd - systemPnlUsd).toFixed(2),
    }
  })
}

function decisionSessionMergeKey(session: DecisionReplaySession) {
  // Conflict branches are deliberately separate historical records. They have
  // the same source exercise geometry as the main session, so never fold them
  // back into the main record during duplicate cleanup.
  if (isDecisionSyncBranch(session)) return `sync-branch:${session.id}`
  return JSON.stringify({
    origin: session.origin ?? 'practice',
    sourceSessionId: session.sourceSessionId ?? null,
    sourceCandidateKey: session.sourceCandidateKey ?? null,
    startedAt: session.startedAt,
    requestedCount: session.requestedCount,
    practiceMode: decisionSessionPracticeMode(session),
    daySequenceKey: session.daySequence?.key ?? null,
    positionSizingModes: decisionSessionPositionSizingModes(session),
    candidateKeys: session.candidates.map((candidate) => candidate.key),
  })
}

/**
 * Some legacy copies regenerated candidate keys while keeping the same visible
 * exercise. This fallback is used only after the strict candidate-key grouping;
 * when it matches, the more complete session is retained rather than unioning
 * two unrelated candidate lists.
 */
function decisionSessionContentMergeKey(session: DecisionReplaySession) {
  if (isDecisionSyncBranch(session)) return `sync-branch:${session.id}`
  return JSON.stringify({
    origin: session.origin ?? 'practice',
    sourceSessionId: session.sourceSessionId ?? null,
    sourceCandidateKey: session.sourceCandidateKey ?? null,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt ?? null,
    requestedCount: session.requestedCount,
    practiceMode: decisionSessionPracticeMode(session),
    daySequenceKey: session.daySequence?.key ?? null,
    status: session.status,
    candidateCount: session.candidates.length,
    attemptCount: session.attempts.length,
    positionSizingModes: decisionSessionPositionSizingModes(session),
    results: decisionSessionResultSignature(session),
  })
}

export function decisionPositionSizingLabel(mode: DecisionPositionSizingMode, compact = false) {
  if (mode === 'fixed-notional') return compact ? '仓位 10,000U' : '固定仓位 10,000U'
  return compact ? '风险 100U' : '固定风险 100U'
}

export function toggleDecisionHistorySymbolSelection(selected: readonly SymbolId[], symbol: SymbolId): SymbolId[] {
  if (selected.length === 0) return [symbol]
  if (!selected.includes(symbol)) return [...selected, symbol]
  const next = selected.filter((item) => item !== symbol)
  return next.length > 0 ? next : []
}

export function toggleDecisionHistoryIntervalSelection(selected: readonly DecisionReplayInterval[], interval: DecisionReplayInterval): DecisionReplayInterval[] {
  if (selected.length === 0) return [interval]
  if (!selected.includes(interval)) return [...selected, interval]
  const next = selected.filter((item) => item !== interval)
  return next.length > 0 ? next : []
}

export function compareDecisionHistorySortValues(left: DecisionHistorySortValue, right: DecisionHistorySortValue, sort: DecisionHistorySort) {
  const timeDifference = left.startedAt - right.startedAt || left.ordinal - right.ordinal
  if (sort === 'time-asc') return timeDifference
  if (sort === 'time-desc') return -timeDifference
  if (left.pnlUsd === null && right.pnlUsd === null) return -timeDifference
  if (left.pnlUsd === null) return 1
  if (right.pnlUsd === null) return -1
  const pnlDifference = left.pnlUsd - right.pnlUsd
  return sort === 'pnl-asc' ? pnlDifference || -timeDifference : -pnlDifference || -timeDifference
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

/**
 * A result can already exist while the chart deliberately remains on the same
 * exercise in `post-exit`. Only the explicit "下一笔" transition changes the
 * attempt to `complete`, so sync/repair code must use the stage—not `result`—
 * when deciding whether it may advance the exercise cursor.
 */
function isCompletedDecisionAttempt(attempt: DecisionAttempt | undefined) {
  return attempt?.stage === 'complete'
}

function removeExcludedCommodityTradesFromSession(session: DecisionReplaySession): DecisionReplaySession | null {
  const excludedKeys = new Set(session.candidates
    .filter((candidate) => isExcludedCommodityTrade(candidate.symbol, candidate.trade, candidate.interval))
    .map((candidate) => candidate.key))
  if (excludedKeys.size === 0) return session

  const candidates = session.candidates.filter((candidate) => !excludedKeys.has(candidate.key))
  if (candidates.length === 0) return null
  const attempts = session.attempts.filter((attempt) => !excludedKeys.has(attempt.candidateKey))
  const rawCurrentIndex = Number.isFinite(session.currentIndex) ? Math.trunc(session.currentIndex) : 0
  const currentKey = session.candidates[Math.max(0, Math.min(session.candidates.length - 1, rawCurrentIndex))]?.key
  const preservedIndex = currentKey ? candidates.findIndex((candidate) => candidate.key === currentKey) : -1
  const firstIncomplete = candidates.findIndex((candidate) => !isCompletedDecisionAttempt(attempts.find((attempt) => attempt.candidateKey === candidate.key)))
  const requestedCount = Math.min(Math.max(0, session.requestedCount), candidates.length)
  const completedCount = attempts.filter((attempt) => isCompletedDecisionAttempt(attempt)).length
  const status: DecisionSessionStatus = session.status === 'active' && completedCount >= requestedCount
    ? 'completed'
    : session.status
  const currentIndex = status === 'active' && firstIncomplete >= 0
    ? firstIncomplete
    : preservedIndex >= 0 ? preservedIndex : Math.max(0, Math.min(candidates.length - 1, rawCurrentIndex))

  return {
    ...session,
    requestedCount,
    candidates,
    attempts,
    currentIndex,
    status,
    finishedAt: status === 'completed' ? session.finishedAt ?? session.updatedAt : session.finishedAt,
  }
}

function removeExcludedCommodityTradesFromStore(store: DecisionReplayStore): DecisionReplayStore {
  const sessions = store.sessions.flatMap((session) => {
    const filtered = removeExcludedCommodityTradesFromSession(session)
    return filtered ? [filtered] : []
  })
  const excludedKeys = new Set(store.sessions
    .flatMap((session) => session.candidates)
    .filter((candidate) => isExcludedCommodityTrade(candidate.symbol, candidate.trade, candidate.interval))
    .map((candidate) => candidate.key))
  const activeSessionId = store.activeSessionId && sessions.some((session) => session.id === store.activeSessionId && session.status === 'active')
    ? store.activeSessionId
    : null
  return {
    ...store,
    seenTradeKeys: store.seenTradeKeys.filter((key) => !excludedKeys.has(key)),
    activeSessionId,
    sessions,
  }
}

export function parseDecisionReplayStoreChecked(raw: string | null): DecisionReplayStore | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<DecisionReplayStore> & Partial<CompactDecisionReplayStore>
    const value = parsed.storageFormat === DECISION_REPLAY_COMPACT_FORMAT
      ? expandCompactDecisionReplayStore(parsed)
      : parsed
    if (!value) return null
    if (value.version !== DECISION_REPLAY_VERSION || !Array.isArray(value.sessions) || !Array.isArray(value.seenTradeKeys)) return null
    const normalizedSessions = value.sessions.filter((session): session is DecisionReplaySession => (
      isObject(session)
      && typeof session.id === 'string'
      && Array.isArray(session.candidates)
      && Array.isArray(session.attempts)
      && ['active', 'completed', 'stopped'].includes(String(session.status))
    )).map((session) => {
      const candidatesByKey = new Map(session.candidates.map((candidate) => [candidate.key, candidate]))
      return {
        ...session,
        attempts: session.attempts.map((attempt) => {
          const candidate = candidatesByKey.get(attempt.candidateKey)
          if (!candidate) return attempt
          const initialStopLoss = decisionAttemptInitialStopLoss(candidate, attempt)
          return {
            ...attempt,
            initialStopLoss,
            positionMultiplier: normalizeDecisionPositionMultiplier(attempt.positionMultiplier),
            result: attempt.result ? normalizeDecisionTradeResult(attempt.result) : null,
          }
        }),
        positionSizingModes: normalizeDecisionPositionSizingModes(session.positionSizingModes),
        origin: (session.origin === 'review' ? 'review' : 'practice') as DecisionSessionOrigin,
      }
    })
    const excludedKeys = new Set(normalizedSessions
      .flatMap((session) => session.candidates)
    .filter((candidate) => isExcludedCommodityTrade(candidate.symbol, candidate.trade, candidate.interval))
      .map((candidate) => candidate.key))
    const sessions = normalizedSessions.flatMap((session) => {
      const filtered = removeExcludedCommodityTradesFromSession(session)
      return filtered ? [filtered] : []
    })
    const activeSessionId = typeof value.activeSessionId === 'string'
      && sessions.some((session) => session.id === value.activeSessionId && session.status === 'active')
      ? value.activeSessionId
      : null
    return repairDecisionReplayStore({
      version: DECISION_REPLAY_VERSION,
      seenTradeKeys: [...new Set(value.seenTradeKeys.filter((key): key is string => typeof key === 'string' && !excludedKeys.has(key)))],
      activeSessionId,
      sessions,
    })
  } catch {
    return null
  }
}

export function parseDecisionReplayStore(raw: string | null): DecisionReplayStore {
  return parseDecisionReplayStoreChecked(raw) ?? emptyDecisionReplayStore()
}

/**
 * Repair sessions written by older sync merges that advanced currentIndex but
 * did not append the next candidate's in-progress attempt. Without that
 * attempt the causal cutoff is null and the chart renders an empty data set.
 * This only adds a fresh, unanswered attempt; existing answers and drawings
 * are left untouched.
 */
function repairDecisionReplaySession(rawSession: DecisionReplaySession): DecisionReplaySession {
  let session = normalizeDecisionDaySequence(rawSession)
  const storedCurrentIndex = Math.max(0, Math.min(session.candidates.length - 1, Math.trunc(session.currentIndex || 0)))
  const storedCurrentCandidate = session.candidates[storedCurrentIndex]
  const storedCurrentAttempt = storedCurrentCandidate
    ? session.attempts.find((attempt) => attempt.candidateKey === storedCurrentCandidate.key)
    : undefined
  // Older market-end handling could archive an unanswered last candle as a
  // completed whole-day paper. Restore that detectable bad state as resumable;
  // a genuinely completed paper always crossed the explicit `complete` stage.
  if (session.status === 'completed'
    && decisionSessionPracticeMode(session) === 'day-sequence'
    && storedCurrentAttempt?.stage !== 'complete') {
    session = { ...session, status: 'stopped' }
  }
  if (session.status !== 'active' || session.candidates.length === 0) return session

  const rawIndex = Number.isFinite(session.currentIndex) ? Math.trunc(session.currentIndex) : 0
  let currentIndex = Math.max(0, Math.min(session.candidates.length - 1, rawIndex))
  const attemptsByKey = new Map(session.attempts.map((attempt) => [attempt.candidateKey, attempt]))

  // Older additive saves treated any attempt with a result as complete. That
  // could leave an earlier post-exit attempt behind while moving currentIndex
  // to a newly-created next attempt. Rewind to the first candidate that has
  // not crossed the explicit `complete` transition, preserving both attempts.
  const firstNotCompleted = session.candidates.findIndex((candidate) => (
    !isCompletedDecisionAttempt(attemptsByKey.get(candidate.key))
  ))
  if (firstNotCompleted >= 0 && firstNotCompleted < currentIndex) currentIndex = firstNotCompleted

  // If a corrupt/legacy session points at a completed attempt, advance only
  // across fully completed candidates. Keep post-exit attempts in place: they
  // still need the user's explicit "下一笔" action.
  while (currentIndex < session.candidates.length) {
    const attempt = attemptsByKey.get(session.candidates[currentIndex].key)
    if (!attempt || attempt.stage !== 'complete') break
    currentIndex += 1
  }

  if (currentIndex >= session.candidates.length) return { ...session, currentIndex: session.candidates.length - 1 }
  const currentCandidate = session.candidates[currentIndex]
  if (attemptsByKey.has(currentCandidate.key) && currentIndex === rawIndex) return session

  const attempts = attemptsByKey.has(currentCandidate.key)
    ? session.attempts
    : [...session.attempts, createDecisionAttempt(
      currentCandidate,
      decisionSessionPracticeMode(session) === 'day-sequence'
        ? currentIndex === 0
          ? session.daySequence?.startTime
          : attemptsByKey.get(session.candidates[currentIndex - 1]?.key)?.cursorTime
        : undefined,
    )]
  return { ...session, currentIndex, attempts }
}

interface DecisionTradeOccurrence {
  id: string
  session: DecisionReplaySession
  candidate: ReplayDecisionCandidate
  candidateIndex: number
  attempt: DecisionAttempt | undefined
}

function isPracticeTradeDedupSession(session: DecisionReplaySession) {
  // Review sessions and explicit sync branches are intentional alternate
  // views/answers. Normal practice sessions are the only source of one-trade
  // historical duplicates.
  return session.origin !== 'review' && !isDecisionSyncBranch(session)
}

function isIncompleteDaySequencePracticeSession(session: DecisionReplaySession) {
  return isPracticeTradeDedupSession(session)
    && decisionSessionPracticeMode(session) === 'day-sequence'
    && session.status !== 'completed'
}

/** A whole-day exercise becomes deduplicated and seen only after the round completes. */
function shouldCommitPracticeSessionCandidates(session: DecisionReplaySession) {
  return isPracticeTradeDedupSession(session) && !isIncompleteDaySequencePracticeSession(session)
}

function decisionPracticeTradeDedupKey(session: DecisionReplaySession, candidateKey: string) {
  return `${decisionSessionPracticeMode(session)}\u0000${candidateKey}`
}

function decisionAttemptProgressRank(attempt: DecisionAttempt | undefined) {
  if (!attempt) return 0
  const stageRank: Record<DecisionAttemptStage, number> = {
    'entry-decision': 1,
    'entry-price': 2,
    'risk-setup': 3,
    'order-pending': 4,
    'position-open': 5,
    'post-exit': 6,
    complete: 7,
  }
  return (attempt.result ? 10 : 0) + stageRank[attempt.stage]
}

function shouldPreferDecisionTradeOccurrence(next: DecisionTradeOccurrence, current: DecisionTradeOccurrence) {
  const nextProgress = decisionAttemptProgressRank(next.attempt)
  const currentProgress = decisionAttemptProgressRank(current.attempt)
  if (nextProgress !== currentProgress) return nextProgress > currentProgress
  if (next.session.startedAt !== current.session.startedAt) return next.session.startedAt < current.session.startedAt
  if (next.session.updatedAt !== current.session.updatedAt) return next.session.updatedAt < current.session.updatedAt
  return next.candidateIndex < current.candidateIndex
}

/**
 * Keep one occurrence of each transaction inside each practice mode. The same
 * candidate is intentionally allowed once in custom-count practice and once in
 * day-sequence practice because those modes have independent result statistics.
 * Prefer a completed answer, then the earliest copy inside the same mode.
 */
function deduplicatePracticeDecisionTrades(store: DecisionReplayStore): DecisionReplayStore {
  const occurrencesBySession = new Map<string, DecisionTradeOccurrence[]>()
  const winnersByModeAndKey = new Map<string, DecisionTradeOccurrence>()

  store.sessions.forEach((session) => {
    if (!shouldCommitPracticeSessionCandidates(session)) return
    const occurrences = session.candidates.map((candidate, candidateIndex) => {
      const occurrence: DecisionTradeOccurrence = {
        id: `${session.id}\u0000${candidate.key}\u0000${candidateIndex}`,
        session,
        candidate,
        candidateIndex,
        attempt: session.attempts.find((item) => item.candidateKey === candidate.key),
      }
      const dedupKey = decisionPracticeTradeDedupKey(session, candidate.key)
      const current = winnersByModeAndKey.get(dedupKey)
      if (!current || shouldPreferDecisionTradeOccurrence(occurrence, current)) winnersByModeAndKey.set(dedupKey, occurrence)
      return occurrence
    })
    occurrencesBySession.set(session.id, occurrences)
  })

  const sessions = store.sessions.flatMap((session) => {
    if (!shouldCommitPracticeSessionCandidates(session)) return [session]
    // Preserve legacy/imported records whose result attempts are present but
    // whose candidate array was never serialized. There is no safe identity
    // to deduplicate until the candidate data is available.
    if (session.candidates.length === 0) return [session]
    const occurrences = occurrencesBySession.get(session.id) ?? []
    const candidates = session.candidates.filter((candidate, candidateIndex) => {
      const occurrence = occurrences[candidateIndex]
      return Boolean(occurrence && winnersByModeAndKey.get(decisionPracticeTradeDedupKey(session, candidate.key))?.id === occurrence.id)
    })
    if (candidates.length === 0) return []

    const keptCandidateKeys = new Set(candidates.map((candidate) => candidate.key))
    const attemptsByKey = new Map<string, DecisionAttempt>()
    const attemptOrder: string[] = []
    const orphanAttempts: DecisionAttempt[] = []
    session.attempts.forEach((attempt) => {
      const candidateIndex = session.candidates.findIndex((candidate) => candidate.key === attempt.candidateKey)
      const occurrence = candidateIndex >= 0 ? occurrences[candidateIndex] : undefined
      if (!occurrence) {
        orphanAttempts.push(attempt)
        return
      }
      if (winnersByModeAndKey.get(decisionPracticeTradeDedupKey(session, attempt.candidateKey))?.id !== occurrence.id) return
      const existing = attemptsByKey.get(attempt.candidateKey)
      if (!existing) attemptOrder.push(attempt.candidateKey)
      if (!existing || decisionAttemptProgressRank(attempt) > decisionAttemptProgressRank(existing)) {
        attemptsByKey.set(attempt.candidateKey, attempt)
      }
    })
    const attempts = [
      ...attemptOrder.flatMap((key) => {
        const attempt = attemptsByKey.get(key)
        return attempt ? [attempt] : []
      }),
      ...orphanAttempts,
    ]

    const rawIndex = Number.isFinite(session.currentIndex) ? Math.trunc(session.currentIndex) : 0
    const rawCurrentCandidate = session.candidates[Math.max(0, Math.min(session.candidates.length - 1, rawIndex))]
    const preservedIndex = rawCurrentCandidate
      ? candidates.findIndex((candidate) => candidate.key === rawCurrentCandidate.key)
      : -1
    const requestedCount = Math.min(
      candidates.length,
      Math.max(0, Number.isFinite(session.requestedCount) ? Math.trunc(session.requestedCount) : candidates.length),
    )
    const completedCount = attempts.filter((attempt) => keptCandidateKeys.has(attempt.candidateKey) && isCompletedDecisionAttempt(attempt)).length
    const status: DecisionSessionStatus = session.status === 'active' && completedCount >= requestedCount
      ? 'completed'
      : session.status
    const next: DecisionReplaySession = {
      ...session,
      requestedCount,
      candidates,
      attempts,
      currentIndex: status === 'completed'
        ? candidates.length
        : preservedIndex >= 0 ? preservedIndex : Math.max(0, Math.min(candidates.length - 1, rawIndex)),
      status,
      finishedAt: status === 'completed' ? session.finishedAt ?? session.updatedAt : session.finishedAt,
    }
    return [repairDecisionReplaySession(next)]
  })

  // Count custom-count batches immediately, but commit a day-sequence batch
  // atomically only when the whole day is complete. Older versions reserved
  // all day keys at session start, so explicitly release those legacy keys
  // when their only owner is an active/stopped incomplete day.
  const seen = new Set<string>()
  const seenTradeKeys: string[] = []
  const incompleteDayKeys = new Set(store.sessions
    .filter(isIncompleteDaySequencePracticeSession)
    .flatMap((session) => session.candidates.map((candidate) => candidate.key)))
  const committedSessionKeys = new Set(store.sessions
    .filter(shouldCommitPracticeSessionCandidates)
    .flatMap((session) => session.candidates.map((candidate) => candidate.key)))
  const addSeen = (key: string) => {
    if (seen.has(key)) return
    seen.add(key)
    seenTradeKeys.push(key)
  }
  store.seenTradeKeys.forEach((key) => {
    if (typeof key !== 'string') return
    if (incompleteDayKeys.has(key) && !committedSessionKeys.has(key)) return
    addSeen(key)
  })
  store.sessions.forEach((session) => {
    if (!shouldCommitPracticeSessionCandidates(session)) return
    session.candidates.forEach((candidate) => addSeen(candidate.key))
  })

  return { ...store, sessions, seenTradeKeys }
}

function repairDecisionReplayStore(store: DecisionReplayStore): DecisionReplayStore {
  const repairedSessions = store.sessions.map(repairDecisionReplaySession)
  const normalized = mergeDecisionReplaySessionCollection(repairedSessions)
  const deduplicated = deduplicatePracticeDecisionTrades({ ...store, sessions: normalized.sessions })
  const normalizedActiveSessionId = store.activeSessionId
    ? normalized.idMap.get(store.activeSessionId) ?? null
    : null
  const activeSessionId = normalizedActiveSessionId
    && deduplicated.sessions.some((session) => session.id === normalizedActiveSessionId && session.status === 'active')
    ? normalizedActiveSessionId
    : null
  return { ...store, sessions: deduplicated.sessions, seenTradeKeys: deduplicated.seenTradeKeys, activeSessionId }
}

export function normalizeDecisionReplayStore(store: DecisionReplayStore) {
  return repairDecisionReplayStore(store)
}

function sessionProgressRank(session: DecisionReplaySession) {
  const completed = session.attempts.filter((attempt) => isCompletedDecisionAttempt(attempt)).length
  const stageRank = Math.max(0, ...session.attempts.map((attempt) => (
    attempt.stage === 'complete' ? 4 : attempt.stage === 'post-exit' ? 3 : attempt.stage === 'position-open' ? 2 : attempt.stage === 'order-pending' ? 1 : 0
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

function sameDecisionResult(left: DecisionTradeResult, right: DecisionTradeResult) {
  return stableDecisionStringify(comparableDecisionStopMode(left)) === stableDecisionStringify(comparableDecisionStopMode(right))
}

/** Legacy absent mode and explicit touch mean the same thing. Do not rewrite
 * saved records or change old branch hashes just to make that mode explicit. */
function comparableDecisionStopMode<T extends { stopLossMode?: DecisionStopLossMode }>(value: T): T {
  if (value.stopLossMode !== 'touch') return value
  const comparable = { ...value }
  delete comparable.stopLossMode
  return comparable
}

function stableBranchHash(value: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/**
 * JSON object key order is not part of a saved decision. Sorting keys keeps
 * imports written by different app builds from manufacturing a false conflict.
 */
function stableDecisionStringify(value: unknown) {
  return JSON.stringify(value, (_key, nested) => {
    if (!isObject(nested) || Array.isArray(nested)) return nested
    return Object.fromEntries(Object.keys(nested).sort().map((key) => [key, nested[key]]))
  })
}

function decisionSyncBranchRootId(id: string) {
  const markerIndex = id.indexOf('-sync-')
  return markerIndex >= 0 ? id.slice(0, markerIndex) : id
}

function decisionSessionExactContentKey(session: DecisionReplaySession) {
  const content: Partial<DecisionReplaySession> = {
    ...session,
    attempts: session.attempts.map((attempt) => ({
      ...comparableDecisionStopMode(attempt),
      result: attempt.result ? comparableDecisionStopMode(attempt.result) : attempt.result,
    })),
  }
  delete content.id
  return stableDecisionStringify(content)
}

/**
 * Old repeated merges could append "-sync-..." to an already branched id.
 * Re-key branches from their immutable content so an identical saved answer
 * always has one id, regardless of how many computers merged it previously.
 */
function normalizeDecisionSyncBranchId(session: DecisionReplaySession) {
  if (!isDecisionSyncBranch(session)) return session
  const id = `${decisionSyncBranchRootId(session.id)}-sync-${stableBranchHash(decisionSessionExactContentKey(session))}`
  return id === session.id ? session : { ...session, id }
}

/** Keep only answers that actually conflict with the canonical source session. */
function trimDecisionSyncBranchAgainstPrimary(branch: DecisionReplaySession, primary: DecisionReplaySession) {
  const primaryResults = new Map(primary.attempts.flatMap((attempt) => (
    attempt.result ? [[attempt.candidateKey, attempt.result] as const] : []
  )))
  const attempts = branch.attempts.filter((attempt) => {
    if (!attempt.result) return true
    const primaryResult = primaryResults.get(attempt.candidateKey)
    return !primaryResult || !sameDecisionResult(primaryResult, attempt.result)
  })
  if (attempts.length === branch.attempts.length) return branch
  if (attempts.length === 0) return null
  const candidateKeys = new Set(attempts.map((attempt) => attempt.candidateKey))
  return normalizeDecisionSyncBranchId({
    ...branch,
    requestedCount: attempts.length,
    candidates: branch.candidates.filter((candidate) => candidateKeys.has(candidate.key)),
    attempts,
    currentIndex: attempts.length,
    status: 'completed',
  })
}

/**
 * Merge a session that was continued independently on two computers.
 * Non-conflicting attempts are unioned into the original session. If the same question was
 * answered differently on both computers, the alternative answer is retained in a small,
 * deterministic branch session instead of silently discarding either result.
 */
function mergeDecisionReplaySession(left: DecisionReplaySession, right: DecisionReplaySession) {
  const leftCorrection = Number.isFinite(left.correctionRevision) ? left.correctionRevision! : 0
  const rightCorrection = Number.isFinite(right.correctionRevision) ? right.correctionRevision! : 0
  if (leftCorrection !== rightCorrection) {
    return { merged: leftCorrection > rightCorrection ? left : right, branch: null }
  }
  const base = newerDecisionSession(left, right)
  const alternative = base === left ? right : left
  const leftAttempts = new Map(left.attempts.map((attempt) => [attempt.candidateKey, attempt]))
  const rightAttempts = new Map(right.attempts.map((attempt) => [attempt.candidateKey, attempt]))
  const candidates = [...new Map([...base.candidates, ...alternative.candidates].map((candidate) => [candidate.key, candidate])).values()]
  const baseAttempts = new Map(base.attempts.map((attempt) => [attempt.candidateKey, attempt]))
  const alternativeAttempts = new Map(alternative.attempts.map((attempt) => [attempt.candidateKey, attempt]))
  const conflictingAlternatives: DecisionAttempt[] = []

  const attempts = candidates.flatMap((candidate) => {
    const leftAttempt = leftAttempts.get(candidate.key)
    const rightAttempt = rightAttempts.get(candidate.key)
    if (!leftAttempt) return rightAttempt ? [rightAttempt] : []
    if (!rightAttempt) return [leftAttempt]
    const sameCausalPlaybackStage = leftAttempt.stage === rightAttempt.stage
      && (leftAttempt.stage === 'entry-decision' || leftAttempt.stage === 'post-exit')
    const sameCausalOutcome = (!leftAttempt.result && !rightAttempt.result)
      || Boolean(leftAttempt.result && rightAttempt.result && sameDecisionResult(leftAttempt.result, rightAttempt.result))
    // A second Edge tab can save an older cursor after the active tab has
    // already revealed another candle. Wall-clock updatedAt is not causal
    // progress, so the newer save must never move an otherwise identical
    // entry-decision/post-exit playback backward. An explicit restart raises
    // correctionRevision and is handled before this merge.
    if (sameCausalPlaybackStage && sameCausalOutcome && leftAttempt.cursorTime !== rightAttempt.cursorTime) {
      return [leftAttempt.cursorTime > rightAttempt.cursorTime ? leftAttempt : rightAttempt]
    }
    if (leftAttempt.result && rightAttempt.result && !sameDecisionResult(leftAttempt.result, rightAttempt.result)) {
      const alternativeAttempt = alternativeAttempts.get(candidate.key)
      if (alternativeAttempt?.result) conflictingAlternatives.push(alternativeAttempt)
      return [baseAttempts.get(candidate.key) ?? leftAttempt]
    }
    if (leftAttempt.result && !rightAttempt.result) return [leftAttempt]
    if (rightAttempt.result && !leftAttempt.result) return [rightAttempt]
    return [baseAttempts.get(candidate.key) ?? leftAttempt]
  })

  const requestedCount = Math.max(left.requestedCount, right.requestedCount, attempts.length)
  const completedCount = attempts.filter((attempt) => isCompletedDecisionAttempt(attempt)).length
  const firstIncomplete = candidates.findIndex((candidate) => !isCompletedDecisionAttempt(attempts.find((attempt) => attempt.candidateKey === candidate.key)))
  const status: DecisionSessionStatus = completedCount >= requestedCount
    ? 'completed'
    : base.status
  const merged: DecisionReplaySession = {
    ...base,
    requestedCount,
    candidates,
    attempts,
    currentIndex: status === 'active' && firstIncomplete >= 0
      ? firstIncomplete
      : Math.max(left.currentIndex, right.currentIndex, completedCount),
    status,
    updatedAt: Math.max(left.updatedAt, right.updatedAt),
    finishedAt: status === 'completed'
      ? Math.max(left.finishedAt ?? 0, right.finishedAt ?? 0, left.updatedAt, right.updatedAt)
      : base.finishedAt,
    positionSizingModes: [...new Set([
      ...decisionSessionPositionSizingModes(left),
      ...decisionSessionPositionSizingModes(right),
    ])],
  }

  if (conflictingAlternatives.length === 0) return { merged, branch: null }
  const conflictKeys = new Set(conflictingAlternatives.map((attempt) => attempt.candidateKey))
  const branchCandidates = alternative.candidates.filter((candidate) => conflictKeys.has(candidate.key))
  const branchSignature = stableDecisionStringify(conflictingAlternatives.map((attempt) => (
    attempt.result ? comparableDecisionStopMode(attempt.result) : attempt.result
  )))
  const branch: DecisionReplaySession = {
    ...alternative,
    id: `${decisionSyncBranchRootId(alternative.id)}-sync-${stableBranchHash(branchSignature)}`,
    requestedCount: conflictingAlternatives.length,
    candidates: branchCandidates,
    attempts: conflictingAlternatives,
    currentIndex: conflictingAlternatives.length,
    status: 'completed',
    finishedAt: alternative.finishedAt ?? alternative.updatedAt,
  }
  return { merged, branch }
}

interface NormalizedDecisionReplaySessions {
  sessions: DecisionReplaySession[]
  idMap: Map<string, string>
}

/** Merge duplicate ids first, then merge independently-created copies of one exercise. */
function mergeDecisionReplaySessionCollection(input: readonly DecisionReplaySession[]): NormalizedDecisionReplaySessions {
  const sessionsById = new Map<string, DecisionReplaySession>()
  const immutableBranches: DecisionReplaySession[] = []
  for (const session of input) {
    // A branch is an immutable preserved answer, not another continuation of
    // its source session. Old and canonical branch ids can collide during an
    // upgrade, so branch records must be content-keyed before any id merge.
    if (isDecisionSyncBranch(session)) {
      immutableBranches.push(session)
      continue
    }
    const existing = sessionsById.get(session.id)
    if (!existing) {
      sessionsById.set(session.id, session)
      continue
    }
    const { merged, branch } = mergeDecisionReplaySession(existing, session)
    sessionsById.set(session.id, merged)
    if (branch) immutableBranches.push(branch)
  }

  const primaryGroups = new Map<string, { session: DecisionReplaySession; sourceIds: string[] }>()
  const branches = new Map<string, { session: DecisionReplaySession; sourceIds: string[] }>()
  const addBranch = (sourceBranch: DecisionReplaySession, sourceIds: string[] = [sourceBranch.id]) => {
    const branch = normalizeDecisionSyncBranchId(sourceBranch)
    const contentKey = decisionSessionExactContentKey(branch)
    const existing = branches.get(contentKey)
    if (!existing) {
      branches.set(contentKey, { session: branch, sourceIds: [...new Set([...sourceIds, branch.id])] })
      return
    }
    // Equal content has equal progress; the stable id tie-break makes merging
    // independent of import order even for very old branches with another root.
    if (branch.id.localeCompare(existing.session.id) < 0) existing.session = branch
    existing.sourceIds.push(...sourceIds, branch.id)
  }
  immutableBranches.forEach((branch) => addBranch(branch))
  for (const session of sessionsById.values()) {
    const mergeKey = decisionSessionMergeKey(session)
    const group = primaryGroups.get(mergeKey)
    if (!group) {
      primaryGroups.set(mergeKey, { session, sourceIds: [session.id] })
      continue
    }

    const { merged, branch } = mergeDecisionReplaySession(group.session, session)
    group.session = merged
    group.sourceIds.push(session.id)
    if (branch) {
      addBranch(branch)
    }
  }

  const contentGroups = new Map<string, { session: DecisionReplaySession; sourceIds: string[] }>()
  for (const group of primaryGroups.values()) {
    const contentKey = decisionSessionContentMergeKey(group.session)
    const existing = contentGroups.get(contentKey)
    if (!existing) {
      contentGroups.set(contentKey, { ...group, sourceIds: [...group.sourceIds] })
      continue
    }
    const winner = newerDecisionSession(existing.session, group.session)
    existing.session = winner
    existing.sourceIds.push(...group.sourceIds)
  }

  const idMap = new Map<string, string>()
  const sessions: DecisionReplaySession[] = []
  const primaryIdByExactContent = new Map<string, string>()
  const primaryBySourceId = new Map<string, DecisionReplaySession>()
  for (const group of contentGroups.values()) {
    sessions.push(group.session)
    primaryIdByExactContent.set(decisionSessionExactContentKey(group.session), group.session.id)
    for (const sourceId of [...group.sourceIds, group.session.id]) {
      idMap.set(sourceId, group.session.id)
      primaryBySourceId.set(sourceId, group.session)
    }
  }
  const reconciledBranches = new Map<string, { session: DecisionReplaySession; sourceIds: string[] }>()
  for (const [contentKey, branch] of branches) {
    const matchingPrimaryId = primaryIdByExactContent.get(contentKey)
    if (matchingPrimaryId) {
      branch.sourceIds.forEach((sourceId) => idMap.set(sourceId, matchingPrimaryId))
      idMap.set(branch.session.id, matchingPrimaryId)
      continue
    }
    const primary = primaryBySourceId.get(decisionSyncBranchRootId(branch.session.id))
    const reconciled = primary ? trimDecisionSyncBranchAgainstPrimary(branch.session, primary) : branch.session
    if (!reconciled) {
      branch.sourceIds.forEach((sourceId) => idMap.set(sourceId, primary!.id))
      idMap.set(branch.session.id, primary!.id)
      continue
    }
    const reconciledContentKey = decisionSessionExactContentKey(reconciled)
    const existing = reconciledBranches.get(reconciledContentKey)
    if (!existing) {
      reconciledBranches.set(reconciledContentKey, { session: reconciled, sourceIds: [...branch.sourceIds, branch.session.id] })
      continue
    }
    existing.sourceIds.push(...branch.sourceIds, branch.session.id)
    if (reconciled.id.localeCompare(existing.session.id) < 0) existing.session = reconciled
  }
  for (const branch of reconciledBranches.values()) {
    sessions.push(branch.session)
    branch.sourceIds.forEach((sourceId) => idMap.set(sourceId, branch.session.id))
    idMap.set(branch.session.id, branch.session.id)
  }
  return { sessions, idMap }
}

/** Merge independently-created exercise histories without discarding either computer's progress. */
export function mergeDecisionReplayStores(local: DecisionReplayStore, imported: DecisionReplayStore): DecisionReplayStore {
  const safeLocal = removeExcludedCommodityTradesFromStore(local)
  const safeImported = removeExcludedCommodityTradesFromStore(imported)
  const normalized = normalizeDecisionReplayStore({
    version: DECISION_REPLAY_VERSION,
    seenTradeKeys: [...new Set([...safeLocal.seenTradeKeys, ...safeImported.seenTradeKeys])],
    // repairDecisionReplayStore maps this id to the surviving canonical copy
    // when a local active session is merged with an imported duplicate.
    activeSessionId: safeLocal.activeSessionId,
    sessions: [...safeLocal.sessions, ...safeImported.sessions],
  })
  return {
    ...normalized,
    sessions: [...normalized.sessions].sort((left, right) => right.startedAt - left.startedAt),
  }
}

export function loadDecisionReplayStore(
  storage: Pick<Storage, 'getItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
): DecisionReplayStore {
  if (!storage) return emptyDecisionReplayStore()
  try {
    return parseDecisionReplayStore(storage.getItem(DECISION_REPLAY_STORAGE_KEY))
  } catch {
    return emptyDecisionReplayStore()
  }
}

export function saveDecisionReplayStore(
  store: DecisionReplayStore,
  storage: Pick<Storage, 'setItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
) {
  if (!storage) return false
  try {
    storage.setItem(DECISION_REPLAY_STORAGE_KEY, serializeDecisionReplayStore(normalizeDecisionReplayStore(store)))
    return true
  } catch {
    // Storage quota or privacy-mode failures must never unmount the entire React application.
    return false
  }
}

/**
 * Fast path for a store that is already canonical in React state. Unlike the
 * import/repair path above, this deliberately does not parse and merge the
 * entire previous localStorage snapshot before every interactive update.
 */
export function saveDecisionReplayStoreSnapshot(
  store: DecisionReplayStore,
  storage: Pick<Storage, 'setItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
) {
  if (!storage) return false
  try {
    storage.setItem(DECISION_REPLAY_STORAGE_KEY, serializeDecisionReplayStore(store))
    return true
  } catch {
    return false
  }
}

/**
 * Persist a tab's progress without allowing an older tab to overwrite newer
 * sessions that were merged while this tab was open. This is intentionally
 * additive: both the storage snapshot and the caller's in-memory snapshot are
 * merged before the write, so a refresh/pagehide cannot roll history back.
 */
export function persistDecisionReplayStoreAdditively(
  store: DecisionReplayStore,
  storage: (Pick<Storage, 'getItem'> & Pick<Storage, 'setItem'>) | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
) {
  const latest = loadDecisionReplayStore(storage)
  // mergeDecisionReplayStores deliberately keeps the first store's active
  // pointer. Prefer the current tab while it is starting/continuing a session;
  // otherwise retain an active session that another tab has already saved.
  const merged = store.activeSessionId
    ? mergeDecisionReplayStores(store, latest)
    : mergeDecisionReplayStores(latest, store)
  return { store: merged, saved: saveDecisionReplayStore(merged, storage) }
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
  const uniqueCandidates = [...new Map(candidates.map((candidate) => [candidate.key, candidate])).values()]
  const pool = uniqueCandidates.filter((candidate) => !seen.has(candidate.key))
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1)
    ;[pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]]
  }
  const count = Math.max(0, Math.min(pool.length, Math.floor(requestedCount)))
  return pool.slice(0, count)
}

const BEIJING_UTC_OFFSET_SECONDS = 8 * 60 * 60
const DAY_SECONDS = 24 * 60 * 60

function decisionDaySequenceForCandidate(candidate: ReplayDecisionCandidate): DecisionDaySequence | null {
  const closedSession = CLOSED_SESSION_SYMBOLS.includes(candidate.symbol)
  const sessionOpen = closedSession ? SESSION_OPEN_BEIJING_SECONDS : 0
  const day = Math.floor((candidate.trade.entry.signalTime + BEIJING_UTC_OFFSET_SECONDS - sessionOpen) / DAY_SECONDS)
  const startTime = day * DAY_SECONDS - BEIJING_UTC_OFFSET_SECONDS + sessionOpen
  const endTime = closedSession
    ? startTime + DAY_SECONDS - SESSION_OPEN_BEIJING_SECONDS + SESSION_CLOSE_BEIJING_SECONDS
    : startTime + DAY_SECONDS
  const isInsideSession = (time: number) => time >= startTime && time < endTime
  if (
    !isInsideSession(candidate.trade.entry.signalTime)
    || !isInsideSession(candidate.trade.entry.time)
    || !isInsideSession(candidate.trade.exit.time)
  ) return null
  return {
    key: `${candidate.symbol}:${candidate.interval}:${day}`,
    symbol: candidate.symbol,
    interval: candidate.interval as DecisionReplayInterval,
    startTime,
    endTime,
  }
}

function normalizeDecisionDaySequence(session: DecisionReplaySession): DecisionReplaySession {
  if (decisionSessionPracticeMode(session) !== 'day-sequence' || session.candidates.length === 0) return session
  const index = Math.max(0, Math.min(session.candidates.length - 1, Math.trunc(session.currentIndex || 0)))
  const candidate = session.candidates[index]
  const daySequence = decisionDaySequenceForCandidate(candidate)
  if (!daySequence) return session
  const boundsAlreadyCanonical = (
    session.daySequence?.key === daySequence.key
    && session.daySequence.startTime === daySequence.startTime
    && session.daySequence.endTime === daySequence.endTime
  )
  let normalized = boundsAlreadyCanonical ? session : { ...session, daySequence }
  const attempt = session.attempts.find((item) => item.candidateKey === candidate.key)
  const untouchedFirstQuestion = session.status === 'active'
    && index === 0
    && attempt?.stage === 'entry-decision'
    && attempt.cursorTime === candidate.trade.entry.signalTime
    && attempt.entryMode === null
    && attempt.pendingEntryPrice === null
    && attempt.fill === null
    && attempt.result === null
    && attempt.drawings.length === 0
  if (untouchedFirstQuestion && attempt.cursorTime !== daySequence.startTime) {
    normalized = {
      ...normalized,
      attempts: normalized.attempts.map((item) => item.candidateKey === candidate.key
        ? { ...item, cursorTime: daySequence.startTime }
        : item),
    }
  }
  return normalized
}

export interface SampledDecisionDay {
  daySequence: DecisionDaySequence
  candidates: ReplayDecisionCandidate[]
}

/** A day paper is selectable only when its source tape contains both session edges. */
export function decisionDayHistoryIsComplete(
  daySequence: DecisionDaySequence,
  candles: readonly Candle[] | null | undefined,
) {
  if (!candles?.length) return false
  const lastBarTime = daySequence.endTime - intervalSeconds(daySequence.interval)
  let hasOpen = false
  let hasClose = false
  for (const candle of candles) {
    if (candle.time === daySequence.startTime) hasOpen = true
    if (candle.time === lastBarTime) hasClose = true
    if (hasOpen && hasClose) return true
  }
  return false
}

/**
 * Build one paper from a single symbol/timeframe/Beijing date. Candidates are
 * kept causal and ordered by signal, then entry, instead of being shuffled.
 */
export function decisionDayCandidateGroups(
  candidates: readonly ReplayDecisionCandidate[],
  seenTradeKeys: readonly string[],
) {
  const seen = new Set(seenTradeKeys)
  const uniqueCandidates = [...new Map(candidates.map((candidate) => [candidate.key, candidate])).values()]
  const groups = new Map<string, SampledDecisionDay>()
  uniqueCandidates.forEach((candidate) => {
    if (seen.has(candidate.key) || !DECISION_REPLAY_INTERVALS.includes(candidate.interval as DecisionReplayInterval)) return
    const daySequence = decisionDaySequenceForCandidate(candidate)
    if (!daySequence) return
    const group = groups.get(daySequence.key) ?? { daySequence, candidates: [] }
    group.candidates.push(candidate)
    groups.set(daySequence.key, group)
  })
  return [...groups.values()].map((group) => ({
    ...group,
    candidates: [...group.candidates].sort((left, right) => (
      left.trade.entry.signalTime - right.trade.entry.signalTime
      || left.trade.entry.time - right.trade.entry.time
      || left.trade.tradeNumber - right.trade.tradeNumber
      || left.key.localeCompare(right.key)
    )),
  }))
}

export function sampleDecisionDayCandidates(
  candidates: readonly ReplayDecisionCandidate[],
  seenTradeKeys: readonly string[],
  isSelectable: (group: SampledDecisionDay) => boolean = () => true,
): SampledDecisionDay | null {
  const groups = decisionDayCandidateGroups(candidates, seenTradeKeys).filter(isSelectable)
  return groups.length > 0 ? groups[randomIndex(groups.length)] : null
}

/** Resume the newest explicitly exited whole-day session that matches the current pool. */
export function latestResumableDecisionDaySession(
  sessions: readonly DecisionReplaySession[],
  symbols: readonly SymbolId[],
  intervals: readonly DecisionReplayInterval[],
  eligibleDayKeys?: readonly string[],
) {
  const eligible = eligibleDayKeys ? new Set(eligibleDayKeys) : null
  const latest = [...sessions]
    .filter((session) => (
      session.origin !== 'review'
      && !isDecisionSyncBranch(session)
      && decisionSessionPracticeMode(session) === 'day-sequence'
      && session.candidates.length > 0
      && Boolean(session.daySequence)
      && symbols.includes(session.daySequence!.symbol)
      && intervals.includes(session.daySequence!.interval)
      && (!eligible || eligible.has(session.daySequence!.key))
    ))
    .sort((left, right) => right.updatedAt - left.updatedAt || right.startedAt - left.startedAt)[0] ?? null
  return latest?.status === 'stopped' ? latest : null
}

export function filterDecisionCandidatesByScope(
  candidates: readonly ReplayDecisionCandidate[],
  selectedSymbols: readonly SymbolId[],
  selectedIntervals: readonly DecisionReplayInterval[],
) {
  const symbols = new Set(selectedSymbols)
  const intervals = new Set<IntervalId>(selectedIntervals)
  return candidates.filter((candidate) => symbols.has(candidate.symbol) && intervals.has(candidate.interval))
}

export function createDecisionAttempt(candidate: ReplayDecisionCandidate, cursorTime = candidate.trade.entry.signalTime): DecisionAttempt {
  return {
    candidateKey: candidate.key,
    cursorTime,
    stage: 'entry-decision',
    entryMode: null,
    orderKind: null,
    pendingEntryPrice: null,
    initialStopLoss: null,
    stopLossMode: 'close',
    stopLoss: null,
    takeProfit: null,
    positionMultiplier: 1,
    fill: null,
    drawings: [],
    result: null,
  }
}

/**
 * Finish the settled day-sequence answer and immediately prepare the next
 * chronological exercise at the candle the user is currently viewing.
 * The settled result remains immutable; the new long/short choice belongs to
 * the next candidate, so history statistics never overwrite the prior trade.
 */
export function startNextDaySequenceTrade(
  session: DecisionReplaySession,
  side: TradeSide,
  entryPrice: number,
  drawings: Drawing[],
  now = Date.now(),
): DecisionReplaySession {
  if (decisionSessionPracticeMode(session) !== 'day-sequence' || session.status !== 'active') return session
  const candidate = currentDecisionCandidate(session)
  const attempt = currentDecisionAttempt(session)
  if (!candidate || !attempt?.result || attempt.stage !== 'post-exit' || !Number.isFinite(entryPrice)) return session
  const scheduledCandidate = session.candidates[session.currentIndex + 1]
  const manualStopDistance = Math.max(Math.abs(entryPrice) * 0.002, 0.01)
  const manualStopLoss = side === 'long' ? entryPrice - manualStopDistance : entryPrice + manualStopDistance
  const manualExitTime = Math.max(
    attempt.cursorTime,
    (session.daySequence?.endTime ?? attempt.cursorTime + intervalSeconds(candidate.interval)) - intervalSeconds(candidate.interval),
  )
  const manualBeijingTime = (time: number) => new Date((time + BEIJING_UTC_OFFSET_SECONDS) * 1000).toISOString().slice(0, 16).replace('T', ' ')
  const nextCandidate: ReplayDecisionCandidate = scheduledCandidate ?? {
    ...candidate,
    key: `${candidate.key}:manual:${session.id}:${attempt.cursorTime}:${session.candidates.length + 1}`,
    sourceName: `${candidate.sourceName} · 日内手动续单`,
    manualContinuation: true,
    trade: {
      ...candidate.trade,
      tradeNumber: Math.max(...session.candidates.map((item) => item.trade.tradeNumber), 0) + 1,
      side,
      entry: {
        ...candidate.trade.entry,
        signalTime: attempt.cursorTime,
        time: attempt.cursorTime,
        beijingTime: manualBeijingTime(attempt.cursorTime),
        price: entryPrice,
        setup: '日内手动续单',
        reason: `用户在日内逐根回放中以当前 K 线${side === 'long' ? '最高价' : '最低价'}设置突破追单；本笔没有对应的新增系统交易。`,
        stopLoss: manualStopLoss,
      },
      exit: {
        ...candidate.trade.exit,
        time: manualExitTime,
        beijingTime: manualBeijingTime(manualExitTime),
        price: entryPrice,
        reasonCode: 'END_OF_DATA_MARK_TO_MARKET',
        ambiguous: false,
        finalActiveStop: manualStopLoss,
        trailingActivated: false,
        trailingActivationIdx: null,
        trailingStructureIdx: null,
        trailingStructureConfirmationIdx: null,
        trailingStructurePrice: null,
        signalIdx: undefined,
        signalTime: undefined,
        setup: undefined,
        reason: undefined,
      },
      result: { barsHeld: 0, rMultiple: 0, pnlUsd: 0 },
    },
  }

  const completedAttempt: DecisionAttempt = {
    ...attempt,
    stage: 'complete',
    drawings,
    result: { ...attempt.result, drawings },
  }
  const nextAttempt: DecisionAttempt = {
    ...createDecisionAttempt(nextCandidate, attempt.cursorTime),
    userSide: side,
    entryMode: 'signal-extreme',
    orderKind: 'stop',
    pendingEntryPrice: entryPrice,
    initialStopLoss: null,
    stopLossMode: 'close',
    stopLoss: null,
    takeProfit: null,
    fill: null,
    stage: 'risk-setup',
  }

  const attempts = session.attempts
    .filter((item) => item.candidateKey !== nextCandidate.key)
    .map((item) => item.candidateKey === candidate.key ? completedAttempt : item)

  return {
    ...session,
    candidates: scheduledCandidate ? session.candidates : [...session.candidates, nextCandidate],
    attempts: [...attempts, nextAttempt],
    currentIndex: session.currentIndex + 1,
    requestedCount: scheduledCandidate ? session.requestedCount : Math.max(session.requestedCount, session.candidates.length + 1),
    updatedAt: now,
  }
}

/**
 * Explicitly discard the current, not-yet-finalized post-exit answer and move
 * that one exercise back to its signal candle. The correction marker makes the
 * reset authoritative when additive persistence still contains the old result.
 */
export function restartPostExitDecisionAttempt(session: DecisionReplaySession, candidateKey: string, now = Date.now()) {
  if (session.status !== 'active') return session
  const candidateIndex = session.candidates.findIndex((candidate) => candidate.key === candidateKey)
  if (candidateIndex < 0 || candidateIndex !== session.currentIndex) return session
  const candidate = session.candidates[candidateIndex]
  const attempt = session.attempts.find((item) => item.candidateKey === candidateKey)
  if (!attempt || attempt.stage !== 'post-exit' || !attempt.result) return session
  const correctionRevision = Math.max(now, (session.correctionRevision ?? 0) + 1)
  return {
    ...session,
    attempts: session.attempts.map((item) => item.candidateKey === candidateKey ? createDecisionAttempt(candidate) : item),
    currentIndex: candidateIndex,
    updatedAt: now,
    finishedAt: null,
    correctionRevision,
  }
}

export function filterDecisionCandidatesByTradingDay(
  candidates: readonly ReplayDecisionCandidate[],
  dayKey: string,
) {
  return candidates.filter((candidate) => decisionDaySequenceForCandidate(candidate)?.key === dayKey)
}

/** Aggregate every original AI result once, regardless of overlapping source files. */
export function decisionAiDaySummaries(
  candidates: readonly ReplayDecisionCandidate[],
  mode: DecisionPositionSizingMode = 'fixed-risk',
): DecisionAiDaySummary[] {
  const uniqueCandidates = [...new Map(candidates
    .filter((candidate) => candidate.manualContinuation !== true)
    .map((candidate) => [candidate.key, candidate] as const)).values()]
  const groups = new Map<string, DecisionAiDaySummary>()
  uniqueCandidates.forEach((candidate) => {
    const daySequence = decisionDaySequenceForCandidate(candidate)
    if (!daySequence) return
    const current = groups.get(daySequence.key) ?? {
      key: daySequence.key,
      symbol: daySequence.symbol,
      interval: daySequence.interval,
      startTime: daySequence.startTime,
      endTime: daySequence.endTime,
      pnlUsd: 0,
      wins: 0,
      total: 0,
      trades: [],
    }
    const pnlUsd = mode === 'fixed-risk'
      ? (Number.isFinite(candidate.trade.result.pnlUsd) ? candidate.trade.result.pnlUsd : 0)
      : pnlForDecisionMode(
          'fixed-notional',
          candidate.trade.side,
          candidate.trade.entry.price,
          candidate.trade.exit.price,
          candidate.trade.entry.stopLoss,
        )
    current.pnlUsd += pnlUsd
    current.wins += pnlUsd > 0 ? 1 : 0
    current.total += 1
    current.trades.push({
      key: candidate.key,
      symbol: candidate.symbol,
      interval: candidate.interval as DecisionReplayInterval,
    })
    groups.set(daySequence.key, current)
  })
  return [...groups.values()].sort((left, right) => right.startTime - left.startTime)
}

/**
 * Finish a day-sequence paper when its final market candle has been revealed.
 * The caller may provide a newly settled result (forced close or unfilled
 * order), or an existing post-exit attempt that only needs to be finalized.
 * Later unanswered candidates are deliberately left untouched: reaching the
 * end of the tape ends the paper instead of fabricating answers for them.
 */
export function canFinishDecisionSessionAtMarketEnd(attempt: DecisionAttempt | null | undefined) {
  return Boolean(attempt && (
    attempt.stage === 'position-open'
    || attempt.stage === 'order-pending'
    || attempt.result
  ))
}

export function finishDecisionSessionAtMarketEnd(
  session: DecisionReplaySession,
  marketEndCandle: Pick<Candle, 'time' | 'close'>,
  drawings: Drawing[],
  now = Date.now(),
): DecisionReplaySession {
  if (session.status !== 'active') return session
  const candidate = currentDecisionCandidate(session)
  const attempt = currentDecisionAttempt(session)
  if (!candidate || !attempt || candidate.key !== attempt.candidateKey) return session
  // Merely revealing the final candle does not answer an entry/risk question.
  // Keep that paper active so it can be resumed instead of falsely archiving it
  // as completed. Open positions and pending orders are the only unresolved
  // states that the market close itself can settle automatically.
  if (!canFinishDecisionSessionAtMarketEnd(attempt)) return session
  const atMarketEnd = { ...attempt, cursorTime: marketEndCandle.time, drawings }
  const shouldSettleCurrentOrder = attempt.stage === 'position-open' || attempt.stage === 'order-pending'
  const result = shouldSettleCurrentOrder
    ? buildDecisionResult(candidate, atMarketEnd, {
        time: marketEndCandle.time,
        price: marketEndCandle.close,
        reason: 'end-of-data',
      }, drawings)
    : attempt.result
      ? { ...attempt.result, drawings }
      : null
  const finalizedAttempt = result
    ? { ...atMarketEnd, stage: 'complete' as const, result, drawings: result.drawings }
    : { ...atMarketEnd, result }
  return {
    ...session,
    attempts: session.attempts.map((attempt) => attempt.candidateKey === finalizedAttempt.candidateKey
      ? finalizedAttempt
      : attempt),
    status: 'completed',
    updatedAt: now,
    finishedAt: now,
  }
}

export function createDecisionSession(
  candidates: ReplayDecisionCandidate[],
  requestedCount: number,
  now = Date.now(),
  positionSizingModes: readonly DecisionPositionSizingMode[] = DEFAULT_DECISION_POSITION_SIZING_MODES,
  options: {
    origin?: DecisionSessionOrigin
    sourceSessionId?: string
    sourceCandidateKey?: string
    practiceMode?: DecisionPracticeMode
    daySequence?: DecisionDaySequence
  } = {},
): DecisionReplaySession {
  if (candidates.length === 0) throw new Error('没有可用于决策回放的未完成交易')
  const id = `decision-${now}-${Math.random().toString(36).slice(2, 9)}`
  return {
    id,
    requestedCount,
    candidates,
    attempts: [createDecisionAttempt(candidates[0], options.practiceMode === 'day-sequence'
      ? options.daySequence?.startTime
      : undefined)],
    currentIndex: 0,
    status: 'active',
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    positionSizingModes: normalizeDecisionPositionSizingModes(positionSizingModes),
    origin: options.origin ?? 'practice',
    practiceMode: options.practiceMode ?? 'random-count',
    ...(options.daySequence ? { daySequence: options.daySequence } : {}),
    ...(options.sourceSessionId ? { sourceSessionId: options.sourceSessionId } : {}),
    ...(options.sourceCandidateKey ? { sourceCandidateKey: options.sourceCandidateKey } : {}),
  }
}

function expandCompactDecisionReplayStore(value: Partial<CompactDecisionReplayStore>): Partial<DecisionReplayStore> | null {
  if (!Array.isArray(value.candidateCatalog) || !Array.isArray(value.sessions)) return null
  const candidateCatalog = new Map(value.candidateCatalog
    .filter((candidate): candidate is ReplayDecisionCandidate => isObject(candidate) && typeof candidate.key === 'string')
    .map((candidate) => [candidate.key, candidate]))
  return {
    version: value.version,
    seenTradeKeys: value.seenTradeKeys,
    activeSessionId: value.activeSessionId,
    sessions: value.sessions.map((session) => {
      if (!isObject(session)) return session as unknown as DecisionReplaySession
      const compactCandidateKeys = Array.isArray(session.candidateKeys)
        ? session.candidateKeys.filter((key): key is string => typeof key === 'string')
        : []
      const candidates = compactCandidateKeys.flatMap((key) => {
        const candidate = candidateCatalog.get(key)
        return candidate ? [candidate] : []
      })
      const candidatesByKey = new Map(candidates.map((candidate) => [candidate.key, candidate]))
      const attempts = Array.isArray(session.attempts) ? session.attempts.map((attempt) => {
        if (!isObject(attempt) || !isObject(attempt.result)) return attempt as unknown as DecisionAttempt
        const candidateKey = typeof attempt.candidateKey === 'string' ? attempt.candidateKey : ''
        const candidate = candidatesByKey.get(candidateKey) ?? candidateCatalog.get(candidateKey)
        if (!candidate) return attempt as unknown as DecisionAttempt
        return {
          ...attempt,
          result: {
            ...attempt.result,
            candidate,
            drawings: Array.isArray(attempt.result.drawings)
              ? attempt.result.drawings
              : Array.isArray(attempt.drawings) ? attempt.drawings : [],
          },
        } as DecisionAttempt
      }) : []
      const { candidateKeys, ...rest } = session
      void candidateKeys
      return { ...rest, candidates, attempts } as DecisionReplaySession
    }),
  }
}

/**
 * Persist a lossless normalized representation. Candidates are stored once and completed
 * results reuse their attempt drawing snapshot, avoiding the two largest sources of duplication.
 */
export function serializeDecisionReplayStore(store: DecisionReplayStore) {
  const candidateCatalog = new Map<string, ReplayDecisionCandidate>()
  store.sessions.forEach((session) => {
    session.candidates.forEach((candidate) => candidateCatalog.set(candidate.key, candidate))
    session.attempts.forEach((attempt) => {
      if (attempt.result?.candidate && !candidateCatalog.has(attempt.result.candidate.key)) {
        candidateCatalog.set(attempt.result.candidate.key, attempt.result.candidate)
      }
    })
  })
  const compact: CompactDecisionReplayStore = {
    version: DECISION_REPLAY_VERSION,
    storageFormat: DECISION_REPLAY_COMPACT_FORMAT,
    seenTradeKeys: store.seenTradeKeys,
    activeSessionId: store.activeSessionId,
    candidateCatalog: [...candidateCatalog.values()],
    sessions: store.sessions.map((session) => {
      const { candidates, attempts, ...rest } = session
      return {
        ...rest,
        candidateKeys: candidates.map((candidate) => candidate.key),
        attempts: attempts.map((attempt) => {
          if (!attempt.result) return { ...attempt, result: null }
          const { candidate, drawings, ...result } = attempt.result
          const drawingsMatchAttempt = JSON.stringify(drawings) === JSON.stringify(attempt.drawings)
          return {
            ...attempt,
            result: {
              ...result,
              ...(!candidateCatalog.has(candidate?.key) && candidate ? { candidate } : {}),
              ...(!drawingsMatchAttempt ? { drawings } : {}),
            },
          }
        }),
      }
    }),
  }
  return JSON.stringify(compact)
}

/**
 * Create a fresh, one-question session for redoing a historical result.
 * The source session/result are only metadata inputs; the new attempt starts
 * unanswered at the signal candle and therefore cannot overwrite the source.
 */
export function createDecisionReviewSession(
  sourceSession: DecisionReplaySession,
  result: DecisionTradeResult,
  now = Date.now(),
): DecisionReplaySession {
  const candidate = sourceSession.candidates.find((item) => item.key === result.candidateKey) ?? result.candidate
  return createDecisionSession(
    [candidate],
    1,
    now,
    decisionSessionPositionSizingModes(sourceSession),
    {
      origin: 'review',
      sourceSessionId: sourceSession.id,
      sourceCandidateKey: result.candidateKey,
    },
  )
}

export function currentDecisionCandidate(session: DecisionReplaySession | null | undefined) {
  return session?.candidates[session.currentIndex] ?? null
}

export function currentDecisionAttempt(session: DecisionReplaySession | null | undefined) {
  const candidate = currentDecisionCandidate(session)
  return candidate ? session?.attempts.find((attempt) => attempt.candidateKey === candidate.key) ?? null : null
}

/** Keep session timestamps stable when loading an unchanged drawing snapshot. */
export function updateDecisionSessionDrawings(
  session: DecisionReplaySession,
  candidateKey: string,
  drawings: Drawing[],
  now = Date.now(),
) {
  const attempt = session.attempts.find((item) => item.candidateKey === candidateKey)
  if (!attempt) return session
  const drawingsJson = JSON.stringify(drawings)
  if (JSON.stringify(attempt.drawings) === drawingsJson
    && (!attempt.result || JSON.stringify(attempt.result.drawings) === drawingsJson)) return session
  return {
    ...session,
    updatedAt: now,
    attempts: session.attempts.map((item) => item.candidateKey === candidateKey ? {
      ...item,
      drawings,
      result: item.result ? { ...item.result, drawings } : null,
    } : item),
  }
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

function candleResolutionSeconds(candles: readonly Candle[]) {
  for (let index = 1; index < candles.length; index += 1) {
    const difference = candles[index].time - candles[index - 1].time
    if (difference > 0) return difference
  }
  return 60
}

/**
 * A random exercise is eligible only when the bundled source history can
 * reconstruct the complete signal, entry and system-exit source candles.
 * This prevents a valid trade record from opening as an empty chart merely
 * because its older market window is not shipped with the site.
 */
export function historyCoversDecisionCandidate(candidate: ReplayDecisionCandidate, sourceCandles: readonly Candle[] | null | undefined) {
  if (!sourceCandles?.length) return false
  const seconds = intervalSeconds(candidate.interval)
  const candleSeconds = candleResolutionSeconds(sourceCandles)
  const sourceTimes = [candidate.trade.entry.signalTime, candidate.trade.entry.time, candidate.trade.exit.time]
  return sourceTimes.every((sourceTime) => {
    const firstIndex = candleIndexAtOrAfter(sourceCandles, sourceTime)
    const lastTime = sourceTime + seconds - candleSeconds
    const lastIndex = candleIndexAtOrAfter(sourceCandles, lastTime)
    return sourceCandles[firstIndex]?.time === sourceTime && sourceCandles[lastIndex]?.time === lastTime
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

/**
 * Builds a causal structure stop from the latest candles that are already
 * visible to the learner. Long trades protect below the recent lows; short
 * trades protect above the recent highs. The current candle is included so
 * the default remains useful early in a replay day.
 */
export function recentDecisionStructureStop(
  side: TradeSide,
  entryPrice: number,
  candles: readonly Candle[],
  cursorTime: number,
  lookback = 5,
) {
  const recent = candlesKnownAt(candles, cursorTime).slice(-Math.max(1, Math.floor(lookback)))
  if (!recent.length) return null
  const stopLoss = side === 'long'
    ? Math.min(...recent.map((candle) => candle.low))
    : Math.max(...recent.map((candle) => candle.high))
  if (!Number.isFinite(stopLoss)) return null
  if (side === 'long' && stopLoss >= entryPrice) return null
  if (side === 'short' && stopLoss <= entryPrice) return null
  return stopLoss
}

export function decisionExtremeEntryPrice(side: TradeSide, candle: Pick<Candle, 'high' | 'low'>) {
  return side === 'long' ? candle.high : candle.low
}

export function adjustDecisionPendingEntry(
  side: TradeSide,
  nextEntryPrice: number,
  referencePrice: number,
  levels: { stopLoss: number; takeProfit: number },
) {
  const orderKind: DecisionOrderKind = side === 'long'
    ? nextEntryPrice >= referencePrice ? 'stop' : 'limit'
    : nextEntryPrice <= referencePrice ? 'stop' : 'limit'
  return {
    orderKind,
    stopLoss: levels.stopLoss,
    takeProfit: levels.takeProfit,
  }
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
  if (orderKind === 'stop' && side === 'long' && candle.high > entryPrice) return { time: candle.time, price: candle.open > entryPrice ? candle.open : entryPrice }
  if (orderKind === 'stop' && side === 'short' && candle.low < entryPrice) return { time: candle.time, price: candle.open < entryPrice ? candle.open : entryPrice }
  if (orderKind === 'limit' && side === 'long' && candle.low <= entryPrice) return { time: candle.time, price: candle.open < entryPrice ? candle.open : entryPrice }
  if (orderKind === 'limit' && side === 'short' && candle.high >= entryPrice) return { time: candle.time, price: candle.open > entryPrice ? candle.open : entryPrice }
  return null
}

/** Do not reinterpret an old, already-open order when loading a newer app. */
export function decisionStopLossMode(value: unknown): DecisionStopLossMode {
  return value === 'close' ? 'close' : 'touch'
}

export function evaluatePositionBar(side: TradeSide, stopLoss: number, takeProfit: number, candle: Candle, stopLossMode: DecisionStopLossMode = 'touch'): DecisionExit | null {
  const targetHit = side === 'long' ? candle.high >= takeProfit : candle.low <= takeProfit
  if (stopLossMode === 'close') {
    // A take-profit touched during the bar precedes a stop evaluated only at its close.
    if (targetHit) {
      const price = side === 'long' ? Math.max(candle.open, takeProfit) : Math.min(candle.open, takeProfit)
      return { time: candle.time, price, reason: 'take-profit' }
    }
    const closeBreached = side === 'long' ? candle.close < stopLoss : candle.close > stopLoss
    // Keep time as the candle's opening timestamp, as all replay markers do. The fill is its close.
    return closeBreached ? { time: candle.time, price: candle.close, reason: 'stop-loss' } : null
  }
  const stopHit = side === 'long' ? candle.low <= stopLoss : candle.high >= stopLoss
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
  const side = decisionAttemptSide(candidate, nextAttempt)
  if (nextAttempt.stage === 'order-pending' && nextAttempt.pendingEntryPrice !== null && nextAttempt.stopLoss !== null && nextAttempt.takeProfit !== null) {
    const fill = fillPendingOrder(side, nextAttempt.orderKind ?? 'stop', nextAttempt.pendingEntryPrice, nextCandle)
    if (fill) nextAttempt = { ...nextAttempt, fill, stage: 'position-open' }
  }
  if (nextAttempt.stage === 'position-open' && nextAttempt.stopLoss !== null && nextAttempt.takeProfit !== null) {
    const mode = decisionStopLossMode(nextAttempt.stopLossMode)
    const systemExit = candidate.trade.exit
    // Only a newly reached system-exit bar may close a position. In particular,
    // a late user entry must never be closed retroactively at a past system exit.
    // With OHLC-only data, same-bar system exits take precedence over close confirmation.
    if (nextAttempt.userSide === undefined && mode === 'close' && nextAttempt.fill && systemExit.time === nextCandle.time && systemExit.time >= nextAttempt.fill.time) {
      return { attempt: nextAttempt, exit: { time: systemExit.time, price: systemExit.price, reason: 'system-exit' } }
    }
    return { attempt: nextAttempt, exit: evaluatePositionBar(side, nextAttempt.stopLoss, nextAttempt.takeProfit, nextCandle, mode) }
  }
  return { attempt: nextAttempt, exit: null }
}

export function cancelPendingOrderAndAdvance(attempt: DecisionAttempt, nextCandle: Candle): DecisionAttempt {
  if (attempt.stage !== 'order-pending') return attempt
  return {
    ...attempt,
    cursorTime: nextCandle.time,
    stage: 'entry-decision',
    userSide: undefined,
    entryMode: null,
    orderKind: null,
    pendingEntryPrice: null,
    initialStopLoss: null,
    stopLossMode: 'close',
    stopLoss: null,
    takeProfit: null,
    positionMultiplier: 1,
    fill: null,
    result: null,
  }
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

export function normalizeDecisionPositionMultiplier(value: unknown): DecisionPositionMultiplier {
  return DECISION_POSITION_MULTIPLIERS.includes(value as DecisionPositionMultiplier)
    ? value as DecisionPositionMultiplier
    : 1
}

export function nextDecisionPositionMultiplier(
  current: unknown,
  direction: -1 | 1,
): DecisionPositionMultiplier {
  const normalized = normalizeDecisionPositionMultiplier(current)
  const index = DECISION_POSITION_MULTIPLIERS.indexOf(normalized)
  return DECISION_POSITION_MULTIPLIERS[Math.max(0, Math.min(DECISION_POSITION_MULTIPLIERS.length - 1, index + direction))]
}

export function pnlForDecisionMode(
  mode: DecisionPositionSizingMode,
  side: TradeSide,
  entryPrice: number,
  exitPrice: number,
  stopLoss: number,
  positionMultiplier: unknown = 1,
) {
  const multiplier = normalizeDecisionPositionMultiplier(positionMultiplier)
  return mode === 'fixed-risk'
    ? pnlForDecision(side, entryPrice, exitPrice, stopLoss, DECISION_PLANNED_RISK_USD * multiplier).pnlUsd
    : pnlForFixedNotional(side, entryPrice, exitPrice, DECISION_FIXED_NOTIONAL_USD * multiplier).pnlUsd
}

function isValidInitialStopLoss(side: TradeSide, entryPrice: number, stopLoss: number | null | undefined): stopLoss is number {
  if (stopLoss === null || stopLoss === undefined || !Number.isFinite(stopLoss)) return false
  return side === 'long' ? stopLoss < entryPrice : stopLoss > entryPrice
}

export function decisionAttemptSide(candidate: ReplayDecisionCandidate, attempt: Pick<DecisionAttempt, 'userSide'>): TradeSide {
  return attempt.userSide === 'long' || attempt.userSide === 'short' ? attempt.userSide : candidate.trade.side
}

export function decisionResultSide(result: Pick<DecisionTradeResult, 'userSide' | 'candidate'>): TradeSide {
  return result.userSide === 'long' || result.userSide === 'short' ? result.userSide : result.candidate.trade.side
}

export function decisionAttemptInitialStopLoss(candidate: ReplayDecisionCandidate, attempt: DecisionAttempt) {
  const side = decisionAttemptSide(candidate, attempt)
  const entryPrice = attempt.fill?.price ?? attempt.pendingEntryPrice ?? candidate.trade.entry.price
  if (isValidInitialStopLoss(side, entryPrice, attempt.initialStopLoss)) return attempt.initialStopLoss
  // A legacy pending order has not had a chance to trail yet, so its current stop is still its initial stop.
  if (attempt.stage === 'order-pending' && isValidInitialStopLoss(side, entryPrice, attempt.stopLoss)) return attempt.stopLoss
  // Legacy open/completed attempts did not preserve the initial stop. The causal trade definition is the
  // only immutable pre-entry stop available; never resize from a later trailing stop.
  if (attempt.userSide === undefined && isValidInitialStopLoss(side, entryPrice, candidate.trade.entry.stopLoss)) return candidate.trade.entry.stopLoss
  return isValidInitialStopLoss(side, entryPrice, attempt.stopLoss) ? attempt.stopLoss : null
}

export function decisionResultInitialStopLoss(result: DecisionTradeResult) {
  if (!result.userEntry) return null
  const side = decisionResultSide(result)
  const entryPrice = result.userEntry.price
  if (isValidInitialStopLoss(side, entryPrice, result.initialStopLoss)) return result.initialStopLoss
  // Results created before initialStopLoss existed may contain the final trailing stop in result.stopLoss.
  // Recover their sizing from the immutable structural stop that was known before entry.
  if (result.userSide === undefined && isValidInitialStopLoss(side, entryPrice, result.candidate.trade.entry.stopLoss)) return result.candidate.trade.entry.stopLoss
  return isValidInitialStopLoss(side, entryPrice, result.stopLoss) ? result.stopLoss : null
}

export function decisionResultR(result: DecisionTradeResult, actor: 'user' | 'system') {
  if (actor === 'system') return decisionResultHasSystemBenchmark(result) ? result.systemR : 0
  if (result.choice !== 'traded' || !result.userEntry) return 0
  const initialStopLoss = decisionResultInitialStopLoss(result)
  if (initialStopLoss === null) return result.userR
  return pnlForDecision(decisionResultSide(result), result.userEntry.price, result.userExit.price, initialStopLoss, 1).rMultiple
}

export function decisionResultHasSystemBenchmark(result: Partial<Pick<DecisionTradeResult, 'candidate'>>) {
  // Compact legacy/sync fixtures may omit the embedded candidate. Preserve
  // their historical behavior; only an explicit manual continuation opts out.
  return result.candidate?.manualContinuation !== true
}

export function normalizeDecisionTradeResult(result: DecisionTradeResult): DecisionTradeResult {
  const initialStopLoss = decisionResultInitialStopLoss(result)
  const positionMultiplier = normalizeDecisionPositionMultiplier(result.positionMultiplier)
  if (result.choice !== 'traded' || !result.userEntry || initialStopLoss === null) return { ...result, initialStopLoss, positionMultiplier }
  const plannedRiskUsd = Number.isFinite(result.plannedRiskUsd) && result.plannedRiskUsd > 0 ? result.plannedRiskUsd : DECISION_PLANNED_RISK_USD
  const user = pnlForDecision(decisionResultSide(result), result.userEntry.price, result.userExit.price, initialStopLoss, plannedRiskUsd * positionMultiplier)
  return {
    ...result,
    initialStopLoss,
    positionMultiplier,
    plannedRiskUsd,
    userPnlUsd: user.pnlUsd,
    userR: user.rMultiple,
    differenceUsd: user.pnlUsd - result.systemPnlUsd,
  }
}

export function decisionResultPnl(
  result: DecisionTradeResult,
  mode: DecisionPositionSizingMode,
  actor: 'user' | 'system',
) {
  if (actor === 'system' && !decisionResultHasSystemBenchmark(result)) return 0
  if (mode === 'fixed-risk') {
    if (actor === 'system') return result.systemPnlUsd
    if (result.choice !== 'traded' || !result.userEntry) return 0
    const initialStopLoss = decisionResultInitialStopLoss(result)
    if (initialStopLoss === null) return result.userPnlUsd
    const plannedRiskUsd = Number.isFinite(result.plannedRiskUsd) && result.plannedRiskUsd > 0 ? result.plannedRiskUsd : DECISION_PLANNED_RISK_USD
    return pnlForDecision(
      decisionResultSide(result),
      result.userEntry.price,
      result.userExit.price,
      initialStopLoss,
      plannedRiskUsd * normalizeDecisionPositionMultiplier(result.positionMultiplier),
    ).pnlUsd
  }
  if (actor === 'user') {
    if (result.choice !== 'traded' || !result.userEntry) return 0
    return pnlForDecisionMode(
      'fixed-notional',
      decisionResultSide(result),
      result.userEntry.price,
      result.userExit.price,
      result.stopLoss ?? result.userEntry.price,
      result.positionMultiplier,
    )
  }
  return pnlForDecisionMode(
    'fixed-notional',
    result.candidate.trade.side,
    result.candidate.trade.entry.price,
    result.candidate.trade.exit.price,
    result.candidate.trade.entry.stopLoss ?? result.candidate.trade.entry.price,
  )
}

export interface DecisionSystemBenchmarkStats {
  pnlUsd: number
  wins: number
  total: number
}

/** Calculate the system side from every original question in one paper. */
export function decisionSessionSystemBenchmarkStats(
  session: DecisionReplaySession,
  mode: DecisionPositionSizingMode,
  completeSystemCandidates: readonly ReplayDecisionCandidate[] = session.candidates,
): DecisionSystemBenchmarkStats {
  const candidates = [...new Map(completeSystemCandidates
    .filter((candidate) => candidate.manualContinuation !== true)
    .map((candidate) => [candidate.key, candidate] as const)).values()]
  const values = candidates.map((candidate) => mode === 'fixed-risk'
    ? candidate.trade.result.pnlUsd
    : pnlForDecisionMode(
        'fixed-notional',
        candidate.trade.side,
        candidate.trade.entry.price,
        candidate.trade.exit.price,
        candidate.trade.entry.stopLoss ?? candidate.trade.entry.price,
      ))
  return {
    pnlUsd: values.reduce((sum, value) => sum + value, 0),
    wins: values.filter((value) => value > 0).length,
    total: values.length,
  }
}

/**
 * Select every original system trade belonging to the paper's market day.
 * The input may be the complete source registry rather than only the unseen
 * questions sampled into this practice session. This keeps the AI ledger in
 * sync with the system markers that are visible on the chart.
 */
export function decisionSystemCandidatesForDay(
  candidates: readonly ReplayDecisionCandidate[],
  daySequence: DecisionDaySequence,
) {
  return [...new Map(candidates
    .filter((candidate) => (
      candidate.manualContinuation !== true
      && candidate.symbol === daySequence.symbol
      && candidate.interval === daySequence.interval
      && candidate.trade.entry.signalTime >= daySequence.startTime
      && candidate.trade.entry.signalTime < daySequence.endTime
      && candidate.trade.entry.time >= daySequence.startTime
      && candidate.trade.entry.time < daySequence.endTime
      && candidate.trade.exit.time >= daySequence.startTime
      && candidate.trade.exit.time < daySequence.endTime
    ))
    .map((candidate) => [candidate.key, candidate] as const)).values()]
    .sort((left, right) => (
      left.trade.entry.signalTime - right.trade.entry.signalTime
      || left.trade.entry.time - right.trade.entry.time
      || left.key.localeCompare(right.key)
    ))
}

/**
 * Build the causal AI trade ledger for day-sequence replay.
 *
 * A trade enters the ledger only after its actual system fill is revealed.
 * Closed trades use their immutable exit result; the one currently open trade
 * is marked to the latest revealed candle close without reading its future exit.
 */
export function revealedDecisionSystemTrades(
  candidates: readonly ReplayDecisionCandidate[],
  revealedThrough: number,
  currentClose: number,
): DecisionSystemTradeSnapshot[] {
  const uniqueCandidates = [...new Map(candidates
    .filter((candidate) => candidate.manualContinuation !== true)
    .map((candidate) => [candidate.key, candidate] as const)).values()]
  return uniqueCandidates
    .filter((candidate) => candidate.trade.entry.signalTime <= revealedThrough && candidate.trade.entry.time <= revealedThrough)
    .sort((left, right) => left.trade.entry.time - right.trade.entry.time || left.key.localeCompare(right.key))
    .map((candidate) => {
      const closed = candidate.trade.exit.time <= revealedThrough
      const markPrice = closed ? candidate.trade.exit.price : currentClose
      return {
        candidateKey: candidate.key,
        candidate,
        closed,
        pnlByMode: {
          'fixed-risk': closed
            ? candidate.trade.result.pnlUsd
            : pnlForDecisionMode(
                'fixed-risk',
                candidate.trade.side,
                candidate.trade.entry.price,
                markPrice,
                candidate.trade.entry.stopLoss,
              ),
          'fixed-notional': pnlForDecisionMode(
            'fixed-notional',
            candidate.trade.side,
            candidate.trade.entry.price,
            markPrice,
            candidate.trade.entry.stopLoss,
          ),
        },
      }
    })
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
  const riskStopLoss = decisionAttemptInitialStopLoss(candidate, attempt) ?? attempt.stopLoss
  const userSide = decisionAttemptSide(candidate, attempt)
  const positionMultiplier = normalizeDecisionPositionMultiplier(attempt.positionMultiplier)
  const user = traded
    ? pnlForDecision(userSide, attempt.fill!.price, exit.price, riskStopLoss!, DECISION_PLANNED_RISK_USD * positionMultiplier)
    : { pnlUsd: 0, rMultiple: 0 }
  const hasSystemBenchmark = candidate.manualContinuation !== true
  const systemPnlUsd = hasSystemBenchmark ? candidate.trade.result.pnlUsd : 0
  const systemR = hasSystemBenchmark ? candidate.trade.result.rMultiple : 0
  return {
    candidateKey: candidate.key,
    candidate,
    choice,
    ...(attempt.userSide ? { userSide: attempt.userSide } : {}),
    entryMode: attempt.entryMode,
    orderKind: attempt.orderKind ?? null,
    cursorTime: attempt.cursorTime,
    userEntry: attempt.fill,
    userExit: exit,
    initialStopLoss: riskStopLoss,
    stopLossMode: decisionStopLossMode(attempt.stopLossMode),
    stopLoss: attempt.stopLoss,
    takeProfit: attempt.takeProfit,
    positionMultiplier,
    plannedRiskUsd: DECISION_PLANNED_RISK_USD,
    userPnlUsd: user.pnlUsd,
    userR: user.rMultiple,
    systemPnlUsd,
    systemR,
    differenceUsd: user.pnlUsd - systemPnlUsd,
    drawings: drawings.map((drawing) => ({ ...drawing, points: drawing.points.map((point) => ({ ...point })) })),
  }
}

export function decisionShortcutAction(stage: DecisionAttemptStage, key: string, practiceMode: DecisionPracticeMode = 'random-count'): DecisionShortcutAction | null {
  if (stage === 'entry-decision') {
    if (key === '1') return 'advance'
    if (practiceMode === 'day-sequence') {
      if (key === '2') return 'open-long'
      if (key === '3') return 'open-short'
      return null
    }
    if (key === '2') return 'signal-extreme'
    if (key === '3') return 'free-price'
    if (key === '4') return 'skip'
  }
  if (stage === 'order-pending') {
    if (key === '1') return 'advance'
    if (key === '2') return 'cancel-pending'
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
    if (practiceMode === 'day-sequence') {
      if (key === '2') return 'open-long'
      if (key === '3') return 'open-short'
      return null
    }
    if (key === '4') return 'next-trade'
    if (key === '5') return 'restart-trade'
  }
  return null
}

/**
 * Move through already-reached exercises without mutating the persisted session cursor.
 * The active exercise is a hard upper boundary: forward navigation can return to it,
 * but can never advance the session into an unseen candidate.
 */
export function adjacentDecisionExerciseTarget(
  session: DecisionReplaySession,
  reviewedCandidateKey: string | null,
  direction: -1 | 1,
): DecisionExerciseNavigationTarget | null {
  const results = session.candidates.map((candidate) => (
    session.attempts.find((attempt) => attempt.candidateKey === candidate.key)?.result ?? null
  ))
  let latestResultIndex = -1
  for (let index = results.length - 1; index >= 0; index -= 1) {
    if (results[index]) {
      latestResultIndex = index
      break
    }
  }
  const latestIndex = session.status === 'active'
    ? Math.min(Math.max(session.currentIndex, 0), session.candidates.length - 1)
    : latestResultIndex
  if (latestIndex < 0) return null

  const reviewedIndex = reviewedCandidateKey === null
    ? latestIndex
    : session.candidates.findIndex((candidate) => candidate.key === reviewedCandidateKey)
  if (reviewedIndex < 0) return null

  if (direction < 0) {
    for (let index = reviewedIndex - 1; index >= 0; index -= 1) {
      const result = results[index]
      if (result) return { kind: 'review', result }
    }
    return null
  }

  // "=" is deliberately inert until the user has first moved backward.
  if (reviewedCandidateKey === null) return null
  const reviewBoundary = session.status === 'active' ? latestIndex - 1 : latestIndex
  for (let index = reviewedIndex + 1; index <= reviewBoundary; index += 1) {
    const result = results[index]
    if (result) return { kind: 'review', result }
  }
  return session.status === 'active' ? { kind: 'active' } : null
}

export function sessionResults(session: DecisionReplaySession) {
  return session.attempts.flatMap((attempt) => attempt.result ? [attempt.result] : [])
}

export interface DecisionSessionUserRStats {
  participatedTradeCount: number
  measuredTradeCount: number
  averageInitialStopDistance: number | null
  totalR: number | null
  averageR: number | null
}

/** Use the average initial stop distance of filled user orders as one shared R for the round. */
export function decisionSessionUserRStats(session: DecisionReplaySession): DecisionSessionUserRStats {
  const participated = sessionResults(session).filter((result) => result.choice === 'traded' && result.userEntry)
  const measurements = participated.flatMap((result) => {
    const entryPrice = result.userEntry?.price
    const initialStopLoss = decisionResultInitialStopLoss(result)
    if (entryPrice === undefined || initialStopLoss === null) return []
    const stopDistance = Math.abs(entryPrice - initialStopLoss)
    const signedMove = decisionResultSide(result) === 'long'
      ? result.userExit.price - entryPrice
      : entryPrice - result.userExit.price
    if (!Number.isFinite(stopDistance) || stopDistance <= 0 || !Number.isFinite(signedMove)) return []
    return [{ stopDistance, signedMove }]
  })
  if (measurements.length === 0) {
    return { participatedTradeCount: participated.length, measuredTradeCount: 0, averageInitialStopDistance: null, totalR: null, averageR: null }
  }
  const averageInitialStopDistance = measurements.reduce((sum, item) => sum + item.stopDistance, 0) / measurements.length
  const totalR = measurements.reduce((sum, item) => sum + item.signedMove, 0) / averageInitialStopDistance
  return {
    participatedTradeCount: participated.length,
    measuredTradeCount: measurements.length,
    averageInitialStopDistance,
    totalR,
    averageR: totalR / measurements.length,
  }
}

export function formatDecisionDate(epochSeconds: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(epochSeconds * 1000))
}

export function formatDecisionDay(epochSeconds: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
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
